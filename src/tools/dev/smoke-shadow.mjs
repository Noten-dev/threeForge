/**
 * Smoke-тесты теневого оверхола ThreeForge (логика, без WebGL).
 * Запуск: npm run smoke   (node tools/dev/smoke-shadow.mjs)
 */
import * as THREE from 'three';
import { SunLightShadow as RefSunLightShadow } from 'three/addons/lights/SunLightShadow.js';

const TF = await import('../../src/threeforge-v2_6_0.js');

let failures = 0;
let checks = 0;
function ok(cond, label, extra) {
	checks++;
	if (cond !== true) {
		failures++;
		console.error('✗ ' + label + (extra !== undefined ? ' — ' + extra : ''));
	}
}
function near(a, b, eps = 1e-9) { return Math.abs(a - b) <= eps; }
function section(name) { console.log('— ' + name); }

function makeViewCamera(pos, target) {
	const cam = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 500);
	cam.position.copy(pos);
	cam.lookAt(target);
	cam.updateMatrixWorld(true);
	cam.updateProjectionMatrix();
	return cam;
}

// ---------------------------------------------------------------- 1. CSM
section('SunLightShadow: эквивалентность дефолтов эталону three (N=2, λ=0.5, fade=0.1)');
{
	const light = new TF.SunLight(0xffffff, 3);
	light.position.set(0.4, 0.8, 0.3).multiplyScalar(1000);
	light.updateMatrixWorld(true);
	const ref = new RefSunLightShadow();
	const mine = new TF.SunLightShadow();
	for (const sh of [ref, mine]) {
		sh.mapSize.set(1024, 1024);
		sh.radius = 1.6;
		sh.bias = -0.0004;
		sh.normalBias = 0.03;
		sh.camera.near = 0.5;
		sh.camera.far = 260;
	}
	const cam = makeViewCamera(new THREE.Vector3(10, 5, 20), new THREE.Vector3(0, 0, 0));
	ref.updateMatrices(light, cam);
	mine.updateMatrices(light, cam);
	ok(mine.getViewportCount() === 2, 'viewportCount=2');
	ok(mine._frameExtents.equals(ref._frameExtents), 'frameExtents равны', mine._frameExtents.toArray() + ' vs ' + ref._frameExtents.toArray());
	for (let i = 0; i < 2; i++) {
		ok(mine._cascadeData[i].equals(ref._cascadeData[i]), `cascadeData[${i}] равны`,
			mine._cascadeData[i].toArray() + ' vs ' + ref._cascadeData[i].toArray());
		ok(mine._viewports[i].equals(ref._viewports[i]), `viewport[${i}] равен`);
		const a = mine.getMatrix(i).elements, b = ref.getMatrix(i).elements;
		let same = true;
		for (let k = 0; k < 16; k++) if (!near(a[k], b[k], 1e-12)) same = false;
		ok(same, `matrix[${i}] равна`);
		const ca = mine.getCamera(i), cb = ref.getCamera(i);
		ok(near(ca.left, cb.left, 1e-9) && near(ca.far, cb.far, 1e-9) && ca.position.distanceTo(cb.position) < 1e-9,
			`camera[${i}] равна`);
	}
	mine.dispose();
}

section('SunLightShadow: splitLambda / cascadeFade / cascadeTiles');
{
	const light = new TF.SunLight();
	light.position.set(0, 1, 0);
	light.updateMatrixWorld(true);
	const cam = makeViewCamera(new THREE.Vector3(0, 2, 10), new THREE.Vector3(0, 0, 0));
	const sh = new TF.SunLightShadow({ cascades: 2 });
	sh.camera.near = 0.5; sh.camera.far = 200;

	sh.setSplitLambda(1).updateMatrices(light, cam);
	const uniformSplit = sh._cascadeData[0].y;   // конец каскада 0 = splits[1]
	sh.setSplitLambda(0).updateMatrices(light, cam);
	const logSplit = sh._cascadeData[0].y;
	sh.setSplitLambda(0.5).updateMatrices(light, cam);
	const midSplit = sh._cascadeData[0].y;
	ok(uniformSplit > logSplit, 'λ=1 (uniform) дальше λ=0 (log)', `${uniformSplit} vs ${logSplit}`);
	ok(near(midSplit, (uniformSplit + logSplit) / 2, 1e-9), 'λ=0.5 = среднее (прежнее поведение)');

	sh.setCascadeFade(0.3).updateMatrices(light, cam);
	const c0 = sh._cascadeData[0];
	ok(near(c0.z, c0.y - 0.3 * (c0.y - 0.1), 1e-6), 'cascadeFade=0.3: fadeStart = far − 0.3·(far−near)',
		`${c0.z} vs ${c0.y - 0.3 * (c0.y - 0.1)}`);

	sh.setCascadeTiles([2, 1]);
	ok(sh._frameExtents.x === 3 && sh._frameExtents.y === 1, 'frameExtents [2,1] → 3×1');
	sh.updateMatrices(light, cam);
	ok(near(sh._viewports[0].z, 2, 0.01) && near(sh._viewports[1].x, 2, 0.01), 'тайлы: каскад0 шириной 2, каскад1 с x=2');
	// разрешение каскада 0 вдвое выше → его тексель вдвое мельче (снап точнее)
	ok(sh._cameras[0].right > 0 && isFinite(sh._cameras[0].right), 'камера каскада 0 валидна');
	sh.dispose();
}

section('setSunCascadeCount: чанк, реестры, рекомпиляция');
{
	const sh = new TF.SunLightShadow();
	ok(TF.getSunCascadeCount() === 2, 'дефолт 2 каскада');
	const origChunk = THREE.ShaderChunk.shadowmap_pars_fragment;
	TF.setSunCascadeCount(4);
	ok(TF.getSunCascadeCount() === 4, 'глобально 4');
	ok(sh.getCascadeCount() === 4, 'живая тень переконфигурирована (реестр)');
	ok(sh._frameExtents.x === 4, 'атлас 4×1');
	ok(THREE.ShaderChunk.shadowmap_pars_fragment.indexOf('#define SUN_LIGHT_CASCADES 4') !== -1,
		'чанк shadowmap_pars_fragment переопределён');
	const mat = new THREE.MeshStandardMaterial();
	TF.installSunShadowPatch(mat);
	const ver0 = mat.version;
	TF.setSunCascadeCount(3);
	ok(mat.version > ver0, 'пропатченный материал помечен на рекомпиляцию (version++)');
	ok(sh.getCascadeCount() === 3, 'тень → 3 каскада');
	ok(mat.customProgramCacheKey().indexOf('sunshadow:c3') !== -1, 'cache key содержит число каскадов');
	TF.setSunCascadeCount(2);
	ok(THREE.ShaderChunk.shadowmap_pars_fragment === origChunk, 'возврат к 2 — чанк восстановлен');
	const cloned = TF.cloneMaterialPatched(mat);
	ok(cloned.__tfSunShadowPatched === true, 'cloneMaterialPatched переносит патч теней');
	sh.dispose();
}

// ------------------------------------------------------- 2. Качество/GLSL
section('setShadowQuality: генерация GLSL, cache key, униформы');
{
	const key0 = (() => { const m = new THREE.MeshStandardMaterial(); TF.installSunShadowPatch(m); return m.customProgramCacheKey(); })();
	TF.setShadowQuality({ taps: 24, soft: { mix: 0.7, depthGrowth: 0.3, radius: 2.5 } });
	const q = TF.getShadowQuality();
	ok(q.taps === 24 && q.soft === true, 'состояние quality обновлено');
	const vogelCount = (s) => (s.match(/vogelDiskSample\( \d+/g) || []).length;
	ok(vogelCount(TF.TF_SUN_SHADOW_FN) === 48, 'GLSL: 24 тапа × 2 кольца', vogelCount(TF.TF_SUN_SHADOW_FN));
	ok(near(TF.TF_SHADOW_UNIFORMS.tfShadowSoft.value.x, 0.7) && near(TF.TF_SHADOW_UNIFORMS.tfShadowSoft.value.z, 2.5), 'униформа tfShadowSoft');
	const m2 = new THREE.MeshStandardMaterial();
	TF.installSunShadowPatch(m2);
	const key1 = m2.customProgramCacheKey();
	ok(key1 !== key0, 'cache key изменился после setShadowQuality');
	ok(key1.indexOf(':t24:s:f') !== -1, 'cache key кодирует taps/soft/fade', key1);
	TF.setShadowQuality({ taps: 12, soft: false, fadeAllLights: true });
	ok(vogelCount(TF.TF_SUN_SHADOW_FN) === 12, 'возврат: 12 тапов, одно кольцо');
	ok(TF.TF_SUN_SHADOW_FN.indexOf('tfFadeShadow') !== -1, 'helper фейда присутствует');
	TF.setShadowQuality({ fadeAllLights: false });
	ok(TF.getShadowQuality().fadeAllLights === false, 'fadeAllLights выключается');
	TF.setShadowQuality({ fadeAllLights: true });
}

// ------------------------------------------------------------ 3. SunCycle
section('SunCycle: плавные тени (фикс «застывшей ночи»), луна');
{
	const sun = new TF.SunLight();
	sun.castShadow = true;
	const moon = new TF.DirectionalLight(0xbcd0ff, 0);
	moon.castShadow = true;
	moon.shadow.autoUpdate = false;
	const cycle = new TF.SunCycle({ sun, moon, autoAdvance: false, hoursPerSecond: 0 });
	cycle.setTime(12);
	ok(sun.shadow.intensity > 0.99 && sun.shadow.autoUpdate === true, 'полдень: тени солнца на полную');
	cycle.setTime(0);
	ok(sun.shadow.intensity === 0, 'полночь: shadow.intensity = 0 (застывшая карта НЕ сэмплируется)');
	ok(sun.shadow.autoUpdate === false, 'полночь: shadow-проход солнца выключен');
	ok(moon.shadow.autoUpdate === true, 'полночь: тени луны обновляются');
	ok(cycle.shadowFactor === 0 && cycle.moonShadowFactor > 0.99, 'shadowFactor / moonShadowFactor');
	cycle.setTime(6);
	ok(sun.shadow.intensity > 0 && sun.shadow.intensity < 1, 'рассвет: промежуточная интенсивность (без щелчка)');
	cycle.setTime(12);
}

section('createLightRig: moonShadow + bindShadowCamera');
{
	const scene = new THREE.Scene();
	const cam = makeViewCamera(new THREE.Vector3(0, 3, 12), new THREE.Vector3(0, 1, 0));
	const rig = TF.createLightRig({
		scene, autoAdvance: false, moonShadow: { mapSize: 512, range: 40 }
	});
	ok(rig.moon.castShadow === true, 'луна кастует тени');
	ok(rig.moon.shadow.mapSize.x === 512, 'карта луны 512');
	ok(rig.moon.shadow.autoUpdate === false, 'днём тени луны не рендерятся');
	rig.bindShadowCamera(cam);
	rig.setTime(0);
	rig.update(1 / 60);
	ok(rig.moon.shadow.autoUpdate === true, 'ночью тени луны включены');
	// followCamera делает тексельный снап позиции света (анти-мерцание) и
	// пересчитывает target от snapped-позиции → допуск ~тексель (range*2/mapSize)
	ok(rig.moon.target.position.distanceTo(cam.position) < 0.2, 'target луны ≈ камера (снап)', rig.moon.target.position.distanceTo(cam.position));
	const dist = rig.moon.position.distanceTo(cam.position);
	ok(dist > 10 && dist < 1000, 'луна перебазирована к камере (dist=' + dist.toFixed(1) + ')');
	const dirToMoon = new THREE.Vector3().subVectors(rig.moon.position, rig.moon.target.position).normalize();
	ok(dirToMoon.dot(rig.cycle.moonDirection) > 0.999, 'направление луны сохранено');
	rig.setTime(12);
	rig.update(1 / 60);
	ok(rig.moon.shadow.autoUpdate === false, 'днём снова выключены');
	rig.dispose();
	scene.clear();
}

// -------------------------------------------------------- 4. LightManager
section('LightManager: shadowRate / shadowBudget');
{
	const scene = new THREE.Scene();
	const cam = makeViewCamera(new THREE.Vector3(0, 2, 8), new THREE.Vector3(0, 0, 0));
	const mkLight = (x) => {
		const l = new TF.PointLight(0xffaa55, 8, 20, 2);
		l.position.set(x, 2, 0);
		l.castShadow = true;
		return l;
	};

	// (a) дефолт: каждый кадр
	{
		const lm = new TF.LightManager({ scene, camera: cam, maxPointLights: 2, pointShadowSlots: 2 });
		lm.add(mkLight(0), { shadow: true });
		lm.add(mkLight(2), { shadow: true });
		lm.update(1 / 60, cam);
		ok(lm.stats.shadowUpdates === 2, 'дефолт: оба слота обновляются', lm.stats.shadowUpdates);
		// симуляция: рендерер создал карты
		for (const s of lm._pointSlots) if (s.light.shadow.map === null) s.light.shadow.map = { dispose() {} };
		lm.update(1 / 60, cam);
		ok(lm.stats.shadowUpdates === 2, 'дефолт: каждый кадр (без rate)');
		lm.dispose();
	}

	// (b) rate 10 Гц
	{
		const lm = new TF.LightManager({ scene, camera: cam, maxPointLights: 1, pointShadowSlots: 1, shadowRate: 10 });
		const e = lm.add(mkLight(0), { shadow: true });
		lm.update(1 / 60, cam);
		ok(lm.stats.shadowUpdates === 1, 'rate: первый кадр (map==null) — всегда грант');
		lm._pointSlots[0].light.shadow.map = { dispose() {} };
		let grants = 0;
		for (let i = 0; i < 30; i++) { lm.update(1 / 60, cam); grants += lm.stats.shadowUpdates; }
		// 0.5 c при 10 Гц → ~5 грантов (±1)
		ok(grants >= 4 && grants <= 6, 'rate 10 Гц: ~5 грантов за 0.5 с, получено ' + grants);
		ok(e.shadowRate === 10, 'entry.shadowRate из defaultShadowRate');
		lm.dispose();
	}

	// (c) budget 1 на три источника — round robin
	{
		const lm = new TF.LightManager({ scene, camera: cam, maxPointLights: 3, pointShadowSlots: 3, shadowBudget: 1 });
		lm.add(mkLight(0), { shadow: true });
		lm.add(mkLight(1), { shadow: true });
		lm.add(mkLight(2), { shadow: true });
		lm.update(1 / 60, cam);
		ok(lm.stats.shadowUpdates === 1, 'budget=1: один грант на кадр', lm.stats.shadowUpdates);
		for (const s of lm._pointSlots) if (s.light.shadow.map === null) s.light.shadow.map = { dispose() {} };
		const who = [];
		for (let i = 0; i < 6; i++) {
			lm.update(1 / 60, cam);
			for (const s of lm._pointSlots) if (s.light.shadow.needsUpdate) who.push(s.light.position.x);
		}
		ok(who.length === 6, '6 кадров → 6 грантов');
		ok(new Set(who).size === 3, 'round-robin покрывает все три источника', JSON.stringify(who));
		lm.dispose();
	}
	scene.clear();
}

// ------------------------------------------------------------- 5. Пресеты
section('applyShadowQuality + SunShadowHelper');
{
	const scene = new THREE.Scene();
	const cam = makeViewCamera(new THREE.Vector3(0, 3, 10), new THREE.Vector3(0, 0, 0));
	const rig = TF.createLightRig({ scene, autoAdvance: false, moonShadow: true });
	const lights = new TF.LightManager({ scene, camera: cam });
	const p = TF.applyShadowQuality('ultra', { rig, lights });
	ok(p !== null && p.cascades === 4, 'ultra: 4 каскада');
	ok(TF.getSunCascadeCount() === 4, 'глобально 4 каскада');
	ok(rig.sun.shadow.getCascadeCount() === 4, 'солнце рига переконфигурировано');
	ok(rig.sun.shadow.mapSize.x === 1536, 'sun mapSize 1536');
	ok(rig.sun.shadow._frameExtents.x === 5, 'tiles [2,1,1,1] → атлас 5×');
	ok(rig.sun.shadow.splitLambda === 0.6, 'splitLambda 0.6');
	ok(TF.getShadowQuality().taps === 16 && TF.getShadowQuality().soft === true, 'taps=16, soft вкл');
	TF.applyShadowQuality('high', { rig, lights });
	ok(TF.getSunCascadeCount() === 2 && TF.getShadowQuality().taps === 12 && TF.getShadowQuality().soft === false,
		'возврат к high = прежнему дефолту');

	const helper = new TF.SunShadowHelper(rig.sun);
	scene.add(helper);
	helper.update(cam);
	ok(helper._geometry.drawRange.count === 2 * 24 + 2, 'helper: 2 каскада + направление', helper._geometry.drawRange.count);
	let finite = true;
	for (let i = 0; i < helper._geometry.drawRange.count * 3; i++) {
		if (!isFinite(helper._positions[i])) finite = false;
	}
	ok(finite, 'helper: координаты конечны');
	TF.setSunCascadeCount(4);
	rig.sun.shadow.setCascadeTiles([2, 1, 1, 1]);
	helper.update(cam);
	ok(helper._geometry.drawRange.count === 4 * 24 + 2, 'helper: 4 каскада');
	helper.dispose();
	TF.setSunCascadeCount(2);
	rig.dispose();
	lights.dispose();
	scene.clear();
}

// ---------------------------------------------------------------- итог
console.log(`\nSmoke: ${checks - failures}/${checks} проверок пройдено`);
if (failures > 0) { console.error('✗ ЕСТЬ ПАДЕНИЯ'); process.exit(1); }
console.log('✓ smoke OK');
