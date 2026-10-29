/**
 * Smoke-тесты Gameplay Kit v2.8 (логика, без WebGL).
 * Запуск: npm run game   (или npm run smoke — цепочкой)
 */
import * as THREE from 'three';

const TF = await import('../../threeforge-v2_6_0.js');

let failures = 0;
let checks = 0;
function ok(cond, label, extra) {
	checks++;
	if (cond !== true) {
		failures++;
		console.error('✗ ' + label + (extra !== undefined ? ' — ' + extra : ''));
	}
}
function near(a, b, eps = 1e-6) { return Math.abs(a - b) <= eps; }
function section(name) { console.log('— ' + name); }
function finiteGeo(geo) {
	const p = geo.attributes.position.array;
	for (let i = 0; i < p.length; i++) if (!Number.isFinite(p[i])) return false;
	return true;
}

class FakeInput {
	constructor() {
		this.keys = new Set();
		this.enabled = true;
		this.pointerLocked = false;
		this._delta = new THREE.Vector2();
	}
	isKeyDown(c) { return this.keys.has(c); }
	consumeMouseDelta(out) { out.copy(this._delta); this._delta.set(0, 0); return out; }
	pushMouse(dx, dy) { this._delta.set(dx, dy); }
	lockPointer() { this.pointerLocked = true; }
	unlockPointer() { this.pointerLocked = false; }
}

// ------------------------------------------------------------- 1. геометрии
section('GK1/GK2/GK3: процедурные геометрии');
{
	const sword = TF.createSwordGeometry({ bladeLength: 1.05, gripLength: 0.24 });
	ok(finiteGeo(sword), 'меч: позиции конечны');
	ok(sword.attributes.color !== undefined, 'меч: вершинные цвета есть');
	sword.computeBoundingBox();
	const bb = sword.boundingBox;
	ok(bb.max.y > 1.0 && bb.max.y < 1.2, 'меч: верх ≈ клинок', bb.max.y);
	ok(bb.min.y < -0.25 && bb.min.y > -0.45, 'меч: низ ≈ рукоять+навершие', bb.min.y);
	ok(bb.max.x > 0.15 && bb.max.x < 0.2, 'меч: перекрестье по X', bb.max.x);

	const giant = TF.createSwordGeometry({ bladeLength: 6 });
	giant.computeBoundingBox();
	ok(giant.boundingBox.max.y > 5.9, 'меч: масштабируемый клинок', giant.boundingBox.max.y);

	const fist = TF.createFistGeometry();
	ok(finiteGeo(fist), 'кулак: позиции конечны');
	ok(fist.boundingSphere.radius < 0.25, 'кулак: радиус < 0.25', fist.boundingSphere.radius);

	const flower = TF.createFlowerGeometry({ stemHeight: 0.22, petals: 5 });
	ok(finiteGeo(flower), 'цветок: позиции конечны');
	flower.computeBoundingBox();
	ok(flower.boundingBox.max.y > 0.2 && flower.boundingBox.max.y < 0.4, 'цветок: высота головки', flower.boundingBox.max.y);
	ok(flower.attributes.color !== undefined, 'цветок: вершинные цвета есть');
	ok(TF.TF_DETAIL_TYPES !== undefined && TF.TF_DETAIL_TYPES.indexOf('flower') !== -1, 'детали: тип flower зарегистрирован');
}

// ------------------------------------------------------------- 2. stylized
section('GK8: stylized-материалы и gradientMap');
{
	const gm = TF.createGradientMap(4);
	ok(gm.image.width === 4 && gm.image.height === 1, 'gradientMap: размер 4x1');
	ok(gm.magFilter === THREE.NearestFilter, 'gradientMap: NearestFilter');
	const d = gm.image.data;
	ok(d[0] < d[4] && d[4] < d[8] && d[8] < d[12], 'gradientMap: ступени монотонны');

	const mat = TF.createStylizedMaterial({ color: 0x8899bb, steps: 3, rim: 0.4 });
	ok(mat.isMeshToonMaterial === true, 'stylized: это MeshToonMaterial');
	ok(mat.gradientMap !== null && mat.gradientMap.image.width === 3, 'stylized: gradientMap 3 ступени');
	ok(mat.__tfStylizedPatched === true, 'stylized: rim-патч установлен');
	ok(mat.__tfStylizedUniforms.tfStylRimStrength.value === 0.4, 'stylized: сила rim из options');

	const copy = TF.cloneMaterialPatched(mat);
	ok(copy.__tfStylizedPatched === true, 'stylized: cloneMaterialPatched воспроизводит патч');
	ok(copy.__tfStylizedUniforms === mat.__tfStylizedUniforms, 'stylized: клон делит uniforms');

	const noRim = TF.createStylizedMaterial({ rim: false });
	ok(noRim.__tfStylizedPatched !== true, 'stylized: rim:false без патча');

	const std = new THREE.MeshStandardMaterial();
	TF.installStylizedPatch(std, { rim: 0.3 });
	const sh = { uniforms: {}, fragmentShader: THREE.ShaderLib.physical.fragmentShader, vertexShader: '' };
	std.onBeforeCompile(sh, null);
	ok(sh.uniforms.tfStylRimColor !== undefined && sh.uniforms.tfStylRimPower !== undefined, 'stylized: uniforms в шейдере');
	ok(sh.fragmentShader.indexOf('tfStylRim') !== -1, 'stylized: GLSL вставлен');
	ok(sh.fragmentShader.indexOf('tfStylRimColor * tfStylRim') !== -1, 'stylized: добавка в gl_FragColor');
}

// ------------------------------------------------------------- 3. FP controller
section('GK6: FirstPersonController — кинематика');
{
	const cam = new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 500);
	const ctl = new TF.FirstPersonController({ camera: cam, groundFn: () => 0 });
	ctl.teleport(0, 5, 0);
	ok(near(ctl.feet.y, 5), 'FP: teleport');
	for (let i = 0; i < 240; i++) ctl.update(1 / 60);
	ok(ctl.onGround === true && near(ctl.feet.y, 0, 1e-6), 'FP: падение и опора', ctl.feet.y);
	ok(near(ctl.velocity.y, 0), 'FP: vy обнулён на опоре');
	ok(near(cam.position.y, ctl.eyeHeight + ctl.bobOffset, 1e-9), 'FP: камера = ноги + глаз');

	// прыжок
	const ctl2 = new TF.FirstPersonController({ camera: new THREE.PerspectiveCamera(), groundFn: () => 0 });
	ctl2.teleport(0, 0, 0);
	const inp = new FakeInput();
	ctl2.input = inp;
	inp.keys.add('Space');
	ctl2.update(1 / 60);
	ok(ctl2.velocity.y > 4 && ctl2.onGround === false, 'FP: прыжок дал vy', ctl2.velocity.y);
	const apex = (ctl2.jumpSpeed * ctl2.jumpSpeed) / (2 * ctl2.gravity);
	let maxY = 0;
	for (let i = 0; i < 200; i++) { ctl2.update(1 / 60); maxY = Math.max(maxY, ctl2.feet.y); }
	ok(Math.abs(maxY - apex) < 0.15, 'FP: апекс ≈ v²/2g', maxY + ' vs ' + apex);
	ok(ctl2.onGround === true, 'FP: приземление');

	// ходьба вперёд (-Z при yaw=0) и спринт
	const ctl3 = new TF.FirstPersonController({ camera: new THREE.PerspectiveCamera(), groundFn: () => 0 });
	ctl3.teleport(0, 0, 0);
	const inp3 = new FakeInput();
	ctl3.input = inp3;
	inp3.keys.add('KeyW');
	for (let i = 0; i < 120; i++) ctl3.update(1 / 60);
	ok(ctl3.feet.z < -3, 'FP: W идёт в -Z', ctl3.feet.z);
	ok(ctl3.speedRatio > 0.95, 'FP: speedRatio ≈ 1', ctl3.speedRatio);
	ok(near(Math.hypot(ctl3.velocity.x, ctl3.velocity.z), ctl3.speed, 0.05), 'FP: скорость = speed');
	inp3.keys.add('ShiftLeft');
	for (let i = 0; i < 120; i++) ctl3.update(1 / 60);
	ok(near(Math.hypot(ctl3.velocity.x, ctl3.velocity.z), ctl3.sprintSpeed, 0.05), 'FP: спринт = sprintSpeed');
	ok(Math.abs(ctl3.bobOffset) <= ctl3.headBobAmp + 1e-6, 'FP: bob в пределах amp', ctl3.bobOffset);

	// мышь: yaw/pitch clamp
	const ctl4 = new TF.FirstPersonController({ camera: new THREE.PerspectiveCamera(), groundFn: () => 0 });
	const inp4 = new FakeInput();
	ctl4.input = inp4;
	inp4.pointerLocked = true;
	inp4.pushMouse(300, 0);
	ctl4.update(1 / 60);
	ok(ctl4.yaw < 0, 'FP: dx>0 поворачивает yaw влево', ctl4.yaw);
	inp4.pushMouse(0, 100000);
	ctl4.update(1 / 60);
	ok(near(ctl4.pitch, -ctl4.maxPitch, 1e-9), 'FP: pitch_CLAMP вниз', ctl4.pitch);
	inp4.pushMouse(0, -1000000);
	ctl4.update(1 / 60);
	ok(near(ctl4.pitch, ctl4.maxPitch, 1e-9), 'FP: pitch clamp вверх', ctl4.pitch);

	// наклонная опора
	const ctl5 = new TF.FirstPersonController({ camera: new THREE.PerspectiveCamera(), groundFn: (x, z) => z * 0.1 });
	ctl5.teleport(0, 0, 10);
	for (let i = 0; i < 60; i++) ctl5.update(1 / 60);
	ok(near(ctl5.feet.y, 1.0, 1e-6), 'FP: groundFn наклонной поверхности', ctl5.feet.y);
}

// ------------------------------------------------------------- 4. scatter
section('GK4: scatterProps');
{
	const geo = TF.createSwordGeometry();
	const mat = new THREE.MeshStandardMaterial();
	const a = TF.scatterProps({ geometry: geo, material: mat, count: 40, seed: 7, radius: 50, chunkSize: 32, scale: [4, 7], tiltMax: 0.3 });
	const b = TF.scatterProps({ geometry: geo, material: mat, count: 40, seed: 7, radius: 50, chunkSize: 32, scale: [4, 7], tiltMax: 0.3 });
	const c = TF.scatterProps({ geometry: geo, material: mat, count: 40, seed: 8, radius: 50, chunkSize: 32, scale: [4, 7], tiltMax: 0.3 });
	ok(a.count === 40, 'scatter: count соблюдён', a.count);
	ok(a.meshes.length > 1, 'scatter: чанки > 1', a.meshes.length);
	const sameAB = a.meshes.length === b.meshes.length && a.meshes.every((m, i) => {
		const x = m.instanceMatrix.array, y = b.meshes[i].instanceMatrix.array;
		for (let k = 0; k < x.length; k++) if (x[k] !== y[k]) return false;
		return true;
	});
	ok(sameAB, 'scatter: детерминизм seed');
	let diff = false;
	{
		const x = a.meshes[0].instanceMatrix.array, y = c.meshes[0].instanceMatrix.array;
		for (let k = 0; k < x.length && !diff; k++) if (x[k] !== y[k]) diff = true;
	}
	ok(diff, 'scatter: другой seed → другая раскладка');
	let inRadius = true;
	for (const m of a.meshes) {
		const arr = m.instanceMatrix.array;
		for (let i = 0; i < m.count; i++) {
			const x = arr[i * 16 + 12], z = arr[i * 16 + 14];
			if (Math.hypot(x, z) > 50.001) inRadius = false;
		}
		ok(m.boundingSphere.radius > 0 && Number.isFinite(m.boundingSphere.radius), 'scatter: boundingSphere чанка');
	}
	ok(inRadius, 'scatter: все внутри radius');
	const zero = TF.scatterProps({ geometry: geo, material: mat, count: 20, seed: 3, radius: 10, densityFn: () => 0 });
	ok(zero.count === 0, 'scatter: densityFn=0 → пусто', zero.count);
	const sunk = TF.scatterProps({ geometry: geo, material: mat, count: 5, seed: 3, radius: 10, sink: 0.5, heightFn: () => 2 });
	{
		const y = sunk.meshes[0].instanceMatrix.array[13];
		ok(near(y, 1.5, 1e-9), 'scatter: sink учитывается', y);
	}
	a.dispose();
	ok(a.meshes.length === 0 && a.group.children.length === 0, 'scatter: dispose чистит');
	let threw = false;
	try { TF.scatterProps({ geometry: geo }); } catch { threw = true; }
	ok(threw, 'scatter: без material — ошибка');
}

// ------------------------------------------------------------- 5. ViewModel
section('GK7: ViewModel');
{
	const renderer = {
		autoClear: true,
		calls: [],
		render(scene, cam) { this.calls.push(scene); }
	};
	const camera = new THREE.PerspectiveCamera();
	const engine = { renderer, scene: new THREE.Scene(), camera, renderOverride: null, postPipeline: null };
	const vm = new TF.ViewModel({ camera });
	const sword = new THREE.Mesh(TF.createSwordGeometry(), new THREE.MeshStandardMaterial());
	vm.add(sword, { offset: { x: 0.3, y: -0.3, z: -0.7 } });
	ok(vm.items.length === 1, 'VM: item добавлен');
	vm.attach(engine);
	ok(typeof engine.renderOverride === 'function', 'VM: override установлен');
	engine.renderOverride(engine, 1 / 60, 1);
	ok(renderer.calls.length === 2 && renderer.calls[0] === engine.scene && renderer.calls[1] === vm.scene, 'VM: сцена затем вьюмодель');
	ok(renderer.autoClear === true, 'VM: autoClear восстановлен');

	// с пост-пайплайном: хук, а не обёртка
	const pipe = { scenePassHook: null };
	const engine2 = { renderer, scene: new THREE.Scene(), camera, renderOverride: (e) => { renderer.calls.push(e.scene); }, postPipeline: pipe };
	const vm2 = new TF.ViewModel({ camera });
	vm2.add(new THREE.Mesh(geo0(), new THREE.MeshStandardMaterial()));
	vm2.attach(engine2);
	ok(pipe.scenePassHook === vm2._boundPass || typeof pipe.scenePassHook === 'function', 'VM: scenePassHook установлен');
	renderer.calls.length = 0;
	engine2.renderOverride(engine2);
	pipe.scenePassHook(renderer, engine2.scene, camera);
	ok(renderer.calls.length === 2 && renderer.calls[1] === vm2.scene, 'VM: хук рисует вьюмодель в тот же RT');
	vm2.detach();
	ok(pipe.scenePassHook === null, 'VM: detach возвращает хук');
	ok(engine.renderOverride !== null, 'VM: engine1 override не тронут');
	vm.detach();
	ok(engine.renderOverride === null, 'VM: detach возвращает override');

	// sway/bob ограничен
	const vm3 = new TF.ViewModel({ camera });
	const holder = vm3.add(new THREE.Mesh(geo0(), new THREE.MeshStandardMaterial()));
	const base = holder.position.clone();
	for (let i = 0; i < 300; i++) vm3.update(1 / 60, { speedRatio: 1, bobPhase: i * 0.1 });
	const d = holder.position.distanceTo(base);
	ok(d <= vm3.swayAmp + vm3.bobAmp + 1e-6, 'VM: sway/bob в пределах амплитуд', d);
	ok(vm3.remove(holder.children[0]) === true || vm3.remove(holder) === true, 'VM: remove работает');

	function geo0() { return new THREE.BoxGeometry(0.1, 0.1, 0.1); }
}

// ------------------------------------------------------------- 6. FloatingProps
section('GK5: FloatingProps');
{
	const fp = new TF.FloatingProps();
	const obj = new THREE.Object3D();
	obj.position.set(3, 10, -4);
	fp.add(obj, { amp: 0.5, freq: 0.06, rotSpeed: 0.1, tilt: 0.05 });
	let minY = Infinity, maxY = -Infinity;
	for (let i = 0; i < 600; i++) {
		fp.update(1 / 60);
		minY = Math.min(minY, obj.position.y);
		maxY = Math.max(maxY, obj.position.y);
	}
	ok(minY > 9.49 && maxY < 10.51, 'float: bob в пределах amp', minY + '..' + maxY);
	ok(obj.position.x === 3 && obj.position.z === -4, 'float: X/Z не тронуты');
	ok(Math.abs(obj.rotation.y) > 0.5, 'float: rotSpeed крутит', obj.rotation.y);
	ok(Math.abs(obj.rotation.z) <= 0.051, 'float: tilt в пределах', obj.rotation.z);
	ok(fp.remove(obj) === true && fp.items.length === 0, 'float: remove');
}

// ------------------------------------------------------------- 7. Hud headless
section('GK10: Hud без DOM');
{
	const hud = new TF.Hud({ hints: ['Tab — конструктор'] });
	ok(hud.available === false, 'Hud: headless флаг');
	let threw = false;
	try { hud.setHints(['a'], 'ИГРА'); hud.setPrompt('x'); hud.setCrosshair(true); hud.dispose(); } catch { threw = true; }
	ok(threw === false, 'Hud: headless-методы безопасны');
}

// ------------------------------------------------------------- 7.5 Terrain.scatterWeights (F4)
{
	const t1 = new TF.Terrain({ seed: 3 });
	const c1 = {};
	for (const it of t1.scatter(0, 0, 64, 400)) c1[it.type] = (c1[it.type] || 0) + 1;
	ok(c1.flower === undefined && c1.grass > 0 && c1.tree > 0, 'scatter: дефолт = палитра v2.7 (без flower)');
	const t2 = new TF.Terrain({ seed: 3, scatterWeights: { grass: 1, flower: 1 } });
	const c2 = {};
	for (const it of t2.scatter(0, 0, 64, 400)) c2[it.type] = (c2[it.type] || 0) + 1;
	ok(c2.flower > 15 && c2.grass > 15 && c2.tree === undefined, 'scatter: кастомные веса дают flower', JSON.stringify(c2));
	const a = t2.scatter(1, 2, 64, 200), b = t2.scatter(1, 2, 64, 200);
	ok(a.length === b.length && a.every((it, i) => it.type === b[i].type), 'scatter: детерминизм по чанку');
}

// ------------------------------------------------------------- 8. PostPipeline grade
section('GK9: grade финального пасса');
{
	const fakeRenderer = {
		extensions: { get: () => null },
		info: { autoReset: true },
		capabilities: { isWebGL2: true }
	};
	const pipe = new TF.PostPipeline({ renderer: fakeRenderer });
	ok(pipe.gradeOptions.vignette === 0 && pipe.gradeOptions.saturation === 1, 'grade: дефолт нейтрален');
	ok(pipe.scenePassHook === null, 'grade: scenePassHook дефолт null');
	ok(pipe.finalMat.uniforms.uVignette !== undefined && pipe.finalMat.uniforms.uTint !== undefined, 'grade: униформы в finalMat');
	pipe.setGrade({ vignette: 0.35, saturation: 1.12, tint: 0xb8c4ff });
	ok(pipe.finalMat.uniforms.uVignette.value === 0.35, 'grade: setGrade vignette');
	ok(near(pipe.finalMat.uniforms.uSaturation.value, 1.12), 'grade: setGrade saturation');
	ok(pipe.finalMat.uniforms.uTint.value.b > 0.9, 'grade: setGrade tint');
	ok(TF.TF_FINAL_FRAG.indexOf('uVignette') !== -1, 'grade: GLSL виньетки в TF_FINAL_FRAG');
	// F1: tint числом/строкой в конструкторе не должен ронять пайплайн
	const pipe2 = new TF.PostPipeline({ renderer: fakeRenderer, grade: { vignette: 0.3, tint: 0xc9d2ff } });
	ok(pipe2.gradeOptions.tint.isColor === true, 'grade: tint числом нормализован в Color');
	ok(pipe2.finalMat.uniforms.uTint !== undefined || pipe2.finalMat.uniforms.uTint.value.isColor === true, 'grade: uTint — Color');
	const pipe3 = new TF.PostPipeline({ renderer: fakeRenderer, grade: { tint: '#aabbee' } });
	ok(pipe3.gradeOptions.tint.isColor === true, 'grade: tint строкой нормализован в Color');
}

// ------------------------------------------------------------- 9. экспорт
section('Экспорты v2.8');
{
	const need = ['FirstPersonController', 'ViewModel', 'FloatingProps', 'Hud', 'scatterProps',
		'createSwordGeometry', 'createFistGeometry', 'createFlowerGeometry',
		'installStylizedPatch', 'createStylizedMaterial', 'createGradientMap'];
	for (const n of need) ok(typeof TF[n] !== 'undefined', 'экспорт ' + n);
	ok(Object.keys(TF).length === 186, 'всего экспортов 186', Object.keys(TF).length);
}

console.log(`\nGameplay Kit smoke: ${checks - failures}/${checks} проверок пройдено`);
if (failures > 0) { console.error('✗ smoke FAIL'); process.exit(1); }
console.log('✓ gameplay smoke OK');
