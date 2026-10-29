/**
 * ThreeForge Engine v2.6.0 + v2.7 Shadow Overhaul + v2.8 Gameplay Kit — единый ESM-модуль для three.js r186
 * (без внешних зависимостей).
 *
 * v2.7 (SH1..SH9): конфигурируемые каскады CSM 1–4 (setSunCascadeCount, splitLambda,
 * cascadeTiles), генерируемый PCF (setShadowQuality: тапы/soft/фейд всех источников),
 * плавные ночные тени и тени луны (SunCycle/createLightRig), бюджет обновлений
 * LightManager (shadowBudget/shadowRate), пресеты (applyShadowQuality), SunShadowHelper.
 * Дефолты = поведение v2.6. Имена файлов/прежних экспортов не менялись.
 *
 * v2.8 (GK1..GK10): Gameplay Kit — FirstPersonController, ViewModel (+хук
 * PostPipeline.scenePassHook), scatterProps, FloatingProps, Hud, stylized-материалы
 * (createStylizedMaterial/installStylizedPatch/createGradientMap), процедурные
 * createSwordGeometry/createFistGeometry/createFlowerGeometry, тип детали 'flower',
 * grade финального пасса (vignette/saturation/tint). Дефолты нейтральны (186 экспортов).
 *
 * Документация:
 *   API.md       — справочник (186 экспортов: 40 классов, 49 функций, GLSL-чанки, пресеты);
 *   QUICKSTART.md — подключение и рабочие примеры интеграции (8.5 — тени, 8.6 — Gameplay Kit);
 *   CHANGELOG.md — история исправлений (метки T/F/R/S/L/N/M/SH/GK).
 *
 * Все системы опциональны. Игровой цикл — Engine (fixed timestep); системы
 * подключаются через engine.addSystem({ fixedUpdate?(h), update?(dt, alpha) }, priority).
 * Крупные сборки «одним вызовом»: createTerrainSystem, createSkySystem, createLightRig.
 * Постобработка: PostPipeline.attach(engine) (устанавливает engine.renderOverride).
 */
import * as THREE from 'three';

const {
	Vector2, Vector3, Color, Matrix4, Quaternion, Sphere, Box3, Ray,
	Timer,
	EventDispatcher, InstancedMesh, BufferGeometry, BufferAttribute,
	Vector4, Light, LightShadow, Object3D, OrthographicCamera, Frustum, Group,
	WebGPUCoordinateSystem,
	PerspectiveCamera, HemisphereLight, MeshStandardMaterial, RepeatWrapping,
	DirectionalLight: ThreeDirectionalLight, SpotLight: ThreeSpotLight,
	ShaderChunk,
	Mesh, ShaderMaterial, DataTexture, InstancedBufferAttribute,
	AdditiveBlending, NormalBlending, DoubleSide,
	LinearFilter, LinearMipmapLinearFilter, ClampToEdgeWrapping,
	RGBAFormat, UnsignedByteType, SRGBColorSpace
} = THREE;

const DYNAMIC_DRAW = THREE.DynamicDrawUsage;

const _tfNow = () => (typeof performance !== 'undefined' && performance.now !== undefined
	? performance.now() : Date.now());

const Engine = class extends EventDispatcher {
	constructor(options = {}) {
		super();
		this.renderer = options.renderer || null;
		this.scene = options.scene || null;
		this.camera = options.camera || null;
		this.fixedTimeStep = options.fixedTimeStep !== undefined ? options.fixedTimeStep : 1 / 60;
		this.maxSubSteps = options.maxSubSteps !== undefined ? options.maxSubSteps : 5;
		this.maxFrameDelta = options.maxFrameDelta !== undefined ? options.maxFrameDelta : 0.25;
		this.interpolation = options.interpolation !== undefined ? options.interpolation : true;
		this.timeScale = 1;
		this.running = false;
		this.paused = false;
		this.simTime = 0;
		this.elapsed = 0;
		this.frames = 0;
		this.systems = [];
		this.stats = { fps: 0, frameTime: 0, simSteps: 0, fpsAccum: 0, fpsFrames: 0, renderMs: 0 };
		this.renderOverride = options.renderOverride || null;
		this.profile = options.profile === true;
		this._profile = new Map();
		this._timer = new Timer();
		if (typeof document !== 'undefined') this._timer.connect(document);
		this._accumulator = 0;
		this._rafId = 0;
		this._boundTick = this._tick.bind(this);
	}

	addSystem(system, priority = 0) {
		const next = this.systems.slice();
		next.push({ system, priority });
		next.sort((a, b) => a.priority - b.priority);
		this.systems = next;
		return this;
	}

	removeSystem(system) {
		const i = this.systems.findIndex(entry => entry.system === system);
		if (i !== -1) { const next = this.systems.slice(); next.splice(i, 1); this.systems = next; }
		return this;
	}

	start() {
		if (this.running) return this;
		if (this.renderer === null && typeof requestAnimationFrame !== 'function') {
			console.warn('ThreeForge: Engine.start() — нет ни renderer, ни requestAnimationFrame; ' +
				'цикл не запущен. Дёргайте engine.frame(dt)/step() вручную (тесты, headless, воркер).');
			return this;
		}
		this.running = true;
		this._timer.update();
		if (this.renderer !== null) this.renderer.setAnimationLoop(this._boundTick);
		else this._rafId = requestAnimationFrame(this._boundTick);
		this.dispatchEvent({ type: 'start' });
		return this;
	}

	stop() {
		if (!this.running) return this;
		this.running = false;
		if (this.renderer !== null) this.renderer.setAnimationLoop(null);
		else cancelAnimationFrame(this._rafId);
		this.dispatchEvent({ type: 'stop' });
		return this;
	}

	pause() {
		this.paused = true;
		this.dispatchEvent({ type: 'pause' });
		return this;
	}

	resume() {
		this.paused = false;
		this._timer.update();
		this.dispatchEvent({ type: 'resume' });
		return this;
	}

	/**
	 * Ручной одиночный шаг (отладка, тесты, покадровая запись).
	 * @param {number} [h] - Шаг физики; по умолчанию fixedTimeStep.
	 * @returns {this}
	 */
	step(h = this.fixedTimeStep) {
		this._simulate(h);
		this._frame(h, 1);
		return this;
	}

	/**
	 * Тело цикла: берёт дельту из `Timer` и передаёт её в `frame()`.
	 *
	 * ИСПРАВЛЕНО (N16): `requestAnimationFrame` и `renderer.setAnimationLoop`
	 * передают в колбэк timestamp кадра, но прежняя сигнатура `_tick()` его
	 * отбрасывала, и дельта считалась от `performance.now()` в момент входа
	 * в колбэк. Расхождение с реальным временем кадра растёт вместе с задержкой
	 * между началом кадра и вызовом колбэка (очередь rAF, тяжелая сборка чанков),
	 * то есть симуляция систематически отставала от настенного времени.
	 * `Timer.update(timestamp)` для этого и предназначен — timestamp'ы rAF
	 * имеют ту же точку отсчёта, что `performance.now()`.
	 *
	 * @param {number} [timestamp] - Время кадра из rAF/setAnimationLoop, мс.
	 */
	_tick(timestamp) {
		if (!this.running) return;
		if (this.renderer === null) this._rafId = requestAnimationFrame(this._boundTick);
		this._timer.update(timestamp);
		this.frame(this._timer.getDelta());
	}

	/**
	 * Один кадр с ЯВНОЙ дельтой времени.
	 *
	 * ДОБАВЛЕНО (N17): раньше кадр можно было получить только из `_tick()`,
	 * который берёт dt из настенного таймера. Из-за этого движок было
	 * невозможно прогнать детерминированно — ни в тестах (число шагов физики
	 * зависело от скорости машины: на быстрых тиках аккумулятор не успевал
	 * набрать fixedTimeStep, и симуляция «замирала»), ни в реплеях, ни при
	 * headless-рендере/покадровой записи видео.
	 *
	 * `frame()` повторяет всю логику кадра (clamp, пауза, timeScale, аккумулятор,
	 * alpha, статистика, рендер) и используется самим `_tick()`, поэтому
	 * поведение обычного цикла не меняется.
	 *
	 * @param {number} [dt] - Дельта кадра в секундах. Отрицательная/NaN → 0.
	 * @returns {this}
	 */
	frame(dt) {
		if (!(dt > 0) || !Number.isFinite(dt)) dt = 0;
		if (dt > this.maxFrameDelta) dt = this.maxFrameDelta;
		this.elapsed += dt;

		const t0 = _tfNow();
		if (!this.paused) this._simulate(dt * this.timeScale);
		const alpha = this.interpolation ? this._accumulator / this.fixedTimeStep : 1;
		this._frame(dt, alpha);
		const t1 = _tfNow();

		const s = this.stats;
		s.frameTime += (t1 - t0 - s.frameTime) * 0.1;
		s.fpsAccum += dt;
		s.fpsFrames++;
		if (s.fpsAccum >= 0.5) {
			s.fps = s.fpsFrames / s.fpsAccum;
			s.fpsAccum = 0;
			s.fpsFrames = 0;
		}
		this.frames++;
		return this;
	}

	_simulate(dt) {
		this._accumulator += dt;
		this.stats.simSteps = 0;
		let steps = 0;
		while (this._accumulator >= this.fixedTimeStep && steps < this.maxSubSteps) {
			const h = this.fixedTimeStep;
			this.simTime += h;
			const systems = this.systems;
			for (let i = 0; i < systems.length; i++) {
				const sys = systems[i].system;
				if (sys.fixedUpdate) {
					if (this.profile) this._profRun(sys, i, 'fixed', () => sys.fixedUpdate(h, this));
					else sys.fixedUpdate(h, this);
				}
			}
			this._accumulator -= h;
			steps++;
		}
		if (steps === this.maxSubSteps && this._accumulator > this.fixedTimeStep) {
			this._accumulator = this.fixedTimeStep;
		}
		this.stats.simSteps = steps;
	}

	_frame(dt, alpha) {
		const systems = this.systems;
		for (let i = 0; i < systems.length; i++) {
			const sys = systems[i].system;
			if (sys.update) {
				if (this.profile) this._profRun(sys, i, 'update', () => sys.update(dt, alpha, this));
				else sys.update(dt, alpha, this);
			}
		}
		this.dispatchEvent({ type: 'update', dt, alpha });
		if (this.renderer !== null && this.scene !== null && this.camera !== null) {
			if (this.profile) {
				const t0 = _tfNow();
				if (this.renderOverride !== null) this.renderOverride(this, dt, alpha);
				else this.renderer.render(this.scene, this.camera);
				const d = _tfNow() - t0;
				const s = this.stats;
				s.renderMs += (d - s.renderMs) * 0.1;
			} else if (this.renderOverride !== null) {
				this.renderOverride(this, dt, alpha);
			} else {
				this.renderer.render(this.scene, this.camera);
			}
			this.dispatchEvent({ type: 'postrender', dt, alpha });
		}
	}

	_profRun(sys, index, phase, fn) {
		const name = sys.name || (sys.constructor !== undefined && sys.constructor.name) || ('system#' + index);
		let entry = this._profile.get(name);
		if (entry === undefined) {
			entry = { name, fixed: 0, update: 0, fixedMax: 0, updateMax: 0, fixedCalls: 0, updateCalls: 0 };
			this._profile.set(name, entry);
		}
		const t0 = _tfNow();
		fn();
		const d = _tfNow() - t0;
		entry[phase] += (d - entry[phase]) * 0.1;
		const maxKey = phase + 'Max';
		if (d > entry[maxKey]) entry[maxKey] = d; else entry[maxKey] *= 0.995;
		entry[phase + 'Calls']++;
	}

	getProfile() {
		const out = [];
		for (const entry of this._profile.values()) {
			out.push({
				name: entry.name,
				fixedMs: +entry.fixed.toFixed(3),
				updateMs: +entry.update.toFixed(3),
				totalMs: +(entry.fixed + entry.update).toFixed(3),
				fixedMaxMs: +entry.fixedMax.toFixed(3),
				updateMaxMs: +entry.updateMax.toFixed(3),
				fixedCalls: entry.fixedCalls,
				updateCalls: entry.updateCalls
			});
		}
		out.sort((a, b) => b.totalMs - a.totalMs);
		return out;
	}

	resetProfile() {
		this._profile.clear();
		return this;
	}

	/**
	 * Остановка цикла + освобождение всех ссылок.
	 *
	 * ИСПРАВЛЕНО (N12): прежний dispose() оставлял `renderOverride` (замыкание
	 * на PostPipeline → renderer/сцену/камеру) и накопленный профиль, поэтому
	 * после dispose() весь граф сцены продолжал удерживаться в памяти.
	 */
	dispose() {
		this.stop();
		this.systems = [];
		this._timer.dispose();
		this._profile.clear();
		this.renderOverride = null;
		this.scene = null;
		this.camera = null;
		this.renderer = null;
		this._accumulator = 0;
		this.dispatchEvent({ type: 'dispose' });
	}
};

const _ibMat4 = new Matrix4();
const _ibPos = new Vector3();
const _ibColor = new Color();
const _ibSphere = new Sphere();
const _ibQuatIdentity = new Quaternion();
const _ibUnitScale = new Vector3(1, 1, 1);

const InstancedBatcher = class {
	constructor(options) {
		this.geometry = options.geometry;
		this.material = options.material;
		this.pageSize = options.pageSize !== undefined ? options.pageSize : 16384;
		this.parent = options.parent || null;
		this.useColor = options.useColor === true;
		this.boundsMode = options.bounds || 'grow';
		this.castShadow = options.castShadow === true;
		this.receiveShadow = options.receiveShadow === true;
		this.frustumCulled = options.frustumCulled !== false;
		this.pages = [];
		this.count = 0;
		this._geometryRadius = 0;
		if (this.geometry.boundingSphere === null) this.geometry.computeBoundingSphere();
		if (this.geometry.boundingSphere !== null) this._geometryRadius = this.geometry.boundingSphere.radius;
	}

	_allocatePage() {
		const mesh = new InstancedMesh(this.geometry, this.material, this.pageSize);
		mesh.castShadow = this.castShadow;
		mesh.receiveShadow = this.receiveShadow;
		mesh.frustumCulled = this.frustumCulled && this.boundsMode !== 'none';
		mesh.count = 0;
		mesh.boundingSphere = new Sphere(new Vector3(), -1);
		mesh.instanceMatrix.setUsage(DYNAMIC_DRAW);
		if (this.useColor) {
			mesh.setColorAt(0, _ibColor.setRGB(1, 1, 1));
			mesh.instanceColor.setUsage(DYNAMIC_DRAW);
			mesh.instanceColor.clearUpdateRanges();
			mesh.count = 0;
		}
		const page = {
			mesh,
			used: 0,
			handles: new Array(this.pageSize).fill(null),
			dirtyMin: Infinity,
			dirtyMax: -1,
			colorDirtyMin: Infinity,
			colorDirtyMax: -1
		};
		this.pages.push(page);
		if (this.parent !== null) this.parent.add(mesh);
		return page;
	}

	add(matrix, color = null) {
		let page = null;
		for (let i = 0; i < this.pages.length; i++) {
			if (this.pages[i].used < this.pageSize) { page = this.pages[i]; break; }
		}
		if (page === null) page = this._allocatePage();

		const slot = page.used++;
		const handle = { pool: this, page, slot, alive: true };
		page.handles[slot] = handle;

		page.mesh.setMatrixAt(slot, matrix);
		this._markDirty(page, slot);
		this._growBounds(page, matrix);

		if (this.useColor) {
			if (color !== null) _ibColor.set(color);
			else _ibColor.setRGB(1, 1, 1);
			page.mesh.setColorAt(slot, _ibColor);
			this._markColorDirty(page, slot);
		}
		page.mesh.count = page.used;
		this.count++;
		return handle;
	}

	_validHandle(handle) {
		return handle !== null && handle !== undefined && typeof handle === 'object' &&
			handle.alive !== false && handle.page !== undefined && handle.page !== null &&
			(handle.pool === undefined || handle.pool === this);
	}

	setMatrix(handle, matrix, growBounds = true) {
		if (!this._validHandle(handle)) return this;
		handle.page.mesh.setMatrixAt(handle.slot, matrix);
		this._markDirty(handle.page, handle.slot);
		if (growBounds === true) this._growBounds(handle.page, matrix);
		return this;
	}

	setTransform(handle, position, quaternion = null, scale = null) {
		_ibMat4.compose(
			position,
			quaternion !== null ? quaternion : _ibQuatIdentity.identity(),
			scale !== null ? scale : _ibUnitScale.set(1, 1, 1)
		);
		return this.setMatrix(handle, _ibMat4);
	}

	setColor(handle, color) {
		if (!this._validHandle(handle) || !this.useColor) return this;
		_ibColor.set(color);
		handle.page.mesh.setColorAt(handle.slot, _ibColor);
		this._markColorDirty(handle.page, handle.slot);
		return this;
	}

	getMatrix(handle, out) {
		if (!this._validHandle(handle)) return out.identity();
		handle.page.mesh.getMatrixAt(handle.slot, out);
		return out;
	}

	remove(handle) {
		if (!this._validHandle(handle)) return this;
		const page = handle.page;
		const mesh = page.mesh;
		const slot = handle.slot;
		const last = page.used - 1;

		if (slot !== last) {
			mesh.getMatrixAt(last, _ibMat4);
			mesh.setMatrixAt(slot, _ibMat4);
			this._markDirty(page, slot);
			if (this.useColor && mesh.instanceColor !== null) {
				mesh.getColorAt(last, _ibColor);
				mesh.setColorAt(slot, _ibColor);
				this._markColorDirty(page, slot);
			}
			const moved = page.handles[last];
			page.handles[last] = null;
			if (moved !== null) {
				moved.slot = slot;
				page.handles[slot] = moved;
			} else {
				page.handles[slot] = null;
			}
		} else {
			page.handles[slot] = null;
		}

		page.used = last;
		mesh.count = page.used;
		handle.alive = false;
		this.count--;
		return this;
	}

	_markDirty(page, slot) {
		if (slot < page.dirtyMin) page.dirtyMin = slot;
		if (slot > page.dirtyMax) page.dirtyMax = slot;
	}

	_markColorDirty(page, slot) {
		if (slot < page.colorDirtyMin) page.colorDirtyMin = slot;
		if (slot > page.colorDirtyMax) page.colorDirtyMax = slot;
	}

	_growBounds(page, matrix) {
		if (this.boundsMode !== 'grow') return;
		const e = matrix.elements;
		_ibPos.set(e[12], e[13], e[14]);
		const sx = e[0] * e[0] + e[1] * e[1] + e[2] * e[2];
		const sy = e[4] * e[4] + e[5] * e[5] + e[6] * e[6];
		const sz = e[8] * e[8] + e[9] * e[9] + e[10] * e[10];
		let maxScaleSq = sx;
		if (sy > maxScaleSq) maxScaleSq = sy;
		if (sz > maxScaleSq) maxScaleSq = sz;
		const r = this._geometryRadius * Math.sqrt(maxScaleSq);
		_ibSphere.center.copy(_ibPos);
		_ibSphere.radius = r >= 0 ? r : 0;
		page.mesh.boundingSphere.union(_ibSphere);
	}

	flush() {
		for (let i = 0; i < this.pages.length; i++) {
			const page = this.pages[i];
			const mesh = page.mesh;
			if (page.dirtyMax >= page.dirtyMin) {
				mesh.instanceMatrix.clearUpdateRanges();
				mesh.instanceMatrix.addUpdateRange(page.dirtyMin * 16, (page.dirtyMax - page.dirtyMin + 1) * 16);
				mesh.instanceMatrix.needsUpdate = true;
				page.dirtyMin = Infinity;
				page.dirtyMax = -1;
			}
			if (mesh.instanceColor !== null && page.colorDirtyMax >= page.colorDirtyMin) {
				mesh.instanceColor.clearUpdateRanges();
				mesh.instanceColor.addUpdateRange(page.colorDirtyMin * 3, (page.colorDirtyMax - page.colorDirtyMin + 1) * 3);
				mesh.instanceColor.needsUpdate = true;
				page.colorDirtyMin = Infinity;
				page.colorDirtyMax = -1;
			}
		}
		return this;
	}

	computeBounds() {
		for (let i = 0; i < this.pages.length; i++) {
			const page = this.pages[i];
			page.mesh.boundingSphere.radius = -1;
			for (let s = 0; s < page.used; s++) {
				page.mesh.getMatrixAt(s, _ibMat4);
				this._growBounds(page, _ibMat4);
			}
			if (page.used === 0) {
				page.mesh.boundingSphere.center.set(0, 0, 0);
				page.mesh.boundingSphere.radius = -1;
			}
		}
		return this;
	}

	/**
	 * Мгновенно удалить все инстансы (страницы и GPU-буферы сохраняются).
	 * ДОБАВЛЕНО: смена уровня/сцены раньше требовала remove() по одному хендлу.
	 * @returns {this}
	 */
	clear() {
		for (let i = 0; i < this.pages.length; i++) {
			const page = this.pages[i];
			for (let s = 0; s < page.used; s++) {
				const h = page.handles[s];
				if (h !== null) h.alive = false;
				page.handles[s] = null;
			}
			this.count -= page.used;
			page.used = 0;
			page.mesh.count = 0;
			page.mesh.boundingSphere.center.set(0, 0, 0);
			page.mesh.boundingSphere.radius = -1;
			page.dirtyMin = Infinity;
			page.dirtyMax = -1;
			page.colorDirtyMin = Infinity;
			page.colorDirtyMax = -1;
		}
		this.count = 0;
		return this;
	}

	get capacity() { return this.pages.length * this.pageSize; }
	get pageCount() { return this.pages.length; }

	forEachInstance(callback) {
		for (let p = 0; p < this.pages.length; p++) {
			const page = this.pages[p];
			for (let s = 0; s < page.used; s++) {
				page.mesh.getMatrixAt(s, _ibMat4);
				callback(_ibMat4, p, s);
			}
		}
	}

	dispose() {
		for (let i = 0; i < this.pages.length; i++) {
			const mesh = this.pages[i].mesh;
			if (mesh.parent !== null) mesh.parent.remove(mesh);
			mesh.dispose();
		}
		this.pages.length = 0;
		this.count = 0;
	}
};

const _slLightOrientationMatrix = new Matrix4();
const _slViewToLightMatrix = new Matrix4();
const _slLightDirection = new Vector3();
const _slUp = new Vector3();
const _slCenter = new Vector3();
const _slNearCorners = [new Vector3(), new Vector3(), new Vector3(), new Vector3()];
const _slFarCorners = [new Vector3(), new Vector3(), new Vector3(), new Vector3()];
const _slCascadeCorners = [
	new Vector3(), new Vector3(), new Vector3(), new Vector3(),
	new Vector3(), new Vector3(), new Vector3(), new Vector3()
];

const SUN_CASCADE_COUNT = 2;
const SUN_CASCADE_FADE = 0.1;

// ---------------------------------------------------------------------------
// Глобальное состояние CSM (v2.7 Shadow Overhaul)
//
// Число каскадов — СВОЙСТВО ШЕЙДЕРА (define SUN_LIGHT_CASCADES в чанке three
// shadowmap_pars_fragment задаёт размеры униформ-массивов sunShadowMatrix /
// sunShadowCascade), поэтому оно одно на рендерер. setSunCascadeCount(n):
//   1) переопределяет define в ShaderChunk.shadowmap_pars_fragment — все
//      программы, скомпилированные ПОСЛЕ вызова, получают массивы нужного
//      размера (включая нативный getSunShadow и shadowmask);
//   2) переконфигурирует все живые SunLightShadow (реестр);
//   3) помечает материалы с TF-патчем теней на рекомпиляцию (реестр WeakRef).
// Программы, скомпилированные ДО вызова, нужно пересобрать (needsUpdate) —
// поэтому меняйте число каскадов на старте, до первого рендера.
// ---------------------------------------------------------------------------
const TF_SHADOWMAP_PARS_SRC = ShaderChunk.shadowmap_pars_fragment;
let _tfSunCascades = SUN_CASCADE_COUNT;
const _tfSunShadows = [];
const _tfShadowMaterials = [];

function getSunCascadeCount() { return _tfSunCascades; }

function setSunCascadeCount(n) {
	n = Math.round(Number(n));
	if (!isFinite(n)) n = SUN_CASCADE_COUNT;
	n = Math.max(1, Math.min(4, n));
	if (n === _tfSunCascades) return n;
	_tfSunCascades = n;
	_tfOverrideCascadeDefine(n);
	for (let i = _tfSunShadows.length - 1; i >= 0; i--) {
		_tfSunShadows[i].setCascadeCount(n);
	}
	_tfMarkShadowMaterials();
	return n;
}

function _tfOverrideCascadeDefine(n) {
	const anchor = '#define SUN_LIGHT_CASCADES ' + SUN_CASCADE_COUNT;
	if (n === SUN_CASCADE_COUNT) {
		ShaderChunk.shadowmap_pars_fragment = TF_SHADOWMAP_PARS_SRC;
		return;
	}
	if (TF_SHADOWMAP_PARS_SRC.indexOf(anchor) === -1) {
		console.warn('ThreeForge: setSunCascadeCount — якорь "' + anchor + '" не найден в ' +
			'shadowmap_pars_fragment (изменился three.js?); остаётся нативное число каскадов');
		return;
	}
	ShaderChunk.shadowmap_pars_fragment = TF_SHADOWMAP_PARS_SRC
		.replace(anchor, '#define SUN_LIGHT_CASCADES ' + n);
}

function _tfRegisterSunShadow(shadow) {
	if (_tfSunShadows.indexOf(shadow) === -1) _tfSunShadows.push(shadow);
}

function _tfUnregisterSunShadow(shadow) {
	const i = _tfSunShadows.indexOf(shadow);
	if (i !== -1) _tfSunShadows.splice(i, 1);
}

function _tfRegisterShadowMaterial(material) {
	if (typeof WeakRef === 'undefined') return;
	for (let i = _tfShadowMaterials.length - 1; i >= 0; i--) {
		const m = _tfShadowMaterials[i].deref();
		if (m === undefined) _tfShadowMaterials.splice(i, 1);
		else if (m === material) return;
	}
	_tfShadowMaterials.push(new WeakRef(material));
}

function _tfMarkShadowMaterials() {
	if (typeof WeakRef === 'undefined') return;
	for (let i = _tfShadowMaterials.length - 1; i >= 0; i--) {
		const m = _tfShadowMaterials[i].deref();
		if (m === undefined) { _tfShadowMaterials.splice(i, 1); continue; }
		m.needsUpdate = true;
	}
}

const SunLightShadow = class extends LightShadow {
	/**
	 * Каскадные тени солнца (CSM) поверх атласа: N фрустумов-срезов view-камеры
	 * упакованы в одну карту (mapSize = размер ОДНОГО каскада; атлас =
	 * mapSize × сумма тайлов). Настройки:
	 * @param {{cascades?:number, splitLambda?:number, cascadeFade?:number, cascadeTiles?:number[]}} [options]
	 *   cascades — число каскадов 1..4 (по умолчанию — глобальное getSunCascadeCount());
	 *   splitLambda — схема сплитов: 0 = логарифмическая, 1 = равномерная,
	 *     0.5 = их среднее (прежнее поведение three-эталона);
	 *   cascadeFade — доля глубины каскада, растворяющаяся в следующем (0.02..0.9);
	 *   cascadeTiles — целые ВЕСА каскадов в атласе ([2,1] — ближний каскад
	 *     вдвое шире → вдвое выше разрешение вблизи); null/undefined = по 1.
	 */
	constructor(options = {}) {
		super(new OrthographicCamera(-5, 5, 5, -5, 0.5, 500));
		this.isSunLightShadow = true;
		this.mapSize.set(1024, 1024);
		this.splitLambda = 0.5;
		this.cascadeFade = SUN_CASCADE_FADE;
		this.cascadeTiles = null;
		this._tiles = [];
		this._tileOffsets = [];
		if (options.cascades !== undefined && Math.round(Number(options.cascades)) !== _tfSunCascades) {
			console.warn('ThreeForge: SunLightShadow({cascades:' + options.cascades + '}) не совпадает с глобальным ' +
				'getSunCascadeCount()=' + _tfSunCascades + ' — define SUN_LIGHT_CASCADES в шейдерах глобальный; ' +
				'используйте setSunCascadeCount(n)');
		}
		this._initCascades(options.cascades !== undefined ? options.cascades : _tfSunCascades);
		if (options.splitLambda !== undefined) this.setSplitLambda(options.splitLambda);
		if (options.cascadeFade !== undefined) this.setCascadeFade(options.cascadeFade);
		if (options.cascadeTiles !== undefined) this.setCascadeTiles(options.cascadeTiles);
		_tfRegisterSunShadow(this);
	}

	_initCascades(count) {
		count = Math.round(Number(count));
		if (!isFinite(count)) count = SUN_CASCADE_COUNT;
		count = Math.max(1, Math.min(4, count));
		this._cascadeCount = count;
		this._cameras = [];
		this._matrices = [];
		this._frustums = [];
		this._cascadeData = [];
		this._cascadeSplits = new Array(count + 1).fill(0);
		this._viewports.length = 0;
		for (let i = 0; i < count; i++) {
			this._cameras.push(new OrthographicCamera());
			this._matrices.push(new Matrix4());
			this._frustums.push(new Frustum());
			this._cascadeData.push(new Vector4());
			this._viewports.push(new Vector4());
		}
		this._viewportCount = count;
		this._updateTiles();
		if (this.map !== null && this.map !== undefined) {
			this.map.dispose();
			this.map = null;
		}
		this.needsUpdate = true;
	}

	_updateTiles() {
		const n = this._cascadeCount;
		const src = this.cascadeTiles;
		this._tiles.length = 0;
		this._tileOffsets.length = 0;
		let acc = 0;
		for (let i = 0; i < n; i++) {
			const w = (src !== null && src !== undefined && src[i] !== undefined)
				? Math.max(1, Math.min(8, Math.round(src[i]))) : 1;
			this._tiles.push(w);
			this._tileOffsets.push(acc);
			acc += w;
		}
		this._frameExtents.set(acc, 1);
	}

	/** Число каскадов 1..4 (пересоздаёт камеры/атлас; карта будет пересобрана). */
	setCascadeCount(n) {
		n = Math.max(1, Math.min(4, Math.round(Number(n)) || SUN_CASCADE_COUNT));
		if (n !== _tfSunCascades) {
			console.warn('ThreeForge: SunLightShadow.setCascadeCount(' + n + ') не совпадает с глобальным ' +
				'getSunCascadeCount()=' + _tfSunCascades + ' — define SUN_LIGHT_CASCADES в шейдерах глобальный; ' +
				'используйте setSunCascadeCount(n) для всех теней сразу');
		}
		if (n !== this._cascadeCount) this._initCascades(n);
		return this;
	}

	getCascadeCount() { return this._cascadeCount; }

	/** Схема сплитов: 0 = логарифмическая, 1 = равномерная (дефолт 0.5). */
	setSplitLambda(x) {
		x = Number(x);
		this.splitLambda = isFinite(x) ? Math.max(0, Math.min(1, x)) : 0.5;
		return this;
	}

	/** Доля глубины каскада, растворяющаяся в следующем (0.02..0.9). */
	setCascadeFade(f) {
		f = Number(f);
		this.cascadeFade = isFinite(f) ? Math.max(0.02, Math.min(0.9, f)) : SUN_CASCADE_FADE;
		return this;
	}

	/** Веса каскадов в атласе ([2,1,1,1] — ближний вдвое детальнее); null = по 1. */
	setCascadeTiles(tiles) {
		this.cascadeTiles = Array.isArray(tiles) ? tiles.slice(0, 4) : null;
		this._updateTiles();
		if (this.map !== null && this.map !== undefined) {
			this.map.dispose();
			this.map = null;
		}
		this.needsUpdate = true;
		return this;
	}

	getCamera(cascadeIndex = 0) { return this._cameras[cascadeIndex]; }
	getMatrix(cascadeIndex = 0) { return this._matrices[cascadeIndex]; }
	getFrustum(cascadeIndex = 0) { return this._frustums[cascadeIndex]; }

	updateMatrices(light, viewCamera) {
		if (viewCamera === undefined) return;

		const cascadeCount = this._cascadeCount;
		const tiles = this._tiles;
		const tileOffsets = this._tileOffsets;

		const insetX = Math.min(0.25, (Math.ceil(this.radius) + 1) / this.mapSize.x);
		const insetY = Math.min(0.25, (Math.ceil(this.radius) + 1) / this.mapSize.y);
		for (let i = 0; i < cascadeCount; i++) {
			this._viewports[i].set(tileOffsets[i] + insetX, insetY, tiles[i] - 2 * insetX, 1 - 2 * insetY);
		}

		const resolutionY = this.mapSize.y * (1 - 2 * insetY);

		const camera = this.camera;
		const cameraNear = viewCamera.near;
		const cameraFar = Math.max(cameraNear + 1e-6, Math.min(camera.far, viewCamera.far));

		const splits = this._cascadeSplits;
		const lambda = this.splitLambda;
		splits[0] = cameraNear;
		for (let i = 1; i < cascadeCount; i++) {
			const amount = i / cascadeCount;
			const uniform = cameraNear + (cameraFar - cameraNear) * amount;
			const logarithmic = cameraNear > 0 ? cameraNear * Math.pow(cameraFar / cameraNear, amount) : uniform;
			splits[i] = logarithmic + (uniform - logarithmic) * lambda;
		}
		splits[cascadeCount] = cameraFar;

		_slLightDirection.setFromMatrixPosition(light.matrixWorld).negate().normalize();

		_slUp.set(0, 1, 0);
		if (Math.abs(_slUp.dot(_slLightDirection)) > 0.99) _slUp.set(0, 0, 1);

		_slLightOrientationMatrix.lookAt(_slCenter.set(0, 0, 0), _slLightDirection, _slUp);
		_slViewToLightMatrix.copy(_slLightOrientationMatrix).transpose().multiply(viewCamera.matrixWorld);

		const zNear = viewCamera.reversedDepth ? 1 : (viewCamera.coordinateSystem === WebGPUCoordinateSystem ? 0 : -1);
		const inverseProjectionMatrix = viewCamera.projectionMatrixInverse;

		let globalMaxZ = -Infinity;
		for (let i = 0; i < 4; i++) {
			const x = i === 0 || i === 1 ? 1 : -1;
			const y = i === 0 || i === 3 ? 1 : -1;
			const nearCorner = _slNearCorners[i].set(x, y, zNear).applyMatrix4(inverseProjectionMatrix);
			const farCorner = _slFarCorners[i];
			if (viewCamera.isPerspectiveCamera === true) {
				farCorner.copy(nearCorner).multiplyScalar(cameraFar / cameraNear);
			} else {
				farCorner.set(nearCorner.x, nearCorner.y, -cameraFar);
			}
			nearCorner.applyMatrix4(_slViewToLightMatrix);
			farCorner.applyMatrix4(_slViewToLightMatrix);
			globalMaxZ = Math.max(globalMaxZ, nearCorner.z, farCorner.z);
		}
		globalMaxZ += cameraFar;

		const shadowNear = camera.near;
		const cascadeFade = this.cascadeFade;

		for (let i = 0; i < cascadeCount; i++) {
			const cascadeNear = i === 0 ? splits[0] : this._cascadeData[i - 1].z;
			const cascadeFar = splits[i + 1];
			const fadeStart = cascadeFar - cascadeFade * (cascadeFar - splits[i]);
			this._cascadeData[i].set(i === 0 ? -1e10 : cascadeNear, cascadeFar, fadeStart, 0);

			const nearAlpha = (cascadeNear - cameraNear) / (cameraFar - cameraNear);
			const farAlpha = (cascadeFar - cameraNear) / (cameraFar - cameraNear);
			_slCenter.set(0, 0, 0);
			for (let j = 0; j < 4; j++) {
				_slCascadeCorners[j * 2].lerpVectors(_slNearCorners[j], _slFarCorners[j], nearAlpha);
				_slCascadeCorners[j * 2 + 1].lerpVectors(_slNearCorners[j], _slFarCorners[j], farAlpha);
				_slCenter.add(_slCascadeCorners[j * 2]).add(_slCascadeCorners[j * 2 + 1]);
			}
			_slCenter.multiplyScalar(1 / 8);

			let radiusSq = 0;
			let minZ = Infinity;
			for (let j = 0; j < 8; j++) {
				radiusSq = Math.max(radiusSq, _slCascadeCorners[j].distanceToSquared(_slCenter));
				minZ = Math.min(minZ, _slCascadeCorners[j].z);
			}
			let radius = Math.sqrt(radiusSq);

			const resolutionX = this.mapSize.x * (tiles[i] - 2 * insetX);
			const resolution = Math.min(resolutionX, resolutionY);
			if (resolution > 1) {
				radius /= 1 - 1 / resolution;
				const texelSizeX = 2 * radius / resolutionX;
				const texelSizeY = 2 * radius / resolutionY;
				_slCenter.x = Math.round(_slCenter.x / texelSizeX) * texelSizeX;
				_slCenter.y = Math.round(_slCenter.y / texelSizeY) * texelSizeY;
			}

			_slCenter.z = globalMaxZ + shadowNear;
			_slCenter.applyMatrix4(_slLightOrientationMatrix);

			const cascadeCamera = this._cameras[i];
			cascadeCamera.position.copy(_slCenter);
			cascadeCamera.quaternion.setFromRotationMatrix(_slLightOrientationMatrix);
			cascadeCamera.left = -radius;
			cascadeCamera.right = radius;
			cascadeCamera.top = radius;
			cascadeCamera.bottom = -radius;
			cascadeCamera.near = shadowNear;
			cascadeCamera.far = globalMaxZ - minZ + 2 * shadowNear;
			cascadeCamera.coordinateSystem = camera.coordinateSystem;
			cascadeCamera._reversedDepth = camera.reversedDepth;
			cascadeCamera.updateProjectionMatrix();
			cascadeCamera.updateMatrixWorld();

			this._updateMatrix(cascadeCamera, this._matrices[i], this._frustums[i], this._viewports[i]);
		}
	}

	copy(source, recursive) {
		super.copy(source, recursive);
		if (source.splitLambda !== undefined) this.splitLambda = source.splitLambda;
		if (source.cascadeFade !== undefined) this.cascadeFade = source.cascadeFade;
		if (source.cascadeTiles !== undefined && source.cascadeTiles !== null) {
			this.cascadeTiles = source.cascadeTiles.slice();
		} else {
			this.cascadeTiles = null;
		}
		const n = source._cascadeCount !== undefined ? source._cascadeCount : this._cascadeCount;
		if (n !== this._cascadeCount) this._initCascades(n);
		else this._updateTiles();
		return this;
	}

	toJSON() {
		const data = super.toJSON();
		data.cascades = this._cascadeCount;
		data.splitLambda = this.splitLambda;
		data.cascadeFade = this.cascadeFade;
		if (this.cascadeTiles !== null) data.cascadeTiles = this.cascadeTiles.slice();
		return data;
	}

	dispose() {
		_tfUnregisterSunShadow(this);
		if (typeof super.dispose === 'function') super.dispose();
	}
};

const SunLight = class extends Light {
	/**
	 * @param {number|THREE.Color|string} [color]
	 * @param {number} [intensity]
	 * @param {object} [shadowOptions] Опции SunLightShadow (cascades, splitLambda,
	 *   cascadeFade, cascadeTiles) — применяются к this.shadow.
	 */
	constructor(color, intensity, shadowOptions) {
		super(color, intensity);
		this.isSunLight = true;
		this.type = 'SunLight';
		this.position.copy(Object3D.DEFAULT_UP);
		this.updateMatrix();
		this.shadow = new SunLightShadow(shadowOptions !== undefined && shadowOptions !== null ? shadowOptions : {});
	}

	dispose() {
		if (typeof super.dispose === 'function') super.dispose();
		if (this.shadow !== null && this.shadow !== undefined) this.shadow.dispose();
	}

	copy(source, recursive) {
		super.copy(source, recursive);
		this.shadow = source.shadow.clone();
		return this;
	}

	toJSON(meta) {
		const data = super.toJSON(meta);
		data.object.shadow = this.shadow.toJSON();
		return data;
	}
};

function tfAddProgramCacheKey(material, key) {
	if (material === undefined || material === null) return material;
	if (material.__tfCacheKeys === undefined) {
		material.__tfCacheKeys = [];
		const hasOwn = Object.prototype.hasOwnProperty.call(material, 'customProgramCacheKey');
		const proto = Object.getPrototypeOf(material);
		const src = hasOwn ? material.customProgramCacheKey
			: (proto !== null ? proto.customProgramCacheKey : undefined);
		const base = typeof src === 'function' ? src.bind(material) : null;
		material.customProgramCacheKey = function () {
			const b = base !== null ? base() : '';
			return this.__tfCacheKeys === undefined || this.__tfCacheKeys.length === 0
				? b : b + '|tf(' + this.__tfCacheKeys.join(';') + ')';
		};
	}
	if (material.__tfCacheKeys.indexOf(key) === -1) material.__tfCacheKeys.push(key);
	return material;
}

function tfRecordPatch(material, entry) {
	if (material === undefined || material === null) return material;
	if (material.__tfPatches === undefined) material.__tfPatches = [];
	material.__tfPatches.push(entry);
	return material;
}

function tfChainOnBeforeCompile(material, apply) {
	const prev = material.onBeforeCompile;
	material.onBeforeCompile = function (shader, renderer) {
		if (typeof prev === 'function') prev.call(this, shader, renderer);
		apply.call(this, shader, renderer);
	};
	material.needsUpdate = true;
}

/**
 * Клонировать материал, СОХРАНИВ патчи ThreeForge (туман/тени/дизер/emissive).
 *
 * `material.clone()` в three r186 не переносит onBeforeCompile — копия
 * возвращается «голой». Этот метод клонирует материал и повторяет на копии
 * все зарегистрированные патчи в исходном порядке.
 *
 * @param {THREE.Material} material
 * @returns {THREE.Material} Клон с теми же патчами.
 */
function cloneMaterialPatched(material) {
	if (material === undefined || material === null) return material;
	const copy = material.clone();
	const patches = material.__tfPatches;
	if (patches !== undefined) {
		for (let i = 0; i < patches.length; i++) {
			const p = patches[i];
			if (p !== null && typeof p.replay === 'function') p.replay(copy);
		}
	}
	return copy;
}

// ---------------------------------------------------------------------------
// Качество теней (v2.7 Shadow Overhaul). GLSL-функции ГЕНЕРИРУЮТСЯ под настройки:
//   taps          — число Vogel-тапов PCF (1..64; дефолт 12 = прежнее поведение);
//   soft          — второе «широкое» PCF-кольцо: мягкие тени с усилением по
//                   дальности (аппроксимация contact hardening; ×2 стоимость
//                   сэмплинга, работает только в SHADOWMAP_TYPE_PCF);
//   softMix / softDepthGrowth / softRadius — значения униформы tfShadowSoft(x,y,z):
//                   базовая доля широкого кольца, прирост доли на view-глубину
//                   (нормируется на tfShadowFade.y), множитель радиуса кольца;
//   fadeAllLights — растворять в дымке (tfShadowFade) тени ВСЕХ источников
//                   (directional/spot/point), а не только солнца (дефолт вкл).
// Изменения: tfShadowCacheKey (динамический ключ кэша программ) + реестр
// WeakRef пропатченных материалов → setShadowQuality()/setSunCascadeCount()
// сами помечают их на рекомпиляцию.
// ---------------------------------------------------------------------------
const TF_SHADOW_QUALITY = {
	taps: 12,
	soft: false,
	softMix: 0.55,
	softDepthGrowth: 0.45,
	softRadius: 3.0,
	fadeAllLights: true
};

// Общие униформы качества теней (значения пишут PostPipeline / setShadowQuality):
//   tfShadowRot  — временнóе вращение Vogel-диска (кадровая фаза): с TAA шум
//                  PCF усредняется накоплением, без TAA остаётся 0 (статично);
//   tfShadowFade — (start, end) view-глубины: тени растворяются в тумане —
//                  вдали, где 1 экранный пиксель накрывает десятки текселей
//                  карты теней, PCF-алиасинг уходит вместе с тенью;
//   tfShadowSoft — (mix, depthGrowth, radiusMul) мягких теней (soft-режим).
const TF_SHADOW_UNIFORMS = {
	tfShadowRot: { value: 0 },
	tfShadowFade: { value: new Vector2(1e8, 1e8 + 1) },
	tfShadowSoft: { value: new Vector3(TF_SHADOW_QUALITY.softMix, TF_SHADOW_QUALITY.softDepthGrowth, TF_SHADOW_QUALITY.softRadius) }
};

// Динамический ключ кэша программ: toString() вычисляется в момент компиляции,
// поэтому смена каскадов/тиров/режимов ДАЁТ новый ключ (three не переиспользует
// старую программу). Живой объект добавляется в __tfCacheKeys один раз.
const tfShadowCacheKey = {
	toString() {
		const q = TF_SHADOW_QUALITY;
		return 'sunshadow:c' + _tfSunCascades + ':t' + q.taps +
			(q.soft === true ? ':s' : '') + (q.fadeAllLights === true ? ':f' : '');
	}
};

function tfVogelRing(taps, radiusExpr, phiExpr) {
	const rows = [];
	for (let i = 0; i < taps; i++) {
		rows.push('\t\t\ttexture( smap, vec3( shadowCoord.xy + vogelDiskSample( ' + i + ', ' +
			taps + ', ' + phiExpr + ' ) * ' + radiusExpr + ', shadowCoord.z ) )');
	}
	return rows.join(' +\n');
}

function tfBuildShadowFn(q) {
	const taps = Math.max(1, Math.min(64, Math.round(q.taps) || 12));
	const weight = (1 / taps).toFixed(7);
	const soft = q.soft === true;
	const softBlock = soft ? `
		if ( softMix > 0.001 ) {
			// второе кольцо: шире в tfShadowSoft.z раз и повёрнуто на π —
			// вместе с TAA-ротацией даёт плотное покрытие penumbra-зоны
			float radiusSoft = radius * max( tfShadowSoft.z, 1.0 );
			float shadowSoft = (
` + tfVogelRing(taps, 'radiusSoft', 'phi + 3.14159265') + `
			) * ${weight};
			shadow = mix( shadow, shadowSoft, softMix );
		}` : '';
	const softMixExpr = soft
		? 'clamp( tfShadowSoft.x + tfShadowSoft.y * viewDepth / max( tfShadowFade.y, 1.0 ), 0.0, 1.0 )'
		: '0.0';
	return `
#if defined( USE_SHADOWMAP ) && ( NUM_SUN_LIGHT_SHADOWS > 0 || NUM_DIR_LIGHT_SHADOWS > 0 || NUM_SPOT_LIGHT_SHADOWS > 0 || NUM_POINT_LIGHT_SHADOWS > 0 )
uniform float tfShadowRot;
uniform vec2 tfShadowFade;
uniform vec3 tfShadowSoft;

// Растворение тени в дымке расстояния (единый метрик для всех источников:
// view-глубина -geometryPosition.z == vSunShadowWorldPosition.w солнца).
float tfFadeShadow( float shadow, float viewDepth ) {
	float f = 1.0 - smoothstep( tfShadowFade.x, tfShadowFade.y, viewDepth );
	return mix( 1.0, shadow, f );
}

// ИСПРАВЛЕНО (C2): three объявляет interleavedGradientNoise()/vogelDiskSample()
// ТОЛЬКО под #if defined( SHADOWMAP_TYPE_PCF ), а sunShadowMap — это
// sampler2DShadow лишь в PCF-ветке (в Basic/VSM это sampler2D). Vogel-сэмплинг
// существует только в PCF-ветке, прочие режимы используют встроенный getShadow()
// того же типа сэмплера — патч корректен при ЛЮБОМ shadowMap.type.
#if defined( SHADOWMAP_TYPE_PCF ) && NUM_SUN_LIGHT_SHADOWS > 0

float tfGetShadowSample( sampler2DShadow smap, vec2 smapSize, float shadowIntensity, float shadowBias, float shadowRadius, vec4 shadowCoord, float softMix ) {
	shadowCoord.xyz /= shadowCoord.w;
	shadowCoord.z += shadowBias;
	bool inFrustum = shadowCoord.x >= 0.0 && shadowCoord.x <= 1.0 && shadowCoord.y >= 0.0 && shadowCoord.y <= 1.0;
	bool frustumTest = inFrustum && shadowCoord.z <= 1.0;
	float shadow = 1.0;
	if ( frustumTest ) {
		vec2 texelSize = vec2( 1.0 ) / smapSize;
		// радиус PCF: базовый (в текселях) НО не меньше экранного футпринта
		// пикселя (fwidth shadowCoord): вдали пиксель накрывает много
		// текселей — taps должны покрывать эту площадь, иначе salt&pepper
		float foot = max( fwidth( shadowCoord.x ), fwidth( shadowCoord.y ) );
		float radius = max( shadowRadius * texelSize.x, foot * 1.25 );
		float phi = ( interleavedGradientNoise( gl_FragCoord.xy ) + tfShadowRot ) * PI2;
		shadow = (
${tfVogelRing(taps, 'radius', 'phi')}
		) * ${weight};${softBlock}
	}
	return mix( 1.0, shadow, shadowIntensity );
}

float tfSunCascadeSample( sampler2DShadow smap, SunLightShadow sls, vec4 shadowCoord, float softMix ) {
	return tfGetShadowSample( smap, sls.shadowMapSize, sls.shadowIntensity, sls.shadowBias, sls.shadowRadius, shadowCoord, softMix );
}

#elif NUM_SUN_LIGHT_SHADOWS > 0

// Basic / VSM: один вызов встроенного getShadow() (перегрузка под sampler2D
// объявлена в shadowmap_pars_fragment для обоих режимов); softMix игнорируется.
float tfSunCascadeSample( sampler2D smap, SunLightShadow sls, vec4 shadowCoord, float softMix ) {
	return getShadow( smap, sls.shadowMapSize, sls.shadowIntensity, sls.shadowBias, sls.shadowRadius, shadowCoord );
}

#endif

#if NUM_SUN_LIGHT_SHADOWS > 0

float tfGetSunShadow(
	#if defined( SHADOWMAP_TYPE_PCF )
		sampler2DShadow smap,
	#else
		sampler2D smap,
	#endif
	SunLightShadow sls, int shadowIndex ) {
	vec4 shadowWorldPosition = vec4( vSunShadowWorldPosition.xyz + vSunShadowWorldNormal * sls.shadowNormalBias, 1.0 );
	float viewDepth = vSunShadowWorldPosition.w;
	int cascadeOffset = shadowIndex * SUN_LIGHT_CASCADES;
	float shadow = 1.0;
	// soft-режим: чем дальше пиксель, тем шире penumbra (contact hardening
	// по дальности; нормировка на tfShadowFade.y = границу растворения теней)
	float softMix = ${softMixExpr};
	// каскады обрабатываются от дальних к ближним; цикл на ЛЮБОЕ число
	// SUN_LIGHT_CASCADES (задаётся setSunCascadeCount, 1..4)
	for ( int i = SUN_LIGHT_CASCADES - 1; i >= 0; i -- ) {
		vec4 c = sunShadowCascade[ cascadeOffset + i ];
		if ( viewDepth >= c.x && viewDepth < c.y ) {
			float cs = tfSunCascadeSample( smap, sls, sunShadowMatrix[ cascadeOffset + i ] * shadowWorldPosition, softMix );
			shadow = mix( cs, shadow, smoothstep( c.z, c.y, viewDepth ) );
		}
	}
	// растворение теней в дымке расстояния (борьба с PCF-алиасингом
	// вдали + воздушная перспектива: реальные тени в тумане не читаются)
	float fade = 1.0 - smoothstep( tfShadowFade.x, tfShadowFade.y, viewDepth );
	shadow = mix( 1.0, shadow, fade );
	return shadow;
}
#endif
#endif
`;
}

let TF_SUN_SHADOW_FN = tfBuildShadowFn(TF_SHADOW_QUALITY);

/** Текущие настройки качества теней (копия). */
function getShadowQuality() { return Object.assign({}, TF_SHADOW_QUALITY); }

/**
 * Изменить качество теней глобально (для всех материалов с installSunShadowPatch).
 *
 * Смена taps/soft/fadeAllLights перегенерирует GLSL и помечает пропатченные
 * материалы на рекомпиляцию (one-time фриз — зовите на паузе/загрузке);
 * softMix/softDepthGrowth/softRadius — униформы (без рекомпиляции).
 *
 * @param {{taps?:number, soft?:boolean|{mix?:number, depthGrowth?:number, radius?:number, enabled?:boolean},
 *   softMix?:number, softDepthGrowth?:number, softRadius?:number, fadeAllLights?:boolean}} [q]
 * @returns {object} Итоговые настройки (копия).
 */
function setShadowQuality(q) {
	if (q === undefined || q === null) return getShadowQuality();
	let glslChanged = false;
	let paramsChanged = false;
	const Q = TF_SHADOW_QUALITY;
	if (q.taps !== undefined) {
		const t = Math.max(1, Math.min(64, Math.round(Number(q.taps)) || 12));
		if (t !== Q.taps) { Q.taps = t; glslChanged = true; }
	}
	const softObj = (q.soft !== undefined && q.soft !== null && typeof q.soft === 'object') ? q.soft : null;
	const softFlag = softObj !== null
		? (softObj.enabled === true || softObj.enabled === undefined)
		: (q.soft === true ? true : (q.soft === false ? false : null));
	if (softFlag !== null && softFlag !== Q.soft) { Q.soft = softFlag; glslChanged = true; }
	const setNum = (v, key, min, max) => {
		if (v === undefined) return;
		const n = Number(v);
		if (!isFinite(n)) return;
		const c = Math.max(min, Math.min(max, n));
		if (c !== Q[key]) { Q[key] = c; paramsChanged = true; }
	};
	if (softObj !== null) {
		setNum(softObj.mix, 'softMix', 0, 1);
		setNum(softObj.depthGrowth, 'softDepthGrowth', 0, 4);
		setNum(softObj.radius, 'softRadius', 1, 12);
	}
	setNum(q.softMix, 'softMix', 0, 1);
	setNum(q.softDepthGrowth, 'softDepthGrowth', 0, 4);
	setNum(q.softRadius, 'softRadius', 1, 12);
	if (q.fadeAllLights !== undefined) {
		const f = q.fadeAllLights !== false;
		if (f !== Q.fadeAllLights) { Q.fadeAllLights = f; glslChanged = true; }
	}
	if (glslChanged) {
		TF_SUN_SHADOW_FN = tfBuildShadowFn(Q);
		_tfMarkShadowMaterials();
	}
	if (paramsChanged || glslChanged) {
		TF_SHADOW_UNIFORMS.tfShadowSoft.value.set(Q.softMix, Q.softDepthGrowth, Q.softRadius);
	}
	return getShadowQuality();
}

// Якоря вызовов встроенных теневых функций в lights_fragment_begin (r186):
// патч оборачивает их в tfFadeShadow(<call>, -geometryPosition.z) — единое
// растворение в дымке для directional/spot/point (метрик глубины тот же,
// что у солнца: geometryPosition = -vViewPosition = mvPosition.xyz).
const TF_FADE_WRAP_HEADS = [
	'getShadow( directionalShadowMap[ i ]',
	'getShadow( spotShadowMap[ i ]',
	'getPointShadow( pointShadowMap[ i ]'
];

function tfWrapShadowCallsWithFade(chunkSrc) {
	let src = chunkSrc;
	let wrapped = 0;
	for (let h = 0; h < TF_FADE_WRAP_HEADS.length; h++) {
		const head = TF_FADE_WRAP_HEADS[h];
		const at = src.indexOf(head);
		if (at === -1) continue;
		let depth = 0;
		let end = -1;
		for (let i = at; i < src.length; i++) {
			const ch = src.charAt(i);
			if (ch === '(') depth++;
			else if (ch === ')') { depth--; if (depth === 0) { end = i; break; } }
		}
		if (end === -1) continue;
		const call = src.slice(at, end + 1);
		src = src.slice(0, at) + 'tfFadeShadow( ' + call + ', -geometryPosition.z )' + src.slice(end + 1);
		wrapped++;
	}
	return wrapped > 0 ? src : null;
}

function installSunShadowPatch(material) {
	if (material.__tfSunShadowPatched === true) return material;
	material.__tfSunShadowPatched = true;
	tfAddProgramCacheKey(material, tfShadowCacheKey);
	tfRecordPatch(material, { name: 'sunshadow', replay: (copy) => installSunShadowPatch(copy) });
	_tfRegisterShadowMaterial(material);
	tfChainOnBeforeCompile(material, function (shader, renderer) {
		shader.uniforms.tfShadowRot = TF_SHADOW_UNIFORMS.tfShadowRot;
		shader.uniforms.tfShadowFade = TF_SHADOW_UNIFORMS.tfShadowFade;
		shader.uniforms.tfShadowSoft = TF_SHADOW_UNIFORMS.tfShadowSoft;
		const parsTag = '#include <shadowmap_pars_fragment>';
		const beginTag = '#include <lights_fragment_begin>';
		if (shader.fragmentShader.indexOf(parsTag) === -1 || shader.fragmentShader.indexOf(beginTag) === -1) {
			console.warn('ThreeForge: sun shadow patch — чанки не найдены, материал останется на встроенном пути');
			return;
		}
		let beginChunk = ShaderChunk.lights_fragment_begin;
		const callSrc = 'getSunShadow( sunShadowMap[ i ], sunLightShadow, UNROLLED_LOOP_INDEX )';
		if (beginChunk.indexOf(callSrc) === -1) {
			console.warn('ThreeForge: sun shadow patch — вызов getSunShadow не совпал, материал останется на встроенном пути');
			return;
		}
		beginChunk = beginChunk.replace(callSrc, 'tfGetSunShadow( sunShadowMap[ UNROLLED_LOOP_INDEX ], sunLightShadow, UNROLLED_LOOP_INDEX )');
		if (TF_SHADOW_QUALITY.fadeAllLights === true) {
			const wrapped = tfWrapShadowCallsWithFade(beginChunk);
			if (wrapped !== null) beginChunk = wrapped;
		}
		shader.fragmentShader = shader.fragmentShader
			.replace(parsTag, parsTag + '\n' + TF_SUN_SHADOW_FN)
			.replace(beginTag, beginChunk);
	});
	return material;
}

const _scSmooth = (a, b, x) => {
	const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
	return t * t * (3 - 2 * t);
};

const SunCycle = class extends EventDispatcher {
	constructor(options = {}) {
		super();
		this.time = options.time !== undefined ? options.time : 10.0;
		this.hoursPerSecond = options.hoursPerSecond !== undefined ? options.hoursPerSecond : 0.1;
		this.autoAdvance = options.autoAdvance !== undefined ? options.autoAdvance : true;
		this.maxElevation = (options.maxElevationDeg !== undefined ? options.maxElevationDeg : 62) * (Math.PI / 180);
		this.sunDistance = options.sunDistance !== undefined ? options.sunDistance : 1000;
		this.sunIntensityMax = options.sunIntensityMax !== undefined ? options.sunIntensityMax : 3.3;
		this.moonIntensityMax = options.moonIntensityMax !== undefined ? options.moonIntensityMax : 0.25;

		this.sun = options.sun || null;
		this.hemi = options.hemi || null;
		this.moon = options.moon || null;
		this.fogColor = options.fogColor || null;
		this.skyUniforms = options.skyUniforms || null;
		this.waterUniforms = options.waterUniforms || null;
		this.lights = options.lights !== undefined && options.lights !== null ? options.lights : null;
		this.shadowFadeOut = null;

		this.palette = {
			sunDeep: new Color(0xff5a2e),
			sunWarm: new Color(0xffb072),
			sunWhite: new Color(0xfff4e2),
			zenithDay: new Color(0x3f6fb5),
			zenithNight: new Color(0x05070f),
			horizonDay: new Color(0x9fc0dd),
			horizonNight: new Color(0x0c1220),
			sunset: new Color(0xff8a3d),
			hemiSkyDay: new Color(0xcfe4ff),
			hemiSkyNight: new Color(0x1c2a4a),
			groundDay: new Color(0x5c6442),
			groundNight: new Color(0x0b0f0c),
			moon: new Color(0xbcd0ff),
			waterTintNight: new Color(0x25364f)
		};

		this.sunDirection = new Vector3(0, 1, 0);
		this.moonDirection = new Vector3(0, -1, 0);
		this.sunColor = new Color(1, 1, 1);
		this.zenithColor = new Color();
		this.horizonColor = new Color();
		this.groundColor = new Color();
		this.elevation = 0;
		this.dayFactor = 0;
		this.nightFactor = 0;
		this.sunsetFactor = 0;
		this.sunIntensity = 0;
		this.hemiIntensity = 0;
		this.moonIntensity = 0;
		this.shadowFactor = 0;
		this.moonShadowFactor = 0;
		this._white = new Color(1, 1, 1);

		this.update(0);
	}

	setTime(hours) {
		if (!Number.isFinite(hours)) return this;
		this.time = ((hours % 24) + 24) % 24;
		this.update(0);
		return this;
	}

	get timeString() {
		const h = Math.floor(this.time);
		const m = Math.floor((this.time - h) * 60);
		return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
	}

	update(dt) {
		if (this.autoAdvance === true && dt > 0 && Number.isFinite(dt)) {
			this.time = (this.time + dt * this.hoursPerSecond) % 24;
		}
		if (!Number.isFinite(this.time)) this.time = 0;
		this._compute();
		this._apply();
		if (this._listeners !== undefined && this._listeners.update !== undefined) {
			this.dispatchEvent({
				type: 'update', time: this.time, dayFactor: this.dayFactor,
				nightFactor: this.nightFactor, sunsetFactor: this.sunsetFactor,
				sunIntensity: this.sunIntensity, elevation: this.elevation
			});
		}
		return this;
	}

	/** Привязать LightManager (часть 1.6): dayFactor будет синхронизироваться. */
	bindLightManager(lights) {
		this.lights = lights !== undefined && lights !== null ? lights : null;
		if (this.lights !== null && typeof this.lights.setDayFactor === 'function') {
			this.lights.setDayFactor(this.dayFactor);
		}
		return this;
	}

	_compute() {
		const t = this.time;
		const elev = Math.sin(((t - 6) / 12) * Math.PI) * this.maxElevation;
		const azim = ((t - 6) / 12) * Math.PI - Math.PI / 2;
		this.elevation = elev;
		const ce = Math.cos(elev), se = Math.sin(elev);
		this.sunDirection.set(ce * Math.cos(azim), se, ce * Math.sin(azim));
		this.moonDirection.copy(this.sunDirection).negate();

		this.dayFactor = _scSmooth(-0.05, 0.22, se);
		this.nightFactor = 1 - _scSmooth(-0.14, -0.03, se);
		this.sunsetFactor = Math.exp(-Math.pow((se - 0.03) / 0.11, 2));

		const P = this.palette;
		this.sunColor.copy(P.sunDeep)
			.lerp(P.sunWarm, _scSmooth(-0.02, 0.18, se))
			.lerp(P.sunWhite, _scSmooth(0.12, 0.5, se));
		this.sunIntensity = this.sunIntensityMax * _scSmooth(-0.06, 0.16, se);

		this.zenithColor.copy(P.zenithNight).lerp(P.zenithDay, this.dayFactor);
		this.horizonColor.copy(P.horizonNight).lerp(P.horizonDay, Math.pow(this.dayFactor, 0.8));
		this.horizonColor.lerp(P.sunset, this.sunsetFactor * 0.6);
		this.groundColor.copy(P.groundNight).lerp(P.groundDay, this.dayFactor);

		this.hemiIntensity = 0.14 + 0.95 * this.dayFactor + 0.15 * this.sunsetFactor;
		this.moonIntensity = this.moonIntensityMax * this.nightFactor;

		// v2.7: множитель теней солнца/луны. ПЛАВНЫЙ (вместо прежнего порога
		// sunIntensity > 0.05): тени растворяются у горизонта вместе со светом —
		// ночью застывшая карта заката больше не сэмплируется (shadow.intensity
		// → 0), а на рассвете не «включается» скачком.
		this.shadowFactor = _scSmooth(-0.02, 0.1, se);
		this.moonShadowFactor = _scSmooth(-0.02, 0.1, -se);
	}

	_apply() {
		const sun = this.sun;
		if (sun !== null) {
			sun.position.copy(this.sunDirection).multiplyScalar(this.sunDistance);
			sun.color.copy(this.sunColor);
			sun.intensity = this.sunIntensity;
			if (sun.shadow !== undefined && sun.shadow !== null) {
				// v2.7: интенсивность теней следует за высотой солнца (0 ночью —
				// застывшая карта заката НЕ сэмплируется; рассвет/закат без щелчка).
				const intensity = sun.castShadow === true ? this.shadowFactor : 0;
				const active = intensity > 0.002;
				sun.shadow.intensity = intensity;
				if (active && sun.shadow.autoUpdate === false) sun.shadow.needsUpdate = true;
				sun.shadow.autoUpdate = active;
			}
		}
		if (this.hemi !== null) {
			this.hemi.color.copy(this.palette.hemiSkyNight).lerp(this.palette.hemiSkyDay, this.dayFactor);
			this.hemi.groundColor.copy(this.groundColor);
			this.hemi.intensity = this.hemiIntensity;
		}
		if (this.moon !== null) {
			this.moon.position.copy(this.moonDirection).multiplyScalar(this.sunDistance);
			this.moon.color.copy(this.palette.moon);
			this.moon.intensity = this.moonIntensity;
			// v2.7: лунные тени (если rig включил moon.castShadow): карта
			// обновляется только когда луна реально светит; днём проход теней
			// луны не рендерится (экономия 1 shadow map), состав источников
			// не меняется — без рекомпиляции программ.
			const moon = this.moon;
			if (moon.castShadow === true && moon.shadow !== undefined && moon.shadow !== null) {
				moon.shadow.intensity = this.moonShadowFactor;
				const on = this.moonIntensity > 0.01 && this.moonShadowFactor > 0.002;
				if (on && moon.shadow.autoUpdate === false) moon.shadow.needsUpdate = true;
				moon.shadow.autoUpdate = on;
			}
		}
		if (this.fogColor !== null) this.fogColor.copy(this.horizonColor);

		const sky = this.skyUniforms;
		if (sky !== null) {
			sky.uZenith.value.copy(this.zenithColor);
			sky.uHorizon.value.copy(this.horizonColor);
			sky.uSunColor.value.copy(this.sunColor);
			sky.uSunIntensity.value = this.sunIntensity;
			sky.uNightFactor.value = this.nightFactor;
		}
		const water = this.waterUniforms;
		if (water !== null) {
			water.uSunColor.value.copy(this.sunColor);
			water.uSunIntensity.value = this.sunIntensity;
			const tint = Math.max(this.dayFactor, 0.3 * this.nightFactor);
			water.uTint.value.copy(this.palette.waterTintNight).lerp(this._white, tint);
			// v2.7: плавный фейд из shadow.intensity (раньше — булев autoUpdate):
			// блики воды гаснут/растут вместе с тенями на рассвете и закате
			let fade = (sun !== null && sun.shadow !== undefined && sun.shadow !== null && sun.shadow.intensity !== undefined)
				? Math.max(0, Math.min(1, sun.shadow.intensity)) : 0;
			if (this.shadowFadeOut !== null) fade *= this.shadowFadeOut();
			water.uShadowFade.value = fade;
		}
		const lm = this.lights;
		if (lm !== null && typeof lm.setDayFactor === 'function') lm.setDayFactor(this.dayFactor);
	}
};

const TF_LIGHT_TAU = Math.PI * 2;

const LIGHT_FLICKER = {
	none: null,
	pulse: { kind: 'pulse', speed: 1.2, amount: 0.22 },
	breath: { kind: 'pulse', speed: 0.35, amount: 0.45 },
	candle: { kind: 'noise', speed: 5.5, amount: 0.3, octaves: 2 },
	torch: { kind: 'noise', speed: 3.1, amount: 0.45, octaves: 3 },
	fire: { kind: 'noise', speed: 7.5, amount: 0.7, octaves: 3 },
	tv: { kind: 'noise', speed: 21.0, amount: 0.5, octaves: 2 },
	fluorescent: { kind: 'stutter', speed: 9.0, amount: 0.85, duty: 0.07, octaves: 1 },
	broken: { kind: 'stutter', speed: 4.0, amount: 1.0, duty: 0.22, octaves: 2 },
	strobe: { kind: 'strobe', speed: 5.0, amount: 1.0, duty: 0.12 },
	beacon: { kind: 'strobe', speed: 0.8, amount: 1.0, duty: 0.08 }
};

const _lfHash1 = (n) => {
	const s = Math.sin(n * 127.1 + 311.7) * 43758.5453123;
	return s - Math.floor(s);
};
const _lfNoise1 = (x) => {
	const i = Math.floor(x);
	const f = x - i;
	const u = f * f * (3 - 2 * f);
	return _lfHash1(i) * (1 - u) + _lfHash1(i + 1) * u;
};

function tfFlickerValue(f, t, phase = 0) {
	if (f === null || f === undefined) return 1;
	const p = phase !== undefined ? phase : 0;
	switch (f.kind) {
		case 'pulse':
			return 1 + (f.amount || 0) * Math.sin(TF_LIGHT_TAU * ((t * (f.speed || 1)) + p));
		case 'strobe': {
			const s = (t * (f.speed || 1) + p) % 1;
			return s < (f.duty !== undefined ? f.duty : 0.1) ? 1 : 1 - (f.amount !== undefined ? f.amount : 1);
		}
		case 'stutter': {
			const n = _lfNoise1(t * (f.speed || 5) + p * 13.7);
			const drop = n < (f.duty !== undefined ? f.duty : 0.1) ? 1 - (f.amount !== undefined ? f.amount : 1) : 1;
			const jitter = 1 - 0.3 * (f.amount || 0) * (_lfNoise1(t * (f.speed || 5) * 3.3 + p) - 0.5);
			return drop * jitter;
		}
		case 'noise':
		default: {
			const oct = f.octaves !== undefined ? f.octaves : 2;
			let v = 0, amp = 1, tot = 0, fr = f.speed || 4;
			for (let o = 0; o < oct; o++) {
				v += amp * _lfNoise1(t * fr + p * 7.13 + o * 5.71);
				tot += amp; amp *= 0.5; fr *= 2.17;
			}
			v = tot > 0 ? v / tot : 0.5;
			return 1 + (f.amount || 0) * (v * 2 - 1);
		}
	}
}

const TFPointLightShadow = class extends LightShadow {
	constructor() {
		super(new PerspectiveCamera(90, 1, 0.5, 500));
		this.isPointLightShadow = true;
	}
};

const PointLight = class extends Light {
	constructor(color, intensity, distance = 0, decay = 2, options = {}) {
		super(color, intensity);
		this.isPointLight = true;
		this.type = 'PointLight';
		this.distance = distance;
		this.decay = decay;
		this.shadow = new TFPointLightShadow();
		const ms = options.shadowMapSize !== undefined ? options.shadowMapSize : 512;
		this.shadow.mapSize.set(ms, ms);
		this.shadow.bias = options.shadowBias !== undefined ? options.shadowBias : 0.005;
		this.shadow.normalBias = options.shadowNormalBias !== undefined ? options.shadowNormalBias : 0.02;
		this.shadow.radius = options.shadowRadius !== undefined ? options.shadowRadius : 2;
		if (options.shadowNear !== undefined) this.shadow.camera.near = options.shadowNear;
		if (options.shadowFar !== undefined) this.shadow.camera.far = options.shadowFar;
		if (options.castShadow === true) this.castShadow = true;
		this.priority = options.priority !== undefined ? options.priority : 1;
	}

	/** Световой поток в люменах (изотропный источник: lm = 4π·cd). */
	get power() { return this.intensity * 4 * Math.PI; }
	set power(p) { this.intensity = p / (4 * Math.PI); }

	/**
	 * Включить куб-тени и настроить качество.
	 * @param {number} [mapSize=512] Размер грани куб-карты (256/512/1024).
	 * @param {{near?:number, far?:number, bias?:number, normalBias?:number, radius?:number}} [o]
	 */
	enableShadow(mapSize = 512, o = {}) {
		this.castShadow = true;
		if (this.shadow.mapSize.x !== mapSize || this.shadow.mapSize.y !== mapSize) {
			this.shadow.mapSize.set(mapSize, mapSize);
			if (this.shadow.map !== null && this.shadow.map !== undefined) {
				this.shadow.map.dispose();
				this.shadow.map = null;
			}
		}
		if (o.near !== undefined) this.shadow.camera.near = o.near;
		if (o.far !== undefined) this.shadow.camera.far = o.far;
		if (o.bias !== undefined) this.shadow.bias = o.bias;
		if (o.normalBias !== undefined) this.shadow.normalBias = o.normalBias;
		if (o.radius !== undefined) this.shadow.radius = o.radius;
		this.shadow.needsUpdate = true;
		return this;
	}

	disableShadow() {
		this.castShadow = false;
		this.shadow.autoUpdate = false;
		this.shadow.needsUpdate = false;
		return this;
	}

	dispose() {
		if (typeof super.dispose === 'function') super.dispose();
		if (this.shadow !== null && this.shadow !== undefined) this.shadow.dispose();
	}

	copy(source, recursive) {
		super.copy(source, recursive);
		this.distance = source.distance;
		this.decay = source.decay;
		this.castShadow = source.castShadow;
		this.priority = source.priority !== undefined ? source.priority : 1;
		if (source.shadow !== undefined && source.shadow !== null) this.shadow = source.shadow.clone();
		return this;
	}

	toJSON(meta) {
		const data = super.toJSON(meta);
		data.object.distance = this.distance;
		data.object.decay = this.decay;
		data.object.castShadow = this.castShadow;
		if (this.shadow !== undefined && this.shadow !== null) data.object.shadow = this.shadow.toJSON();
		return data;
	}
};

const _dlBox = new Box3();
const _dlV1 = new Vector3();
const _dlV2 = new Vector3();
const _dlV3 = new Vector3();
const _dlRight = new Vector3();
const _dlUp = new Vector3();
const _dlBack = new Vector3();
const _dlCorner = new Vector3();

const DirectionalLight = class extends ThreeDirectionalLight {
	constructor(color, intensity, options = {}) {
		super(color, intensity);
		this.isTFDirectionalLight = true;
		const ms = options.shadowMapSize !== undefined ? options.shadowMapSize : 1024;
		this.shadow.mapSize.set(ms, ms);
		this.shadow.bias = options.shadowBias !== undefined ? options.shadowBias : -0.0005;
		this.shadow.normalBias = options.shadowNormalBias !== undefined ? options.shadowNormalBias : 0.02;
		this.shadow.radius = options.shadowRadius !== undefined ? options.shadowRadius : 1.5;
		if (options.range !== undefined) this.setShadowRange(0.5, options.range);
		if (options.castShadow === true) this.castShadow = true;
	}

	/** near/far теневой орто-камеры (диапазон кастеров вдоль направления). */
	setShadowRange(near, far) {
		this.shadow.camera.near = near;
		this.shadow.camera.far = far;
		this.shadow.camera.updateProjectionMatrix();
		return this;
	}

	/**
	 * Подогнать теневой орто-фрустум под объект (или Box3) и обновить матрицы.
	 *
	 * @param {THREE.Object3D|THREE.Box3} target Что накрывать тенями.
	 * @param {{padding?:number, snap?:boolean, casterMargin?:number}} [o]
	 *   padding — запас в мировых единицах по периметру;
	 *   snap — снап положения света на тексельную сетку (анти-мерцание);
	 *   casterMargin — запас по near/far для кастеров ВНЕ target.
	 * @returns {this}
	 */
	fitShadowCamera(target, o = {}) {
		if (target === undefined || target === null) return this;
		const box = target.isBox3 === true ? target : _dlBox.setFromObject(target);
		if (box.isEmpty()) return this;
		const padding = o.padding !== undefined ? o.padding : 0.5;
		const snap = o.snap !== false;
		const margin = o.casterMargin !== undefined ? o.casterMargin : 0;

		this.updateMatrixWorld(true);
		this.target.updateMatrixWorld(true);
		const shadow = this.shadow;
		shadow.updateMatrices(this);
		const cam = shadow.camera;

		const e = cam.matrixWorld.elements;
		_dlRight.set(e[0], e[1], e[2]);
		_dlUp.set(e[4], e[5], e[6]);
		_dlBack.set(e[8], e[9], e[10]);

		box.getCenter(_dlV1);
		let radius = 0;
		for (let i = 0; i < 8; i++) {
			_dlCorner.set(
				(i & 1) ? box.max.x : box.min.x,
				(i & 2) ? box.max.y : box.min.y,
				(i & 4) ? box.max.z : box.min.z
			);
			radius = Math.max(radius, _dlCorner.distanceTo(_dlV1));
		}
		radius += padding;

		const texel = radius * 2 / Math.max(1, shadow.mapSize.x);
		if (snap && texel > 0) {
			const cx = _dlV1.dot(_dlRight);
			const cy = _dlV1.dot(_dlUp);
			const sx = Math.round(cx / texel) * texel - cx;
			const sy = Math.round(cy / texel) * texel - cy;
			this.position.addScaledVector(_dlRight, sx).addScaledVector(_dlUp, sy);
			this.target.position.addScaledVector(_dlRight, sx).addScaledVector(_dlUp, sy);
			this.updateMatrixWorld(true);
			this.target.updateMatrixWorld(true);
			shadow.updateMatrices(this);
		}

		cam.left = -radius;
		cam.right = radius;
		cam.top = radius;
		cam.bottom = -radius;
		const depth = box.max.distanceTo(box.min) * 0.5 + radius;
		_dlV3.copy(this.target.position).sub(this.position);
		const axisLen = _dlV3.length();
		if (axisLen > 1e-6) _dlV3.multiplyScalar(1 / axisLen);
		else _dlV3.set(0, -1, 0);
		const distC = _dlV2.copy(_dlV1).sub(this.position).dot(_dlV3);
		cam.near = Math.max(0.01, Math.min(cam.near !== undefined ? cam.near : 0.5, distC - radius));
		cam.far = Math.max(cam.near + 1e-3, Math.max(depth * 2 + margin + radius, distC + radius + margin));
		cam.updateProjectionMatrix();
		shadow.updateMatrices(this);
		return this;
	}

	/**
	 * Держать свет и его цель привязанными к камере (бесконечный мир) и
	 * накрывать тенями сферу радиуса range вокруг точки интереса.
	 *
	 * @param {THREE.Camera} camera
	 * @param {{range?:number, distance?:number, focus?:THREE.Vector3|THREE.Object3D, snap?:boolean}} [o]
	 */
	followCamera(camera, o = {}) {
		if (camera === undefined || camera === null) return this;
		const range = o.range !== undefined ? o.range : 60;
		const dist = o.distance !== undefined ? o.distance : range * 2.5;
		camera.updateMatrixWorld(true);
		let focus;
		if (o.focus === undefined || o.focus === null) {
			focus = _dlV2.setFromMatrixPosition(camera.matrixWorld);
		} else if (o.focus.isObject3D === true) {
			o.focus.updateMatrixWorld(true);
			focus = _dlV2.setFromMatrixPosition(o.focus.matrixWorld);
		} else {
			focus = _dlV2.copy(o.focus);
		}
		_dlV1.copy(this.position).sub(this.target.position);
		if (_dlV1.lengthSq() < 1e-9) _dlV1.set(0, 1, 0);
		_dlV1.normalize().multiplyScalar(dist);
		this.target.position.copy(focus);
		this.position.copy(focus).add(_dlV1);
		this.target.updateMatrixWorld(true);
		this.updateMatrixWorld(true);
		const shadow = this.shadow;
		const cam = shadow.camera;
		const texel = range * 2 / Math.max(1, shadow.mapSize.x);
		if (o.snap !== false && texel > 0) {
			shadow.updateMatrices(this);
			const e = cam.matrixWorld.elements;
			_dlRight.set(e[0], e[1], e[2]);
			_dlUp.set(e[4], e[5], e[6]);
			const cx = focus.dot(_dlRight), cy = focus.dot(_dlUp);
			this.position.addScaledVector(_dlRight, Math.round(cx / texel) * texel - cx);
			this.position.addScaledVector(_dlUp, Math.round(cy / texel) * texel - cy);
			this.target.position.copy(this.position).sub(_dlV3.copy(_dlV1));
			this.target.updateMatrixWorld(true);
			this.updateMatrixWorld(true);
		}
		cam.left = -range; cam.right = range; cam.top = range; cam.bottom = -range;
		cam.near = Math.max(0.01, dist - range * 2);
		cam.far = dist + range * 2;
		cam.updateProjectionMatrix();
		shadow.updateMatrices(this);
		return this;
	}

	/** Направить свет на объект/точку (position остаётся, крутится target). */
	aimAt(target) {
		if (target === undefined || target === null) return this;
		if (target.isObject3D === true) {
			target.updateMatrixWorld(true);
			this.target.position.setFromMatrixPosition(target.matrixWorld);
		} else if (target.isVector3 === true) {
			this.target.position.copy(target);
		}
		this.target.updateMatrixWorld(true);
		return this;
	}

	copy(source, recursive) {
		Light.prototype.copy.call(this, source, recursive);
		this.target = source.target.clone();
		this.shadow = source.shadow.clone();
		this.isTFDirectionalLight = source.isTFDirectionalLight === true;
		return this;
	}
};

const SpotLight = class extends ThreeSpotLight {
	constructor(color, intensity, distance = 0, angle = Math.PI / 6, penumbra = 0, decay = 2, options = {}) {
		super(color, intensity, distance, angle, penumbra, decay);
		this.isTFSpotLight = true;
		const ms = options.shadowMapSize !== undefined ? options.shadowMapSize : 1024;
		this.shadow.mapSize.set(ms, ms);
		this.shadow.bias = options.shadowBias !== undefined ? options.shadowBias : -0.0005;
		this.shadow.normalBias = options.shadowNormalBias !== undefined ? options.shadowNormalBias : 0.02;
		this.shadow.radius = options.shadowRadius !== undefined ? options.shadowRadius : 1.5;
		this.shadow.focus = options.shadowFocus !== undefined ? options.shadowFocus : 1;
		this.priority = options.priority !== undefined ? options.priority : 1;
		if (options.castShadow === true) this.castShadow = true;
		if (options.target !== undefined && options.target !== null) this.aimAt(options.target);
	}

	get power() { return this.intensity * Math.PI; }
	set power(p) { this.intensity = p / Math.PI; }

	/** Угол конуса в ГРАДУСАХ + penumbra [0..1] (мягкость кромки). */
	setCone(angleDeg, penumbra) {
		if (angleDeg !== undefined) this.angle = Math.max(1e-4, Math.min(Math.PI / 2 - 1e-4, angleDeg * Math.PI / 180));
		if (penumbra !== undefined) this.penumbra = Math.max(0, Math.min(1, penumbra));
		return this;
	}

	aimAt(target) {
		if (target === undefined || target === null) return this;
		if (target.isObject3D === true) {
			target.updateMatrixWorld(true);
			this.target.position.setFromMatrixPosition(target.matrixWorld);
		} else if (target.isVector3 === true) {
			this.target.position.copy(target);
		}
		this.target.updateMatrixWorld(true);
		return this;
	}

	/**
	 * Настроить near/far теневой камеры под текущий конус.
	 * @param {number} [near=0.5]
	 * @param {number} [far] По умолчанию this.distance (или 100, если 0).
	 */
	fitShadowCamera(near = 0.5, far) {
		const f = far !== undefined ? far : (this.distance > 0 ? this.distance : 100);
		this.shadow.camera.near = Math.max(0.01, near);
		this.shadow.camera.far = Math.max(this.shadow.camera.near + 1e-3, f);
		this.shadow.camera.fov = Math.max(1e-3, this.angle * 2 * 180 / Math.PI);
		this.shadow.camera.updateProjectionMatrix();
		this.shadow.updateMatrices(this);
		return this;
	}

	copy(source, recursive) {
		super.copy(source, recursive);
		this.isTFSpotLight = source.isTFSpotLight === true;
		this.priority = source.priority !== undefined ? source.priority : 1;
		return this;
	}
};

function createLightRig(options = {}) {
	const scene = options.scene !== undefined && options.scene !== null ? options.scene : null;
	const group = options.group !== undefined && options.group !== null ? options.group : new Group();
	group.name = options.name !== undefined ? options.name : 'tfLightRig';

	const sun = options.sun !== undefined && options.sun !== null
		? options.sun
		: new SunLight(options.sunColor !== undefined ? options.sunColor : 0xfff4e2,
			options.sunIntensity !== undefined ? options.sunIntensity : 3.3);
	const hemi = options.hemi !== undefined && options.hemi !== null
		? options.hemi
		: new HemisphereLight(0xcfe4ff, 0x5c6442, 0.6);
	const moon = options.moon !== undefined && options.moon !== null
		? options.moon
		: new DirectionalLight(options.moonColor !== undefined ? options.moonColor : 0xbcd0ff, 0);

	if (options.sunShadow !== false) {
		sun.castShadow = true;
		const ms = options.sunShadowMapSize !== undefined ? options.sunShadowMapSize : 1024;
		sun.shadow.mapSize.set(ms, ms);
		sun.shadow.bias = options.sunShadowBias !== undefined ? options.sunShadowBias : -0.0004;
		sun.shadow.normalBias = options.sunShadowNormalBias !== undefined ? options.sunShadowNormalBias : 0.03;
		sun.shadow.radius = options.sunShadowRadius !== undefined ? options.sunShadowRadius : 1.6;
		sun.shadow.camera.near = options.shadowNear !== undefined ? options.shadowNear : 0.5;
		sun.shadow.camera.far = options.shadowFar !== undefined ? options.shadowFar : 260;
	}
	// v2.7: лунные тени (опция moonShadow). castShadow включается СРАЗУ —
	// состав источников (NUM_DIR_LIGHT_SHADOWS) не меняется в рантайме, поэтому
	// рекомпиляции программ при восходе/заходе луны нет; ночью SunCycle сам
	// включает autoUpdate, днём проход теней луны не рендерится.
	let moonShadowCfg = null;
	if (options.moonShadow === true || (options.moonShadow !== null && typeof options.moonShadow === 'object' && options.moonShadow !== undefined)) {
		const mo = options.moonShadow === true ? {} : options.moonShadow;
		moon.castShadow = true;
		const mms = mo.mapSize !== undefined ? mo.mapSize : 1024;
		moon.shadow.mapSize.set(mms, mms);
		moon.shadow.bias = mo.bias !== undefined ? mo.bias : -0.0004;
		moon.shadow.normalBias = mo.normalBias !== undefined ? mo.normalBias : 0.03;
		moon.shadow.radius = mo.radius !== undefined ? mo.radius : 1.6;
		moon.shadow.intensity = 0;
		moon.shadow.autoUpdate = false;
		// D2 (v2.9): карта луны обязана существовать с ПЕРВОГО кадра, даже днём:
		// castShadow=true держит NUM_DIR_LIGHT_SHADOWS>0 (sampler2DShadow в PCF),
		// а при shadow.map === null three биндит плейсхолдер без COMPARE_MODE →
		// GL INVALID_OPERATION (1282) → ВСЕ draw-pass'ы материалов с тенями
		// отбрасывались днём (кадр = одно небо). Однократный рендер карты на
		// первом кадре (needsUpdate) чинит сэмплер; вклад тени днём = 0
		// (shadow.intensity = 0), стоимость — один shadow-pass при старте.
		moon.shadow.needsUpdate = true;
		moonShadowCfg = {
			range: mo.range !== undefined ? mo.range : 60,
			distance: mo.distance !== undefined ? mo.distance : undefined
		};
	} else {
		moon.castShadow = false;
	}
	if (moon.target !== undefined && moon.target !== null) {
		group.add(moon.target);
		moon.target.position.set(0, 0, 0);
	}

	group.add(sun, hemi, moon);
	if (scene !== null) scene.add(group);

	const cycle = options.cycle !== undefined && options.cycle !== null
		? options.cycle
		: new SunCycle(Object.assign({
			sun, hemi, moon,
			fogColor: options.fogColor !== undefined ? options.fogColor : null,
			skyUniforms: options.skyUniforms !== undefined ? options.skyUniforms : null,
			waterUniforms: options.waterUniforms !== undefined ? options.waterUniforms : null,
			time: options.time,
			hoursPerSecond: options.hoursPerSecond,
			autoAdvance: options.autoAdvance,
			sunIntensityMax: options.sunIntensity,
			moonIntensityMax: options.moonIntensity,
			maxElevationDeg: options.maxElevationDeg,
			sunDistance: options.sunDistance
		}, options.cycleOptions || {}));
	cycle.sun = sun; cycle.hemi = hemi; cycle.moon = moon;

	let shadowCamera = options.camera !== undefined && options.camera !== null ? options.camera : null;

	return {
		group, sun, hemi, moon, cycle,
		setTime(hours) { cycle.setTime(hours); return this; },
		/**
		 * Привязать камеру для лунных теней (опция moonShadow): орто-фрустум
		 * луны каждый кадр следует за камерой (followCamera + тексельный снап).
		 */
		bindShadowCamera(camera) { shadowCamera = camera !== undefined && camera !== null ? camera : null; return this; },
		update(dt) {
			cycle.update(dt);
			if (moonShadowCfg !== null && shadowCamera !== null && moon.castShadow === true &&
				cycle.moonIntensity > 0.01) {
				// cycle выставил moon.position = moonDirection * sunDistance (от
				// МИРОВОГО нуля); для followCamera на мгновение возвращаем target
				// в ноль — направление света сохранится, а база переедет к камере.
				if (moon.target !== undefined && moon.target !== null) moon.target.position.set(0, 0, 0);
				moon.followCamera(shadowCamera, {
					range: moonShadowCfg.range, distance: moonShadowCfg.distance
				});
			}
			return this;
		},
		dispose() {
			group.remove(sun, hemi, moon);
			if (moon.target !== undefined && moon.target !== null) group.remove(moon.target);
			if (group.parent !== null && group.parent !== undefined) group.parent.remove(group);
			if (sun.dispose !== undefined) sun.dispose();
			if (moon.dispose !== undefined) moon.dispose();
			if (hemi.dispose !== undefined) hemi.dispose();
		}
	};
}

const _lmRankCompare = (a, b) => {
	if (a.pin !== b.pin) return a.pin ? -1 : 1;
	return b.score - a.score;
};
const _lmCamPos = new Vector3();
const _lmSphere = new Sphere();

const LightManager = class extends EventDispatcher {
	constructor(options = {}) {
		super();
		this.scene = options.scene !== undefined && options.scene !== null ? options.scene : null;
		this.camera = options.camera !== undefined && options.camera !== null ? options.camera : null;
		this.maxPointLights = options.maxPointLights !== undefined ? options.maxPointLights : 6;
		this.maxSpotLights = options.maxSpotLights !== undefined ? options.maxSpotLights : 3;
		this.pointShadowSlots = Math.min(this.maxPointLights,
			options.pointShadowSlots !== undefined ? options.pointShadowSlots : 1);
		this.spotShadowSlots = Math.min(this.maxSpotLights,
			options.spotShadowSlots !== undefined ? options.spotShadowSlots : 1);
		// v2.7: бюджет обновлений теневых карт (макс. рендеров shadow map на
		// кадр; 0 = без лимита) и частота по умолчанию (Гц; 0 = каждый кадр).
		this.shadowBudget = Math.max(0, options.shadowBudget !== undefined ? options.shadowBudget | 0 : 0);
		this.defaultShadowRate = Math.max(0, options.shadowRate !== undefined ? Number(options.shadowRate) || 0 : 0);
		this.fadeReserve = options.fadeReserve !== undefined ? options.fadeReserve : 2;
		this.fadeTime = Math.max(1e-3, options.fadeTime !== undefined ? options.fadeTime : 0.25);
		this.hysteresis = options.hysteresis !== undefined ? options.hysteresis : 0.2;
		this.defaultRange = options.defaultRange !== undefined ? options.defaultRange : 24;
		this.globalIntensity = options.globalIntensity !== undefined ? options.globalIntensity : 1;
		this.dayFactor = 0;
		this.enabled = options.enabled !== false;
		this.profile = options.profile === true;
		this.time = 0;
		this._frame = 0;
		this.entries = [];
		this.stats = { pointActive: 0, spotActive: 0, pointSlots: 0, spotSlots: 0, shadowUpdates: 0, ms: 0, culled: 0 };
		this._pointSlots = [];
		this._spotSlots = [];
		this._shadowQueue = [];
		this._frustum = new Frustum();
		this._pv = new Matrix4();
		this._hasFrustum = false;
		this._sorted = [];
		this._candidates = [];
		this._warned = { shadowBudget: false, oversubscribed: false };
		this._slotsBuilt = false;
		this._slotOptions = Object.assign({}, options);
		if (this.scene !== null) this._buildSlots();
	}

	/**
	 * Изменить бюджет источников «на лету» (смена уровня графики, настройка).
	 *
	 * Пул слотов пересоздаётся: число источников в сцене изменится, поэтому
	 * three ОДИН раз перекомпилирует программы с новым NUM_POINT_LIGHTS /
	 * NUM_SPOT_LIGHTS / NUM_*_SHADOWS. Это дорогая операция — зовите её на
	 * паузе/загрузке, а НЕ каждый кадр.
	 *
	 * @param {number} [maxPoint] Активных точечных источников.
	 * @param {number} [maxSpot] Активных прожекторов.
	 * @param {{pointShadowSlots?:number, spotShadowSlots?:number,
	 *   pointShadowMapSize?:number, spotShadowMapSize?:number}} [o]
	 * @returns {this}
	 */
	setBudget(maxPoint, maxSpot, o = {}) {
		if (maxPoint !== undefined && maxPoint !== null) {
			this.maxPointLights = Math.max(0, maxPoint | 0);
		}
		if (maxSpot !== undefined && maxSpot !== null) {
			this.maxSpotLights = Math.max(0, maxSpot | 0);
		}
		if (o.pointShadowSlots !== undefined) this.pointShadowSlots = Math.max(0, o.pointShadowSlots | 0);
		if (o.spotShadowSlots !== undefined) this.spotShadowSlots = Math.max(0, o.spotShadowSlots | 0);
		if (o.shadowBudget !== undefined) this.shadowBudget = Math.max(0, o.shadowBudget | 0);
		if (o.shadowRate !== undefined) {
			this.defaultShadowRate = Math.max(0, Number(o.shadowRate) || 0);
			for (let i = 0; i < this.entries.length; i++) {
				const e = this.entries[i];
				if (e._shadowRateExplicit !== true) e.shadowRate = this.defaultShadowRate;
			}
		}
		this.pointShadowSlots = Math.min(this.pointShadowSlots, this.maxPointLights);
		this.spotShadowSlots = Math.min(this.spotShadowSlots, this.maxSpotLights);
		Object.assign(this._slotOptions, o);
		if (this.scene === null) return this;
		this._disposeSlots(this._pointSlots);
		this._disposeSlots(this._spotSlots);
		this._pointSlots.length = 0;
		this._spotSlots.length = 0;
		for (let i = 0; i < this.entries.length; i++) {
			this.entries[i].slot = -1;
			this.entries[i].blend = 0;
			this.entries[i].active = false;
		}
		this._slotsBuilt = false;
		this._warned.oversubscribed = false;
		return this._buildSlots();
	}

	/** Привязать сцену (пул слотов создаётся один раз). */
	setScene(scene) {
		if (this.scene === scene) return this;
		if (this.scene !== null && this._slotsBuilt === true) {
			this._disposeSlots(this._pointSlots);
			this._disposeSlots(this._spotSlots);
			this._pointSlots.length = 0;
			this._spotSlots.length = 0;
			for (let i = 0; i < this.entries.length; i++) {
				this.entries[i].slot = -1;
				this.entries[i].blend = 0;
				this.entries[i].active = false;
			}
			this._slotsBuilt = false;
		}
		this.scene = scene !== undefined && scene !== null ? scene : null;
		if (this.scene !== null) this._buildSlots();
		return this;
	}

	_buildSlots() {
		if (this._slotsBuilt === true || this.scene === null) return this;
		this._slotsBuilt = true;
		const options = this._slotOptions;
		const pointTotal = this.maxPointLights + this.fadeReserve;
		const spotTotal = this.maxSpotLights + this.fadeReserve;
		for (let i = 0; i < pointTotal; i++) {
			const l = new PointLight(0xffffff, 0, this.defaultRange, 2);
			l.name = 'tfPointSlot' + i;
			if (i < this.pointShadowSlots) {
				l.enableShadow(options.pointShadowMapSize !== undefined ? options.pointShadowMapSize : 512);
				l.shadow.autoUpdate = false;
				l.shadow.needsUpdate = false;
			}
			this.scene.add(l);
			this._pointSlots.push({ light: l, shadowCapable: i < this.pointShadowSlots, entry: null });
		}
		for (let i = 0; i < spotTotal; i++) {
			const l = new SpotLight(0xffffff, 0, this.defaultRange, Math.PI / 6, 0.2, 2);
			l.name = 'tfSpotSlot' + i;
			if (i < this.spotShadowSlots) {
				l.castShadow = true;
				l.shadow.mapSize.set(options.spotShadowMapSize !== undefined ? options.spotShadowMapSize : 1024,
					options.spotShadowMapSize !== undefined ? options.spotShadowMapSize : 1024);
				l.shadow.autoUpdate = false;
				l.shadow.needsUpdate = false;
			}
			this.scene.add(l);
			if (l.target !== undefined && l.target !== null) this.scene.add(l.target);
			this._spotSlots.push({ light: l, shadowCapable: i < this.spotShadowSlots, entry: null });
		}
		return this;
	}

	/**
	 * Зарегистрировать источник.
	 *
	 * @param {THREE.PointLight|THREE.SpotLight|object} light Либо источник (в сцену
	 *   НЕ добавлять), либо дескриптор { type:'point'|'spot', color, intensity,
	 *   distance, decay, angle, penumbra, position }.
	 * @param {{range?:number, priority?:number, follow?:THREE.Object3D,
	 *   shadow?:boolean, flicker?:string|object, phase?:number, group?:string,
	 *   dayDim?:number, pin?:boolean, enabled?:boolean}} [options]
	 *   range — радиус действия для куллинга/скоринга (по умолчанию
	 *     light.distance, иначе defaultRange);
	 *   follow — объект, к которому привязана позиция источника;
	 *   shadow — просить теневой слот (если бюджет исчерпан, свет без теней);
	 *   flicker — имя пресета LIGHT_FLICKER или конфиг;
	 *   dayDim — насколько гасить свет днём (0..1, требует setDayFactor);
	 *   pin — гарантированное место в бюджете (например, фонарь игрока).
	 * @returns {object|null} Внутренняя запись (entry) или null.
	 */
	add(light, options = {}) {
		if (light === undefined || light === null) return null;
		let src = light;
		if (light.isLight !== true) {
			const d = light;
			const type = d.type === 'spot' ? 'spot' : 'point';
			src = type === 'spot'
				? new SpotLight(d.color, d.intensity, d.distance, d.angle, d.penumbra, d.decay)
				: new PointLight(d.color, d.intensity, d.distance, d.decay);
			if (d.position !== undefined && d.position !== null) src.position.copy(d.position);
		}
		const existing = this.find(src);
		if (existing !== null) return existing;
		const isSpot = src.isSpotLight === true;
		if (!isSpot && src.isPointLight !== true) {
			console.warn('ThreeForge: LightManager.add — поддержаны PointLight и SpotLight; ' +
				'для солнца/луны используйте SunLight/DirectionalLight напрямую (они не входят в бюджет).');
			return null;
		}
		const range = options.range !== undefined ? options.range
			: (src.distance > 0 ? src.distance : this.defaultRange);
		const entry = {
			light: src,
			type: isSpot ? 'spot' : 'point',
			range: Math.max(0.01, range),
			priority: options.priority !== undefined ? options.priority
				: (src.priority !== undefined ? src.priority : 1),
			follow: options.follow !== undefined && options.follow !== null ? options.follow : null,
			followTarget: options.followTarget !== undefined && options.followTarget !== null ? options.followTarget : null,
			shadow: options.shadow === true && src.shadow !== undefined && src.shadow !== null,
			shadowRate: options.shadowRate !== undefined ? Math.max(0, Number(options.shadowRate) || 0) : this.defaultShadowRate,
			_shadowRateExplicit: options.shadowRate !== undefined,
			_lastShadowTime: -1e9,
			_shadowWants: false,
			flicker: this._resolveFlicker(options.flicker),
			phase: options.phase !== undefined ? options.phase : Math.random(),
			group: options.group !== undefined ? options.group : 'default',
			dayDim: options.dayDim !== undefined ? Math.max(0, Math.min(1, options.dayDim)) : 0,
			pin: options.pin === true,
			enabled: options.enabled !== false,
			blend: 0,
			slot: -1,
			score: 0,
			active: false,
			inFrustum: true,
			flickerValue: 1,
			_want: false,
			_dayMul: 1,
			_usedMark: -1,
			position: new Vector3().copy(src.position),
			targetPosition: new Vector3(0, 0, -1),
			distanceToCamera: 0
		};
		this.entries.push(entry);
		return entry;
	}

	/** Снять источник с регистрации (слот освобождается на следующем кадре). */
	remove(light) {
		const entry = this._entry(light);
		if (entry === null) return this;
		const i = this.entries.indexOf(entry);
		if (i !== -1) this.entries.splice(i, 1);
		if (entry.slot >= 0) {
			const slots = entry.type === 'spot' ? this._spotSlots : this._pointSlots;
			if (slots[entry.slot] !== undefined && slots[entry.slot].entry === entry) slots[entry.slot].entry = null;
			entry.slot = -1;
		}
		entry.blend = 0;
		return this;
	}

	find(light) {
		for (let i = 0; i < this.entries.length; i++) if (this.entries[i].light === light) return this.entries[i];
		return null;
	}

	setEnabled(light, on) {
		const e = this._entry(light);
		if (e !== null) e.enabled = on !== false;
		return this;
	}

	setIntensity(light, v) {
		const e = this._entry(light);
		if (e !== null) e.light.intensity = v;
		return this;
	}

	setRange(light, range) {
		const e = this._entry(light);
		if (e !== null) {
			e.range = Math.max(0.01, range);
			if (e.light.distance > 0) e.light.distance = e.range;
		}
		return this;
	}

	setPriority(light, p) {
		const e = this._entry(light);
		if (e !== null) e.priority = p;
		return this;
	}

	/**
	 * Частота обновления теневой карты источника (Гц; 0 = каждый кадр).
	 * Для статичных факелов/ламп достаточно 5–15 Гц —shadow map рендерится
	 * реже, артефакты устаревания не видны (свет не двигается).
	 */
	setShadowRate(light, hz) {
		const e = this._entry(light);
		if (e !== null) {
			e.shadowRate = Math.max(0, Number(hz) || 0);
			e._shadowRateExplicit = true;
		}
		return this;
	}

	/** Мерцание: имя пресета (LIGHT_FLICKER), конфиг или null (ровный свет). */
	setFlicker(light, preset) {
		const e = this._entry(light);
		if (e !== null) e.flicker = this._resolveFlicker(preset);
		return this;
	}

	_resolveFlicker(f) {
		if (f === undefined || f === null || f === false) return null;
		if (typeof f === 'string') {
			const p = LIGHT_FLICKER[f];
			if (p === undefined) {
				console.warn('ThreeForge: LightManager — неизвестный пресет мерцания: ' + f);
				return null;
			}
			return p;
		}
		return f;
	}

	/** Массовое включение/выключение группы (например, 'torches'). */
	setGroupEnabled(group, on) {
		for (let i = 0; i < this.entries.length; i++) {
			if (this.entries[i].group === group) this.entries[i].enabled = on !== false;
		}
		return this;
	}

	/** 0 = ночь, 1 = день. SunCycle пишет сам (options.lights / bindLightManager). */
	setDayFactor(f) {
		this.dayFactor = Math.max(0, Math.min(1, isFinite(f) ? f : 0));
		return this;
	}

	_entry(lightOrEntry) {
		if (lightOrEntry === undefined || lightOrEntry === null) return null;
		if (lightOrEntry.light !== undefined && lightOrEntry.blend !== undefined) return lightOrEntry;
		return this.find(lightOrEntry);
	}

	/**
	 * Кадровое обновление: куллинг → скоринг → бюджет → кроссфейд → запись в слоты.
	 * @param {number} dt Секунды с прошлого кадра.
	 * @param {THREE.Camera} [camera]
	 */
	update(dt, camera) {
		const t0 = this.profile === true ? _tfNow() : 0;
		if (!(dt > 0)) dt = 1 / 60;
		this.time += dt;
		if (this.enabled === false) return this;
		if (this._slotsBuilt === false) this._buildSlots();
		if (this._slotsBuilt === false) return this;

		const cam = (camera !== undefined && camera !== null &&
			(camera.isCamera === true || camera.isObject3D === true)) ? camera : this.camera;
		if (cam !== null && cam !== undefined) {
			cam.updateMatrixWorld();
			this._pv.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
			this._frustum.setFromProjectionMatrix(this._pv);
			this._hasFrustum = true;
			_lmCamPos.setFromMatrixPosition(cam.matrixWorld);
		} else {
			this._hasFrustum = false;
			_lmCamPos.set(0, 0, 0);
		}

		let culled = 0;
		const entries = this.entries;
		for (let i = 0; i < entries.length; i++) {
			const e = entries[i];
			const src = e.light;
			if (e.follow !== null) {
				e.follow.updateMatrixWorld(true);
				e.position.setFromMatrixPosition(e.follow.matrixWorld);
			} else if (src.parent !== null && src.parent !== undefined) {
				src.updateMatrixWorld(true);
				e.position.setFromMatrixPosition(src.matrixWorld);
			} else {
				e.position.copy(src.position);
			}
			if (src.isSpotLight === true) {
				if (e.followTarget !== null) {
					e.followTarget.updateMatrixWorld(true);
					e.targetPosition.setFromMatrixPosition(e.followTarget.matrixWorld);
				} else if (src.target !== undefined && src.target !== null) {
					src.target.updateMatrixWorld(true);
					e.targetPosition.setFromMatrixPosition(src.target.matrixWorld);
				}
			}
			e.distanceToCamera = e.position.distanceTo(_lmCamPos);
			if (this._hasFrustum) {
				_lmSphere.center.copy(e.position);
				_lmSphere.radius = e.range;
				e.inFrustum = this._frustum.intersectsSphere(_lmSphere);
			} else {
				e.inFrustum = true;
			}
			const want = e.enabled === true && e.inFrustum === true;
			if (!want) culled++;
			const rn = e.distanceToCamera / e.range;
			const att = 1 / (1 + rn * rn * 4);
			e.flickerValue = e.flicker !== null ? tfFlickerValue(e.flicker, this.time, e.phase) : 1;
			const dayMul = e.dayDim > 0 ? 1 - e.dayDim * this.dayFactor : 1;
			e.score = want
				? Math.max(0, src.intensity) * att * Math.max(0, e.priority) * Math.max(0, e.flickerValue) * dayMul
				: 0;
			if (e.slot >= 0) e.score *= 1 + this.hysteresis;
			e._want = want;
			e._dayMul = dayMul;
		}

		for (let ti = 0; ti < 2; ti++) {
			const type = ti === 0 ? 'point' : 'spot';
			const budget = ti === 0 ? this.maxPointLights : this.maxSpotLights;
			const list = this._sorted;
			list.length = 0;
			for (let i = 0; i < entries.length; i++) if (entries[i].type === type) list.push(entries[i]);
			list.sort(_lmRankCompare);
			let n = 0, want = 0;
			for (let i = 0; i < list.length; i++) {
				const e = list[i];
				if (e._want === false) { e.active = false; continue; }
				want++;
				e.active = n < budget;
				if (e.active === true) n++;
			}
			if (want > budget && this._warned.oversubscribed === false) {
				this._warned.oversubscribed = true;
				console.warn('ThreeForge: LightManager — в зоне видимости ' + want + ' ' + type +
					'-источников при бюджете ' + budget + '. Лишние гасятся (считайте range/priority ' +
					'или поднимите max' + (ti === 0 ? 'Point' : 'Spot') + 'Lights).');
			}
		}

		const k = 1 - Math.exp(-dt / this.fadeTime);
		for (let i = 0; i < entries.length; i++) {
			const e = entries[i];
			const target = e.active === true ? 1 : 0;
			e.blend += (target - e.blend) * k;
			if (e.blend < 0.002) e.blend = 0;
			else if (e.blend > 0.995) e.blend = 1;
		}

		this._frame++;
		const pointActive = this._assignSlots(this._pointSlots, 'point');
		const spotActive = this._assignSlots(this._spotSlots, 'spot');
		const shadowUpdates = this._grantShadowUpdates();

		this.stats.culled = culled;
		this.stats.pointActive = pointActive;
		this.stats.spotActive = spotActive;
		this.stats.pointSlots = this._pointSlots.length;
		this.stats.spotSlots = this._spotSlots.length;
		this.stats.shadowUpdates = shadowUpdates;
		this.stats.entries = entries.length;
		if (this.profile === true) this.stats.ms = _tfNow() - t0;
		return this;
	}

	_assignSlots(slots, type) {
		const cand = this._candidates;
		cand.length = 0;
		for (let i = 0; i < this.entries.length; i++) {
			const e = this.entries[i];
			if (e.type !== type) continue;
			if (e.blend <= 0 && e.active !== true) {
				if (e.slot >= 0 && slots[e.slot] !== undefined && slots[e.slot].entry === e) {
					slots[e.slot].entry = null;
					e.slot = -1;
				}
				continue;
			}
			cand.push(e);
		}
		cand.sort((a, b) => {
			if (a.active !== b.active) return a.active ? -1 : 1;
			return b.score - a.score;
		});

		const frame = this._frame;
		for (let i = 0; i < slots.length; i++) {
			const s = slots[i];
			if (s.entry !== null && cand.indexOf(s.entry) === -1) s.entry = null;
		}
		for (let i = 0; i < slots.length; i++) {
			if (slots[i].entry !== null) slots[i].entry._usedMark = frame;
		}

		let ci = 0;
		for (let i = 0; i < slots.length; i++) {
			const s = slots[i];
			if (s.shadowCapable !== true || s.entry !== null) continue;
			while (ci < cand.length && (cand[ci]._usedMark === frame || cand[ci].shadow !== true)) ci++;
			if (ci >= cand.length) break;
			s.entry = cand[ci];
			cand[ci].slot = i;
			cand[ci]._usedMark = frame;
			ci++;
		}
		ci = 0;
		for (let i = 0; i < slots.length; i++) {
			const s = slots[i];
			if (s.entry !== null) continue;
			while (ci < cand.length && cand[ci]._usedMark === frame) ci++;
			if (ci >= cand.length) break;
			s.entry = cand[ci];
			cand[ci].slot = i;
			cand[ci]._usedMark = frame;
			ci++;
		}
		for (let i = 0; i < cand.length; i++) {
			if (cand[i]._usedMark !== frame && cand[i].slot >= 0) cand[i].slot = -1;
		}
		for (let i = 0; i < cand.length; i++) {
			if (cand[i].slot < 0) { cand[i].blend = 0; cand[i].active = false; }
		}

		let active = 0;
		for (let i = 0; i < slots.length; i++) {
			const s = slots[i];
			const L = s.light;
			const e = s.entry;
			if (e === null) {
				L.intensity = 0;
				if (L.shadow !== undefined && L.shadow !== null) {
					L.shadow.autoUpdate = false;
					L.shadow.needsUpdate = false;
				}
				continue;
			}
			const src = e.light;
			if (e.active === true) active++;
			L.position.copy(e.position);
			L.color.copy(src.color);
			L.distance = src.distance > 0 ? src.distance : e.range;
			if (src.decay !== undefined) L.decay = src.decay;
			const dayMul = e._dayMul !== undefined ? e._dayMul : 1;
			L.intensity = src.intensity * e.blend * e.flickerValue * dayMul * this.globalIntensity;
			if (L.isSpotLight === true) {
				if (src.angle !== undefined) L.angle = src.angle;
				if (src.penumbra !== undefined) L.penumbra = src.penumbra;
				L.target.position.copy(e.targetPosition);
				L.target.updateMatrixWorld(true);
			}
			if (s.shadowCapable === true && L.shadow !== undefined && L.shadow !== null) {
				this._syncShadow(L, src, e);
			} else if (L.shadow !== undefined && L.shadow !== null) {
				L.shadow.autoUpdate = false;
				L.shadow.needsUpdate = false;
			}
		}
		return active;
	}

	_syncShadow(L, src, e) {
		const sh = L.shadow;
		const ssh = src.shadow;
		const on = e.shadow === true && e.blend > 0.02 && e.active === true;
		if (ssh !== undefined && ssh !== null) {
			if (sh.mapSize.x !== ssh.mapSize.x || sh.mapSize.y !== ssh.mapSize.y) {
				sh.mapSize.copy(ssh.mapSize);
				if (sh.map !== null && sh.map !== undefined) { sh.map.dispose(); sh.map = null; }
			}
			sh.bias = ssh.bias;
			sh.normalBias = ssh.normalBias;
			sh.radius = ssh.radius;
			if (ssh.intensity !== undefined) sh.intensity = ssh.intensity;
			if (sh.camera !== undefined && sh.camera !== null && ssh.camera !== undefined && ssh.camera !== null) {
				if (sh.camera.near !== ssh.camera.near) { sh.camera.near = ssh.camera.near; sh.camera.updateProjectionMatrix(); }
				if (L.isSpotLight === true && sh.camera.far !== ssh.camera.far) {
					sh.camera.far = ssh.camera.far;
					sh.camera.updateProjectionMatrix();
				}
				if (L.isSpotLight === true && sh.camera.fov !== undefined && ssh.camera.fov !== undefined &&
					sh.camera.fov !== ssh.camera.fov) {
					sh.camera.fov = ssh.camera.fov;
					sh.camera.updateProjectionMatrix();
				}
			}
		}
		// v2.7: вместо autoUpdate «каждый кадр» — планирование (rate + бюджет):
		// _syncShadow лишь помечает ЗАПРОС обновления, реальные гранты
		// раздаёт _grantShadowUpdates() (round-robin по времени ожидания).
		sh.autoUpdate = false;
		if (on !== true) { sh.needsUpdate = false; e._shadowWants = false; return; }
		const first = (sh.map === null || sh.map === undefined);
		const rate = e.shadowRate > 0 ? e.shadowRate : 0;
		const due = first === true || rate <= 0 || (this.time - e._lastShadowTime) >= 1 / rate;
		e._shadowWants = due;
		if (due !== true) sh.needsUpdate = false;
	}

	_grantShadowUpdates() {
		const wants = this._shadowQueue;
		wants.length = 0;
		const collect = (slots) => {
			for (let i = 0; i < slots.length; i++) {
				const s = slots[i];
				if (s.entry !== null && s.entry._shadowWants === true) wants.push(s);
			}
		};
		collect(this._pointSlots);
		collect(this._spotSlots);
		const time = this.time;
		if (this.shadowBudget > 0 && wants.length > this.shadowBudget) {
			wants.sort((a, b) => {
				const fa = (a.light.shadow.map === null || a.light.shadow.map === undefined) ? 1 : 0;
				const fb = (b.light.shadow.map === null || b.light.shadow.map === undefined) ? 1 : 0;
				if (fa !== fb) return fb - fa;
				const wa = time - a.entry._lastShadowTime;
				const wb = time - b.entry._lastShadowTime;
				if (Math.abs(wa - wb) > 1e-9) return wb - wa;
				return b.entry.score - a.entry.score;
			});
		}
		let granted = 0;
		for (let i = 0; i < wants.length; i++) {
			const s = wants[i];
			const e = s.entry;
			if (this.shadowBudget > 0 && granted >= this.shadowBudget) {
				s.light.shadow.needsUpdate = false;
				continue;
			}
			s.light.shadow.needsUpdate = true;
			e._lastShadowTime = time;
			e._shadowWants = false;
			granted++;
		}
		wants.length = 0;
		return granted;
	}

	_countShadowUpdates() {
		return this._countShadowIn(this._pointSlots) + this._countShadowIn(this._spotSlots);
	}

	_countShadowIn(slots) {
		let n = 0;
		for (let i = 0; i < slots.length; i++) {
			const L = slots[i].light;
			if (L.castShadow === true && L.shadow !== undefined && L.shadow !== null &&
				(L.shadow.autoUpdate === true || L.shadow.needsUpdate === true)) n++;
		}
		return n;
	}

	getStats() {
		return Object.assign({ entries: this.entries.length }, this.stats);
	}

	/** Список активных источников (для отладки/HUD). */
	getActive(out = []) {
		out.length = 0;
		for (let i = 0; i < this.entries.length; i++) if (this.entries[i].active === true) out.push(this.entries[i]);
		return out;
	}

	/** Сбросить все слоты и бленды (смена сцены/уровня, телепорт камеры). */
	restoreAll() {
		this._clearSlots(this._pointSlots);
		this._clearSlots(this._spotSlots);
		for (let i = 0; i < this.entries.length; i++) {
			const e = this.entries[i];
			e.blend = 0; e.slot = -1; e.active = false;
		}
		return this;
	}

	_clearSlots(slots) {
		for (let i = 0; i < slots.length; i++) {
			slots[i].light.intensity = 0;
			slots[i].entry = null;
			const sh = slots[i].light.shadow;
			if (sh !== undefined && sh !== null) {
				sh.autoUpdate = false;
				sh.needsUpdate = false;
			}
		}
		return this;
	}

	dispose() {
		this._disposeSlots(this._pointSlots);
		this._disposeSlots(this._spotSlots);
		this._pointSlots.length = 0;
		this._spotSlots.length = 0;
		this._slotsBuilt = false;
		this.entries.length = 0;
		return this;
	}

	_disposeSlots(slots) {
		for (let i = 0; i < slots.length; i++) {
			const L = slots[i].light;
			if (this.scene !== null) {
				this.scene.remove(L);
				if (L.target !== undefined && L.target !== null) this.scene.remove(L.target);
			}
			if (L.dispose !== undefined) L.dispose();
			slots[i].entry = null;
		}
	}
};

// ---------------------------------------------------------------------------
// Пресеты качества теней (v2.7 Shadow Overhaul)
//
// Один вызов applyShadowQuality('ultra', { rig, lights }) настраивает:
// каскады CSM, тиры PCF-тапов, soft-режим, размеры карт солнца/луны/слотов
// LightManager, бюджет и частоту обновлений. Пресет 'high' = прежнее
// поведение движка по умолчанию (2 каскада × 1024, 12 тапов, без soft).
//
// VRAM карт солнца (depth, 4 байта/тексель, атлас = tiles × mapSize):
//   low/medium/high: 2×1024 → 2048×1024 ≈ 8 МБ;
//   ultra: tiles [2,1,1,1] × 1536 → 7680×1536 ≈ 47 МБ.
// ---------------------------------------------------------------------------
const SHADOW_QUALITY_PRESETS = {
	low: {
		cascades: 2, taps: 4, soft: false, fadeAllLights: true, splitLambda: 0.5,
		sunMapSize: 1024, sunTiles: null, moonMapSize: 512,
		dirMapSize: 512, spotMapSize: 512, pointMapSize: 256,
		shadowBudget: 1, shadowRate: 12
	},
	medium: {
		cascades: 2, taps: 8, soft: false, fadeAllLights: true, splitLambda: 0.5,
		sunMapSize: 1024, sunTiles: null, moonMapSize: 512,
		dirMapSize: 1024, spotMapSize: 1024, pointMapSize: 512,
		shadowBudget: 2, shadowRate: 24
	},
	high: {
		cascades: 2, taps: 12, soft: false, fadeAllLights: true, splitLambda: 0.5,
		sunMapSize: 1024, sunTiles: null, moonMapSize: 1024,
		dirMapSize: 1024, spotMapSize: 1024, pointMapSize: 512,
		shadowBudget: 0, shadowRate: 0
	},
	ultra: {
		cascades: 4, taps: 16, soft: { mix: 0.55, depthGrowth: 0.45, radius: 3.0 },
		fadeAllLights: true, splitLambda: 0.6,
		sunMapSize: 1536, sunTiles: [2, 1, 1, 1], moonMapSize: 1024,
		dirMapSize: 2048, spotMapSize: 2048, pointMapSize: 1024,
		shadowBudget: 0, shadowRate: 0
	}
};

const SHADOW_QUALITY_ORDER = ['low', 'medium', 'high', 'ultra'];

/**
 * Применить пресет качества теней ко всем связанным целям.
 *
 * Смена каскадов/тапов/soft ПЕРЕКОМПИЛИРУЕТ пропатченные материалы (one-time
 * фриз) — зовите на загрузке/паузе, не в бою.
 *
 * @param {string|object} preset Имя ('low'|'medium'|'high'|'ultra') или объект-пресет.
 * @param {{rig?:object, sun?:THREE.Light, lights?:LightManager, directional?:THREE.DirectionalLight}} [targets]
 *   rig — объект createLightRig (возьмёт sun и moon сам);
 *   sun — SunLight напрямую (если rig не задан);
 *   lights — LightManager (бюджет/частота/размеры карт слотов);
 *   directional — одиночный DirectionalLight (размер карты).
 * @returns {object|null} Применённый пресет (копия) или null.
 */
function applyShadowQuality(preset, targets = {}) {
	const p = typeof preset === 'string' ? SHADOW_QUALITY_PRESETS[preset] : preset;
	if (p === undefined || p === null) {
		console.warn('ThreeForge: applyShadowQuality — неизвестный пресет: ' + preset +
			' (ожидается ' + SHADOW_QUALITY_ORDER.join('/') + ' или объект)');
		return null;
	}
	if (p.cascades !== undefined) setSunCascadeCount(p.cascades);
	setShadowQuality({
		taps: p.taps !== undefined ? p.taps : undefined,
		soft: p.soft !== undefined ? p.soft : false,
		fadeAllLights: p.fadeAllLights !== false
	});

	const rig = targets.rig !== undefined && targets.rig !== null ? targets.rig : null;
	const sun = targets.sun !== undefined && targets.sun !== null
		? targets.sun : (rig !== null ? rig.sun : null);
	if (sun !== null && sun.shadow !== undefined && sun.shadow !== null) {
		const sh = sun.shadow;
		if (p.sunMapSize !== undefined) sh.mapSize.set(p.sunMapSize, p.sunMapSize);
		if (p.splitLambda !== undefined && typeof sh.setSplitLambda === 'function') sh.setSplitLambda(p.splitLambda);
		if (typeof sh.setCascadeTiles === 'function') sh.setCascadeTiles(p.sunTiles !== undefined ? p.sunTiles : null);
		if (p.sunFade !== undefined && typeof sh.setCascadeFade === 'function') sh.setCascadeFade(p.sunFade);
		sh.needsUpdate = true;
	}

	const moon = rig !== null && rig.moon !== undefined ? rig.moon : null;
	if (moon !== null && moon.castShadow === true && moon.shadow !== undefined && moon.shadow !== null &&
		p.moonMapSize !== undefined) {
		moon.shadow.mapSize.set(p.moonMapSize, p.moonMapSize);
		moon.shadow.needsUpdate = true;
	}

	const dir = targets.directional !== undefined && targets.directional !== null ? targets.directional : null;
	if (dir !== null && dir.shadow !== undefined && dir.shadow !== null && p.dirMapSize !== undefined) {
		dir.shadow.mapSize.set(p.dirMapSize, p.dirMapSize);
		dir.shadow.needsUpdate = true;
	}

	const lights = targets.lights !== undefined && targets.lights !== null ? targets.lights : null;
	if (lights !== null) {
		if (p.shadowBudget !== undefined) lights.shadowBudget = Math.max(0, p.shadowBudget | 0);
		if (p.shadowRate !== undefined) {
			lights.defaultShadowRate = Math.max(0, Number(p.shadowRate) || 0);
			for (let i = 0; i < lights.entries.length; i++) {
				const e = lights.entries[i];
				if (e._shadowRateExplicit !== true) e.shadowRate = lights.defaultShadowRate;
			}
		}
		const resizeSlots = (slots, mapSize) => {
			if (mapSize === undefined) return;
			for (let i = 0; i < slots.length; i++) {
				const s = slots[i];
				if (s.shadowCapable !== true) continue;
				const sh = s.light.shadow;
				if (sh === undefined || sh === null) continue;
				if (sh.mapSize.x !== mapSize || sh.mapSize.y !== mapSize) {
					sh.mapSize.set(mapSize, mapSize);
					if (sh.map !== null && sh.map !== undefined) { sh.map.dispose(); sh.map = null; }
					sh.needsUpdate = true;
				}
			}
		};
		resizeSlots(lights._pointSlots, p.pointMapSize);
		resizeSlots(lights._spotSlots, p.spotMapSize);
	}
	return Object.assign({}, p);
}

// ---------------------------------------------------------------------------
// SunShadowHelper — отладочная визуализация каскадов CSM (v2.7).
// LineSegments: боксы орто-фрустумов каждого каскада (свой цвет) + линия
// направления света. update(camera) пересчитывает матрицы каскадов сам —
// работает даже когда теневой проход выключен (ночь, autoUpdate=false).
// ---------------------------------------------------------------------------
const SSH_CASCADE_COLORS = [0x3dff88, 0xffe14d, 0xff9e4d, 0xff5c5d];
const _sshCorners = [];
for (let i = 0; i < 8; i++) _sshCorners.push(new Vector3());
const _sshA = new Vector3();
const _sshB = new Vector3();
const _sshCenter = new Vector3();
const _sshColor = new Color();

const SunShadowHelper = class extends Group {
	/**
	 * @param {SunLight} sun Солнце с SunLightShadow.
	 * @param {{colors?:number[], showDirection?:boolean, depthTest?:boolean}} [options]
	 */
	constructor(sun, options = {}) {
		super();
		this.name = 'tfSunShadowHelper';
		this.sun = sun !== undefined && sun !== null ? sun : null;
		this.showDirection = options.showDirection !== false;
		this.maxCascades = 4;
		const colors = options.colors !== undefined && options.colors !== null ? options.colors : SSH_CASCADE_COLORS;

		const vertCount = this.maxCascades * 24 + 2;
		const positions = new Float32Array(vertCount * 3);
		const colorAttr = new Float32Array(vertCount * 3);
		// цвета статичны: 24 вершины на каскад + 2 на направление
		let v = 0;
		for (let c = 0; c < this.maxCascades; c++) {
			_sshColor.setHex(colors[c % colors.length] !== undefined ? colors[c % colors.length] : 0xffffff);
			for (let k = 0; k < 24; k++) {
				colorAttr[(v + k) * 3] = _sshColor.r;
				colorAttr[(v + k) * 3 + 1] = _sshColor.g;
				colorAttr[(v + k) * 3 + 2] = _sshColor.b;
			}
			v += 24;
		}
		_sshColor.setHex(0xffffff);
		colorAttr[v * 3] = _sshColor.r; colorAttr[v * 3 + 1] = _sshColor.g; colorAttr[v * 3 + 2] = _sshColor.b;
		colorAttr[(v + 1) * 3] = _sshColor.r; colorAttr[(v + 1) * 3 + 1] = _sshColor.g; colorAttr[(v + 1) * 3 + 2] = _sshColor.b;

		const geometry = new BufferGeometry();
		geometry.setAttribute('position', new BufferAttribute(positions, 3).setUsage(DYNAMIC_DRAW));
		geometry.setAttribute('color', new BufferAttribute(colorAttr, 3));
		geometry.setDrawRange(0, 0);
		this._positions = positions;
		this._geometry = geometry;
		this._lines = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({
			vertexColors: true,
			depthTest: options.depthTest === true,
			transparent: true
		}));
		this._lines.renderOrder = 999;
		this._lines.frustumCulled = false;
		this.add(this._lines);
		this.matrixAutoUpdate = false;
	}

	_setEdge(vi, a, b) {
		const p = this._positions;
		p[vi * 3] = a.x; p[vi * 3 + 1] = a.y; p[vi * 3 + 2] = a.z;
		p[(vi + 1) * 3] = b.x; p[(vi + 1) * 3 + 1] = b.y; p[(vi + 1) * 3 + 2] = b.z;
	}

	/**
	 * Пересчитать геометрию под текущее состояние каскадов.
	 * @param {THREE.Camera} camera View-камера (как у рендера).
	 */
	update(camera) {
		const sun = this.sun;
		const geometry = this._geometry;
		if (sun === null || sun.shadow === undefined || sun.shadow === null ||
			typeof sun.shadow.updateMatrices !== 'function') {
			geometry.setDrawRange(0, 0);
			return this;
		}
		const shadow = sun.shadow;
		if (camera !== undefined && camera !== null) {
			sun.updateMatrixWorld(true);
			camera.updateMatrixWorld(true);
			shadow.updateMatrices(sun, camera);
		}
		const n = Math.min(this.maxCascades,
			shadow._cascadeCount !== undefined ? shadow._cascadeCount : SUN_CASCADE_COUNT);
		let vi = 0;
		_sshCenter.set(0, 0, 0);
		for (let c = 0; c < n; c++) {
			const cam = shadow.getCamera(c);
			if (cam === undefined || cam === null) continue;
			for (let k = 0; k < 8; k++) {
				_sshCorners[k].set(
					(k & 1) ? cam.right : cam.left,
					(k & 2) ? cam.top : cam.bottom,
					(k & 4) ? -cam.far : -cam.near
				).applyMatrix4(cam.matrixWorld);
			}
			// 12 рёбер: нижняя грань, верхняя, вертикали
			const E = [[0, 1], [1, 3], [3, 2], [2, 0], [4, 5], [5, 7], [7, 6], [6, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
			for (let e = 0; e < 12; e++) {
				this._setEdge(vi, _sshCorners[E[e][0]], _sshCorners[E[e][1]]);
				vi += 2;
			}
			if (c === 0) {
				_sshCenter.copy(_sshCorners[0]);
				for (let k = 1; k < 8; k++) _sshCenter.add(_sshCorners[k]);
				_sshCenter.multiplyScalar(1 / 8);
			}
		}
		if (this.showDirection === true && n > 0) {
			// направление света: от центра ближнего каскада вдоль -position солнца
			_sshA.setFromMatrixPosition(sun.matrixWorld);
			if (_sshA.lengthSq() > 1e-9) _sshA.negate().normalize();
			else _sshA.set(0, -1, 0);
			const cam0 = shadow.getCamera(0);
			const len = cam0 !== undefined && cam0 !== null ? Math.max(cam0.right, 1) : 1;
			_sshB.copy(_sshCenter).addScaledVector(_sshA, len);
			this._setEdge(vi, _sshCenter, _sshB);
			vi += 2;
		}
		geometry.setDrawRange(0, vi);
		geometry.attributes.position.needsUpdate = true;
		return this;
	}

	dispose() {
		if (this._lines !== undefined) {
			this._lines.geometry.dispose();
			this._lines.material.dispose();
			this.remove(this._lines);
		}
		return this;
	}
};
/* ================================================================== */
/* v2.8 «GAMEPLAY KIT»: стилизованные материалы, FP-контроллер,         */
/* вьюмодель, рассеивание пропсов, парящие острова, HUD.                */
/* ================================================================== */

/** mulberry32 — компактный сидированный ГПСЧ для scatter/генераторов. */
function tfGameRng(seed) {
	let a = (seed >>> 0) || 1;
	return function () {
		a |= 0; a = (a + 0x6D2B79F5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/* --- GK8: стилизованный rim-патч (toon/pbr) ------------------------- */

const TF_STYLIZED_FRAG_HEAD = `
float tfStylNdv = clamp( dot( normalize( normal ), normalize( vViewPosition ) ), 0.0, 1.0 );
float tfStylRim = pow( 1.0 - tfStylNdv, tfStylRimPower ) * tfStylRimStrength;
`;
const TF_STYLIZED_FRAG_TAIL = `
gl_FragColor.rgb += tfStylRimColor * tfStylRim;
`;

/**
 * Rim-подсветка (френель) для любого материала с чанком <opaque_fragment>
 * (MeshToonMaterial/MeshStandardMaterial/...): пастельный контурный свет,
 * как у стилизованных night-сцен. Совместим с fog/shadow/sway-патчами и
 * material.copy (патч регистрируется в tfRecordPatch).
 * @param {THREE.Material} material
 * @param {object} [options] rim (сила), rimPower, rimColor, uniforms (shared).
 */
function installStylizedPatch(material, options = {}) {
	if (material === undefined || material === null) return material;
	if (material.__tfStylizedPatched === true) return material;
	const uniforms = options.uniforms !== undefined && options.uniforms !== null ? options.uniforms : {
		tfStylRimColor: { value: new Color(options.rimColor !== undefined ? options.rimColor : 0x9db8ff) },
		tfStylRimPower: { value: options.rimPower !== undefined ? options.rimPower : 2.6 },
		tfStylRimStrength: { value: options.rim !== undefined ? options.rim : 0.35 }
	};
	material.__tfStylizedPatched = true;
	material.__tfStylizedUniforms = uniforms;
	tfAddProgramCacheKey(material, 'stylized');
	tfRecordPatch(material, { name: 'stylized', replay: (copy) => installStylizedPatch(copy, Object.assign({}, options, { uniforms })) });
	tfChainOnBeforeCompile(material, function (shader) {
		shader.uniforms.tfStylRimColor = uniforms.tfStylRimColor;
		shader.uniforms.tfStylRimPower = uniforms.tfStylRimPower;
		shader.uniforms.tfStylRimStrength = uniforms.tfStylRimStrength;
		const anchor = '#include <opaque_fragment>';
		if (shader.fragmentShader.indexOf(anchor) === -1 || shader.fragmentShader.indexOf('#include <common>') === -1) {
			console.warn('ThreeForge: stylized patch — нет <opaque_fragment>/<common>, материал останется без rim');
			return;
		}
		const decl = 'uniform vec3 tfStylRimColor;\nuniform float tfStylRimPower;\nuniform float tfStylRimStrength;\n';
		shader.fragmentShader = shader.fragmentShader
			.replace('#include <common>', '#include <common>\n' + decl)
			.replace(anchor, TF_STYLIZED_FRAG_HEAD + anchor + TF_STYLIZED_FRAG_TAIL);
	});
	return material;
}

/**
 * Градиентная карта для MeshToonMaterial: ступени «toon»-освещения.
 * @param {number|number[]} stepsOrLevels число ступеней (2..8) или массив уровней 0..1.
 */
function createGradientMap(stepsOrLevels, options = {}) {
	const levels = Array.isArray(stepsOrLevels) ? stepsOrLevels.slice() : null;
	const steps = levels !== null ? levels.length
		: Math.max(2, Math.min(8, stepsOrLevels !== undefined ? stepsOrLevels | 0 : 3));
	const vals = levels !== null ? levels : (() => {
		const out = [];
		const lo = options.floor !== undefined ? options.floor : 0.42;
		for (let i = 0; i < steps; i++) out.push(lo + (1 - lo) * (i / (steps - 1)));
		return out;
	})();
	const data = new Uint8Array(steps * 4);
	for (let i = 0; i < steps; i++) {
		const v = Math.round(Math.max(0, Math.min(1, vals[i])) * 255);
		data[i * 4] = v; data[i * 4 + 1] = v; data[i * 4 + 2] = v; data[i * 4 + 3] = 255;
	}
	const tex = new DataTexture(data, steps, 1, RGBAFormat, UnsignedByteType);
	tex.magFilter = THREE.NearestFilter;
	tex.minFilter = THREE.NearestFilter;
	tex.generateMipmaps = false;
	tex.needsUpdate = true;
	return tex;
}

/**
 * Stylized-материал «как на референсе»: MeshToonMaterial (ступенчатый свет)
 * + gradientMap + rim-френель. Дружит с туманом, тенями v2.7 и sway.
 */
function createStylizedMaterial(options = {}) {
	const mat = new THREE.MeshToonMaterial({
		color: options.color !== undefined ? options.color : 0xffffff,
		side: options.side !== undefined ? options.side : THREE.FrontSide
	});
	if (options.flatShading === true) mat.flatShading = true; // define FLAT_SHADED подхватит WebGLProgram
	if (options.opacity !== undefined) { mat.opacity = options.opacity; mat.transparent = options.opacity < 1; }
	mat.gradientMap = options.gradientMap !== undefined && options.gradientMap !== null
		? options.gradientMap : createGradientMap(options.steps !== undefined ? options.steps : 3);
	if (options.emissive !== undefined) mat.emissive.set(options.emissive);
	if (options.rim !== false) installStylizedPatch(mat, options);
	return mat;
}

/* --- GK6: контроллер от первого лица -------------------------------- */

const TF_FP_DEFAULT_KEYS = {
	forward: 'KeyW', back: 'KeyS', left: 'KeyA', right: 'KeyD',
	sprint: 'ShiftLeft', jump: 'Space'
};
const _fpDelta = new Vector2();

/**
 * Walker от первого лица: pointer-lock обзор, WASD + спринт + прыжок,
 * гравитация и опора на terrain.heightAt/groundFn, head-bob.
 * Головоногий: без document работает как чистая кинематика (input=null).
 */
const FirstPersonController = class extends EventDispatcher {
	constructor(options = {}) {
		super();
		this.camera = options.camera !== undefined && options.camera !== null ? options.camera : null;
		this.input = options.input !== undefined && options.input !== null ? options.input : null;
		this.terrain = options.terrain !== undefined && options.terrain !== null ? options.terrain : null;
		this.groundFn = options.groundFn !== undefined && options.groundFn !== null ? options.groundFn
			: (this.terrain !== null ? (x, z) => this.terrain.heightAt(x, z) : null);
		this.eyeHeight = options.eyeHeight !== undefined ? options.eyeHeight : 1.65;
		this.speed = options.speed !== undefined ? options.speed : 4.2;
		this.sprintSpeed = options.sprintSpeed !== undefined ? options.sprintSpeed : 7.6;
		this.accel = options.accel !== undefined ? options.accel : 12;
		this.gravity = options.gravity !== undefined ? options.gravity : 14;
		this.jumpSpeed = options.jumpSpeed !== undefined ? options.jumpSpeed : 4.6;
		this.mouseSensitivity = options.mouseSensitivity !== undefined ? options.mouseSensitivity : 0.0022;
		this.maxPitch = options.maxPitch !== undefined ? options.maxPitch : 1.52;
		this.headBobAmp = options.headBobAmp !== undefined ? options.headBobAmp : 0.045;
		this.headBobFreq = options.headBobFreq !== undefined ? options.headBobFreq : 1.9;
		this.keys = Object.assign({}, TF_FP_DEFAULT_KEYS, options.keys || {});
		this.enabled = options.enabled !== false;
		this.yaw = options.yaw !== undefined ? options.yaw : 0;
		this.pitch = options.pitch !== undefined ? options.pitch : 0;
		this.feet = new Vector3();
		this.velocity = new Vector3();
		this.moveAxis = new Vector2();
		this.onGround = false;
		this.bobPhase = 0;
		this.bobOffset = 0;
		this.speedRatio = 0;
		this._jumpHeld = false;
		this._sys = null;
		if (this.camera !== null) {
			this.camera.rotation.order = 'YXZ';
			this.feet.set(this.camera.position.x, this.camera.position.y - this.eyeHeight, this.camera.position.z);
		}
	}

	attach(engine, priority) {
		if (this._sys !== null) this.detach(this._engine);
		this._engine = engine;
		this._sys = { update: (dt) => this.update(dt) };
		engine.addSystem(this._sys, priority !== undefined ? priority : -10);
		return this;
	}

	detach(engine) {
		const eng = engine !== undefined && engine !== null ? engine : this._engine;
		if (eng !== undefined && eng !== null && this._sys !== null) eng.removeSystem(this._sys);
		this._sys = null;
		this._engine = null;
		return this;
	}

	lock() { if (this.input !== null) this.input.lockPointer(); return this; }
	unlock() { if (this.input !== null) this.input.unlockPointer(); return this; }

	groundHeightAt(x, z) { return this.groundFn !== null ? this.groundFn(x, z) : 0; }

	teleport(x, y, z) {
		this.feet.set(x, y !== undefined && y !== null ? y : this.groundHeightAt(x, z), z);
		this.velocity.set(0, 0, 0);
		this.onGround = true;
		return this;
	}

	update(dt) {
		if (this.enabled !== true || this.camera === null) return this;
		const input = this.input;
		let ax = 0, az = 0, sprint = false, jump = false;
		if (input !== null && input.enabled !== false) {
			if (input.pointerLocked === true) {
				const d = input.consumeMouseDelta(_fpDelta);
				this.yaw -= d.x * this.mouseSensitivity;
				this.pitch -= d.y * this.mouseSensitivity;
				const mp = this.maxPitch;
				this.pitch = this.pitch > mp ? mp : (this.pitch < -mp ? -mp : this.pitch);
			}
			const k = this.keys;
			az = (input.isKeyDown(k.forward) === true ? 1 : 0) - (input.isKeyDown(k.back) === true ? 1 : 0);
			ax = (input.isKeyDown(k.right) === true ? 1 : 0) - (input.isKeyDown(k.left) === true ? 1 : 0);
			sprint = input.isKeyDown(k.sprint) === true || input.isKeyDown('ShiftRight') === true;
			jump = input.isKeyDown(k.jump) === true;
		}
		const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
		let wx = -sy * az + cy * ax;
		let wz = -cy * az - sy * ax;
		const wl = Math.hypot(wx, wz);
		if (wl > 1e-5) { wx /= wl; wz /= wl; } else { wx = 0; wz = 0; }
		const target = sprint === true ? this.sprintSpeed : this.speed;
		const damp = Math.min(1, this.accel * dt);
		this.velocity.x += (wx * target - this.velocity.x) * damp;
		this.velocity.z += (wz * target - this.velocity.z) * damp;
		if (jump === true && this.onGround === true && this._jumpHeld === false) {
			this.velocity.y = this.jumpSpeed;
			this.onGround = false;
		}
		this._jumpHeld = jump === true;
		this.velocity.y -= this.gravity * dt;
		this.feet.x += this.velocity.x * dt;
		this.feet.z += this.velocity.z * dt;
		this.feet.y += this.velocity.y * dt;
		const g = this.groundHeightAt(this.feet.x, this.feet.z);
		if (this.feet.y <= g + 1e-4 && this.velocity.y <= 0) {
			this.feet.y = g;
			this.velocity.y = 0;
			this.onGround = true;
		} else {
			this.onGround = this.velocity.y <= 0.001 && this.feet.y <= g + 0.02;
		}
		const hs = Math.hypot(this.velocity.x, this.velocity.z);
		this.speedRatio = Math.min(1, hs / Math.max(0.001, this.speed));
		this.moveAxis.set(ax, az);
		if (this.onGround === true && hs > 0.4) {
			this.bobPhase += dt * this.headBobFreq * 6.283185307 * (0.55 + 0.45 * this.speedRatio);
		}
		const bobTarget = (this.onGround === true && hs > 0.4)
			? Math.sin(this.bobPhase) * this.headBobAmp * this.speedRatio : 0;
		this.bobOffset += (bobTarget - this.bobOffset) * Math.min(1, 10 * dt);
		this.camera.position.set(this.feet.x, this.feet.y + this.eyeHeight + this.bobOffset, this.feet.z);
		this.camera.rotation.set(this.pitch, this.yaw, 0);
		return this;
	}
};

/* --- GK7: вьюмодель (оружие/руки от первого лица) -------------------- */

/**
 * Вьюмодель: отдельная сцена, рисуемая ПОСЛЕ основной в текущий render target
 * без очистки depth — корректная окклюзия миром и нулевой клиппинг дальних
 * объектов. С PostPipeline встаёт в хук scenePassHook (внутрь sceneRT),
 * без него — обёрткой engine.renderOverride.
 */
const ViewModel = class {
	constructor(options = {}) {
		this.camera = options.camera !== undefined && options.camera !== null ? options.camera : null;
		this.scene = new THREE.Scene();
		this.root = new Group();
		this.scene.add(this.root);
		this.items = [];
		this.visible = options.visible !== false;
		this.swayAmp = options.swayAmp !== undefined ? options.swayAmp : 0.018;
		this.bobAmp = options.bobAmp !== undefined ? options.bobAmp : 0.012;
		this._phase = 0;
		this._engine = null;
		this._prevOverride = null;
		this._prevHook = null;
		this._hookSet = false;
		this._boundPass = (renderer, scene, camera) => this.renderPass(renderer, camera);
	}

	add(object, options = {}) {
		if (object === undefined || object === null) return null;
		const holder = new Group();
		holder.add(object);
		const off = options.offset !== undefined && options.offset !== null ? options.offset : null;
		holder.position.set(
			off !== null && off.x !== undefined ? off.x : 0.34,
			off !== null && off.y !== undefined ? off.y : -0.36,
			off !== null && off.z !== undefined ? off.z : -0.78);
		if (options.rotation !== undefined && options.rotation !== null) {
			holder.rotation.set(options.rotation.x || 0, options.rotation.y || 0, options.rotation.z || 0);
		}
		this.root.add(holder);
		this.items.push({
			holder, object,
			base: holder.position.clone(),
			baseRot: holder.rotation.clone(),
			sway: options.sway !== undefined ? options.sway : 1,
			bob: options.bob !== undefined ? options.bob : 1
		});
		return holder;
	}

	remove(object) {
		for (let i = 0; i < this.items.length; i++) {
			if (this.items[i].object === object || this.items[i].holder === object) {
				this.root.remove(this.items[i].holder);
				this.items.splice(i, 1);
				return true;
			}
		}
		return false;
	}

	clear() {
		for (let i = 0; i < this.items.length; i++) this.root.remove(this.items[i].holder);
		this.items.length = 0;
		return this;
	}

	attach(engine) {
		if (this._engine !== null) this.detach();
		this._engine = engine;
		const pipe = engine.postPipeline !== undefined && engine.postPipeline !== null ? engine.postPipeline : null;
		if (pipe !== null) {
			this._prevHook = pipe.scenePassHook !== undefined ? pipe.scenePassHook : null;
			pipe.scenePassHook = this._boundPass;
			this._hookSet = true;
		} else {
			this._prevOverride = engine.renderOverride;
			const prev = this._prevOverride;
			engine.renderOverride = (eng, dt, alpha) => {
				if (prev !== null && prev !== undefined) prev(eng, dt, alpha);
				else if (eng.renderer !== null && eng.scene !== null && eng.camera !== null) {
					eng.renderer.render(eng.scene, eng.camera);
				}
				this.renderPass(eng.renderer, eng.camera);
			};
		}
		return this;
	}

	detach() {
		const engine = this._engine;
		if (engine === null) return this;
		const pipe = engine.postPipeline !== undefined && engine.postPipeline !== null ? engine.postPipeline : null;
		if (this._hookSet === true && pipe !== null) pipe.scenePassHook = this._prevHook;
		else engine.renderOverride = this._prevOverride;
		this._engine = null;
		this._hookSet = false;
		this._prevOverride = null;
		this._prevHook = null;
		return this;
	}

	/** @param {object} [source] FirstPersonController или {speedRatio, bobPhase}. */
	update(dt, source) {
		if (this.camera !== null) {
			this.root.position.copy(this.camera.position);
			this.root.quaternion.copy(this.camera.quaternion);
		}
		const s = source !== undefined && source !== null ? source : null;
		const ratio = s !== null && s.speedRatio !== undefined ? Math.min(1, Math.max(0, s.speedRatio)) : 0;
		const bobPhase = s !== null && s.bobPhase !== undefined ? s.bobPhase : 0;
		this._phase += dt * (1.6 + 2.6 * ratio);
		const sw0 = Math.sin(this._phase * 1.7) * this.swayAmp * (0.35 + ratio);
		const bo0 = Math.sin(bobPhase) * this.bobAmp * Math.min(1, ratio * 1.4);
		for (let i = 0; i < this.items.length; i++) {
			const it = this.items[i];
			const sw = sw0 * it.sway;
			const bo = bo0 * it.bob;
			it.holder.position.set(it.base.x + sw, it.base.y + bo, it.base.z);
			it.holder.rotation.set(it.baseRot.x, it.baseRot.y, it.baseRot.z + sw * 1.6);
		}
		return this;
	}

	renderPass(renderer, camera) {
		const cam = camera !== undefined && camera !== null ? camera : this.camera;
		if (this.visible !== true || this.items.length === 0) return this;
		if (renderer === undefined || renderer === null || cam === undefined || cam === null) return this;
		if (this.camera !== null) {
			this.root.position.copy(this.camera.position);
			this.root.quaternion.copy(this.camera.quaternion);
		}
		const prevAuto = renderer.autoClear;
		renderer.autoClear = false;
		renderer.render(this.scene, cam);
		renderer.autoClear = prevAuto;
		return this;
	}
};

/* --- GK5: парящие объекты (острова/камни в небе) -------------------- */

const FloatingProps = class {
	constructor(options = {}) {
		this.items = [];
		this.time = 0;
		this.enabled = options.enabled !== false;
		this.timeScale = options.speed !== undefined ? options.speed : 1;
		this._sys = null;
		this._engine = null;
	}

	add(object, options = {}) {
		if (object === undefined || object === null) return null;
		const item = {
			object,
			base: object.position.clone(),
			baseRot: object.rotation.clone(),
			amp: options.amp !== undefined ? options.amp : 0.5,
			freq: options.freq !== undefined ? options.freq : 0.06,
			phase: options.phase !== undefined ? options.phase : Math.random() * Math.PI * 2,
			rotSpeed: options.rotSpeed !== undefined ? options.rotSpeed : 0,
			tilt: options.tilt !== undefined ? options.tilt : 0
		};
		this.items.push(item);
		return item;
	}

	remove(object) {
		const i = this.items.findIndex(it => it.object === object);
		if (i !== -1) this.items.splice(i, 1);
		return i !== -1;
	}

	clear() { this.items.length = 0; return this; }

	update(dt) {
		if (this.enabled !== true) return this;
		this.time += dt * this.timeScale;
		const t = this.time;
		for (let i = 0; i < this.items.length; i++) {
			const it = this.items[i];
			it.object.position.y = it.base.y + Math.sin(t * it.freq * 6.283185307 + it.phase) * it.amp;
			if (it.rotSpeed !== 0) it.object.rotation.y = it.baseRot.y + t * it.rotSpeed;
			if (it.tilt !== 0) {
				it.object.rotation.z = it.baseRot.z + Math.sin(t * it.freq * 4.1 + it.phase) * it.tilt;
				it.object.rotation.x = it.baseRot.x + Math.cos(t * it.freq * 3.3 + it.phase) * it.tilt * 0.6;
			}
		}
		return this;
	}

	attach(engine, priority) {
		if (this._sys !== null) this.detach();
		this._engine = engine;
		this._sys = { update: (dt) => this.update(dt) };
		engine.addSystem(this._sys, priority !== undefined ? priority : -5);
		return this;
	}

	detach() {
		if (this._engine !== null && this._sys !== null) this._engine.removeSystem(this._sys);
		this._sys = null;
		this._engine = null;
		return this;
	}
};

/* --- GK10: HUD-плашка (DOM) ----------------------------------------- */

/**
 * Минимальный DOM-HUD в стиле референса: плашка-подсказка снизу
 * («ИГРА · Tab — … · Esc — …»), опциональные промпт и прицел.
 * В headless-среде (без document) — безопасные заглушки.
 */
const Hud = class {
	constructor(options = {}) {
		this.available = typeof document !== 'undefined';
		this.root = null;
		this.bar = null;
		this.prompt = null;
		this.cross = null;
		if (this.available !== true) return;
		const container = options.container !== undefined && options.container !== null
			? options.container : document.body;
		this.root = document.createElement('div');
		const rs = this.root.style;
		rs.position = 'fixed'; rs.inset = '0'; rs.pointerEvents = 'none';
		rs.zIndex = '30'; rs.userSelect = 'none';
		rs.fontFamily = 'ui-monospace, Menlo, Consolas, monospace';
		this.bar = document.createElement('div');
		const bs = this.bar.style;
		bs.position = 'absolute'; bs.left = '50%'; bs.bottom = '10px';
		bs.transform = 'translateX(-50%)';
		bs.background = 'rgba(24,18,30,0.72)';
		bs.border = '1px solid rgba(255,255,255,0.35)';
		bs.padding = '3px 10px'; bs.fontSize = '12px'; bs.color = '#f0eaf4';
		bs.letterSpacing = '0.4px'; bs.whiteSpace = 'nowrap';
		this.prompt = document.createElement('div');
		const ps = this.prompt.style;
		ps.position = 'absolute'; ps.left = '50%'; ps.top = '58%';
		ps.transform = 'translateX(-50%)';
		ps.background = 'rgba(24,18,30,0.66)';
		ps.border = '1px solid rgba(255,255,255,0.28)';
		ps.padding = '6px 12px'; ps.fontSize = '14px'; ps.color = '#ffffff';
		ps.display = 'none';
		this.cross = document.createElement('div');
		const cs = this.cross.style;
		cs.position = 'absolute'; cs.left = '50%'; cs.top = '50%';
		cs.width = '4px'; cs.height = '4px'; cs.margin = '-2px 0 0 -2px';
		cs.borderRadius = '50%'; cs.background = 'rgba(255,255,255,0.8)';
		cs.display = 'none';
		this.root.appendChild(this.bar);
		this.root.appendChild(this.prompt);
		this.root.appendChild(this.cross);
		container.appendChild(this.root);
		this.setHints(options.hints !== undefined ? options.hints : [], options.title !== undefined ? options.title : 'ИГРА');
		if (options.crosshair === true) this.setCrosshair(true);
	}

	setHints(hints, title) {
		if (this.available !== true) return this;
		const parts = [title !== undefined && title !== null ? title : 'ИГРА'].concat(hints || []).filter(Boolean);
		this.bar.textContent = parts.join(' · ');
		this.bar.style.display = parts.length > 0 ? 'block' : 'none';
		return this;
	}

	setPrompt(text) {
		if (this.available !== true) return this;
		if (text === undefined || text === null || text === '') this.prompt.style.display = 'none';
		else { this.prompt.textContent = String(text); this.prompt.style.display = 'block'; }
		return this;
	}

	setCrosshair(on) {
		if (this.available !== true) return this;
		this.cross.style.display = on === true ? 'block' : 'none';
		return this;
	}

	dispose() {
		if (this.available !== true) return this;
		if (this.root !== null && this.root.parentNode !== null) this.root.parentNode.removeChild(this.root);
		this.root = this.bar = this.prompt = this.cross = null;
		return this;
	}
};

/* --- GK4: рассеивание пропсов --------------------------------------- */

/**
 * Детерминированное инстанс-рассеивание пропсов (мечи, камни, декор):
 * случайные позиции в круге/rect с маской плотности, наклон/масштаб/yaw,
 * чанки InstancedMesh для frustum culling.
 * @returns {{group: THREE.Group, meshes: THREE.InstancedMesh[], count: number, dispose: Function}}
 */
function scatterProps(options = {}) {
	const geometry = options.geometry !== undefined && options.geometry !== null ? options.geometry : null;
	const material = options.material !== undefined && options.material !== null ? options.material : null;
	if (geometry === null || material === null) {
		throw new Error('ThreeForge: scatterProps — нужны options.geometry и options.material');
	}
	const rnd = tfGameRng(options.seed !== undefined ? options.seed : 1);
	const count = Math.max(1, options.count !== undefined ? options.count | 0 : 64);
	const center = options.center !== undefined && options.center !== null ? options.center : { x: 0, z: 0 };
	const radius = options.radius !== undefined ? options.radius : 60;
	const bounds = options.bounds !== undefined && options.bounds !== null ? options.bounds : null;
	const heightFn = options.heightFn !== undefined && options.heightFn !== null ? options.heightFn
		: (options.terrain !== undefined && options.terrain !== null ? (x, z) => options.terrain.heightAt(x, z) : null);
	const scaleRange = options.scale !== undefined && options.scale !== null ? options.scale : [1, 1];
	const scaleMin = Array.isArray(scaleRange) ? scaleRange[0] : scaleRange;
	const scaleMax = Array.isArray(scaleRange) ? (scaleRange[1] !== undefined ? scaleRange[1] : scaleRange[0]) : scaleRange;
	const tiltMax = options.tiltMax !== undefined ? options.tiltMax : 0.12;
	const sink = options.sink !== undefined ? options.sink : 0;
	let br = options.baseRotation !== undefined && options.baseRotation !== null ? options.baseRotation : null;
	if (Array.isArray(br)) br = { x: br[0] || 0, y: br[1] || 0, z: br[2] || 0 };
	const densityFn = options.densityFn !== undefined && options.densityFn !== null ? options.densityFn : null;
	const chunkSize = options.chunkSize !== undefined ? options.chunkSize : 0;

	const placed = [];
	let guard = 0;
	while (placed.length < count && guard < count * 12) {
		guard++;
		let x, z;
		if (bounds !== null) {
			x = bounds.minX + rnd() * (bounds.maxX - bounds.minX);
			z = bounds.minZ + rnd() * (bounds.maxZ - bounds.minZ);
		} else {
			const r = Math.sqrt(rnd()) * radius;
			const a = rnd() * Math.PI * 2;
			x = center.x + Math.cos(a) * r;
			z = center.z + Math.sin(a) * r;
		}
		if (densityFn !== null) {
			const d = Math.max(0, Math.min(1, densityFn(x, z)));
			if (rnd() > d) continue;
		}
		const s0 = scaleMin + rnd() * Math.max(0, scaleMax - scaleMin);
		// heightFn может принимать масштаб инстанса третьим аргументом (F3):
		// позволяет «воткнуть» меч на нужную высоту над землёй.
		const y = heightFn !== null ? heightFn(x, z, s0) : 0;
		placed.push({
			x, y: y - sink, z,
			s: s0,
			rx: (rnd() * 2 - 1) * tiltMax,
			rz: (rnd() * 2 - 1) * tiltMax,
			ry: rnd() * Math.PI * 2
		});
	}

	const buckets = new Map();
	for (let i = 0; i < placed.length; i++) {
		const p = placed[i];
		const key = chunkSize > 0
			? Math.floor(p.x / chunkSize) + ',' + Math.floor(p.z / chunkSize) : 'all';
		let arr = buckets.get(key);
		if (arr === undefined) { arr = []; buckets.set(key, arr); }
		arr.push(p);
	}

	const group = new Group();
	const meshes = [];
	const m4 = new Matrix4();
	const q = new Quaternion();
	const eu = new THREE.Euler();
	const vP = new Vector3();
	const vS = new Vector3();
	const bx = br !== null ? (br.x || 0) : 0;
	const by = br !== null ? (br.y || 0) : 0;
	const bz = br !== null ? (br.z || 0) : 0;
	for (const arr of buckets.values()) {
		const mesh = new InstancedMesh(geometry, material, arr.length);
		for (let i = 0; i < arr.length; i++) {
			const p = arr[i];
			eu.set(p.rx + bx, p.ry + by, p.rz + bz);
			q.setFromEuler(eu);
			vP.set(p.x, p.y, p.z);
			vS.setScalar(p.s);
			m4.compose(vP, q, vS);
			mesh.setMatrixAt(i, m4);
		}
		mesh.instanceMatrix.needsUpdate = true;
		mesh.castShadow = options.castShadow !== false;
		mesh.receiveShadow = options.receiveShadow !== false;
		mesh.computeBoundingSphere();
		meshes.push(mesh);
		group.add(mesh);
	}
	return {
		group,
		meshes,
		count: placed.length,
		dispose() {
			for (let i = 0; i < meshes.length; i++) {
				group.remove(meshes[i]);
				meshes[i].dispose();
			}
			meshes.length = 0;
		}
	};
}


const TF_EMISSIVE_TIME = { value: 0 };

const TF_EMISSIVE_GLSL = `
uniform vec3 tfEmColor;
uniform float tfEmIntensity;
uniform vec4 tfEmUv;        // (scale.xy, offset.zw)
uniform vec2 tfEmScroll;    // UV в секунду
uniform vec4 tfEmAnim;      // (pulseHz, pulseAmount, flickerAmount, phase)
uniform vec4 tfEmParams;    // (fresnelPower, fresnelAmount, maskMode, unused)
uniform vec3 tfEmFresnelColor;
uniform float tfEmTime;
#ifdef TF_EM_MAP
uniform sampler2D tfEmMap;
#endif
varying vec2 vTfEmUv;
#ifdef TF_EM_INSTANCE
varying vec3 vTfEmInst;
#endif

float tfEmHash( float n ) { return fract( sin( n ) * 43758.5453123 ); }
float tfEmNoise( float x ) {
	float i = floor( x );
	float f = fract( x );
	f = f * f * ( 3.0 - 2.0 * f );
	return mix( tfEmHash( i ), tfEmHash( i + 1.0 ), f );
}
float tfEmFlicker( float t, float seed ) {
	return tfEmNoise( t * 11.0 + seed ) * 0.6 + tfEmNoise( t * 27.3 + seed * 1.7 ) * 0.4;
}

vec3 tfApplyEmissive( vec3 base ) {
	float phase = tfEmAnim.w;
	#ifdef TF_EM_INSTANCE
		phase += fract( dot( vTfEmInst, vec3( 12.9898, 78.233, 37.719 ) ) );
	#endif
	vec3 em = tfEmColor * tfEmIntensity;
	#ifdef TF_EM_MAP
		vec2 emUv = vTfEmUv * tfEmUv.xy + tfEmUv.zw + tfEmScroll * tfEmTime;
		vec4 emTexel = texture2D( tfEmMap, emUv );
		em *= emTexel.rgb;
		float emMask = 1.0;
		if ( tfEmParams.z > 1.5 ) {
			emMask = dot( emTexel.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
		} else if ( tfEmParams.z > 0.5 ) {
			emMask = emTexel.a;
		}
		em *= emMask;
	#endif
	float t = tfEmTime + phase * 3.7;
	float emPulse = 1.0 + tfEmAnim.y * sin( PI2 * tfEmAnim.x * t );
	float emFlick = mix( 1.0, tfEmFlicker( t, phase * 17.0 ) * 1.7, clamp( tfEmAnim.z, 0.0, 1.0 ) );
	em *= max( 0.0, emPulse ) * emFlick;
	#ifdef TF_EM_FRESNEL
		vec3 emViewDir = normalize( vViewPosition );
		float emFres = pow( 1.0 - saturate( dot( normal, emViewDir ) ), max( 0.05, tfEmParams.x ) );
		em += tfEmFresnelColor * ( emFres * tfEmParams.y * max( tfEmIntensity, 1.0 ) );
	#endif
	return base + em;
}
`;

const TF_EMISSIVE_VERT_GLSL = `
#ifdef TF_EM_INSTANCE
	vec4 tfEmInstPos = vec4( 0.0, 0.0, 0.0, 1.0 );
	#ifdef USE_INSTANCING
		tfEmInstPos = instanceMatrix * tfEmInstPos;
	#endif
	vTfEmInst = tfEmInstPos.xyz;
#endif
`;

function _tfEmissiveDefaults() {
	return {
		tfEmColor: { value: new Color(1, 1, 1) },
		tfEmIntensity: { value: 1 },
		tfEmUv: { value: new Vector4(1, 1, 0, 0) },
		tfEmScroll: { value: new Vector2(0, 0) },
		tfEmAnim: { value: new Vector4(0, 0, 0, 0) },
		tfEmParams: { value: new Vector4(3, 0, 0, 0) },
		tfEmFresnelColor: { value: new Color(1, 1, 1) },
		tfEmTime: TF_EMISSIVE_TIME
	};
}

/**
 * Включить на материале «живое» свечение (светящуюся текстуру).
 *
 * Патч компонуется с туманом/тенями/дизером и добавляет стабильный ключ кэша
 * программ (tfAddProgramCacheKey), поэтому материалы с разными опциями
 * свечения НЕ сливаются в одну шейдерную программу.
 *
 * @param {THREE.Material} material MeshStandard/Physical/Lambert/Phong/Toon.
 * @param {object} [options]
 * @param {THREE.Texture} [options.map] Текстура свечения (свой сэмплер,
 *   НЕ material.emissiveMap — штатная карта three продолжает работать).
 * @param {THREE.ColorRepresentation} [options.color=0xffffff] Цвет свечения.
 * @param {number} [options.intensity=1] HDR-сила; > 1 → попадает в bloom.
 * @param {[number,number]} [options.uvScale] / [options.uvOffset] Тайлинг.
 * @param {[number,number]} [options.scroll] Скорость UV-скролла (uv/с).
 * @param {number} [options.pulseSpeed] Гц пульсации (0 = нет).
 * @param {number} [options.pulseAmount] Глубина пульсации (0..1+).
 * @param {number} [options.flicker] Глубина мерцания (0..1).
 * @param {number} [options.phase] Фаза (для рассинхронизации экземпляров).
 * @param {'none'|'alpha'|'luma'} [options.mask] Канал маски свечения.
 * @param {object|false} [options.fresnel] { power, amount, color } — ободок.
 * @param {boolean} [options.instancePhase] Разная фаза на экземпляр InstancedMesh.
 * @returns {THREE.Material} Тот же материал (патчится на месте).
 */
function installEmissivePatch(material, options = {}) {
	if (material === undefined || material === null) return material;
	if (material.__tfEmissive === true) {
		applyEmissiveOptions(material, options);
		return material;
	}
	const fragTag = '#include <emissivemap_fragment>';
	const vertParsTag = '#include <uv_pars_vertex>';
	const vertTag = '#include <uv_vertex>';
	const probe = material.fragmentShader !== undefined ? material.fragmentShader : null;
	if (probe !== null && probe.indexOf(fragTag) === -1) {
		console.warn('ThreeForge: emissive-патч — материал не содержит <emissivemap_fragment> ' +
			'(нужен MeshStandard/Physical/Lambert/Phong/Toon). Для неосвещённого свечения ' +
			'используйте MeshBasicMaterial с color > 1.');
		return material;
	}
	material.__tfEmissive = true;

	const U = _tfEmissiveDefaults();
	material.__tfEmissiveUniforms = U;
	if (material.defines === undefined || material.defines === null) material.defines = {};

	const hasMap = options.map !== undefined && options.map !== null;
	if (hasMap) {
		U.tfEmMap = { value: options.map };
		material.defines.TF_EM_MAP = '';
	}
	if (options.instancePhase === true) material.defines.TF_EM_INSTANCE = '';
	const fresnel = options.fresnel !== undefined && options.fresnel !== null && options.fresnel !== false;
	if (fresnel) material.defines.TF_EM_FRESNEL = '';

	tfAddProgramCacheKey(material, 'em' + (hasMap ? 'M' : '') + (fresnel ? 'F' : '') +
		(options.instancePhase === true ? 'I' : ''));
	tfRecordPatch(material, {
		name: 'emissive',
		replay: (copy) => {
			if (copy.defines === undefined || copy.defines === null) copy.defines = {};
			copy.__tfEmissive = undefined;
			installEmissivePatch(copy, options);
		}
	});

	tfChainOnBeforeCompile(material, function (shader) {
		for (const k in U) shader.uniforms[k] = U[k];
		if (shader.fragmentShader.indexOf(fragTag) === -1 ||
			shader.vertexShader.indexOf(vertTag) === -1 ||
			shader.vertexShader.indexOf(vertParsTag) === -1) {
			console.warn('ThreeForge: emissive-патч — чанки не найдены, материал без свечения');
			return;
		}
		shader.vertexShader = shader.vertexShader
			.replace(vertParsTag, vertParsTag + '\nvarying vec2 vTfEmUv;\n#ifdef TF_EM_INSTANCE\nvarying vec3 vTfEmInst;\n#endif')
			.replace(vertTag, vertTag + '\nvTfEmUv = uv;\n' + TF_EMISSIVE_VERT_GLSL);
		shader.fragmentShader = shader.fragmentShader
			.replace(fragTag, fragTag + '\n' + TF_EMISSIVE_GLSL +
				'\n\ttotalEmissiveRadiance = tfApplyEmissive( totalEmissiveRadiance );');
	});

	applyEmissiveOptions(material, options);
	return material;
}

/**
 * Обновить параметры уже пропатченного материала (без рекомпиляции, если не
 * меняются define'ы: map/fresnel/instancePhase задаются один раз).
 */
function applyEmissiveOptions(material, options = {}) {
	const U = material.__tfEmissiveUniforms;
	if (U === undefined || U === null) {
		console.warn('ThreeForge: applyEmissiveOptions — материал не пропатчен (сначала installEmissivePatch)');
		return material;
	}
	if (options.color !== undefined) U.tfEmColor.value.set(options.color);
	if (options.intensity !== undefined) U.tfEmIntensity.value = options.intensity;
	if (options.uvScale !== undefined) { U.tfEmUv.value.x = options.uvScale[0]; U.tfEmUv.value.y = options.uvScale[1]; }
	if (options.uvOffset !== undefined) { U.tfEmUv.value.z = options.uvOffset[0]; U.tfEmUv.value.w = options.uvOffset[1]; }
	if (options.scroll !== undefined) U.tfEmScroll.value.set(options.scroll[0], options.scroll[1]);
	if (options.pulseSpeed !== undefined) U.tfEmAnim.value.x = options.pulseSpeed;
	if (options.pulseAmount !== undefined) U.tfEmAnim.value.y = options.pulseAmount;
	if (options.flicker !== undefined) U.tfEmAnim.value.z = options.flicker;
	if (options.phase !== undefined) U.tfEmAnim.value.w = options.phase;
	if (options.mask !== undefined) {
		U.tfEmParams.value.z = options.mask === 'alpha' ? 1 : (options.mask === 'luma' ? 2 : 0);
	}
	if (options.fresnel !== undefined && options.fresnel !== null && options.fresnel !== false) {
		const f = options.fresnel;
		if (f.power !== undefined) U.tfEmParams.value.x = f.power;
		if (f.amount !== undefined) U.tfEmParams.value.y = f.amount;
		if (f.color !== undefined) U.tfEmFresnelColor.value.set(f.color);
	}
	if (options.map !== undefined && options.map !== null) {
		if (U.tfEmMap === undefined) U.tfEmMap = { value: options.map };
		else U.tfEmMap.value = options.map;
	}
	return material;
}

const EmissiveManager = class extends EventDispatcher {
	constructor(options = {}) {
		super();
		this.time = options.time !== undefined ? options.time : 0;
		this.timeUniform = TF_EMISSIVE_TIME;
		this.materials = [];
		this._tweens = [];
		this.autoTime = options.autoTime !== false;
		TF_EMISSIVE_TIME.value = this.time;
	}

	register(material) {
		if (material === undefined || material === null) return material;
		if (material.__tfEmissive !== true) installEmissivePatch(material, {});
		if (this.materials.indexOf(material) === -1) this.materials.push(material);
		return material;
	}

	unregister(material) {
		const i = this.materials.indexOf(material);
		if (i !== -1) this.materials.splice(i, 1);
		for (let k = this._tweens.length - 1; k >= 0; k--) if (this._tweens[k].material === material) this._tweens.splice(k, 1);
		return this;
	}

	/** Мгновенная сила свечения (без анимации). */
	setIntensity(material, v) {
		const U = material !== undefined && material !== null ? material.__tfEmissiveUniforms : null;
		if (U === undefined || U === null) return this;
		U.tfEmIntensity.value = v;
		return this;
	}

	/**
	 * Плавная смена силы свечения.
	 * @param {THREE.Material} material
	 * @param {number} to Целевая интенсивность.
	 * @param {number} [time=0.4] Секунды.
	 * @param {string} [easing='smooth'] 'linear'|'smooth'|'exp'.
	 */
	fadeIntensity(material, to, time = 0.4, easing = 'smooth') {
		const U = material !== undefined && material !== null ? material.__tfEmissiveUniforms : null;
		if (U === undefined || U === null) return this;
		this._tweens.push({
			material, uniform: U.tfEmIntensity, from: U.tfEmIntensity.value, to,
			t: 0, time: Math.max(1e-4, time), easing, kind: 'intensity'
		});
		return this;
	}

	/**
	 * Вспышка (взрыв, выстрел, удар): аддитивный пик силы с экспоненциальным
	 * спадом. Не конфликтует с fadeIntensity (пишет в отдельный множитель).
	 * @param {THREE.Material} material
	 * @param {number} [power=4] Высота пика (добавка к intensity).
	 * @param {number} [duration=0.3] Секунды.
	 */
	flash(material, power = 4, duration = 0.3) {
		const U = material !== undefined && material !== null ? material.__tfEmissiveUniforms : null;
		if (U === undefined || U === null) return this;
		this._tweens.push({
			material, uniform: U.tfEmIntensity, base: U.tfEmIntensity.value,
			power, t: 0, time: Math.max(1e-4, duration), kind: 'flash'
		});
		return this;
	}

	setTime(t) {
		this.time = t;
		TF_EMISSIVE_TIME.value = t;
		return this;
	}

	update(dt) {
		if (!(dt > 0)) dt = 1 / 60;
		if (this.autoTime === true) {
			this.time += dt;
			TF_EMISSIVE_TIME.value = this.time;
		}
		const tw = this._tweens;
		for (let i = tw.length - 1; i >= 0; i--) {
			const a = tw[i];
			a.t += dt;
			const p = Math.min(1, a.t / a.time);
			if (a.kind === 'flash') {
				const env = p < 0.08 ? p / 0.08 : Math.pow(1 - (p - 0.08) / 0.92, 2.4);
				a.uniform.value = a.base + a.power * Math.max(0, env);
			} else {
				const e = a.easing === 'linear' ? p : (a.easing === 'exp' ? 1 - Math.pow(1 - p, 3) : p * p * (3 - 2 * p));
				a.uniform.value = a.from + (a.to - a.from) * e;
			}
			if (p >= 1) {
				if (a.kind === 'flash') a.uniform.value = a.base;
				tw.splice(i, 1);
			}
		}
		return this;
	}

	getStats() {
		return { materials: this.materials.length, tweens: this._tweens.length, time: this.time };
	}

	dispose() {
		this.materials.length = 0;
		this._tweens.length = 0;
		return this;
	}
};

const EMISSIVE_TEXTURE_KINDS = ['glow', 'stripes', 'cells', 'grid', 'runes', 'noise', 'windows', 'scanline'];

/**
 * @param {string} [kind='glow'] Один из EMISSIVE_TEXTURE_KINDS.
 * @param {number} [size=256]
 * @param {{color?:THREE.ColorRepresentation, seed?:number, scale?:number,
 *   alphaMask?:boolean}} [options]
 * @returns {THREE.DataTexture}
 */
function createEmissiveTexture(kind = 'glow', size = 256, options = {}) {
	const n = Math.max(8, size | 0);
	const data = new Uint8Array(n * n * 4);
	const rnd = createPRNG(options.seed !== undefined ? options.seed : 1337);
	const seedK = rnd() * 1000;
	const col = new Color(options.color !== undefined ? options.color : 0xffffff);
	const scale = options.scale !== undefined ? options.scale : 1;
	const alphaMask = options.alphaMask === true;
	const k = EMISSIVE_TEXTURE_KINDS.indexOf(kind) !== -1 ? kind : 'glow';

	const put = (x, y, r, g, b, a) => {
		const o = (y * n + x) * 4;
		data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = a;
	};

	for (let y = 0; y < n; y++) {
		for (let x = 0; x < n; x++) {
			const u = (x + 0.5) / n, v = (y + 0.5) / n;
			let m = 0;
			switch (k) {
				case 'glow': {
					const dx = (u - 0.5) * 2, dy = (v - 0.5) * 2;
					const d = Math.sqrt(dx * dx + dy * dy) * scale;
					m = Math.max(0, 1 - d);
					m = m * m * (3 - 2 * m);
					break;
				}
				case 'stripes': {
					const s = Math.sin(v * Math.PI * 2 * 6 * scale) * 0.5 + 0.5;
					m = Math.pow(s, 6);
					break;
				}
				case 'cells': {
					const cs = 4 * scale;
					const cx = Math.floor(u * cs), cy = Math.floor(v * cs);
					const fx = u * cs - cx - 0.5, fy = v * cs - cy - 0.5;
					const d = Math.sqrt(fx * fx + fy * fy) * 2;
					m = Math.max(0, 1 - d);
					m *= 0.4 + 0.6 * _lfHash1(cx * 12.9898 + cy * 78.233 + seedK);
					break;
				}
				case 'grid': {
					const cs = Math.max(1, 8 * scale);
					const cellPx = n / cs;
					const lw = Math.max(1, cellPx * 0.14);
					const distX = (0.5 - Math.abs((u * cs) % 1 - 0.5)) * cellPx;
					const distY = (0.5 - Math.abs((v * cs) % 1 - 0.5)) * cellPx;
					const half = cellPx * 0.5;
					const lineX = 1 - Math.min(1, Math.max(0, (half - distX) / lw));
					const lineY = 1 - Math.min(1, Math.max(0, (half - distY) / lw));
					m = Math.max(lineX, lineY);
					break;
				}
				case 'runes': {
					const cs = 6 * scale;
					const cx = Math.floor(u * cs), cy = Math.floor(v * cs);
					const on = _lfHash1(cx * 3.1 + cy * 17.7 + seedK) > 0.55;
					const fx = Math.abs((u * cs) % 1 - 0.5) * 2;
					const fy = Math.abs((v * cs) % 1 - 0.5) * 2;
					const bar = (1 - Math.pow(fx, 8)) * (1 - Math.pow(fy, 2));
					const cross = (1 - Math.pow(fy, 12)) * (1 - Math.pow(fx, 1.4)) *
						(_lfHash1(cx * 7.7 + cy * 3.3 + seedK) > 0.5 ? 1 : 0);
					m = on ? Math.max(bar, cross) * 0.9 : 0;
					break;
				}
				case 'noise': {
					m = Math.pow(_lfHash1(x * 12.9898 + y * 78.233 + seedK), 2.2);
					break;
				}
				case 'windows': {
					const cs = 8 * scale;
					const cx = Math.floor(u * cs), cy = Math.floor(v * cs);
					const fx = (u * cs) % 1, fy = (v * cs) % 1;
					const inner = (fx > 0.2 && fx < 0.8 && fy > 0.15 && fy < 0.85) ? 1 : 0;
					const on = _lfHash1(cx * 4.7 + cy * 91.3 + seedK) > 0.45;
					m = inner && on ? 0.65 + 0.35 * _lfHash1(cx * 1.7 + cy * 3.9 + seedK) : 0;
					break;
				}
				case 'scanline':
				default: {
					const s = Math.sin((v * 40 + u * 2) * Math.PI * scale) * 0.5 + 0.5;
					m = Math.pow(s, 3) * (0.35 + 0.65 * (1 - Math.abs(u - 0.5) * 2));
					break;
				}
			}
			m = Math.max(0, Math.min(1, m));
			const a = alphaMask ? Math.round(m * 255) : 255;
			put(x, y,
				Math.round(col.r * m * 255),
				Math.round(col.g * m * 255),
				Math.round(col.b * m * 255),
				a);
		}
	}
	const tex = new DataTexture(data, n, n, RGBAFormat, UnsignedByteType);
	tex.colorSpace = SRGBColorSpace;
	tex.wrapS = tex.wrapT = RepeatWrapping;
	tex.minFilter = LinearMipmapLinearFilter;
	tex.magFilter = LinearFilter;
	tex.generateMipmaps = true;
	tex.needsUpdate = true;
	return tex;
}

/**
 * Удобный конструктор «светящегося» материала: MeshStandardMaterial с
 * установленным emissive-патчем.
 *
 * @param {object} [options] См. installEmissivePatch + { roughness, metalness,
 *   color, emissive, emissiveIntensity, side, transparent }.
 * @returns {THREE.MeshStandardMaterial}
 */
function createEmissiveMaterial(options = {}) {
	const mat = new MeshStandardMaterial({
		color: options.color !== undefined ? options.color : 0x0a0a0c,
		roughness: options.roughness !== undefined ? options.roughness : 0.55,
		metalness: options.metalness !== undefined ? options.metalness : 0.0,
		side: options.side !== undefined ? options.side : THREE.FrontSide,
		transparent: options.transparent === true,
		emissive: options.emissive !== undefined ? options.emissive : 0x000000,
		emissiveIntensity: options.emissiveIntensity !== undefined ? options.emissiveIntensity : 1
	});
	if (options.emissiveMap !== undefined && options.emissiveMap !== null) mat.emissiveMap = options.emissiveMap;
	installEmissivePatch(mat, options);
	return mat;
}

const TF_FOG_GLSL = `
uniform vec3 tfFogColor;
uniform vec4 tfFogParams;
uniform vec4 tfFogHeight;
uniform vec4 tfFogInscatter;
uniform vec3 tfFogSunDir;

// Базовый фактор по view-глубине. Линейная ветка 1:1 совпадает со встроенным
// three.js (smoothstep по vFogDepth), exp2 — с FOG_EXP2. Смешиваются униформой:
// смена режима/плотности — без рекомпиляции программ.
float tfFogBaseFactor( float viewDepth ) {
	float fLin = smoothstep( tfFogParams.x, tfFogParams.y, viewDepth );
	float fExp = 1.0 - exp( - tfFogParams.z * tfFogParams.z * viewDepth * viewDepth );
	return mix( fLin, fExp, tfFogParams.w );
}

// Аналитический height-fog: плотность rho(y) = density * exp( -falloff * (y - base) ).
// Точный интеграл вдоль луча камера -> worldPos: при b = falloff*dir.y
//   I = e^{-a} * (1 - e^{-b*D}) / b,  a = falloff*(camY - base), D = |worldPos-cam|
// (при b -> 0 предел I = e^{-a} * D). Экспоненты клампятся от переполнения.
float tfFogHeightFactor( vec3 worldPos ) {
	vec3 d = worldPos - cameraPosition;
	float dist = length( d );
	if ( dist < 1e-4 ) return 0.0;
	vec3 dir = d / dist;
	float a = tfFogHeight.y * ( cameraPosition.y - tfFogHeight.z );
	float b = tfFogHeight.y * dir.y;
	float e0 = exp( clamp( -a, -30.0, 30.0 ) );
	float integral;
	if ( abs( b ) < 1e-5 ) {
		integral = e0 * dist;
	} else {
		float e1 = exp( clamp( -a - b * dist, -30.0, 30.0 ) );
		integral = ( e0 - e1 ) / b;
	}
	integral = clamp( integral, 0.0, 1e4 );
	return clamp( 1.0 - exp( - tfFogHeight.x * integral ), 0.0, 1.0 );
}

// Итоговый фактор: база ⊕ height-слой по непрозрачности (T = T_base * T_height).
// Ветвление по униформе — когерентное, при weight=0 слой бесплатный.
float tfFogFactor( vec3 worldPos, float viewDepth ) {
	float f = tfFogBaseFactor( viewDepth );
	if ( tfFogHeight.w > 0.0 ) {
		float fh = tfFogHeightFactor( worldPos ) * tfFogHeight.w;
		f = clamp( 1.0 - ( 1.0 - f ) * ( 1.0 - fh ), 0.0, 1.0 );
	}
	return f;
}

// Цвет тумана с инсаттерингом солнца: s^8 — три умножения вместо pow().
vec3 tfFogColorFor( vec3 worldPos ) {
	vec3 dir = normalize( worldPos - cameraPosition + vec3( 1e-6 ) );
	float s = max( dot( dir, tfFogSunDir ), 0.0 );
	s *= s; s *= s; s *= s;
	return tfFogColor + tfFogInscatter.rgb * ( s * tfFogInscatter.a );
}

vec3 tfApplyFog( vec3 color, vec3 worldPos, float viewDepth ) {
	return mix( color, tfFogColorFor( worldPos ), tfFogFactor( worldPos, viewDepth ) );
}

// Для аддитивных шейдеров (вспышки, огонь): туман не подмешивает цвет,
// а ослабляет вклад источника пропорционально прозрачности среды.
float tfFogTransmittance( vec3 worldPos, float viewDepth ) {
	return 1.0 - tfFogFactor( worldPos, viewDepth );
}
`;

function installFogPatch(material, fog) {
	if (material.__tfFogPatched === true) return material;
	if (fog === undefined || fog === null || fog.uniforms === undefined) {
		console.warn('ThreeForge: installFogPatch — нужен FogManager (или объект с .uniforms); материал останется на встроенном тумане three');
		return material;
	}
	material.__tfFogPatched = true;
	tfAddProgramCacheKey(material, 'fog');
	tfRecordPatch(material, { name: 'fog', replay: (copy) => installFogPatch(copy, fog) });
	const U = fog.uniforms;
	tfChainOnBeforeCompile(material, function (shader, renderer) {
		shader.uniforms.tfFogColor = U.tfFogColor;
		shader.uniforms.tfFogParams = U.tfFogParams;
		shader.uniforms.tfFogHeight = U.tfFogHeight;
		shader.uniforms.tfFogInscatter = U.tfFogInscatter;
		shader.uniforms.tfFogSunDir = U.tfFogSunDir;

		const parsV = '#include <fog_pars_vertex>';
		const vertV = '#include <fog_vertex>';
		const parsF = '#include <fog_pars_fragment>';
		const fragF = '#include <fog_fragment>';
		if (shader.vertexShader.indexOf(parsV) === -1 || shader.vertexShader.indexOf(vertV) === -1 ||
			shader.fragmentShader.indexOf(parsF) === -1 || shader.fragmentShader.indexOf(fragF) === -1) {
			console.warn('ThreeForge: fog patch — fog-чанки не найдены, материал останется на встроенном тумане');
			return;
		}
		shader.vertexShader = shader.vertexShader
			.replace(parsV, parsV + '\n#ifdef USE_FOG\n\tvarying vec3 vTfFogWorld;\n#endif')
			.replace(vertV, vertV + `
#ifdef USE_FOG
	vec4 tfFogWorld4 = vec4( transformed, 1.0 );
	#ifdef USE_BATCHING
		tfFogWorld4 = batchingMatrix * tfFogWorld4;
	#endif
	#ifdef USE_INSTANCING
		tfFogWorld4 = instanceMatrix * tfFogWorld4;
	#endif
	vTfFogWorld = ( modelMatrix * tfFogWorld4 ).xyz;
#endif`);
		shader.fragmentShader = shader.fragmentShader
			.replace(parsF, parsF + '\n#ifdef USE_FOG\nvarying vec3 vTfFogWorld;\n' + TF_FOG_GLSL + '\n#endif')
			.replace(fragF, `
#ifdef USE_FOG
	gl_FragColor.rgb = tfApplyFog( gl_FragColor.rgb, vTfFogWorld, vFogDepth );
#endif`);
	});
	return material;
}

const FOG_PRESETS = {
	clear: {
		label: 'ясно',
		near: 60, far: 448, density: 0.0022, mode: 0,
		hDensity: 0, hFalloff: 0.05, hWeight: 0,
		tint: new Color(0xffffff), tintAmt: 0,
		inscatter: 0.28, skyFog: 0
	},
	haze: {
		label: 'дымка',
		near: 24, far: 300, density: 0.0042, mode: 0.35,
		hDensity: 0.010, hFalloff: 0.05, hWeight: 0.30,
		tint: new Color(0xdfe6ee), tintAmt: 0.25,
		inscatter: 0.40, skyFog: 0.18
	},
	fog: {
		label: 'туман',
		near: 8, far: 180, density: 0.0125, mode: 0.85,
		hDensity: 0.030, hFalloff: 0.055, hWeight: 0.65,
		tint: new Color(0xc9d2dc), tintAmt: 0.45,
		inscatter: 0.50, skyFog: 0.55
	},
	dense: {
		label: 'плотный туман',
		near: 2, far: 86, density: 0.030, mode: 1,
		hDensity: 0.055, hFalloff: 0.07, hWeight: 0.90,
		tint: new Color(0xb9c2cc), tintAmt: 0.60,
		inscatter: 0.55, skyFog: 0.85
	}
};
const FOG_PRESET_ORDER = ['auto', 'clear', 'haze', 'fog', 'dense'];
const _fogAutoTint = new Color(0xc6cfda);

const _fogFarSteps = [36, 56, 84, 120, 170, 240, 340, 480, 640, 900, 1400, 3000];

const FogManager = class extends EventDispatcher {
	constructor(options = {}) {
		super();
		this.scene = options.scene || null;
		this.camera = options.camera || null;
		this.sunCycle = options.sunCycle || null;
		this.baseColor = options.baseColor || null;
		this.sky = options.sky || null;
		this.skyRadius = options.skyRadius !== undefined ? options.skyRadius : 2400;
		this.skyUniforms = options.skyUniforms || null;
		this.waterLevel = options.waterLevel !== undefined ? options.waterLevel : 0;
		this.heightBase = options.heightBase !== undefined ? options.heightBase : 0;
		this.baseFar = options.baseFar !== undefined ? options.baseFar : 3000;
		this.responseTime = options.responseTime !== undefined ? options.responseTime : 0.9;
		this.adaptiveFar = options.adaptiveFar !== undefined ? options.adaptiveFar : true;
		this.inscatterBoost = options.inscatterBoost !== undefined ? options.inscatterBoost : 1;
		this.shaderColorSpace = options.shaderColorSpace === 'linear' ? 'linear' : 'srgb';

		this.preset = 'auto';
		this.submerge = 0;
		this.weather = null;
		this.visibility = this.baseFar;
		this.stats = { farUpdates: 0 };

		this.uniforms = {
			tfFogColor: { value: new Color(0x9fc0dd) },
			tfFogParams: { value: new Vector4(60, 448, 0.0022, 0) },
			tfFogHeight: { value: new Vector4(0, 0.05, this.heightBase, 0) },
			tfFogInscatter: { value: new Vector4(1, 0.95, 0.85, 0.28) },
			tfFogSunDir: { value: this.sunCycle !== null ? this.sunCycle.sunDirection : new Vector3(0, 1, 0) }
		};

		this._cur = {
			near: 60, far: 448, density: 0.0022, mode: 0,
			hDensity: 0, hFalloff: 0.05, hWeight: 0,
			tintAmt: 0, inscatter: 0.28, skyFog: 0
		};
		this._curColor = new Color(0x9fc0dd);
		this._target = {
			near: 60, far: 448, density: 0.0022, mode: 0,
			hDensity: 0, hFalloff: 0.05, hWeight: 0,
			tintAmt: 0, inscatter: 0.28, skyFog: 0,
			tint: new Color(0xffffff)
		};
		this._underwater = {
			near: 1, far: 46, density: 0.05, mode: 1,
			hWeight: 0, inscatter: 0.05, skyFog: 0.92,
			color: new Color(0x14425c)
		};
		this._finalColor = new Color();
		this._committed = { near: 60, far: 448, density: 0.0022, mode: 0, hWeight: 0, skyFog: 0, inscatter: 0.28 };
		this._tmpColor = new Color();
		this._sunSrgb = new Color();
		this._baseColorScratch = new Color(0x9fc0dd);
		this._farSteps = _fogFarSteps;
		this._farIdx = _fogFarSteps.length - 1;

		this.setPreset(options.preset || 'auto', true);
	}

	get presetLabel() {
		return this.preset === 'auto' ? 'авто' : (FOG_PRESETS[this.preset] !== undefined ? FOG_PRESETS[this.preset].label : this.preset);
	}

	get isUnderwater() { return this.submerge > 0.5; }

	setShaderColorSpace(mode) {
		this.shaderColorSpace = mode === 'linear' ? 'linear' : 'srgb';
		return this;
	}

	setPreset(name, immediate = false) {
		if (name !== 'auto' && FOG_PRESETS[name] === undefined) {
			console.warn('ThreeForge: FogManager — неизвестный пресет тумана: ' + name);
			return this;
		}
		this.preset = name;
		if (immediate === true) {
			if (this.camera !== null) {
				this.submerge = this.camera.position.y < this.waterLevel ? 1 : 0;
			}
			this._computeTarget(this._target);
			const c = this._cur, P = this._target;
			c.near = P.near; c.far = P.far; c.density = P.density; c.mode = P.mode;
			c.hDensity = P.hDensity; c.hFalloff = P.hFalloff; c.hWeight = P.hWeight;
			c.tintAmt = P.tintAmt; c.inscatter = P.inscatter; c.skyFog = P.skyFog;
			this._readBaseColor();
			this._curColor.copy(this._baseColorScratch).lerp(P.tint, P.tintAmt);
			this._commit();
		}
		this.dispatchEvent({ type: 'preset', preset: name, label: this.presetLabel });
		return this;
	}

	cyclePreset() {
		const i = FOG_PRESET_ORDER.indexOf(this.preset);
		return this.setPreset(FOG_PRESET_ORDER[(i + 1) % FOG_PRESET_ORDER.length]);
	}

	_computeTarget(P) {
		if (this.preset !== 'auto') {
			const p = FOG_PRESETS[this.preset];
			P.near = p.near; P.far = p.far; P.density = p.density; P.mode = p.mode;
			P.hDensity = p.hDensity; P.hFalloff = p.hFalloff; P.hWeight = p.hWeight;
			P.tintAmt = p.tintAmt; P.inscatter = p.inscatter; P.skyFog = p.skyFog;
			P.tint.copy(p.tint);
			return this._applyWeatherInfluence(P);
		}
		const c = FOG_PRESETS.clear;
		const sc = this.sunCycle;
		let morning = 0, evening = 0, sunset = 0, day = 1;
		if (sc !== null && sc !== undefined) {
			let d6 = Math.abs(sc.time - 6); d6 = Math.min(d6, 24 - d6);
			morning = Math.exp(-(d6 * d6) / (2.1 * 2.1));
			let d18 = Math.abs(sc.time - 18.5); d18 = Math.min(d18, 24 - d18);
			evening = 0.28 * Math.exp(-(d18 * d18) / (1.4 * 1.4));
			sunset = sc.sunsetFactor;
			day = sc.dayFactor;
		}
		const k = Math.min(1, morning + evening);
		P.near = c.near + (10 - c.near) * k;
		P.far = c.far + (250 - c.far) * k;
		P.density = c.density + (0.011 - c.density) * k;
		P.mode = 0.75 * k;
		P.hDensity = 0.004 + (0.05 - 0.004) * morning;
		P.hFalloff = 0.05;
		P.hWeight = Math.min(1, 0.9 * morning + 0.25 * evening);
		P.tint.copy(_fogAutoTint);
		P.tintAmt = 0.42 * k;
		P.inscatter = (0.24 + 0.5 * sunset) * (0.15 + 0.85 * day);
		P.skyFog = 0.62 * k;
		return this._applyWeatherInfluence(P);
	}

	_applyWeatherInfluence(P) {
		const w = this.weather;
		if (w === null || w === undefined) return P;
		const rain = w.rain > 0 ? w.rain : 0;
		const snow = w.snow > 0 ? w.snow : 0;
		if (rain < 0.002 && snow < 0.002) return P;
		P.far *= 1 - 0.45 * rain;
		P.near *= 1 - 0.5 * rain;
		P.density += 0.008 * rain;
		P.mode = Math.min(1, P.mode + 0.5 * rain);
		P.skyFog = Math.min(1, P.skyFog + 0.35 * rain);
		P.inscatter *= 1 - 0.6 * rain;
		P.far *= 1 - 0.35 * snow;
		P.density += 0.006 * snow;
		P.skyFog = Math.min(1, P.skyFog + 0.3 * snow);
		P.hDensity = Math.max(P.hDensity, 0.03 * snow);
		P.hWeight = Math.min(1, P.hWeight + 0.4 * snow);
		P.tintAmt = Math.min(1, P.tintAmt + 0.35 * snow);
		return P;
	}

	_readBaseColor() {
		if (this.baseColor !== null) this._baseColorScratch.copy(this.baseColor);
		else if (this.scene !== null && this.scene.fog !== null && this.scene.fog !== undefined) {
			this._baseColorScratch.copy(this.scene.fog.color);
		}
	}

	update(dt) {
		if (!(dt > 0)) dt = 0;
		if (dt > 0.25) dt = 0.25;
		if (this.camera !== null) {
			const tSub = this.camera.position.y < this.waterLevel ? 1 : 0;
			this.submerge += (tSub - this.submerge) * Math.min(1, dt * 5);
			if (this.submerge < 0.002 && tSub === 0) this.submerge = 0;
		}
		this._computeTarget(this._target);
		const k = 1 - Math.exp(-dt / Math.max(1e-3, this.responseTime));
		const c = this._cur, P = this._target;
		c.near += (P.near - c.near) * k;
		c.far += (P.far - c.far) * k;
		c.density += (P.density - c.density) * k;
		c.mode += (P.mode - c.mode) * k;
		c.hDensity += (P.hDensity - c.hDensity) * k;
		c.hFalloff += (P.hFalloff - c.hFalloff) * k;
		c.hWeight += (P.hWeight - c.hWeight) * k;
		c.tintAmt += (P.tintAmt - c.tintAmt) * k;
		c.inscatter += (P.inscatter - c.inscatter) * k;
		c.skyFog += (P.skyFog - c.skyFog) * k;
		this._readBaseColor();
		this._tmpColor.copy(this._baseColorScratch).lerp(P.tint, c.tintAmt);
		this._curColor.lerp(this._tmpColor, k);
		this._commit();
		return this;
	}

	_commit() {
		const c = this._cur, uw = this._underwater, s = this.submerge;
		const near = c.near + (uw.near - c.near) * s;
		const far = c.far + (uw.far - c.far) * s;
		const density = c.density + (uw.density - c.density) * s;
		const mode = c.mode + (uw.mode - c.mode) * s;
		const hWeight = c.hWeight * (1 - s);
		const inscatter = c.inscatter * (1 - s) + uw.inscatter * s;
		const skyFog = c.skyFog * (1 - s) + uw.skyFog * s;
		this._finalColor.copy(this._curColor).lerp(uw.color, s);
		const scd = this.sunCycle;
		if (scd !== null && scd !== undefined) {
			const dusk = Math.min(1, 0.55 + 0.45 * scd.dayFactor + 0.2 * scd.sunsetFactor);
			this._finalColor.multiplyScalar(dusk);
		}
		const cm = this._committed;
		cm.near = near; cm.far = far; cm.density = density;
		cm.mode = mode; cm.hWeight = hWeight; cm.skyFog = skyFog; cm.inscatter = inscatter;

		if (this.scene !== null && this.scene.fog !== null && this.scene.fog !== undefined) {
			this.scene.fog.near = near;
			this.scene.fog.far = far;
			this.scene.fog.color.copy(this._finalColor);
		}

		const U = this.uniforms;
		const linearShader = this.shaderColorSpace === 'linear';
		if (linearShader) U.tfFogColor.value.copy(this._finalColor);
		else this._finalColor.getRGB(U.tfFogColor.value, 'srgb');
		U.tfFogParams.value.set(near, far, density, mode);
		U.tfFogHeight.value.set(c.hDensity, c.hFalloff, this.heightBase, hWeight);
		const sc = this.sunCycle;
		const ins = U.tfFogInscatter.value;
		if (sc !== null && sc !== undefined) {
			if (linearShader) {
				ins.set(sc.sunColor.r, sc.sunColor.g, sc.sunColor.b, inscatter * this.inscatterBoost);
			} else {
				sc.sunColor.getRGB(this._sunSrgb, 'srgb');
				ins.set(this._sunSrgb.r, this._sunSrgb.g, this._sunSrgb.b, inscatter * this.inscatterBoost);
			}
		} else {
			ins.set(1, 0.95, 0.85, inscatter * this.inscatterBoost);
		}

		if (this.skyUniforms !== null && this.skyUniforms.uSkyFogAmt !== undefined) {
			this.skyUniforms.uSkyFogAmt.value = skyFog;
		}

		const visLin = near + 0.929 * Math.max(far - near, 1);
		const visExp = 2.3015 / Math.max(density, 1e-5);
		let vis = visLin + (visExp - visLin) * mode;
		if (hWeight > 0.05) vis *= 1 - 0.12 * hWeight;
		this.visibility = vis;

		if (this.camera !== null) {
			if (this.adaptiveFar === true) {
				const target = Math.min(this.baseFar, Math.max(this._farSteps[0], vis * 1.15 + 10));
				const steps = this._farSteps;
				let idx = this._farIdx;
				while (idx < steps.length - 1 && target > steps[idx]) idx++;
				while (idx > 0 && target < steps[idx - 1] * 0.92) idx--;
				if (idx !== this._farIdx) {
					this._farIdx = idx;
					this.camera.far = steps[idx];
					this.camera.updateProjectionMatrix();
					this.stats.farUpdates++;
					this.dispatchEvent({ type: 'farchange', far: steps[idx] });
				}
			}
			if (this.sky !== null) {
				this.sky.position.copy(this.camera.position);
				this.sky.scale.setScalar(Math.max(1e-4, this.camera.far * 0.98 / this.skyRadius));
			}
		}
	}

	getState() {
		const cm = this._committed;
		return {
			preset: this.preset,
			presetLabel: this.presetLabel,
			underwater: this.isUnderwater,
			submerge: +this.submerge.toFixed(3),
			near: +cm.near.toFixed(2),
			far: +cm.far.toFixed(2),
			density: +cm.density.toFixed(5),
			modeBlend: +cm.mode.toFixed(3),
			heightWeight: +cm.hWeight.toFixed(3),
			visibility: Math.round(this.visibility),
			cameraFar: this.camera !== null ? this.camera.far : null,
			farUpdates: this.stats.farUpdates,
			color: '#' + this._finalColor.getHexString()
		};
	}
};

const TFMesh = Mesh,
	TFShaderMaterial = ShaderMaterial,
	TFDataTexture = DataTexture,
	TFInstAttr = InstancedBufferAttribute,
	TFAdditiveBlend = AdditiveBlending,
	TFNormalBlend = NormalBlending,
	TFDoubleSide = DoubleSide,
	TFLinearFilter = LinearFilter,
	TFLinearMipmap = LinearMipmapLinearFilter,
	TFClampToEdge = ClampToEdgeWrapping,
	TFRGBAFormat = RGBAFormat,
	TFUnsignedByte = UnsignedByteType,
	TFSRGBSpace = SRGBColorSpace;

const TFInstancedBufferGeometry = class extends BufferGeometry {
	constructor() {
		super();
		this.isInstancedBufferGeometry = true;
		this.type = 'InstancedBufferGeometry';
		this.instanceCount = Infinity;
	}

	copy(source) {
		super.copy(source);
		this.instanceCount = source.instanceCount;
		return this;
	}
};

const TF_TILE_PAD = 0.02;
const TF_TILE_SCALE = 0.46;
const TF_TILE_PAD_UV = TF_TILE_PAD * 2;

function createParticleAtlas(size = 256) {
	const data = new Uint8Array(size * size * 4);
	const h = size >> 1;
	const hash2 = (x, y) => {
		const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123;
		return n - Math.floor(n);
	};
	const vnoise = (x, y) => {
		const xi = Math.floor(x), yi = Math.floor(y);
		const xf = x - xi, yf = y - yi;
		const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
		const a = hash2(xi, yi), b = hash2(xi + 1, yi);
		const c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
		return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
	};
	const nfbm = (x, y) => {
		let s = 0, amp = 0.5, f = 1;
		for (let o = 0; o < 4; o++) { s += vnoise(x * f, y * f) * amp; amp *= 0.5; f *= 2; }
		return s / 0.9375;
	};
	for (let ty = 0; ty < 2; ty++) {
		for (let tx = 0; tx < 2; tx++) {
			const tile = ty * 2 + tx;
			for (let y = 0; y < h; y++) {
				for (let x = 0; x < h; x++) {
					const u = (x + 0.5) / h, v = (y + 0.5) / h;
					const dx = u * 2 - 1, dy = v * 2 - 1;
					const d = Math.sqrt(dx * dx + dy * dy);
					let a = 0;
					if (tile === 0) {
						const f = Math.max(0, 1 - d);
						a = Math.pow(f, 1.9) * (0.85 + 0.15 * Math.pow(f, 8));
					} else if (tile === 1) {
						a = Math.exp(-d * d * 5.5) * 0.9 + Math.pow(Math.max(0, 1 - d), 7) * 0.7;
					} else if (tile === 2) {
						const hu = Math.max(0, 1 - Math.abs(dx));
						const core = Math.pow(hu, 6) * 0.85;
						const halo = Math.pow(hu, 1.7) * 0.5;
						const taper = 0.55 + 0.45 * Math.pow(Math.sin(Math.PI * v), 0.35);
						a = d <= 1 ? (core + halo) * taper : 0;
					} else {
						const n = nfbm(u * 4.2 + 3.1, v * 4.2 + 7.7);
						const n2 = nfbm(u * 9.0 + 1.3, v * 9.0 + 2.9);
						const dd = d * (0.72 + 0.42 * n);
						const edge = 1 - Math.min(1, Math.max(0, (dd - 0.42) / 0.58));
						a = edge * edge * (0.45 + 0.55 * n2);
					}
					const edgeDist = Math.min(x, y, h - 1 - x, h - 1 - y) / h;
					if (edgeDist < TF_TILE_PAD_UV) {
						const f = edgeDist / TF_TILE_PAD_UV;
						a *= f * f * (3 - 2 * f);
					}
					const px = tx * h + x, py = ty * h + y;
					const i = (py * size + px) * 4;
					data[i] = 255; data[i + 1] = 255; data[i + 2] = 255;
					data[i + 3] = Math.max(0, Math.min(255, Math.round(a * 255)));
				}
			}
		}
	}
	const tex = new TFDataTexture(data, size, size);
	tex.format = TFRGBAFormat;
	tex.type = TFUnsignedByte;
	tex.magFilter = TFLinearFilter;
	tex.minFilter = TFLinearMipmap;
	tex.generateMipmaps = true;
	tex.wrapS = TFClampToEdge;
	tex.wrapT = TFClampToEdge;
	tex.colorSpace = TFSRGBSpace;
	tex.needsUpdate = true;
	return tex;
}

const TF_PARTICLES_GLSL_COMMON_VERT = `
attribute vec4 aSeed;   // xyz — seed-позиция в [0,1)^3, w — джиттер размера
attribute vec4 aRand;   // x — фаза, y — джиттер скорости, z — джиттер альфы, w — скорость вращения

uniform float uTime;
uniform vec3 uCenter;   // центр бокса (камера)
uniform vec3 uCenterOff;// смещение центра бокса (поле не «зарывается» в землю)
uniform vec3 uBox;      // полные размеры wrap-бокса
uniform vec3 uWind;     // ветер (горизонталь), м/с
uniform float uFall;    // скорость падения, м/с
uniform vec2 uSize;     // sprite: (min,max); streak: (ширина, длина)
uniform vec4 uParams;   // x — амплитуда дрейфа, y — частота дрейфа, z — начало edge-fade, w — резерв
uniform float uIntensity;
uniform float uOpacity;
uniform vec2 uTile;
uniform vec2 uTileScale;

varying vec2 vAtlasUv;
varying float vAlpha;
varying vec3 vWorld;
varying float vViewDepth;

vec3 tfParticleVelocity() {
	return vec3( uWind.x, -uFall * ( 0.75 + 0.5 * aRand.y ), uWind.z );
}

vec3 tfParticleVirtualPos( vec3 vel ) {
	// время заворачивается по каждой оси отдельно: p ограничен боксом,
	// поэтому float32-точность не «плывёт» даже спустя часы uTime.
	vec3 axT = vec3(
		abs( vel.x ) > 1e-4 ? mod( uTime, uBox.x / abs( vel.x ) ) : 0.0,
		abs( vel.y ) > 1e-4 ? mod( uTime, uBox.y / abs( vel.y ) ) : 0.0,
		abs( vel.z ) > 1e-4 ? mod( uTime, uBox.z / abs( vel.z ) ) : 0.0
	);
	vec3 p = aSeed.xyz * uBox + vel * axT;
	// дрейф (снег): две противофазные синусоиды с пер-частичной фазой/частотой
	p.x += sin( uTime * uParams.y * ( 0.6 + 0.8 * aRand.x ) + aRand.x * 6.2831853 ) * uParams.x * ( 0.4 + aSeed.w );
	p.z += cos( uTime * uParams.y * ( 0.5 + 0.7 * aRand.z ) + aRand.z * 6.2831853 ) * uParams.x * ( 0.4 + aRand.y );
	return p;
}

vec3 tfParticleWrap( vec3 p ) {
	vec3 ctr = uCenter + uCenterOff;
	return ctr + mod( p - ctr + uBox * 0.5, uBox ) - uBox * 0.5;
}

float tfParticleEdgeFade( vec3 world ) {
	vec3 ctr = uCenter + uCenterOff;
	vec3 rel = ( world - ctr ) / uBox * 2.0;
	float edge = max( max( abs( rel.x ), abs( rel.y ) ), abs( rel.z ) );
	return 1.0 - smoothstep( uParams.z, 1.0, edge );
}
`;

const TF_PARTICLES_SPRITE_VERT = TF_PARTICLES_GLSL_COMMON_VERT + `
void main() {
	vec3 vel = tfParticleVelocity();
	vec3 world = tfParticleWrap( tfParticleVirtualPos( vel ) );
	float edgeFade = tfParticleEdgeFade( world );
	vAlpha = uIntensity * uOpacity * edgeFade * ( 0.55 + 0.75 * aRand.z );
	vec4 mv = viewMatrix * vec4( world, 1.0 );
	vViewDepth = -mv.z;
	float size = mix( uSize.x, uSize.y, aSeed.w );
	float ang = uTime * ( aRand.w - 0.5 ) * 1.6 + aRand.x * 6.2831853;
	float ca = cos( ang ), sa = sin( ang );
	vec2 q = position.xy * size;
	mv.xy += vec2( q.x * ca - q.y * sa, q.x * sa + q.y * ca );
	vWorld = world;
	vAtlasUv = uTile + uv * uTileScale;
	gl_Position = projectionMatrix * mv;
}
`;

const TF_PARTICLES_STREAK_VERT = TF_PARTICLES_GLSL_COMMON_VERT + `
void main() {
	vec3 vel = tfParticleVelocity();
	vec3 world = tfParticleWrap( tfParticleVirtualPos( vel ) );
	float edgeFade = tfParticleEdgeFade( world );
	vAlpha = uIntensity * uOpacity * edgeFade * ( 0.45 + 0.85 * aRand.z );
	vec3 dir = normalize( vel );
	vec3 toC = ( uCenter + uCenterOff ) - world;
	vec3 side = cross( dir, toC / max( length( toC ), 1e-4 ) );
	float sl = length( side );
	if ( sl < 1e-4 ) {
		// взгляд вдоль падения — вырожденный случай: правый вектор камеры
		side = vec3( viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0] );
		sl = max( length( side ), 1e-4 );
	}
	side /= sl;
	float w = uSize.x * ( 0.7 + 0.6 * aSeed.w );
	float len = uSize.y * ( 0.7 + 0.6 * aRand.y );
	vec3 wp = world + side * ( position.x * w ) + dir * ( position.y * len );
	vWorld = wp;
	vec4 mv = viewMatrix * vec4( wp, 1.0 );
	vViewDepth = -mv.z;
	vAtlasUv = uTile + uv * uTileScale;
	gl_Position = projectionMatrix * mv;
}
`;

const TF_PARTICLES_CPU_VERT = `
attribute vec4 aP0; // xyz — мировая позиция, w — размер
attribute vec4 aP1; // rgb — цвет (линейный), a — альфа (с огибающей жизни)
attribute vec4 aP2; // x — поворот, y — тайл атласа, z — растяжение Y, w — резерв

uniform float uIntensity;

varying vec2 vAtlasUv;
varying float vAlpha;
varying vec3 vColor;
varying vec3 vWorld;
varying float vViewDepth;

void main() {
	vec3 world = aP0.xyz;
	vWorld = world;
	vec4 mv = viewMatrix * vec4( world, 1.0 );
	vViewDepth = -mv.z;
	vec2 q = position.xy * vec2( aP0.w, aP0.w * aP2.z );
	float ang = aP2.x;
	float ca = cos( ang ), sa = sin( ang );
	mv.xy += vec2( q.x * ca - q.y * sa, q.x * sa + q.y * ca );
	float tile = aP2.y;
	vAtlasUv = vec2( mod( tile, 2.0 ), floor( tile * 0.5 ) ) * 0.5
		+ ${TF_TILE_PAD} + uv * ${TF_TILE_SCALE};
	vColor = aP1.rgb;
	vAlpha = aP1.a * uIntensity;
	gl_Position = projectionMatrix * mv;
}
`;

const TF_PARTICLES_FRAG = `
uniform sampler2D uAtlas;
#ifndef TF_P_CPU
uniform vec3 uColor;
#endif
#ifdef TF_P_CPU
varying vec3 vColor;
#endif
varying vec2 vAtlasUv;
varying float vAlpha;
varying vec3 vWorld;
varying float vViewDepth;

// единый туман движка (часть 1.75) — общие uniform-объекты FogManager
${TF_FOG_GLSL}

void main() {
	vec4 tex = texture2D( uAtlas, vAtlasUv );
	float a = tex.a * vAlpha;
	if ( a < 0.004 ) discard; // экономия fillrate на крупных мягких квадах
	#ifdef TF_P_CPU
	vec3 col = vColor * tex.rgb;
	#else
	vec3 col = uColor * tex.rgb;
	#endif
	gl_FragColor = vec4( col, a );
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
	#ifdef TF_P_ADDITIVE
	// аддитивные частицы в тумане ГАСНУТ (прозрачность среды), а не красятся
	float tfT = tfFogTransmittance( vWorld, vViewDepth );
	gl_FragColor.rgb *= tfT;
	gl_FragColor.a *= tfT;
	#else
	float f = tfFogFactor( vWorld, vViewDepth );
	gl_FragColor.rgb = mix( gl_FragColor.rgb, tfFogColorFor( vWorld ), f );
	#endif
}
`;

function createParticleMaterial(options) {
	const mode = options.mode;
	const additive = options.additive === true;
	const defines = {};
	if (mode === 'cpu') defines.TF_P_CPU = '';
	if (additive) defines.TF_P_ADDITIVE = '';

	const F = options.fogUniforms !== undefined && options.fogUniforms !== null
		? options.fogUniforms
		: _tfDefaultFogUniforms();
	const uniforms = {
		uAtlas: { value: options.atlas },
		uIntensity: { value: options.intensity !== undefined ? options.intensity : 1 },
		tfFogColor: F.tfFogColor,
		tfFogParams: F.tfFogParams,
		tfFogHeight: F.tfFogHeight,
		tfFogInscatter: F.tfFogInscatter,
		tfFogSunDir: F.tfFogSunDir
	};
	if (mode !== 'cpu') {
		const S = options.shared !== undefined && options.shared !== null
			? options.shared : _tfDefaultSharedUniforms();
		uniforms.uTime = S.uTime;
		uniforms.uCenter = S.uCenter;
		uniforms.uCenterOff = { value: new Vector3(0, 0, 0) };
		uniforms.uWind = S.uWind;
		uniforms.uBox = { value: new Vector3(120, 60, 120) };
		uniforms.uFall = { value: 1 };
		uniforms.uSize = { value: new Vector2(0.08, 0.16) };
		uniforms.uParams = { value: new Vector4(0, 1, 0.62, 0) };
		uniforms.uOpacity = { value: 1 };
		uniforms.uColor = { value: new Color(1, 1, 1) };
		uniforms.uTile = { value: new Vector2(TF_TILE_PAD, TF_TILE_PAD) };
		uniforms.uTileScale = { value: new Vector2(TF_TILE_SCALE, TF_TILE_SCALE) };
	}

	let vertexShader;
	if (mode === 'cpu') vertexShader = TF_PARTICLES_CPU_VERT;
	else if (mode === 'gpu-streak') vertexShader = TF_PARTICLES_STREAK_VERT;
	else vertexShader = TF_PARTICLES_SPRITE_VERT;

	return new TFShaderMaterial({
		defines,
		uniforms,
		vertexShader,
		fragmentShader: TF_PARTICLES_FRAG,
		transparent: true,
		depthWrite: false,
		depthTest: true,
		side: TFDoubleSide,
		blending: additive ? TFAdditiveBlend : TFNormalBlend,
		fog: false
	});
}

function _tfFillQuad(geo) {
	const pos = new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]);
	const uvs = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
	geo.setAttribute('position', new BufferAttribute(pos, 3));
	geo.setAttribute('uv', new BufferAttribute(uvs, 2));
	geo.setIndex([0, 1, 2, 0, 2, 3]);
	return geo;
}

function _tfTileOffset(tile, out) {
	return out.set((tile % 2) * 0.5 + TF_TILE_PAD, Math.floor(tile / 2) * 0.5 + TF_TILE_PAD);
}

const ParticleField = class {
	constructor(options) {
		this.manager = options.manager;
		this.capacity = options.capacity | 0;
		this.mode = options.mode === 'streak' ? 'streak' : 'sprite';
		this.baseBudget = options.budget !== undefined ? options.budget : this.capacity;
		this.budget = this.baseBudget;
		this.intensity = 0;
		this._warm = 0;

		const rand = createPRNG(options.seed !== undefined ? options.seed : 9176);
		const geo = new TFInstancedBufferGeometry();
		geo.instanceCount = 0;
		_tfFillQuad(geo);
		const n4 = this.capacity * 4;
		const seeds = new Float32Array(n4);
		const rands = new Float32Array(n4);
		for (let i = 0; i < n4; i++) { seeds[i] = rand(); rands[i] = rand(); }
		geo.setAttribute('aSeed', new TFInstAttr(seeds, 4));
		geo.setAttribute('aRand', new TFInstAttr(rands, 4));
		this.geometry = geo;

		this.material = createParticleMaterial({
			mode: this.mode === 'streak' ? 'gpu-streak' : 'gpu-sprite',
			additive: options.additive === true,
			atlas: options.atlas,
			shared: options.shared,
			fogUniforms: options.fogUniforms
		});
		this.uniforms = this.material.uniforms;
		_tfTileOffset(options.tile | 0, this.uniforms.uTile.value);
		if (options.color !== undefined) this.uniforms.uColor.value.copy(options.color);
		if (options.opacity !== undefined) this.uniforms.uOpacity.value = options.opacity;
		if (options.size !== undefined) this.uniforms.uSize.value.set(options.size[0], options.size[1]);
		if (options.fall !== undefined) this.uniforms.uFall.value = options.fall;
		if (options.sway !== undefined) {
			this.uniforms.uParams.value.x = options.sway[0];
			this.uniforms.uParams.value.y = options.sway[1];
		}
		if (options.edgeFade !== undefined) this.uniforms.uParams.value.z = options.edgeFade;
		if (options.box !== undefined) this.uniforms.uBox.value.set(options.box[0], options.box[1], options.box[2]);
		this.uniforms.uIntensity.value = 0;

		this.mesh = new TFMesh(geo, this.material);
		this.mesh.frustumCulled = false;
		this.mesh.renderOrder = options.renderOrder !== undefined ? options.renderOrder : 5;
		if (options.parent) options.parent.add(this.mesh);
		this._refresh();
	}

	setIntensity(v) {
		this.intensity = v;
		this.uniforms.uIntensity.value = v;
		this._refresh();
		return this;
	}

	setBudget(n) {
		this.budget = n;
		this._refresh();
		return this;
	}

	setBox(x, y, z) {
		this.uniforms.uBox.value.set(x, y, z);
		return this;
	}

	/**
	 * ДОБАВЛЕНО (T10): ручное обновление standalone-поля (без ParticleManager):
	 * двигает общее время, центрирует wrap-бокс на камере, считает прогрев и
	 * видимость. При живом менеджере — no-op (менеджер обновляет поля сам в
	 * своём update(): иначе время двигалось бы дважды).
	 * @param {number} dt Секунды с прошлого кадра.
	 * @param {THREE.Camera} [camera] Камера (центр wrap-бокса частиц).
	 * @returns {this}
	 */
	update(dt, camera = null) {
		if (this.manager !== undefined && this.manager !== null) return this;
		if (dt > 0 && Number.isFinite(dt)) this.uniforms.uTime.value += Math.min(dt, 0.25);
		if (camera !== undefined && camera !== null) {
			this.uniforms.uCenter.value.copy(camera.position);
		}
		this._warm++;
		this._refresh();
		return this;
	}

	_refresh() {
		const active = this.intensity > 0.003;
		const warmup = this._warm < 2;
		const qm = this.manager !== undefined && this.manager !== null ? this.manager.qualityMul : 1;
		this.mesh.visible = active || warmup;
		this.geometry.instanceCount = (active || warmup)
			? Math.max(0, Math.min(this.capacity, Math.round(this.budget * qm)))
			: 0;
	}

	dispose() {
		if (this.mesh.parent !== null) this.mesh.parent.remove(this.mesh);
		this.geometry.dispose();
		this.material.dispose();
	}
};

const TF_PSTRIDE = 27;
const TF_P_POS = 0, TF_P_VEL = 3, TF_P_AGE = 6, TF_P_INVLIFE = 7,
	TF_P_SIZE0 = 8, TF_P_SIZE1 = 9, TF_P_ROT0 = 10, TF_P_ROTV = 11,
	TF_P_C0 = 12, TF_P_C1 = 15, TF_P_ALPHA = 18, TF_P_FADEIN = 19,
	TF_P_DRAG = 20, TF_P_GSCALE = 21, TF_P_TILE = 22, TF_P_STRETCH = 23,
	TF_P_WINDF = 24, TF_P_TURBA = 25, TF_P_TURBF = 26;

const TF_WHITE = new Color(1, 1, 1);

function _tfRange(v, def, rnd = Math.random) {
	if (v === undefined || v === null) return def;
	if (typeof v === 'number') return v;
	if (typeof v !== 'object') return def;
	return v.min + (v.max - v.min) * rnd();
}

const _psFallbackGravity = new Vector3(0, -22, 0);
const _psFallbackWind = new Vector3(0, 0, 0);
const _psZeroPos = new Vector3(0, 0, 0);
const _psEmptyCfg = {};
const _tfFin = (v, def) => (typeof v === 'number' && Number.isFinite(v)) ? v : def;

const ParticleSystem = class extends EventDispatcher {
	constructor(options) {
		super();
		this.manager = options.manager;
		this.capacity = options.capacity | 0;
		this.random = typeof options.random === 'function' ? options.random : Math.random;
		this.additive = options.additive === true;
		this.data = new Float32Array(this.capacity * TF_PSTRIDE);
		this.live = 0;
		this.emitters = [];
		this.spawnedTotal = 0;
		this.droppedTotal = 0;
		this._warm = 0;

		const geo = new TFInstancedBufferGeometry();
		geo.instanceCount = 0;
		_tfFillQuad(geo);
		this._aP0 = new Float32Array(this.capacity * 4);
		this._aP1 = new Float32Array(this.capacity * 4);
		this._aP2 = new Float32Array(this.capacity * 4);
		const at0 = new TFInstAttr(this._aP0, 4);
		const at1 = new TFInstAttr(this._aP1, 4);
		const at2 = new TFInstAttr(this._aP2, 4);
		at0.setUsage(DYNAMIC_DRAW);
		at1.setUsage(DYNAMIC_DRAW);
		at2.setUsage(DYNAMIC_DRAW);
		geo.setAttribute('aP0', at0);
		geo.setAttribute('aP1', at1);
		geo.setAttribute('aP2', at2);
		this.geometry = geo;

		this.material = createParticleMaterial({
			mode: 'cpu',
			additive: this.additive,
			atlas: options.atlas,
			shared: options.shared,
			fogUniforms: options.fogUniforms
		});
		this.uniforms = this.material.uniforms;

		this.mesh = new TFMesh(geo, this.material);
		this.mesh.frustumCulled = false;
		this.mesh.renderOrder = options.renderOrder !== undefined ? options.renderOrder : 5;
		if (options.parent) options.parent.add(this.mesh);
	}

	addEmitter(config) {
		const cfg = config !== undefined && config !== null ? config : _psEmptyCfg;
		const em = {
			system: this,
			rate: _tfFin(cfg.rate, 0),
			maxPerStep: Math.max(1, _tfFin(cfg.maxPerStep, 256) | 0),
			enabled: true,
			accum: 0,
			config: cfg.config !== undefined && cfg.config !== null ? cfg.config : cfg
		};
		this.emitters.push(em);
		return em;
	}

	removeEmitter(emitter) {
		const i = this.emitters.indexOf(emitter);
		if (i !== -1) this.emitters.splice(i, 1);
		return this;
	}

	burst(config, count) {
		let n = 0;
		if (typeof count === 'number' && Number.isFinite(count) && count > 0) n = Math.floor(count);
		if (n === 0) return this;
		const cfg = config !== undefined && config !== null ? config : _psEmptyCfg;
		for (let i = 0; i < n; i++) this._spawnOne(cfg);
		return this;
	}

	clear() {
		this.live = 0;
		return this;
	}

	_spawnOne(cfg) {
		if (this.live >= this.capacity) { this.droppedTotal++; return false; }
		const d = this.data;
		const o = this.live * TF_PSTRIDE;

		const pos = cfg.position !== undefined && cfg.position !== null ? cfg.position : _psZeroPos;
		const rnd = this.random;
		let x = _tfFin(pos.x, 0), y = _tfFin(pos.y, 0), z = _tfFin(pos.z, 0);
		const sb = cfg.spreadBox;
		if (sb !== undefined && sb !== null) {
			x += (rnd() * 2 - 1) * _tfFin(sb.x, 0);
			y += (rnd() * 2 - 1) * _tfFin(sb.y, 0);
			z += (rnd() * 2 - 1) * _tfFin(sb.z, 0);
		}
		const sr = Math.max(0, _tfFin(cfg.spreadRadius, 0));
		let dx = 0, dy = 0, dz = 0;
		if (sr > 0) {
			const u = rnd() * 2 - 1;
			const a = rnd() * 6.2831853;
			const s = Math.sqrt(1 - u * u);
			const r = sr * Math.cbrt(rnd());
			dx = s * Math.cos(a); dy = u; dz = s * Math.sin(a);
			x += dx * r; y += dy * r; z += dz * r;
		}
		if (cfg.groundSnap !== undefined && cfg.groundSnap !== null) {
			const gy = cfg.groundSnap(x, z);
			if (gy === null) return false;
			y = _tfFin(gy, y);
		}

		const speed = _tfFin(_tfRange(cfg.speed, 0, rnd), 0);
		let vx = 0, vy = 0, vz = 0;
		if (speed !== 0) {
			if (sr > 0 && (dx !== 0 || dy !== 0 || dz !== 0)) {
				vx = dx * speed; vy = dy * speed; vz = dz * speed;
			} else {
				const u = rnd() * 2 - 1;
				const a = rnd() * 6.2831853;
				const s = Math.sqrt(1 - u * u);
				vx = s * Math.cos(a) * speed; vy = u * speed; vz = s * Math.sin(a) * speed;
			}
		}
		const bias = cfg.bias;
		if (bias !== undefined && bias !== null) {
			vx += _tfFin(bias.x, 0); vy += _tfFin(bias.y, 0); vz += _tfFin(bias.z, 0);
		}

		const life = Math.max(1e-3, _tfFin(_tfRange(cfg.life, 1, rnd), 1));
		d[o + TF_P_POS] = x; d[o + TF_P_POS + 1] = y; d[o + TF_P_POS + 2] = z;
		d[o + TF_P_VEL] = vx; d[o + TF_P_VEL + 1] = vy; d[o + TF_P_VEL + 2] = vz;
		d[o + TF_P_AGE] = 0;
		d[o + TF_P_INVLIFE] = 1 / life;
		d[o + TF_P_SIZE0] = _tfFin(_tfRange(cfg.size0, 0.2, rnd), 0.2);
		d[o + TF_P_SIZE1] = _tfFin(_tfRange(cfg.size1, 0, rnd), 0);
		d[o + TF_P_ROT0] = rnd() * 6.2831853;
		d[o + TF_P_ROTV] = _tfFin(_tfRange(cfg.rotSpeed, 0, rnd), 0);

		const c0 = (cfg.color0 !== undefined && cfg.color0 !== null && Number.isFinite(cfg.color0.r)) ? cfg.color0 : TF_WHITE;
		const c1 = (cfg.color1 !== undefined && cfg.color1 !== null && Number.isFinite(cfg.color1.r)) ? cfg.color1 : c0;
		const cj = cfg.colorJitter ? _tfFin(1 + _tfFin(cfg.colorJitter, 0) * (rnd() * 2 - 1), 1) : 1;
		d[o + TF_P_C0] = _tfFin(c0.r, 1) * cj; d[o + TF_P_C0 + 1] = _tfFin(c0.g, 1) * cj; d[o + TF_P_C0 + 2] = _tfFin(c0.b, 1) * cj;
		d[o + TF_P_C1] = _tfFin(c1.r, 1) * cj; d[o + TF_P_C1 + 1] = _tfFin(c1.g, 1) * cj; d[o + TF_P_C1 + 2] = _tfFin(c1.b, 1) * cj;

		d[o + TF_P_ALPHA] = _tfFin(_tfRange(cfg.alpha0, 1, rnd), 1);
		d[o + TF_P_FADEIN] = Math.max(0, _tfFin(cfg.fadeIn, 0));
		d[o + TF_P_DRAG] = _tfFin(_tfRange(cfg.drag, 0, rnd), 0);
		d[o + TF_P_GSCALE] = _tfFin(_tfRange(cfg.gravityScale, 1, rnd), 1);
		d[o + TF_P_TILE] = _tfFin(cfg.tile, 0);
		d[o + TF_P_STRETCH] = _tfFin(_tfRange(cfg.stretch, 1, rnd), 1);
		d[o + TF_P_WINDF] = _tfFin(cfg.windFactor, 0);
		const tb = cfg.turbulence;
		d[o + TF_P_TURBA] = (tb !== undefined && tb !== null) ? Math.max(0, _tfFin(tb.amp, 0)) : 0;
		d[o + TF_P_TURBF] = (tb !== undefined && tb !== null) ? Math.max(0, _tfFin(tb.freq, 0)) : 0;

		this.live++;
		this.spawnedTotal++;
		return true;
	}

	_kill(i) {
		const last = --this.live;
		if (i !== last) {
			this.data.copyWithin(i * TF_PSTRIDE, last * TF_PSTRIDE, (last + 1) * TF_PSTRIDE);
		}
	}

	fixedUpdate(h) {
		const d = this.data;
		const mgr = this.manager !== undefined && this.manager !== null ? this.manager : null;
		const g = mgr !== null ? mgr.gravity : _psFallbackGravity;
		const w = mgr !== null ? mgr.wind : _psFallbackWind;
		let i = 0;
		while (i < this.live) {
			const o = i * TF_PSTRIDE;
			const age = d[o + TF_P_AGE] + h;
			d[o + TF_P_AGE] = age;
			if (age * d[o + TF_P_INVLIFE] >= 1) { this._kill(i); continue; }

			const dragK = 1 - d[o + TF_P_DRAG] * h;
			const k = dragK > 0 ? dragK : 0;
			const gs = d[o + TF_P_GSCALE];
			const wf = d[o + TF_P_WINDF];
			let vx = d[o + TF_P_VEL] + (g.x * gs + w.x * wf) * h;
			let vy = d[o + TF_P_VEL + 1] + (g.y * gs + w.y * wf) * h;
			let vz = d[o + TF_P_VEL + 2] + (g.z * gs + w.z * wf) * h;
			const ta = d[o + TF_P_TURBA];
			if (ta > 0) {
				const tf = age * d[o + TF_P_TURBF] + d[o + TF_P_ROT0] * 3.71;
				vx += Math.sin(tf) * ta * h;
				vy += Math.sin(tf * 1.31 + 1.7) * ta * 0.5 * h;
				vz += Math.cos(tf * 0.87 + 0.4) * ta * h;
			}
			d[o + TF_P_VEL] = vx * k;
			d[o + TF_P_VEL + 1] = vy * k;
			d[o + TF_P_VEL + 2] = vz * k;
			d[o + TF_P_POS] += d[o + TF_P_VEL] * h;
			d[o + TF_P_POS + 1] += d[o + TF_P_VEL + 1] * h;
			d[o + TF_P_POS + 2] += d[o + TF_P_VEL + 2] * h;
			i++;
		}

		for (let e = 0; e < this.emitters.length; e++) {
			const em = this.emitters[e];
			if (!em.enabled || !(em.rate > 0)) { em.accum = 0; continue; }
			em.accum += em.rate * h;
			let n = em.accum | 0;
			if (n > 0) {
				em.accum -= n;
				if (n > em.maxPerStep) n = em.maxPerStep;
				while (n-- > 0) this._spawnOne(em.config);
			}
		}
	}

	update() {
		this._warm++;
		const live = this.live;
		const d = this.data;
		const A0 = this._aP0, A1 = this._aP1, A2 = this._aP2;
		for (let i = 0; i < live; i++) {
			const o = i * TF_PSTRIDE;
			const t = d[o + TF_P_AGE] * d[o + TF_P_INVLIFE];
			const fi = d[o + TF_P_FADEIN];
			const tIn = fi > 0 ? Math.min(1, t / fi) : 1;
			const om = 1 - t;
			const env = tIn * om * om * (0.35 + 0.65 * om);
			const i4 = i * 4;
			const s0 = d[o + TF_P_SIZE0], s1 = d[o + TF_P_SIZE1];
			A0[i4] = d[o + TF_P_POS];
			A0[i4 + 1] = d[o + TF_P_POS + 1];
			A0[i4 + 2] = d[o + TF_P_POS + 2];
			A0[i4 + 3] = s0 + (s1 - s0) * t;
			const r0 = d[o + TF_P_C0], r1 = d[o + TF_P_C1];
			A1[i4] = r0 + (r1 - r0) * t;
			A1[i4 + 1] = d[o + TF_P_C0 + 1] + (d[o + TF_P_C1 + 1] - d[o + TF_P_C0 + 1]) * t;
			A1[i4 + 2] = d[o + TF_P_C0 + 2] + (d[o + TF_P_C1 + 2] - d[o + TF_P_C0 + 2]) * t;
			A1[i4 + 3] = d[o + TF_P_ALPHA] * env;
			A2[i4] = d[o + TF_P_ROT0] + d[o + TF_P_ROTV] * d[o + TF_P_AGE];
			A2[i4 + 1] = d[o + TF_P_TILE];
			A2[i4 + 2] = d[o + TF_P_STRETCH];
			A2[i4 + 3] = 0;
		}
		this.geometry.instanceCount = live;
		this.mesh.visible = live > 0 || this._warm < 2;
		if (live > 0) {
			const n = live * 4;
			const geo = this.geometry;
			const at0 = geo.attributes.aP0, at1 = geo.attributes.aP1, at2 = geo.attributes.aP2;
			at0.clearUpdateRanges(); at0.addUpdateRange(0, n); at0.needsUpdate = true;
			at1.clearUpdateRanges(); at1.addUpdateRange(0, n); at1.needsUpdate = true;
			at2.clearUpdateRanges(); at2.addUpdateRange(0, n); at2.needsUpdate = true;
		}
	}

	dispose() {
		if (this.mesh.parent !== null) this.mesh.parent.remove(this.mesh);
		this.geometry.dispose();
		this.material.dispose();
		this.emitters.length = 0;
		this.live = 0;
	}
};

const TF_QUALITY_MUL = { low: 0.35, medium: 0.65, high: 1.0 };
const TF_QUALITY_ORDER = ['auto', 'low', 'medium', 'high'];
const TF_QUALITY_TIERS = ['low', 'medium', 'high'];

function _tfDefaultFogUniforms() {
	return {
		tfFogColor: { value: new Color(0.62, 0.75, 0.87) },
		tfFogParams: { value: new Vector4(0, 1e5, 1e-6, 0) },
		tfFogHeight: { value: new Vector4(0, 0.05, 0, 0) },
		tfFogInscatter: { value: new Vector4(0, 0, 0, 0) },
		tfFogSunDir: { value: new Vector3(0, 1, 0) }
	};
}

function _tfDefaultSharedUniforms() {
	return {
		uTime: { value: 0 },
		uCenter: { value: new Vector3() },
		uWind: { value: new Vector3() }
	};
}

const ParticleManager = class extends EventDispatcher {
	constructor(options = {}) {
		super();
		this.scene = options.scene || null;
		this.camera = options.camera || null;
		this.gravity = options.gravity !== undefined ? options.gravity.clone() : new Vector3(0, -22, 0);
		this.wind = new Vector3(0, 0, 0);
		this.time = 0;
		this.shared = {
			uTime: { value: 0 },
			uCenter: { value: new Vector3() },
			uWind: { value: this.wind }
		};
		this.atlas = createParticleAtlas(options.atlasSize !== undefined ? options.atlasSize : 256);
		this.fogUniforms = options.fog !== null && options.fog !== undefined
			? options.fog.uniforms
			: _tfDefaultFogUniforms();
		this.fields = [];
		this.systems = [];
		this.qualityMode = options.quality || 'auto';
		this.quality = 'high';
		this.qualityMul = TF_QUALITY_MUL.high;
		this._fpsEma = 60;
		this._qCooldown = 2;
		this._applyQualityMode();
	}

	createField(options) {
		const field = new ParticleField(Object.assign({
			manager: this,
			parent: this.scene,
			atlas: this.atlas,
			shared: this.shared,
			fogUniforms: this.fogUniforms
		}, options));
		this.fields.push(field);
		return field;
	}

	createSystem(options) {
		const system = new ParticleSystem(Object.assign({
			manager: this,
			parent: this.scene,
			atlas: this.atlas,
			shared: this.shared,
			fogUniforms: this.fogUniforms
		}, options));
		this.systems.push(system);
		return system;
	}

	/**
	 * Уничтожить поле и снять его с регистрации в менеджере.
	 *
	 * ДОБАВЛЕНО (N1): field.dispose() освобождал GPU-ресурсы, но объект
	 * оставался в this.fields — менеджер продолжал каждый кадр дёргать у него
	 * _refresh() и учитывать его в getStats().
	 * WeatherManager.dispose() теперь зовёт именно этот метод.
	 *
	 * @param {ParticleField} field
	 * @returns {this}
	 */
	destroyField(field) {
		const i = this.fields.indexOf(field);
		if (i !== -1) this.fields.splice(i, 1);
		field.dispose();
		return this;
	}

	/** Уничтожить CPU-систему и снять её с регистрации. См. destroyField. */
	destroySystem(system) {
		const i = this.systems.indexOf(system);
		if (i !== -1) this.systems.splice(i, 1);
		system.dispose();
		return this;
	}

	setQuality(mode) {
		if (TF_QUALITY_ORDER.indexOf(mode) === -1) {
			console.warn('ThreeForge: ParticleManager — неизвестное качество: ' + mode);
			return this;
		}
		this.qualityMode = mode;
		this._applyQualityMode();
		this.dispatchEvent({ type: 'quality', quality: this.quality, mode: this.qualityMode });
		return this;
	}

	cycleQuality() {
		const i = TF_QUALITY_ORDER.indexOf(this.qualityMode);
		return this.setQuality(TF_QUALITY_ORDER[(i + 1) % TF_QUALITY_ORDER.length]);
	}

	_applyQualityMode() {
		if (this.qualityMode !== 'auto') this.quality = this.qualityMode;
		this.qualityMul = TF_QUALITY_MUL[this.quality];
		for (let i = 0; i < this.fields.length; i++) this.fields[i]._refresh();
	}

	_autoQuality(dt) {
		if (this.qualityMode !== 'auto') return;
		this._qCooldown -= dt;
		if (this._qCooldown > 0) return;
		const idx = TF_QUALITY_TIERS.indexOf(this.quality);
		if (this._fpsEma < 34 && idx > 0) {
			this.quality = TF_QUALITY_TIERS[idx - 1];
			this._qCooldown = 3;
			this._applyQualityMode();
			this.dispatchEvent({ type: 'quality', quality: this.quality, mode: this.qualityMode });
		} else if (this._fpsEma > 56 && idx < TF_QUALITY_TIERS.length - 1) {
			this.quality = TF_QUALITY_TIERS[idx + 1];
			this._qCooldown = 3;
			this._applyQualityMode();
			this.dispatchEvent({ type: 'quality', quality: this.quality, mode: this.qualityMode });
		}
	}

	fixedUpdate(h) {
		if (!(h > 0)) return;
		for (let i = 0; i < this.systems.length; i++) this.systems[i].fixedUpdate(h);
	}

	update(dt, alpha, engine) {
		if (!(dt > 0)) dt = 0;
		if (dt > 0.25) dt = 0.25;
		this.time += dt;
		this.shared.uTime.value = this.time;
		if (this.camera !== null) this.shared.uCenter.value.copy(this.camera.position);
		if (engine !== undefined && engine !== null && engine.stats !== undefined) {
			const f = engine.stats.fps;
			if (f > 0) this._fpsEma += (f - this._fpsEma) * 0.06;
		}
		this._autoQuality(dt);
		for (let i = 0; i < this.fields.length; i++) {
			const field = this.fields[i];
			field._warm++;
			field._refresh();
		}
		for (let i = 0; i < this.systems.length; i++) this.systems[i].update();
	}

	getStats() {
		let gpu = 0, cpu = 0, spawned = 0, dropped = 0;
		for (let i = 0; i < this.fields.length; i++) {
			const f = this.fields[i];
			if (f.mesh.visible) gpu += f.geometry.instanceCount;
		}
		for (let i = 0; i < this.systems.length; i++) {
			const s = this.systems[i];
			cpu += s.live;
			spawned += s.spawnedTotal;
			dropped += s.droppedTotal;
		}
		return {
			gpu, cpu,
			fields: this.fields.length,
			systems: this.systems.length,
			spawned, dropped,
			quality: this.quality,
			qualityMode: this.qualityMode,
			qualityMul: this.qualityMul
		};
	}

	dispose() {
		for (let i = 0; i < this.fields.length; i++) this.fields[i].dispose();
		for (let i = 0; i < this.systems.length; i++) this.systems[i].dispose();
		this.fields.length = 0;
		this.systems.length = 0;
		this.atlas.dispose();
	}
};

const WEATHER_MODES = {
	clear: { label: 'ясно' },
	rain: { label: 'дождь' },
	snow: { label: 'снег' },
	storm: { label: 'гроза' }
};
const WEATHER_ORDER = ['clear', 'rain', 'snow', 'storm'];

const WeatherManager = class extends EventDispatcher {
	constructor(options = {}) {
		super();
		this.camera = options.camera || null;
		this.particles = options.particles || null;
		this.fog = options.fog || null;
		this.audio = options.audio || null;
		this.terrain = options.terrain || null;
		this.waterLevel = options.waterLevel !== undefined ? options.waterLevel : 0;
		this.skyUniforms = options.skyUniforms || null;
		this.lightning = options.lightning || null;
		this.splashSystem = options.splashSystem || null;

		this.mode = 'clear';
		this.rain = 0;
		this.snow = 0;
		this.windSpeed = 0;
		this.windAngle = 0;
		this.time = 0;
		this.underwater = false;

		this._nextStrike = 4 + Math.random() * 6;
		this._flashT = -1;
		this._flashDur = 0.5;
		this._flashSeed = 0;
		this._flashPower = 1;
		this._thunderTimers = [];
		this._audioReady = false;
		this._audioInitTried = false;
		this._rainHandle = null;
		this._windHandle = null;
		this._fogWeather = { rain: 0, snow: 0 };

		if (this.particles !== null) {
			this.rainField = this.particles.createField({
				mode: 'streak',
				capacity: 40960, budget: 24000, seed: 7717,
				tile: 2, additive: false,
				color: new Color(0.64, 0.72, 0.86),
				opacity: 0.62,
				size: [0.075, 2.6],
				fall: 30,
				sway: [0, 0],
				edgeFade: 0.62
			});
			this.snowField = this.particles.createField({
				mode: 'sprite',
				capacity: 30000, budget: 20000, seed: 3313,
				tile: 0, additive: false,
				color: new Color(0.93, 0.95, 1.0),
				opacity: 0.9,
				size: [0.16, 0.42],
				fall: 1.15,
				sway: [0.55, 0.9],
				edgeFade: 0.6
			});
		} else {
			this.rainField = null;
			this.snowField = null;
		}

		this.splashEmitter = null;
		this._splashPos = new Vector3();
		if (this.splashSystem !== null && this.terrain !== null) {
			const self = this;
			this.splashEmitter = this.splashSystem.addEmitter({
				rate: 0,
				maxPerStep: 24,
				config: {
					position: this._splashPos,
					spreadBox: new Vector3(19, 0, 19),
					speed: { min: 0.4, max: 1.3 },
					bias: new Vector3(0, 0.8, 0),
					life: { min: 0.14, max: 0.3 },
					size0: { min: 0.05, max: 0.11 },
					size1: { min: 0.16, max: 0.38 },
					color0: new Color(0.60, 0.68, 0.78),
					color1: new Color(0.52, 0.60, 0.72),
					alpha0: { min: 0.26, max: 0.5 },
					drag: { min: 1.5, max: 3.0 },
					gravityScale: { min: 1.0, max: 1.7 },
					windFactor: 0.08,
					tile: 0,
					stretch: { min: 1.2, max: 2.0 },
					groundSnap: (x, z) => {
						const y = self.terrain.height(x, z);
						return y < self.waterLevel + 0.25 ? null : y + 0.04;
					}
				}
			});
		}

		if (this.fog !== null) this.fog.weather = this._fogWeather;
		this.setMode(options.mode || 'clear', true);
	}

	get modeLabel() { return WEATHER_MODES[this.mode].label; }

	setMode(name, immediate = false) {
		if (WEATHER_MODES[name] === undefined) {
			console.warn('ThreeForge: WeatherManager — неизвестный режим: ' + name);
			return this;
		}
		this.mode = name;
		if (immediate === true) {
			this.rain = name === 'rain' ? 0.85 : name === 'storm' ? 1 : 0;
			this.snow = name === 'snow' ? 1 : 0;
		}
		this.dispatchEvent({ type: 'mode', mode: name, label: this.modeLabel });
		return this;
	}

	cycleMode() {
		const i = WEATHER_ORDER.indexOf(this.mode);
		return this.setMode(WEATHER_ORDER[(i + 1) % WEATHER_ORDER.length]);
	}

	update(dt) {
		if (!(dt > 0)) dt = 0;
		if (dt > 0.25) dt = 0.25;
		this.time += dt;
		const t = this.time;
		const m = this.mode;

		const tRain = m === 'rain' ? 0.85 : m === 'storm' ? 1 : 0;
		const tSnow = m === 'snow' ? 1 : 0;
		const k = 1 - Math.exp(-dt / 1.1);
		this.rain += (tRain - this.rain) * k;
		this.snow += (tSnow - this.snow) * k;
		if (Math.abs(tRain - this.rain) < 0.002) this.rain = tRain;
		if (Math.abs(tSnow - this.snow) < 0.002) this.snow = tSnow;

		const stormB = m === 'storm' ? 1 : 0;
		const windBase = this.rain * (5.5 + 5 * stormB) + this.snow * 1.9;
		const gust = 0.72 + 0.28 * Math.sin(t * 0.63) + 0.14 * Math.sin(t * 1.91 + 2.2);
		this.windSpeed = windBase * gust;
		this.windAngle = t * 0.045 + Math.sin(t * 0.017) * 1.7;
		if (this.particles !== null) {
			this.particles.wind.set(
				Math.cos(this.windAngle) * this.windSpeed, 0,
				Math.sin(this.windAngle) * this.windSpeed
			);
		}

		const sub = this.fog !== null ? this.fog.submerge : 0;
		this.underwater = sub > 0.35;
		const vis = this.fog !== null ? this.fog.visibility : 380;
		const hideK = this.underwater ? 0 : 1;

		if (this.rainField !== null) {
			const rI = this.rain * (m === 'storm' ? 1.1 : 1) * hideK;
			this.rainField.setIntensity(rI);
			if (rI > 0.003) {
				const rad = Math.min(55, Math.max(20, vis * 0.22));
				const hh = Math.min(48, Math.max(24, rad * 0.85));
				this.rainField.setBox(rad * 2, hh * 2, rad * 2);
				this.rainField.uniforms.uCenterOff.value.set(0, hh * 0.3, 0);
				const volume = 8 * rad * rad * hh;
				this.rainField.setBudget(Math.min(this.rainField.capacity, volume * 0.028));
				this.rainField.uniforms.uFall.value = 28 + 6 * stormB + this.windSpeed * 0.12;
			}
		}
		if (this.snowField !== null) {
			const sI = this.snow * hideK;
			this.snowField.setIntensity(sI);
			if (sI > 0.003) {
				const rad = Math.min(45, Math.max(18, vis * 0.2));
				const hh = Math.min(40, Math.max(20, rad * 0.8));
				this.snowField.setBox(rad * 2, hh * 2, rad * 2);
				this.snowField.uniforms.uCenterOff.value.set(0, hh * 0.55, 0);
				const volume = 8 * rad * rad * hh;
				this.snowField.setBudget(Math.min(this.snowField.capacity, volume * 0.045));
				this.snowField.uniforms.uFall.value = 1.05 + this.windSpeed * 0.02;
			}
		}

		if (this.splashEmitter !== null && this.camera !== null) {
			const rate = hideK * (this.snow > 0.5 ? 0 : 150 * this.rain * this.rain);
			this.splashEmitter.rate = rate;
			this.splashEmitter.enabled = rate > 1;
			this._splashPos.copy(this.camera.position);
		}

		this._fogWeather.rain = this.rain * hideK;
		this._fogWeather.snow = this.snow * hideK;

		this._updateLightning(dt, m === 'storm' && this.rain > 0.55 && !this.underwater);
		this._updateAudio();
		return this;
	}

	_strike() {
		this._flashT = 0;
		this._flashDur = 0.45 + Math.random() * 0.5;
		this._flashSeed = Math.random() * 10;
		this._flashPower = 0.7 + Math.random() * 0.6;
		if (this.lightning !== null) {
			const a = Math.random() * Math.PI * 2;
			this.lightning.position.set(Math.cos(a) * 420, 380 + Math.random() * 220, Math.sin(a) * 420);
		}
		if (this.audio !== null) {
			const delay = 350 + Math.random() * 2200;
			const gain = 0.25 + 0.5 * (1 - delay / 2600);
			const id = setTimeout(() => {
				if (this.audio !== null) this.audio.play('wx_thunder', { gain, rate: 0.75 + Math.random() * 0.5 });
			}, delay);
			this._thunderTimers.push(id);
			if (this._thunderTimers.length > 8) clearTimeout(this._thunderTimers.shift());
		}
		this.dispatchEvent({ type: 'lightning' });
	}

	_updateLightning(dt, stormOn) {
		if (this._flashT >= 0) {
			this._flashT += dt;
			const k = this._flashT / this._flashDur;
			if (k >= 1) {
				this._flashT = -1;
				if (this.lightning !== null) this.lightning.intensity = 0;
				if (this.skyUniforms !== null && this.skyUniforms.uFlash !== undefined) this.skyUniforms.uFlash.value = 0;
			} else {
				const blink = Math.sin(k * Math.PI * 5.5 + this._flashSeed) * 0.5 + 0.5;
				const attack = k < 0.06 ? k / 0.06 : 1;
				const env = Math.pow(1 - k, 2.2) * (0.35 + 0.65 * blink) * attack;
				if (this.lightning !== null) this.lightning.intensity = 3.4 * env * this._flashPower;
				if (this.skyUniforms !== null && this.skyUniforms.uFlash !== undefined) {
					this.skyUniforms.uFlash.value = 0.85 * env * this._flashPower;
				}
			}
		}
		if (stormOn) {
			this._nextStrike -= dt;
			if (this._nextStrike <= 0) {
				this._strike();
				this._nextStrike = 3.5 + Math.random() * 7.5;
			}
		} else {
			this._nextStrike = Math.max(this._nextStrike, 1.5);
		}
	}

	_updateAudio() {
		const a = this.audio;
		if (a === null) return;
		if (!this._audioReady) {
			if (a.ctx === null) return;
			if (this._audioInitTried === true) return;
			this._audioInitTried = true;
			if (!a._buffers.has('wx_rain')) {
				const rainBuf = a.makeNoiseBuffer({ seconds: 4, color: 'pink' });
				const windBuf = a.makeNoiseBuffer({ seconds: 5, color: 'brown' });
				const thunderBuf = a.makeNoiseBuffer({ seconds: 2.6, color: 'brown', decay: 1.6 });
				if (rainBuf !== null) a.registerBuffer('wx_rain', rainBuf);
				if (windBuf !== null) a.registerBuffer('wx_wind', windBuf);
				if (thunderBuf !== null) a.registerBuffer('wx_thunder', thunderBuf);
			}
			this._rainHandle = a.playAmbient('wx_rain', { loop: true, gain: 0 });
			this._windHandle = a.playAmbient('wx_wind', { loop: true, gain: 0 });
			this._audioReady = this._rainHandle !== null || this._windHandle !== null;
			if (!this._audioReady) {
				console.warn('ThreeForge: WeatherManager — процедурный звук погоды недоступен (AmbientSource не создан), дальнейшие попытки отключены');
				return;
			}
		}
		const mute = this.underwater ? 0.15 : 1;
		if (this._rainHandle !== null) {
			this._rainHandle.setGain((this.rain * 0.16 + (this.mode === 'storm' ? 0.05 : 0)) * mute);
		}
		if (this._windHandle !== null) {
			this._windHandle.setGain((this.snow * 0.05 + this.rain * 0.03 * (this.mode === 'storm' ? 2 : 1)) * mute);
		}
	}

	getState() {
		return {
			mode: this.mode,
			label: this.modeLabel,
			rain: +this.rain.toFixed(2),
			snow: +this.snow.toFixed(2),
			windSpeed: +this.windSpeed.toFixed(1),
			windDeg: Math.round(this.windAngle * 180 / Math.PI % 360),
			lightning: this._flashT >= 0,
			underwater: this.underwater
		};
	}

	/**
	 * Полная остановка погоды: таймеры грома, амбиент-лупы, поля частиц.
	 *
	 * ИСПРАВЛЕНО (N1): поля частиц уничтожались через field.dispose(), но
	 * оставались зарегистрированными в ParticleManager (менеджер продолжал
	 * каждый кадр вызывать у них _refresh() и считать их в getStats());
	 * эмиттер брызг оставался в splashSystem.emitters и спавнил частицы
	 * в disposed-систему; ссылка fog.weather продолжала влиять на туман.
	 */
	dispose() {
		for (const id of this._thunderTimers) clearTimeout(id);
		this._thunderTimers.length = 0;
		if (this._rainHandle !== null) { this._rainHandle.stop(); this._rainHandle = null; }
		if (this._windHandle !== null) { this._windHandle.stop(); this._windHandle = null; }
		this._audioReady = false;
		const pm = this.particles;
		if (pm !== null && pm !== undefined) {
			if (this.rainField !== null) pm.destroyField(this.rainField);
			if (this.snowField !== null) pm.destroyField(this.snowField);
		} else {
			if (this.rainField !== null) this.rainField.dispose();
			if (this.snowField !== null) this.snowField.dispose();
		}
		this.rainField = null;
		this.snowField = null;
		if (this.splashEmitter !== null && this.splashSystem !== null) {
			this.splashSystem.removeEmitter(this.splashEmitter);
			this.splashEmitter = null;
		}
		if (this.fog !== null && this.fog.weather === this._fogWeather) this.fog.weather = null;
		if (this.lightning !== null) this.lightning.intensity = 0;
		this.rain = 0;
		this.snow = 0;
		this._fogWeather.rain = 0;
		this._fogWeather.snow = 0;
	}
};

function createPRNG(seed) {
	let s = seed >>> 0;
	return function () {
		s |= 0;
		s = (s + 1831565813) | 0;
		let t = Math.imul(s ^ (s >>> 15), 1 | s);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const SIMPLEX_GRAD3 = new Float32Array([
	1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0,
	1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1,
	0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1
]);
const SIMPLEX_F2 = 0.5 * (Math.sqrt(3) - 1);
const SIMPLEX_G2 = (3 - Math.sqrt(3)) / 6;

const SimplexNoise = class {
	constructor(seed = 0) {
		const rand = typeof seed === 'function' ? seed : createPRNG(seed);
		const p = new Uint8Array(256);
		for (let i = 0; i < 256; i++) p[i] = i;
		for (let i = 255; i > 0; i--) {
			const j = Math.floor(rand() * (i + 1));
			const t = p[i]; p[i] = p[j]; p[j] = t;
		}
		this.perm = new Uint8Array(512);
		this.permMod12 = new Uint8Array(512);
		for (let i = 0; i < 512; i++) {
			this.perm[i] = p[i & 255];
			this.permMod12[i] = this.perm[i] % 12;
		}
	}

	noise2D(x, y) {
		const grad3 = SIMPLEX_GRAD3, perm = this.perm, permMod12 = this.permMod12;
		const F2 = SIMPLEX_F2, G2 = SIMPLEX_G2;
		let n0 = 0, n1 = 0, n2 = 0;
		const s = (x + y) * F2;
		const i = Math.floor(x + s);
		const j = Math.floor(y + s);
		const t = (i + j) * G2;
		const x0 = x - (i - t);
		const y0 = y - (j - t);
		let i1, j1;
		if (x0 > y0) { i1 = 1; j1 = 0; } else { i1 = 0; j1 = 1; }
		const x1 = x0 - i1 + G2, y1 = y0 - j1 + G2;
		const x2 = x0 - 1 + 2 * G2, y2 = y0 - 1 + 2 * G2;
		const ii = i & 255, jj = j & 255;
		let t0 = 0.5 - x0 * x0 - y0 * y0;
		if (t0 >= 0) {
			const gi0 = permMod12[ii + perm[jj]] * 3;
			t0 *= t0;
			n0 = t0 * t0 * (grad3[gi0] * x0 + grad3[gi0 + 1] * y0);
		}
		let t1 = 0.5 - x1 * x1 - y1 * y1;
		if (t1 >= 0) {
			const gi1 = permMod12[ii + i1 + perm[jj + j1]] * 3;
			t1 *= t1;
			n1 = t1 * t1 * (grad3[gi1] * x1 + grad3[gi1 + 1] * y1);
		}
		let t2 = 0.5 - x2 * x2 - y2 * y2;
		if (t2 >= 0) {
			const gi2 = permMod12[ii + 1 + perm[jj + 1]] * 3;
			t2 *= t2;
			n2 = t2 * t2 * (grad3[gi2] * x2 + grad3[gi2 + 1] * y2);
		}
		return 70 * (n0 + n1 + n2);
	}
};

function fbm(noiseFn, x, y, options = {}) {
	const octaves = Math.max(1, Math.floor(options.octaves !== undefined ? options.octaves : 4));
	const lacunarity = options.lacunarity !== undefined ? options.lacunarity : 2;
	const gain = options.gain !== undefined ? options.gain : 0.5;
	let sum = 0, amp = 1, freq = 1, norm = 0;
	for (let o = 0; o < octaves; o++) {
		sum += noiseFn(x * freq, y * freq) * amp;
		norm += amp;
		amp *= gain;
		freq *= lacunarity;
	}
	return norm > 0 ? sum / norm : 0;
}

const TERRAIN_SAND = new Color(0.76, 0.70, 0.50);
const TERRAIN_SNOW = new Color(0.95, 0.96, 0.98);
const TERRAIN_ROCK = new Color(0.42, 0.40, 0.38);
const TERRAIN_GRASS_A = new Color(0.24, 0.45, 0.18);
const TERRAIN_GRASS_B = new Color(0.36, 0.42, 0.22);

const Terrain = class {
	constructor(options = {}) {
		this.seed = options.seed || 0;
		// F4: кастомные веса типов scatter (null = палитра v2.7)
		this.scatterWeights = null;
		if (options.scatterWeights !== undefined && options.scatterWeights !== null) {
			const entries = Object.entries(options.scatterWeights).filter(e => e[1] > 0);
			const total = entries.reduce((a, e) => a + e[1], 0);
			if (total > 0) {
				let acc = 0;
				this.scatterWeights = entries.map(e => {
					acc += e[1] / total;
					return { t: e[0], c: acc };
				});
			}
		}
		this.scale = options.scale !== undefined ? options.scale : 0.004;
		this.amplitude = options.amplitude !== undefined ? options.amplitude : 40;
		this.octaves = options.octaves !== undefined ? options.octaves : 5;
		this.ridgeMix = options.ridgeMix !== undefined ? options.ridgeMix : 0.35;
		this.waterLevel = options.waterLevel !== undefined ? options.waterLevel : -6;
		this.noise = new SimplexNoise(this.seed);
		this.noise2 = new SimplexNoise(this.seed + 1013);
		this._baseNoiseFn = (x, y) => this.noise.noise2D(x, y);
		this._ridgeNoiseFn = (x, y) => 1 - Math.abs(this.noise2.noise2D(x, y));
		this._baseOpts = { octaves: this.octaves };
		this._ridgeOpts = { octaves: 4 };
		this._palRGB = {
			sand: [TERRAIN_SAND.r, TERRAIN_SAND.g, TERRAIN_SAND.b],
			snow: [TERRAIN_SNOW.r, TERRAIN_SNOW.g, TERRAIN_SNOW.b],
			rock: [TERRAIN_ROCK.r, TERRAIN_ROCK.g, TERRAIN_ROCK.b],
			grassA: [TERRAIN_GRASS_A.r, TERRAIN_GRASS_A.g, TERRAIN_GRASS_A.b],
			grassB: [TERRAIN_GRASS_B.r, TERRAIN_GRASS_B.g, TERRAIN_GRASS_B.b]
		};
		if (options.palette !== undefined && options.palette !== null) {
			for (const k of ['sand', 'snow', 'rock', 'grassA', 'grassB']) {
				const v = options.palette[k];
				if (v !== undefined && v !== null && v.length === 3) this._palRGB[k] = [v[0], v[1], v[2]];
			}
		}
		this._colScratch = [0, 0, 0];
	}

	height(x, z) {
		const s = this.scale;
		const base = fbm(this._baseNoiseFn, x * s, z * s, this._baseOpts);
		let ridge = fbm(this._ridgeNoiseFn, x * s * 0.7, z * s * 0.7, this._ridgeOpts);
		ridge = ridge * ridge;
		return (base * (1 - this.ridgeMix) + (ridge * 2 - 1) * this.ridgeMix) * this.amplitude;
	}

	normal(x, z, out, eps = 0.5) {
		const hL = this.height(x - eps, z);
		const hR = this.height(x + eps, z);
		const hD = this.height(x, z - eps);
		const hU = this.height(x, z + eps);
		return out.set(hL - hR, 2 * eps, hD - hU).normalize();
	}

	buildChunkArrays(chunkX, chunkZ, size, segments = 24, options = null) {
		const seg = Math.max(1, segments | 0);
		const side = seg + 1;
		const gridVerts = side * side;
		const skirt = options !== null && options !== undefined && options.skirt > 0 ? options.skirt : 0;
		const skirtVerts = skirt > 0 ? 4 * side : 0;
		const vertCount = gridVerts + skirtVerts;
		const positions = new Float32Array(vertCount * 3);
		const normals = new Float32Array(vertCount * 3);
		const colors = new Float32Array(vertCount * 3);
		const uvs = new Float32Array(vertCount * 2);
		const originX = chunkX * size;
		const originZ = chunkZ * size;
		const step = size / seg;

		const heights = new Float64Array(gridVerts);
		for (let iz = 0; iz <= seg; iz++)
			for (let ix = 0; ix <= seg; ix++)
				heights[iz * side + ix] = this.height(originX + ix * step, originZ + iz * step);
		const hAt = (ix, iz) => {
			if (ix >= 0 && ix <= seg && iz >= 0 && iz <= seg) return heights[iz * side + ix];
			return this.height(originX + ix * step, originZ + iz * step);
		};

		const col = this._colScratch;
		let v = 0;
		for (let iz = 0; iz <= seg; iz++) {
			for (let ix = 0; ix <= seg; ix++) {
				const wx = originX + ix * step;
				const wz = originZ + iz * step;
				const h = heights[iz * side + ix];
				positions[v * 3] = wx - originX;
				positions[v * 3 + 1] = h;
				positions[v * 3 + 2] = wz - originZ;
				uvs[v * 2] = ix / seg;
				uvs[v * 2 + 1] = iz / seg;
				const hL = hAt(ix - 1, iz), hR = hAt(ix + 1, iz);
				const hD = hAt(ix, iz - 1), hU = hAt(ix, iz + 1);
				let nx = hL - hR, ny = 2 * step, nz = hD - hU;
				let inv = 1 / (Math.sqrt(nx * nx + ny * ny + nz * nz) || 1);
				normals[v * 3] = nx * inv;
				normals[v * 3 + 1] = ny * inv;
				normals[v * 3 + 2] = nz * inv;
				const fL = this.height(wx - 0.5, wz), fR = this.height(wx + 0.5, wz);
				const fD = this.height(wx, wz - 0.5), fU = this.height(wx, wz + 0.5);
				const fx = fL - fR, fy = 1, fz = fD - fU;
				inv = 1 / (Math.sqrt(fx * fx + fy * fy + fz * fz) || 1);
				const slope = 1 - fy * inv;
				this._terrainColorRGB(h, slope, col);
				colors[v * 3] = col[0];
				colors[v * 3 + 1] = col[1];
				colors[v * 3 + 2] = col[2];
				v++;
			}
		}

		const stitch = options !== null && options !== undefined ? options.stitch : null;
		if (stitch !== null && stitch !== undefined) {
			const edges = [
				{ n: stitch.south, alongX: true, fixed: 0, perpZ: originZ },
				{ n: stitch.north, alongX: true, fixed: seg, perpZ: originZ + size },
				{ n: stitch.west, alongX: false, fixed: 0, perpX: originX },
				{ n: stitch.east, alongX: false, fixed: seg, perpX: originX + size }
			];
			for (let e = 0; e < 4; e++) {
				const ed = edges[e];
				const nSeg = ed.n | 0;
				if (!(nSeg > 0) || nSeg >= seg) continue;
				const coarseStep = size / nSeg;
				for (let i = 1; i < seg; i++) {
					const along = (ed.alongX ? originX : originZ) + i * step;
					const k = along / coarseStep;
					const kf = Math.floor(k);
					const frac = k - kf;
					if (frac < 1e-9) continue;
					const a0 = kf * coarseStep;
					const a1 = a0 + coarseStep;
					let h0, h1;
					if (ed.alongX) {
						h0 = this.height(a0, ed.perpZ);
						h1 = this.height(a1, ed.perpZ);
					} else {
						h0 = this.height(ed.perpX, a0);
						h1 = this.height(ed.perpX, a1);
					}
					const y = h0 + (h1 - h0) * frac;
					const vi = ed.alongX ? (ed.fixed * side + i) : (i * side + ed.fixed);
					positions[vi * 3 + 1] = y;
				}
			}
		}

		let skirtBase = gridVerts;
		const sideDefs = skirt > 0 ? [
			{ alongX: true, fixed: 0, fwd: true },
			{ alongX: false, fixed: seg, fwd: true },
			{ alongX: true, fixed: seg, fwd: false },
			{ alongX: false, fixed: 0, fwd: false }
		] : null;
		if (skirt > 0) {
			for (let s = 0; s < 4; s++) {
				const def = sideDefs[s];
				for (let k = 0; k < side; k++) {
					const gx = def.alongX ? k : def.fixed;
					const gz = def.alongX ? def.fixed : k;
					const g = gz * side + gx;
					const sv = skirtBase + s * side + k;
					positions[sv * 3] = positions[g * 3];
					positions[sv * 3 + 1] = positions[g * 3 + 1] - skirt;
					positions[sv * 3 + 2] = positions[g * 3 + 2];
					normals[sv * 3] = normals[g * 3];
					normals[sv * 3 + 1] = normals[g * 3 + 1];
					normals[sv * 3 + 2] = normals[g * 3 + 2];
					colors[sv * 3] = colors[g * 3];
					colors[sv * 3 + 1] = colors[g * 3 + 1];
					colors[sv * 3 + 2] = colors[g * 3 + 2];
					uvs[sv * 2] = uvs[g * 2];
					uvs[sv * 2 + 1] = uvs[g * 2 + 1];
				}
			}
		}

		const indexCount = seg * seg * 6 + (skirt > 0 ? 4 * seg * 6 : 0);
		const index = vertCount > 65535 ? new Uint32Array(indexCount) : new Uint16Array(indexCount);
		let m = 0;
		for (let iz = 0; iz < seg; iz++) {
			for (let ix = 0; ix < seg; ix++) {
				const a = iz * side + ix;
				const b = a + 1;
				const c = a + side;
				const d = c + 1;
				index[m++] = a; index[m++] = c; index[m++] = b;
				index[m++] = b; index[m++] = c; index[m++] = d;
			}
		}
		if (skirt > 0) {
			for (let s = 0; s < 4; s++) {
				const def = sideDefs[s];
				const skBase = gridVerts + s * side;
				for (let k = 0; k < seg; k++) {
					const gix0 = def.alongX ? k : def.fixed;
					const giz0 = def.alongX ? def.fixed : k;
					const gix1 = def.alongX ? k + 1 : def.fixed;
					const giz1 = def.alongX ? def.fixed : k + 1;
					const A = giz0 * side + gix0;
					const B = giz1 * side + gix1;
					const SkA = skBase + k;
					const SkB = skBase + k + 1;
					if (def.fwd) {
						index[m++] = A; index[m++] = B; index[m++] = SkA;
						index[m++] = B; index[m++] = SkB; index[m++] = SkA;
					} else {
						index[m++] = B; index[m++] = A; index[m++] = SkA;
						index[m++] = SkB; index[m++] = B; index[m++] = SkA;
					}
				}
			}
		}
		return { positions, normals, colors, uvs, index, vertCount, indexCount, seg, side, skirt };
	}

	buildChunkGeometry(chunkX, chunkZ, size, segments = 24, options = null) {
		const a = this.buildChunkArrays(chunkX, chunkZ, size, segments, options);
		const geo = new BufferGeometry();
		geo.setAttribute('position', new BufferAttribute(a.positions, 3));
		geo.setAttribute('normal', new BufferAttribute(a.normals, 3));
		geo.setAttribute('color', new BufferAttribute(a.colors, 3));
		geo.setAttribute('uv', new BufferAttribute(a.uvs, 2));
		geo.setIndex(new BufferAttribute(a.index, 1));
		return geo;
	}

	_terrainColorRGB(h, slope, out3) {
		const o = out3 !== undefined && out3 !== null ? out3 : this._colScratch;
		const wl = this.waterLevel;
		const amp = this.amplitude;
		const P = this._palRGB;
		let a, b, t;
		if (h < wl + 1.5) {
			o[0] = P.sand[0]; o[1] = P.sand[1]; o[2] = P.sand[2];
			return o;
		}
		if (slope > 0.35 || h > amp * 0.72) {
			t = h > amp * 0.72 ? Math.min(1, (h - amp * 0.72) / (amp * 0.2)) : 0;
			a = P.rock; b = P.snow;
		} else {
			t = Math.min(1, Math.max(0, (h - wl) / (amp * 0.8)));
			a = P.grassA; b = P.grassB;
		}
		o[0] = a[0] + (b[0] - a[0]) * t;
		o[1] = a[1] + (b[1] - a[1]) * t;
		o[2] = a[2] + (b[2] - a[2]) * t;
		return o;
	}

	_terrainColor(h, slope, out) {
		const c = this._terrainColorRGB(h, slope, this._colScratch);
		out.setRGB(c[0], c[1], c[2]);
		return out;
	}

	/**
	 * Веса типов растительности для scatter() (F4): по умолчанию — палитра v2.7
	 * (tree/rock/bush/grass). Передайте options.scatterWeights {type: weight},
	 * чтобы добавить свои типы (например 'flower'): веса нормализуются.
	 */
	scatter(chunkX, chunkZ, size, count = 512) {
		const rand = createPRNG(chunkX * 73856093 ^ chunkZ * 19349663 ^ this.seed);
		const items = [];
		const baseX = chunkX * size;
		const baseZ = chunkZ * size;
		const nrm = new Vector3();
		for (let i = 0; i < count; i++) {
			const x = baseX + rand() * size;
			const z = baseZ + rand() * size;
			const h = this.height(x, z);
			if (h < this.waterLevel + 1) continue;
			this.normal(x, z, nrm);
			if (1 - nrm.y > 0.32) continue;
			const pick = rand();
			let type;
			const w = this.scatterWeights;
			if (w !== null) {
				type = w[w.length - 1].t;
				for (let k = 0; k < w.length; k++) {
					if (pick < w[k].c) { type = w[k].t; break; }
				}
			} else if (pick < 0.14) type = 'tree';
			else if (pick < 0.24) type = 'rock';
			else if (pick < 0.44) type = 'bush';
			else type = 'grass';
			items.push({
				type,
				position: new Vector3(x, h, z),
				scale: type === 'tree' ? 0.7 + rand() * 0.9
					: type === 'rock' ? 0.5 + rand() * 2.2
					: 0.6 + rand() * 0.8,
				rotationY: rand() * Math.PI * 2
			});
		}
		return items;
	}
};

const _physNormal = new Vector3();
const _physDelta = new Vector3();
const _physTmp1 = new Vector3();
const _physTmp2 = new Vector3();
const _physImpulse = new Vector3();
const _physSphere = new Sphere();
const _physBoxA = new Box3();
const _physBoxB = new Box3();
const _physBoxSelf = new Box3();
const _physSeenIds = new Set();
const _physRay = new Ray();
let _bodyIdCounter = 0;

const RigidBody = class {
	constructor(options = {}) {
		this.isBody = true;
		this.id = ++_bodyIdCounter;
		this.shape = options.shape || 'sphere';
		this.position = options.position !== undefined ? options.position.clone() : new Vector3();
		this.prevPosition = this.position.clone();
		this.velocity = options.velocity !== undefined ? options.velocity.clone() : new Vector3();
		this.radius = options.radius !== undefined ? options.radius : 0.5;
		this.halfExtents = options.halfExtents !== undefined ? options.halfExtents.clone() : new Vector3(0.5, 0.5, 0.5);
		this.mass = options.mass !== undefined ? options.mass : 1;
		this.invMass = this.mass > 0 ? 1 / this.mass : 0;
		this.restitution = options.restitution !== undefined ? options.restitution : 0.35;
		this.friction = options.friction !== undefined ? options.friction : 0.2;
		this.linearDamping = options.linearDamping !== undefined ? options.linearDamping : 0.02;
		this.type = options.type || (this.mass > 0 ? 'dynamic' : 'static');
		if (this.type !== 'dynamic') this.invMass = 0;
		this.grounded = false;
		this.onGroundSurface = false;
		this.userData = options.userData !== undefined ? options.userData : null;
		this.sleeping = false;
		this.sleepThreshold = options.sleepThreshold !== undefined ? options.sleepThreshold : 0.04;
		this._still = 0;
	}

	getBounds(out) {
		if (this.shape === 'sphere') {
			out.min.set(this.position.x - this.radius, this.position.y - this.radius, this.position.z - this.radius);
			out.max.set(this.position.x + this.radius, this.position.y + this.radius, this.position.z + this.radius);
		} else {
			out.min.copy(this.position).sub(this.halfExtents);
			out.max.copy(this.position).add(this.halfExtents);
		}
		return out;
	}

	applyImpulse(impulse) {
		if (this.invMass === 0) return this;
		this.velocity.addScaledVector(impulse, this.invMass);
		this.sleeping = false;
		return this;
	}
};

const SpatialHashGrid = class {
	constructor(cellSize = 8) {
		this.cellSize = cellSize;
		this.inv = 1 / cellSize;
		this.map = new Map();
		this._pool = [];
		this.pruneInterval = 60;
		this._frames = 0;
		this.maxCellsPerBody = 512;
		this._large = [];
	}

	/**
	 * Очистка перед новым шагом broadphase.
	 *
	 * ИСПРАВЛЕНО (C5): раньше пустые бакеты оставались в Map навсегда — тело,
	 * проехавшее через мир, «размазывало» по хешу тысячи мёртвых массивов
	 * (замер: 304 бакета после 200 позиций ОДНОГО тела; в открытом мире это
	 * неограниченный рост памяти и всё более дорогой обход Map). Теперь
	 * опустевшие бакеты возвращаются в пул, а пул периодически сбрасывается.
	 */
	clear() {
		for (const [key, bucket] of this.map) {
			bucket.length = 0;
			if (this._pool.length < 512) this._pool.push(bucket);
			this.map.delete(key);
		}
		this._large.length = 0;
		if (++this._frames >= this.pruneInterval) {
			this._frames = 0;
			this._pool.length = 0;
		}
	}
	_key(ix, iy, iz) {
		return (ix * 92837111) ^ (iy * 689287499) ^ (iz * 283923481) | 0;
	}
	insert(body) {
		body.getBounds(_physBoxSelf);
		const mn = _physBoxSelf.min, mx = _physBoxSelf.max;
		const x0 = Math.floor(mn.x * this.inv), x1 = Math.floor(mx.x * this.inv);
		const y0 = Math.floor(mn.y * this.inv), y1 = Math.floor(mx.y * this.inv);
		const z0 = Math.floor(mn.z * this.inv), z1 = Math.floor(mx.z * this.inv);
		const span = (x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1);
		if (span !== span) return;
		if (!(span <= this.maxCellsPerBody)) { this._large.push(body); return; }
		for (let ix = x0; ix <= x1; ix++)
			for (let iy = y0; iy <= y1; iy++)
				for (let iz = z0; iz <= z1; iz++) {
					const key = this._key(ix, iy, iz);
					let bucket = this.map.get(key);
					if (bucket === undefined) {
						bucket = this._pool.length > 0 ? this._pool.pop() : [];
						this.map.set(key, bucket);
					}
					bucket.push(body);
				}
	}
	queryBox(box, out) {
		const seen = _physSeenIds;
		seen.clear();
		const mn = box.min, mx = box.max;
		const x0 = Math.floor(mn.x * this.inv), x1 = Math.floor(mx.x * this.inv);
		const y0 = Math.floor(mn.y * this.inv), y1 = Math.floor(mx.y * this.inv);
		const z0 = Math.floor(mn.z * this.inv), z1 = Math.floor(mx.z * this.inv);
		for (let i = 0; i < this._large.length; i++) {
			const body = this._large[i];
			if (!seen.has(body.id)) { seen.add(body.id); out.push(body); }
		}
		const span = (x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1);
		if (span !== span) return out;
		if (span > this.map.size) {
			for (const bucket of this.map.values()) {
				for (let i = 0; i < bucket.length; i++) {
					const body = bucket[i];
					if (!seen.has(body.id)) { seen.add(body.id); out.push(body); }
				}
			}
			return out;
		}
		for (let ix = x0; ix <= x1; ix++)
			for (let iy = y0; iy <= y1; iy++)
				for (let iz = z0; iz <= z1; iz++) {
					const bucket = this.map.get(this._key(ix, iy, iz));
					if (bucket === undefined) continue;
					for (let i = 0; i < bucket.length; i++) {
						const body = bucket[i];
						if (!seen.has(body.id)) { seen.add(body.id); out.push(body); }
					}
				}
		return out;
	}
};

const PhysicsWorld = class {
	constructor(options = {}) {
		this.gravity = options.gravity !== undefined ? options.gravity.clone() : new Vector3(0, -25, 0);
		this.maxSpeed = options.maxSpeed !== undefined ? options.maxSpeed : 200;
		this.maxStep = options.maxStep !== undefined ? options.maxStep : 0.1;
		this.nanGuard = options.nanGuard !== false;
		this.iterations = options.iterations !== undefined ? options.iterations : 12;
		this.bodies = [];
		this.hash = new SpatialHashGrid(options.cellSize || 8);
		this.hashThreshold = options.hashThreshold !== undefined ? options.hashThreshold : 512;
		this.hashAwakeMin = options.hashAwakeMin !== undefined ? options.hashAwakeMin : 24;
		this.hashAwakeRatio = 0.15;
		this.heightfield = null;
		this.heightfieldEps = 0.5;
		this.contacts = [];
		this.recordContacts = options.recordContacts === true;
		this.wakeImpulse = 0.5;
		this.groundSlop = 0.06;
		this.sleepDelay = options.sleepDelay !== undefined ? options.sleepDelay : 0.25;
		this._pairSeen = new Set();
		this._pairK = 16777216;
		this._pairUseString = false;
		this._queryBuf = [];
		this._pairs = [];
		this._awake = [];
		this.enabled = true;
	}

	addBody(options) {
		if (options.isBody === true) {
			if (this.bodies.indexOf(options) === -1) this.bodies.push(options);
			return options;
		}
		const body = new RigidBody(options);
		this.bodies.push(body);
		return body;
	}

	removeBody(body) {
		const i = this.bodies.indexOf(body);
		if (i === -1) return this;
		this.bodies.splice(i, 1);
		const queue = [body];
		for (let q = 0; q < queue.length; q++) {
			const src = queue[q];
			const sp = src.position, sr = this._reach(src) + 0.25;
			for (let k = 0; k < this.bodies.length; k++) {
				const o = this.bodies[k];
				if (o.type !== 'dynamic' || !o.sleeping) continue;
				const reach = sr + this._reach(o);
				if (o.position.distanceToSquared(sp) <= reach * reach) {
					o.sleeping = false;
					o._still = 0;
					queue.push(o);
				}
			}
		}
		return this;
	}

	setHeightfield(fn) {
		this.heightfield = fn;
		return this;
	}

	step(dt) {
		if (!this.enabled) return this;
		if (!Number.isFinite(dt) || dt <= 0) return this;
		if (dt > this.maxStep) dt = this.maxStep;
		const bodies = this.bodies;
		const guard = this.nanGuard === true;

		const awake = this._awake;
		awake.length = 0;
		for (let i = 0; i < bodies.length; i++) {
			const b = bodies[i];
			if (b.type !== 'dynamic' || b.sleeping) continue;
			awake.push(b);
			if (guard === true) {
				const p = b.position, v = b.velocity;
				if (!Number.isFinite(p.x + p.y + p.z)) {
					const pp = b.prevPosition;
					if (Number.isFinite(pp.x + pp.y + pp.z)) p.copy(pp);
					else p.set(0, 0, 0);
				}
				if (!Number.isFinite(v.x + v.y + v.z)) v.set(0, 0, 0);
			}
			b.prevPosition.copy(b.position);
			b.velocity.addScaledVector(this.gravity, dt);
			const speedSq = b.velocity.lengthSq();
			if (speedSq > this.maxSpeed * this.maxSpeed) b.velocity.multiplyScalar(this.maxSpeed / Math.sqrt(speedSq));
			const damp = 1 - b.linearDamping * dt;
			b.velocity.multiplyScalar(damp > 0 ? damp : 0);
			b.position.addScaledVector(b.velocity, dt);
			b.grounded = false;
			b.onGroundSurface = false;
		}
		this.contacts.length = 0;

		const awakeCount = awake.length;
		const useHash = bodies.length >= this.hashThreshold && awakeCount >= this.hashAwakeMin;
		const pairs = this._pairs;
		pairs.length = 0;
		if (useHash) {
			this.hash.clear();
			let maxId = 0;
			for (let i = 0; i < bodies.length; i++) {
				const b = bodies[i];
				if (b.id > maxId) maxId = b.id;
				this.hash.insert(b);
			}
			let K = 1;
			while (K <= maxId) K *= 2;
			if (K <= 67108864) { this._pairK = K; this._pairUseString = false; }
			else this._pairUseString = true;
			this._pairSeen.clear();
			const stride = this._pairK;
			const useStr = this._pairUseString;
			for (let i = 0; i < bodies.length; i++) {
				const a = bodies[i];
				if (a.sleeping || a.type !== 'dynamic') continue;
				a.getBounds(_physBoxA);
				const query = this._queryBuf;
				query.length = 0;
				this.hash.queryBox(_physBoxA, query);
				const reachA = this._reach(a);
				for (let q = 0; q < query.length; q++) {
					const b = query[q];
					if (b === a || (a.invMass === 0 && b.invMass === 0)) continue;
					const lo = a.id < b.id ? a.id : b.id;
					const hi = a.id < b.id ? b.id : a.id;
					const pairId = useStr ? lo + ':' + hi : lo * stride + hi;
					if (this._pairSeen.has(pairId)) continue;
					this._pairSeen.add(pairId);
					_physDelta.subVectors(b.position, a.position);
					const reach = reachA + this._reach(b);
					if (_physDelta.lengthSq() > reach * reach) continue;
					pairs.push(a, b);
				}
			}
		} else {
			for (let ai = 0; ai < awake.length; ai++) {
				const a = awake[ai];
				const reachA = this._reach(a);
				const ax = a.position.x, ay = a.position.y, az = a.position.z;
				for (let j = 0; j < bodies.length; j++) {
					const b = bodies[j];
					if (b === a) continue;
					if (b.type === 'dynamic' && !b.sleeping && b.id < a.id) continue;
					if (a.invMass === 0 && b.invMass === 0) continue;
					const dx = b.position.x - ax, dy = b.position.y - ay, dz = b.position.z - az;
					const reach = reachA + this._reach(b);
					if (dx * dx + dy * dy + dz * dz > reach * reach) continue;
					pairs.push(a, b);
				}
			}
		}

		for (let iter = 0; iter < this.iterations; iter++) {
			if (this.heightfield !== null) {
				for (let i = 0; i < awake.length; i++) this._collideHeightfield(awake[i]);
			}
			for (let p = 0; p < pairs.length; p += 2) this._collidePair(pairs[p], pairs[p + 1]);
		}

		const minSpeedSq = Math.max(this.gravity.lengthSq() * dt * dt * 1.44, 0.04);
		for (let i = 0; i < bodies.length; i++) {
			const b = bodies[i];
			if (b.type !== 'dynamic' || b.sleeping) continue;
			const threshold = Math.max(b.sleepThreshold, minSpeedSq);
			if (b.grounded && b.velocity.lengthSq() < threshold) {
				b._still += dt;
				if (b._still >= this.sleepDelay) {
					b.velocity.set(0, 0, 0);
					b.sleeping = true;
					b.prevPosition.copy(b.position);
				}
			} else {
				b._still = 0;
			}
		}
		return this;
	}

	_reach(body) {
		return body.shape === 'sphere'
			? body.radius
			: body.halfExtents.x + body.halfExtents.y + body.halfExtents.z;
	}

	_collidePair(a, b) {
		if (a.shape === 'sphere' && b.shape === 'sphere') this._sphereSphere(a, b);
		else if (a.shape === 'sphere' && b.shape === 'box') this._sphereBox(a, b);
		else if (a.shape === 'box' && b.shape === 'sphere') this._sphereBox(b, a);
		else this._boxBox(a, b);
	}

	_sphereSphere(a, b) {
		_physDelta.subVectors(b.position, a.position);
		const rSum = a.radius + b.radius;
		const distSq = _physDelta.lengthSq();
		if (distSq >= rSum * rSum || distSq === 0) return;
		const dist = Math.sqrt(distSq);
		_physNormal.copy(_physDelta).multiplyScalar(1 / dist);
		const depth = rSum - dist;
		const point = _physTmp1.copy(a.position).addScaledVector(_physNormal, a.radius);
		this._resolve(a, b, _physNormal, depth, point);
	}

	_sphereBox(sphere, box) {
		_physDelta.copy(sphere.position).clamp(
			_physTmp1.copy(box.position).sub(box.halfExtents),
			_physTmp2.copy(box.position).add(box.halfExtents)
		);
		_physNormal.subVectors(sphere.position, _physDelta);
		const distSq = _physNormal.lengthSq();
		if (distSq >= sphere.radius * sphere.radius) return;
		let dist = Math.sqrt(distSq);
		if (dist === 0) { _physNormal.set(0, 1, 0); dist = 1e-4; }
		else _physNormal.multiplyScalar(1 / dist);
		const depth = sphere.radius - dist;
		this._resolve(box, sphere, _physNormal, depth, _physDelta);
	}

	_boxBox(a, b) {
		a.getBounds(_physBoxA);
		b.getBounds(_physBoxB);
		const ox = Math.min(_physBoxA.max.x, _physBoxB.max.x) - Math.max(_physBoxA.min.x, _physBoxB.min.x);
		if (ox <= 0) return;
		const oy = Math.min(_physBoxA.max.y, _physBoxB.max.y) - Math.max(_physBoxA.min.y, _physBoxB.min.y);
		if (oy <= 0) return;
		const oz = Math.min(_physBoxA.max.z, _physBoxB.max.z) - Math.max(_physBoxA.min.z, _physBoxB.min.z);
		if (oz <= 0) return;
		let depth;
		if (ox <= oy && ox <= oz) {
			_physNormal.set(a.position.x < b.position.x ? 1 : -1, 0, 0);
			depth = ox;
		} else if (oy <= oz) {
			_physNormal.set(0, a.position.y < b.position.y ? 1 : -1, 0);
			depth = oy;
		} else {
			_physNormal.set(0, 0, a.position.z < b.position.z ? 1 : -1);
			depth = oz;
		}
		this._resolve(a, b, _physNormal, depth, _physDelta.copy(a.position));
	}

	_resolve(a, b, normal, depth, point) {
		if (this.recordContacts) {
			this.contacts.push({ a, b, normal: normal.clone(), depth, point: point.clone() });
		}
		_physDelta.subVectors(b.velocity, a.velocity);
		const vn = _physDelta.dot(normal);
		if (vn > 0 && depth < 0.02) return;

		const restitution = Math.min(a.restitution, b.restitution);
		const invMassSum = a.invMass + b.invMass;
		if (invMassSum === 0) return;

		const jn = -(1 + restitution) * vn / invMassSum;
		const wake = Math.abs(jn) > this.wakeImpulse;
		const invA = (a.sleeping === true && wake === false) ? 0 : a.invMass;
		const invB = (b.sleeping === true && wake === false) ? 0 : b.invMass;
		const invEff = invA + invB;
		if (invEff === 0) return;
		const je = -(1 + restitution) * vn / invEff;
		_physImpulse.copy(normal).multiplyScalar(je);
		a.velocity.addScaledVector(_physImpulse, -invA);
		b.velocity.addScaledVector(_physImpulse, invB);

		_physDelta.subVectors(b.velocity, a.velocity);
		_physTmp1.copy(normal).multiplyScalar(_physDelta.dot(normal));
		_physTmp2.subVectors(_physDelta, _physTmp1);
		const vt = _physTmp2.length();
		if (vt > 1e-6) {
			_physTmp2.multiplyScalar(1 / vt);
			const mu = Math.sqrt(a.friction * b.friction);
			let jt = -vt / invEff;
			const maxFriction = Math.abs(je) * mu;
			if (jt < -maxFriction) jt = -maxFriction;
			else if (jt > maxFriction) jt = maxFriction;
			a.velocity.addScaledVector(_physTmp2, -jt * invA);
			b.velocity.addScaledVector(_physTmp2, jt * invB);
		}

		const correction = Math.max(depth - 0.005, 0) / invEff * 0.55;
		a.position.addScaledVector(normal, -correction * invA);
		b.position.addScaledVector(normal, correction * invB);

		if (wake === true) {
			if (a.sleeping === true) { a.sleeping = false; a._still = 0; }
			if (b.sleeping === true) { b.sleeping = false; b._still = 0; }
		}
		if (normal.y > 0.6 && b.invMass > 0) b.grounded = true;
		if (normal.y < -0.6 && a.invMass > 0) a.grounded = true;
	}

	_collideHeightfield(body) {
		const hf = this.heightfield;
		const x = body.position.x, z = body.position.z;
		const support = body.shape === 'sphere' ? body.radius : body.halfExtents.y;
		const groundY = hf(x, z);
		const penetration = groundY + support - body.position.y;
		if (penetration <= -this.groundSlop) return;
		if (penetration <= 0) {
			body.grounded = true;
			body.onGroundSurface = true;
			return;
		}
		const eps = this.heightfieldEps;
		const hL = hf(x - eps, z), hR = hf(x + eps, z);
		const hD = hf(x, z - eps), hU = hf(x, z + eps);
		_physNormal.set(hL - hR, 2 * eps, hD - hU);
		if (_physNormal.y < 0) _physNormal.y = -_physNormal.y;
		if (_physNormal.lengthSq() < 1e-12) _physNormal.set(0, 1, 0);
		_physNormal.normalize();

		if (body.type !== 'dynamic') return;
		const vn = body.velocity.dot(_physNormal);
		if (vn < 0) {
			const bounce = vn < -6 ? body.restitution : 0;
			body.velocity.addScaledVector(_physNormal, -(1 + bounce) * vn);
			_physTmp1.copy(_physNormal).multiplyScalar(body.velocity.dot(_physNormal));
			_physTmp2.subVectors(body.velocity, _physTmp1);
			if (_physTmp2.length() > 1e-6) {
				const friction = Math.min(1, body.friction * (1 + Math.abs(vn) * 0.02));
				body.velocity.addScaledVector(_physTmp2, -friction);
			}
		}
		body.position.addScaledVector(_physNormal, penetration);
		body.grounded = _physNormal.y > 0.6;
		body.onGroundSurface = true;
		if (vn < -this.wakeImpulse) body.sleeping = false;
		if (this.recordContacts) {
			this.contacts.push({
				a: body, b: null,
				normal: _physNormal.clone(), depth: penetration,
				point: new Vector3(x, groundY, z)
			});
		}
	}

	/**
	 * Ближайшее попадание луча по телам (сферы — точно, боксы — по AABB).
	 *
	 * ИСПРАВЛЕНО (N2):
	 *  · направление нормируется — Ray.intersectSphere/intersectBox требуют
	 *    единичный dir, иначе при `direction.length() !== 1` возвращаемая
	 *    `distance` была дистанцией в «длинях направления», а maxDistance
	 *    сравнивалось не с метрами (тихий источник багов прицеливания);
	 *  · результат можно писать в свой объект (`out`) — прежняя версия
	 *    аллоцировала `{body, point: Vector3.clone(), distance}` на каждое
	 *    улучшение хита, то есть до нескольких объектов за кадр в горячем пути
	 *    (рейкаст земли под игроком делается каждый шаг физики).
	 *
	 * @param {THREE.Vector3} origin - Начало луча (мир).
	 * @param {THREE.Vector3} direction - Направление (нормируется внутри).
	 * @param {number} [maxDistance=Infinity] - Ограничение дистанции, метры.
	 * @param {{body:RigidBody,point:THREE.Vector3,distance:number}|null} [out=null] - Куда писать хит.
	 * @returns {{body:RigidBody,point:THREE.Vector3,distance:number}|null}
	 */
	raycast(origin, direction, maxDistance = Infinity, out = null) {
		_physRay.origin.copy(origin);
		_physRay.direction.copy(direction);
		const len = _physRay.direction.length();
		if (!(len > 1e-9)) return null;
		_physRay.direction.multiplyScalar(1 / len);
		let closest = null;
		let best = maxDistance;
		for (let i = 0; i < this.bodies.length; i++) {
			const body = this.bodies[i];
			let hitPoint = null;
			if (body.shape === 'sphere') {
				_physSphere.center.copy(body.position);
				_physSphere.radius = body.radius;
				hitPoint = _physRay.intersectSphere(_physSphere, _physTmp1);
			} else {
				body.getBounds(_physBoxA);
				hitPoint = _physRay.intersectBox(_physBoxA, _physTmp1);
			}
			if (hitPoint === null) continue;
			const dist = origin.distanceTo(_physTmp1);
			if (dist < best) {
				best = dist;
				if (closest === null) {
					closest = out !== null ? out : { body: null, point: new Vector3(), distance: 0 };
				}
				closest.body = body;
				closest.point.copy(_physTmp1);
				closest.distance = dist;
			}
		}
		return closest;
	}

	explode(position, radius, strength) {
		for (let i = 0; i < this.bodies.length; i++) {
			const b = this.bodies[i];
			if (b.invMass === 0) continue;
			_physDelta.subVectors(b.position, position);
			const dist = _physDelta.length();
			if (dist > radius || dist === 0) continue;
			const falloff = 1 - dist / radius;
			b.applyImpulse(_physDelta.multiplyScalar(strength * falloff / dist));
		}
		return this;
	}

	clear() {
		this.bodies.length = 0;
		this.contacts.length = 0;
		return this;
	}
};

const _inputMouseDelta = new Vector2();

const InputManager = class extends EventDispatcher {
	constructor(domElement = null) {
		super();
		this.domElement = domElement || (typeof document !== 'undefined' ? document.body : null);
		this.keys = new Set();
		this._pressed = new Set();
		this._released = new Set();
		this.mouse = { x: 0, y: 0, dx: 0, dy: 0, wheel: 0 };
		this.mouseButtons = new Set();
		this._actions = new Map();
		this._axes = new Map();
		this._boundCodes = new Set();
		this.pointerLocked = false;
		this.gamepadIndex = null;
		this.gamepadDeadzone = 0.18;
		this.enabled = true;
		this._gamepadCache = null;
		this._gamepadCached = false;
		this._onKeyDown = this._onKeyDown.bind(this);
		this._onKeyUp = this._onKeyUp.bind(this);
		this._onMouseMove = this._onMouseMove.bind(this);
		this._onMouseDown = this._onMouseDown.bind(this);
		this._onMouseUp = this._onMouseUp.bind(this);
		this._onWheel = this._onWheel.bind(this);
		this._onContext = e => e.preventDefault();
		this._onLockChange = this._onLockChange.bind(this);
		this._onBlur = this._onBlur.bind(this);
		this._connected = false;
		this.connect();
	}

	connect() {
		if (this.domElement === null || typeof window === 'undefined') return this;
		if (this._connected === true) return this;
		this._connected = true;
		window.addEventListener('keydown', this._onKeyDown);
		window.addEventListener('keyup', this._onKeyUp);
		window.addEventListener('mousemove', this._onMouseMove);
		window.addEventListener('mousedown', this._onMouseDown);
		window.addEventListener('mouseup', this._onMouseUp);
		window.addEventListener('wheel', this._onWheel, { passive: true });
		window.addEventListener('contextmenu', this._onContext);
		window.addEventListener('blur', this._onBlur);
		document.addEventListener('visibilitychange', this._onBlur);
		document.addEventListener('pointerlockchange', this._onLockChange);
		return this;
	}

	disconnect() {
		if (this.domElement === null || typeof window === 'undefined') return this;
		if (this._connected !== true) return this;
		this._connected = false;
		this._resetState();
		window.removeEventListener('keydown', this._onKeyDown);
		window.removeEventListener('keyup', this._onKeyUp);
		window.removeEventListener('mousemove', this._onMouseMove);
		window.removeEventListener('mousedown', this._onMouseDown);
		window.removeEventListener('mouseup', this._onMouseUp);
		window.removeEventListener('wheel', this._onWheel);
		window.removeEventListener('contextmenu', this._onContext);
		window.removeEventListener('blur', this._onBlur);
		if (typeof document !== 'undefined') {
			document.removeEventListener('visibilitychange', this._onBlur);
			document.removeEventListener('pointerlockchange', this._onLockChange);
		}
		return this;
	}

	bind(action, ...codes) {
		let set = this._actions.get(action);
		if (set === undefined) { set = new Set(); this._actions.set(action, set); }
		for (const code of codes) {
			const c = String(code);
			set.add(c);
			if (!c.startsWith('Mouse')) this._boundCodes.add(c);
		}
		return this;
	}

	bindAxis(axis, negativeCode, positiveCode, gamepadAxis = null) {
		this._axes.set(axis, { negative: negativeCode, positive: positiveCode, gamepadAxis });
		if (negativeCode) this._boundCodes.add(String(negativeCode));
		if (positiveCode) this._boundCodes.add(String(positiveCode));
		return this;
	}

	isDown(action) {
		const set = this._actions.get(action);
		if (set === undefined) return false;
		for (const code of set) {
			if (code.startsWith('Mouse')) {
				if (this.mouseButtons.has(Number(code.slice(5)))) return true;
			} else if (this.keys.has(code)) return true;
		}
		return false;
	}

	isPressed(action) {
		const set = this._actions.get(action);
		if (set === undefined) return false;
		for (const code of set) if (this._pressed.has(code)) return true;
		return false;
	}

	isReleased(action) {
		const set = this._actions.get(action);
		if (set === undefined) return false;
		for (const code of set) if (this._released.has(code)) return true;
		return false;
	}

	axis(name) {
		const def = this._axes.get(name);
		if (def === undefined) return 0;
		let value = 0;
		if (this.keys.has(def.negative)) value -= 1;
		if (this.keys.has(def.positive)) value += 1;
		const pad = this.gamepad();
		if (pad !== null && def.gamepadAxis !== null) {
			const stick = pad.axes[def.gamepadAxis] || 0;
			if (Math.abs(stick) > this.gamepadDeadzone) value += stick;
		}
		return Math.max(-1, Math.min(1, value));
	}

	isKeyDown(code) { return this.keys.has(code); }

	/**
	 * Включить/выключить обработку ввода.
	 *
	 * ИСПРАВЛЕНО (N4): при `enabled = false` обработчики keyup/mouseup
	 * выходили сразу, поэтому зажатые в момент выключения клавиши оставались
	 * в this.keys навсегда — персонаж «бежал» после открытия меню/паузы.
	 * Теперь выключение сбрасывает всё текущее состояние (как при blur).
	 *
	 * @param {boolean} value
	 * @returns {this}
	 */
	setEnabled(value) {
		const next = value === true;
		if (next === this.enabled) return this;
		this.enabled = next;
		if (next === false) this._resetState();
		return this;
	}

	/**
	 * Накопленное движение мыши за кадр (dx, dy) с обнулением.
	 * P4: `out` по умолчанию — модульный скретч, а не новый Vector2 на вызов
	 * (метод зовётся каждый кадр в обработчике камеры).
	 */
	consumeMouseDelta(out = _inputMouseDelta) {
		out.set(this.mouse.dx, this.mouse.dy);
		this.mouse.dx = 0;
		this.mouse.dy = 0;
		return out;
	}

	gamepad() {
		if (this._gamepadCached) return this._gamepadCache;
		this._gamepadCached = true;
		if (typeof navigator === 'undefined' || navigator.getGamepads === undefined) {
			this._gamepadCache = null;
			return null;
		}
		const pads = navigator.getGamepads();
		this._gamepadCache = null;
		for (let i = 0; i < pads.length; i++) {
			if (pads[i] && pads[i].connected) { this._gamepadCache = pads[i]; break; }
		}
		return this._gamepadCache;
	}

	lockPointer() {
		if (this.domElement !== null && this.domElement.requestPointerLock) this.domElement.requestPointerLock();
		return this;
	}

	unlockPointer() {
		if (typeof document !== 'undefined' && document.exitPointerLock) document.exitPointerLock();
		return this;
	}

	endFrame() {
		this._pressed.clear();
		this._released.clear();
		this.mouse.wheel = 0;
		this.mouse.dx = 0;
		this.mouse.dy = 0;
		this._gamepadCached = false;
		this._gamepadCache = null;
	}

	_onKeyDown(event) {
		if (!this.enabled) return;
		if (this.pointerLocked && this._boundCodes.has(event.code)) event.preventDefault();
		if (event.repeat) return;
		this.keys.add(event.code);
		this._pressed.add(event.code);
		this.dispatchEvent({ type: 'keydown', code: event.code, event });
	}

	_onKeyUp(event) {
		if (!this.enabled) return;
		this.keys.delete(event.code);
		this._released.add(event.code);
		this.dispatchEvent({ type: 'keyup', code: event.code, event });
	}

	_onMouseMove(event) {
		if (!this.enabled) return;
		if (this.pointerLocked || this.mouseButtons.has(0)) {
			this.mouse.dx += event.movementX || 0;
			this.mouse.dy += event.movementY || 0;
		}
		this.mouse.x = event.clientX;
		this.mouse.y = event.clientY;
	}

	_onMouseDown(event) {
		if (!this.enabled) return;
		this.mouseButtons.add(event.button);
		this._pressed.add('Mouse' + event.button);
		this.dispatchEvent({ type: 'click', button: event.button, event });
	}

	_onMouseUp(event) {
		if (!this.enabled) return;
		this.mouseButtons.delete(event.button);
		this._released.add('Mouse' + event.button);
	}

	_onWheel(event) {
		if (!this.enabled) return;
		this.mouse.wheel += event.deltaY;
	}

	_onLockChange() {
		this.pointerLocked = typeof document !== 'undefined' && document.pointerLockElement === this.domElement;
		this.dispatchEvent({ type: 'pointerlockchange', locked: this.pointerLocked });
	}

	_resetState() {
		this.keys.clear();
		this.mouseButtons.clear();
		this._pressed.clear();
		this._released.clear();
		this.mouse.dx = 0;
		this.mouse.dy = 0;
		this.mouse.wheel = 0;
	}

	_onBlur() {
		this._resetState();
		this.dispatchEvent({ type: 'blur' });
	}

	dispose() {
		this.disconnect();
		this._actions.clear();
		this._axes.clear();
		this._boundCodes.clear();
	}
};

const AudioManager = class {
	constructor(options = {}) {
		this.maxVoices = options.maxVoices || 24;
		this.masterVolume = options.masterVolume !== undefined ? options.masterVolume : 0.7;
		this.ctx = null;
		this.master = null;
		this.listener = null;
		this._buffers = new Map();
		this._voices = 0;
		this.supported = typeof window !== 'undefined' &&
			!!(window.AudioContext || window.webkitAudioContext);
	}

	unlock() {
		if (!this.supported) return this;
		if (this.ctx === null) {
			const Ctor = window.AudioContext || window.webkitAudioContext;
			if (Ctor === undefined) return this;
			this.ctx = new Ctor();
			this.master = this.ctx.createGain();
			this.master.gain.value = this.masterVolume;
			this.master.connect(this.ctx.destination);
		}
		if (this.ctx.state === 'suspended') this.ctx.resume();
		return this;
	}

	setVolume(v) {
		this.masterVolume = v;
		if (this.master !== null) this.master.gain.value = v;
		return this;
	}

	setListener(object3d) {
		this.listener = object3d;
		return this;
	}

	_updateListener() {
		if (this.ctx === null || this.listener === null) return;
		const l = this.ctx.listener;
		const src = this.listener;
		if (typeof src.getWorldPosition === 'function') src.getWorldPosition(_audioPos);
		else _audioPos.copy(src.position);
		const fwd = typeof src.getWorldDirection === 'function' ? src.getWorldDirection(_audioFwd) : _audioFwd.set(0, 0, -1);
		if (l.positionX !== undefined) {
			l.positionX.value = _audioPos.x;
			l.positionY.value = _audioPos.y;
			l.positionZ.value = _audioPos.z;
			l.forwardX.value = fwd.x;
			l.forwardY.value = fwd.y;
			l.forwardZ.value = fwd.z;
		} else if (typeof l.setPosition === 'function') {
			l.setPosition(_audioPos.x, _audioPos.y, _audioPos.z);
			if (typeof l.setOrientation === 'function') l.setOrientation(fwd.x, fwd.y, fwd.z, 0, 1, 0);
		}
	}

	playTone(options = {}) {
		if (this.ctx === null || this._voices >= this.maxVoices) return this;
		const ctx = this.ctx;
		const t0 = ctx.currentTime;
		const duration = Math.max(0.01, options.duration !== undefined ? options.duration : 0.2);

		const osc = ctx.createOscillator();
		osc.type = options.type || 'sine';
		osc.frequency.setValueAtTime(options.freq !== undefined ? options.freq : 440, t0);
		if (options.freqEnd !== undefined) {
			osc.frequency.exponentialRampToValueAtTime(Math.max(1, options.freqEnd), t0 + duration);
		}
		const gain = ctx.createGain();
		const volume = Math.max(1e-4, options.gain !== undefined ? options.gain : 0.3);
		gain.gain.setValueAtTime(volume, t0);
		gain.gain.exponentialRampToValueAtTime(1e-4, t0 + duration);
		osc.connect(gain);

		let panner = null;
		if (options.position !== undefined && ctx.createPanner !== undefined) {
			this._updateListener();
			panner = ctx.createPanner();
			panner.panningModel = 'HRTF';
			panner.distanceModel = 'inverse';
			panner.refDistance = 5;
			if (panner.positionX !== undefined) {
				panner.positionX.value = options.position.x;
				panner.positionY.value = options.position.y;
				panner.positionZ.value = options.position.z;
			} else {
				panner.setPosition(options.position.x, options.position.y, options.position.z);
			}
			gain.connect(panner);
			panner.connect(this.master);
		} else {
			gain.connect(this.master);
		}

		this._voices++;
		osc.onended = () => {
			this._voices--;
			osc.disconnect();
			gain.disconnect();
			if (panner !== null) panner.disconnect();
		};
		osc.start(t0);
		osc.stop(t0 + duration + 0.02);
		return this;
	}

	registerBuffer(name, buffer) {
		this._buffers.set(name, buffer);
		return this;
	}

	async loadBuffer(name, url) {
		if (this.ctx === null) this.unlock();
		if (this.ctx === null) {
			console.warn('AudioManager: WebAudio недоступен, loadBuffer("' + name + '") пропущен');
			return null;
		}
		try {
			const response = await fetch(url);
			const arrayBuffer = await response.arrayBuffer();
			const audioBuffer = await this.ctx.decodeAudioData(arrayBuffer);
			this.registerBuffer(name, audioBuffer);
			return audioBuffer;
		} catch (err) {
			console.warn('AudioManager: не удалось загрузить "' + url + '":', err);
			return null;
		}
	}

	/**
	 * Проигрывание зарегистрированного сэмпла: {loop, rate, gain, position?}.
	 *
	 * ИСПРАВЛЕНО (N5):
	 *  · лимит maxVoices не применялся (в отличие от playTone) — залп из
	 *    сотни одновременных событий создавал сотню цепочек
	 *    source→gain→panner→master и вешал аудиопоток;
	 *  · зацикленный источник никогда не завершается, поэтому onended не
	 *    срабатывает и узлы остаются в графе навсегда (утечка). Возвращаем
	 *    объект с `stop()`, который корректно разрывает цепочку.
	 *
	 * @returns {{stop:Function, source:AudioBufferSourceNode, gain:GainNode}|null}
	 */
	play(name, options = {}) {
		const buffer = this._buffers.get(name);
		if (this.ctx === null || buffer === undefined) return null;
		if (this._voices >= this.maxVoices) return null;
		const ctx = this.ctx;
		const source = ctx.createBufferSource();
		source.buffer = buffer;
		source.loop = options.loop === true;
		source.playbackRate.value = options.rate !== undefined ? options.rate : 1;
		const gain = ctx.createGain();
		gain.gain.value = options.gain !== undefined ? options.gain : 1;
		source.connect(gain);

		let panner = null;
		if (options.position !== undefined) {
			this._updateListener();
			panner = ctx.createPanner();
			panner.distanceModel = 'inverse';
			panner.refDistance = 8;
			if (panner.positionX !== undefined) {
				panner.positionX.value = options.position.x;
				panner.positionY.value = options.position.y;
				panner.positionZ.value = options.position.z;
			} else {
				panner.setPosition(options.position.x, options.position.y, options.position.z);
			}
			gain.connect(panner);
			panner.connect(this.master);
		} else {
			gain.connect(this.master);
		}

		let stopped = false;
		const teardown = () => {
			if (stopped) return;
			stopped = true;
			this._voices--;
			source.disconnect();
			gain.disconnect();
			if (panner !== null) panner.disconnect();
		};
		source.onended = teardown;
		this._voices++;
		source.start();
		const handle = {
			source,
			gain,
			panner,
			stop() {
				try { source.stop(); } catch { }
				teardown();
			}
		};
		return handle;
	}

	makeNoiseBuffer(options = {}) {
		if (this.ctx === null) this.unlock();
		if (this.ctx === null || !this.supported) return null;
		const seconds = options.seconds !== undefined ? options.seconds : 3;
		const color = options.color || 'white';
		const decay = options.decay !== undefined ? options.decay : 0;
		const rate = this.ctx.sampleRate;
		const length = Math.max(1, Math.floor(seconds * rate));
		const buffer = this.ctx.createBuffer(1, length, rate);
		const data = buffer.getChannelData(0);
		let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, last = 0;
		for (let i = 0; i < length; i++) {
			const white = Math.random() * 2 - 1;
			let s;
			if (color === 'pink') {
				b0 = 0.99886 * b0 + white * 0.0555179;
				b1 = 0.99332 * b1 + white * 0.0750759;
				b2 = 0.96900 * b2 + white * 0.1538520;
				b3 = 0.86650 * b3 + white * 0.3104856;
				b4 = 0.55000 * b4 + white * 0.5329522;
				b5 = -0.7616 * b5 - white * 0.0168980;
				s = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
				b6 = white * 0.115926;
			} else if (color === 'brown') {
				last = (last + 0.02 * white) / 1.02;
				s = last * 3.5;
			} else {
				s = white * 0.5;
			}
			if (decay > 0) s *= Math.exp(-decay * (i / length));
			data[i] = Math.max(-1, Math.min(1, s));
		}
		return buffer;
	}

	playAmbient(name, options = {}) {
		if (this.ctx === null) this.unlock();
		const buffer = this._buffers.get(name);
		if (this.ctx === null || buffer === undefined) return null;
		const ctx = this.ctx;
		const source = ctx.createBufferSource();
		source.buffer = buffer;
		source.loop = options.loop !== false;
		if (options.rate !== undefined) source.playbackRate.value = options.rate;
		const gain = ctx.createGain();
		gain.gain.value = options.gain !== undefined ? options.gain : 0;
		source.connect(gain);
		gain.connect(this.master);
		source.onended = () => { source.disconnect(); gain.disconnect(); };
		source.start();
		return {
			source,
			setGain(v, timeConstant = 0.4) {
				gain.gain.setTargetAtTime(Math.max(0, v), ctx.currentTime, timeConstant);
			},
			stop() {
				try { source.stop(); } catch { }
			}
		};
	}

	dispose() {
		if (this.ctx !== null) {
			try { this.ctx.close(); } catch { }
		}
		this.ctx = null;
		this.master = null;
		this.listener = null;
		this._buffers.clear();
		this._voices = 0;
	}
};

const _audioFwd = new Vector3();
const _audioPos = new Vector3();

const _cgSphereWorld = new Sphere();
const _cgSphereUnion = new Sphere();
const _cgLocalCenter = new Vector3();
const _cgWorldBox = new Box3();
const _cgWorldToLocal = new Matrix4();

const CullGroup = class extends Group {
	constructor() {
		super();
		this.isCullGroup = true;
		this.boundingSphere = null;
	}

	computeBoundingSphere() {
		this.updateWorldMatrix(true, true);
		const worldToLocal = _cgWorldToLocal.copy(this.matrixWorld).invert();
		let union = null;
		this.traverse(child => {
			if (child === this) return;
			const geometry = child.geometry;
			if (geometry === undefined) return;
			if (child.boundingSphere !== undefined && child.boundingSphere !== null && child.isInstancedMesh === true) {
				_cgSphereWorld.copy(child.boundingSphere).applyMatrix4(child.matrixWorld);
			} else {
				if (geometry.boundingSphere === null) geometry.computeBoundingSphere();
				if (geometry.boundingSphere === null) return;
				_cgSphereWorld.copy(geometry.boundingSphere).applyMatrix4(child.matrixWorld);
			}
			union = union === null ? _cgSphereUnion.copy(_cgSphereWorld) : union.union(_cgSphereWorld);
		});
		if (union === null) {
			this.boundingSphere = null;
			return this;
		}
		if (this.boundingSphere === null) this.boundingSphere = new Sphere();
		this.boundingSphere.copy(union);
		_cgLocalCenter.copy(union.center).applyMatrix4(worldToLocal);
		this.boundingSphere.center.copy(_cgLocalCenter);
		return this;
	}

	setBoundingSphereFromWorldBox(box) {
		this.updateWorldMatrix(true, false);
		_cgWorldBox.copy(box);
		if (this.boundingSphere === null) this.boundingSphere = new Sphere();
		_cgWorldBox.getBoundingSphere(this.boundingSphere);
		const worldToLocal = _cgWorldToLocal.copy(this.matrixWorld).invert();
		this.boundingSphere.center.applyMatrix4(worldToLocal);
		return this;
	}

	intersectsFrustum(frustum) {
		const sphere = this.boundingSphere;
		if (sphere === null) return true;
		_cgSphereUnion.copy(sphere).applyMatrix4(this.matrixWorld);
		return frustum.intersectsSphere(_cgSphereUnion);
	}

	copy(source, recursive) {
		super.copy(source, recursive);
		this.boundingSphere = source.boundingSphere !== null ? source.boundingSphere.clone() : null;
		return this;
	}
};

const defaultFogUniforms = _tfDefaultFogUniforms;

const TF_FS_VERT = `
varying vec2 vTfUv;
void main() {
	vTfUv = uv;
	gl_Position = vec4( position.xy, 0.0, 1.0 );
}`;

const TF_AO_FRAG = `
uniform sampler2D tDepth;
#ifdef TF_AO_NORMALS
uniform sampler2D tNormals;
#endif
uniform mat4 uProj;
uniform vec2 uProjScale;   // ( 1/proj[0][0], 1/proj[1][1] )
uniform float uNear;
uniform float uFar;
uniform float uRadius;     // мировой радиус семплинга
uniform float uBias;       // world-единицы: защита от self-occlusion
uniform float uRangeCheck; // дальние «окклюдеры» не учитываются
uniform float uIntensity;
uniform float uPower;
uniform float uFadeEnd;    // >0: гасить AO дальше этой view-дистанции (туман)
uniform vec2 uJitter;      // ИСПРАВЛЕНО (N9): NDC-джиттер TAA (0,0 без TAA)
varying vec2 vTfUv;

float tfAoPDToViewZ( float d ) {
	return ( uNear * uFar ) / ( ( uFar - uNear ) * d - uFar );
}

vec3 tfAoSampleDir( int i, float rot, vec3 n ) {
	float fi = float( i );
	// phyllotaxis: равномерное покрытие полусферы + золотое сечение на ротацию
	float r1 = ( fi + 0.5 ) / float( TF_AO_SAMPLES );
	float r2 = fract( ( fi + 1.0 ) * 0.6180339887 + rot );
	float phi = 6.2831853 * r2;
	float cosT = 1.0 - r1 * 0.85;                 // cos в [0.15..1] — без grazing
	float sinT = sqrt( max( 0.0, 1.0 - cosT * cosT ) );
	vec3 h = vec3( cos( phi ) * sinT, sin( phi ) * sinT, cosT );
	vec3 up = abs( n.z ) < 0.9 ? vec3( 0.0, 0.0, 1.0 ) : vec3( 1.0, 0.0, 0.0 );
	vec3 t = normalize( cross( up, n ) );
	vec3 b = cross( n, t );
	return normalize( t * h.x + b * h.y + n * h.z );
}

void main() {
	vec3 P;
	vec3 N;
#ifdef TF_AO_NORMALS
	vec4 nrmD = texture2D( tNormals, vTfUv );
	if ( nrmD.a <= 0.0 ) { gl_FragColor = vec4( 1.0 ); return; }  // небо (a=0)
	// джиттер вычитается: глубина/нормали писались джиттернутой проекцией,
	// а реконструируем мы в НЕджиттернутом view-пространстве
	vec2 ndc0 = vTfUv * 2.0 - 1.0 - uJitter;
	P = vec3( ndc0.x * nrmD.a * uProjScale.x, ndc0.y * nrmD.a * uProjScale.y, -nrmD.a );
	N = normalize( nrmD.xyz );
#else
	float d = texture2D( tDepth, vTfUv ).r;
	if ( d >= 1.0 ) { gl_FragColor = vec4( 1.0 ); return; }       // небо
	float vz = tfAoPDToViewZ( d );
	vec2 ndc0 = vTfUv * 2.0 - 1.0 - uJitter;
	P = vec3( ndc0.x * -vz * uProjScale.x, ndc0.y * -vz * uProjScale.y, vz );
	// нормаль из производных view-позиции (depth-only режим)
	N = normalize( cross( dFdx( P ), dFdy( P ) ) );
	if ( dot( N, P ) > 0.0 ) N = -N;   // развернуть к камере (P перед камерой: z<0)
#endif
	float rot = fract( 52.9829189 * fract( dot( gl_FragCoord.xy, vec2( 0.06711056, 0.00583715 ) ) ) );
	float ao = 0.0;
	for ( int i = 0; i < TF_AO_SAMPLES; i++ ) {
		vec3 S = P + tfAoSampleDir( i, rot, N ) * uRadius;
		vec4 clip = uProj * vec4( S, 1.0 );
		if ( clip.w <= 0.0 ) continue;                    // за камерой
		vec2 suv = clip.xy / clip.w * 0.5 + 0.5;
		if ( suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0 ) continue;
		float sViewZ;
#ifdef TF_AO_NORMALS
		vec4 sn = texture2D( tNormals, suv );
		if ( sn.a <= 0.0 ) continue;
		sViewZ = -sn.a;
#else
		float sd = texture2D( tDepth, suv ).r;
		if ( sd >= 1.0 ) continue;
		sViewZ = tfAoPDToViewZ( sd );
#endif
		// семпл закрыт, если считанная геометрия БЛИЖЕ к камере (viewZ больше)
		float dv = sViewZ - S.z;
		if ( dv > uBias ) {
			// S1 (v2.9): контактная локализация. Вклад сэмпла гаснет квадратично
			// по дистанции до окклюдера (view-глубина): остаётся только окклюзия
			// «в стыке», метровые ореолы-«объятия» вокруг силуэтов исчезают.
			// Прежний бинарный range-check оставляем внешним отсечением.
			float od = abs( P.z - sViewZ );
			float contact = 1.0 - smoothstep( uRadius * 0.25, uRadius, od );
			ao += contact * contact * smoothstep( 0.0, 1.0, uRangeCheck / max( 1e-4, od ) );
		}
	}
	float occ = clamp( ( ao / float( TF_AO_SAMPLES ) ) * uIntensity, 0.0, 1.0 );
	float a = pow( 1.0 - occ, uPower );
	if ( uFadeEnd > 0.0 ) {
		float fade = 1.0 - smoothstep( uFadeEnd * 0.55, uFadeEnd, -P.z );
		a = mix( 1.0, a, fade );
	}
	gl_FragColor = vec4( a, a, a, 1.0 );
}`;

const TF_AO_BLUR_FRAG = `
uniform sampler2D tAO;
#ifdef TF_AO_NORMALS
uniform sampler2D tNormals;
#else
uniform sampler2D tDepth;
uniform float uNear;
uniform float uFar;
#endif
uniform vec2 uTexel;
uniform float uSharpness;
varying vec2 vTfUv;

#ifndef TF_AO_NORMALS
float tfBlPDToViewZ( float d ) {
	return ( uNear * uFar ) / ( ( uFar - uNear ) * d - uFar );
}
#endif

// viewZ пикселя (0 = небо)
float tfBlViewZ( vec2 uv ) {
#ifdef TF_AO_NORMALS
	float a = texture2D( tNormals, uv ).a;
	return a <= 0.0 ? 0.0 : -a;
#else
	float d = texture2D( tDepth, uv ).r;
	return d >= 1.0 ? 0.0 : tfBlPDToViewZ( d );
#endif
}

void main() {
	float v0 = tfBlViewZ( vTfUv );
	if ( v0 == 0.0 ) { gl_FragColor = vec4( 1.0 ); return; }  // небо — без AO
	float sum = 0.0;
	float wsum = 0.0;
	for ( int y = -2; y <= 1; y++ ) {
		for ( int x = -2; x <= 1; x++ ) {
			vec2 uv = vTfUv + ( vec2( float( x ), float( y ) ) + 0.5 ) * uTexel;
			float vz = tfBlViewZ( uv );
			if ( vz == 0.0 ) continue;
			float w = max( 0.0, 1.0 - abs( vz - v0 ) * uSharpness );
			sum += texture2D( tAO, uv ).r * w;
			wsum += w;
		}
	}
	float a = wsum > 0.0 ? sum / wsum : 1.0;
	gl_FragColor = vec4( a, a, a, 1.0 );
}`;

const TF_COMPOSITE_FRAG = `
uniform sampler2D tScene;
#ifdef TF_COMP_AO
uniform sampler2D tAO;
uniform float uAOStrength;
// S3 (v2.9): доля ambient в освещении кадра; AO гасит только её (прямой свет
// светила остаётся нетронутым — тени даёт теневая карта, а не AO).
uniform float uAOAmbient;
#endif
uniform sampler2D tBloom;        // 3.1d: HDR-ореол (¼ рез), добавляется до тонмаппинга
uniform float uBloomIntensity;
uniform float uDither;   // 1 = последний проход в canvas: гасим banding 8-бит
varying vec2 vTfUv;
#include <tonemapping_pars_fragment>
float tfCompIgn( vec2 p ) {
	return fract( 52.9829189 * fract( dot( p, vec2( 0.06711056, 0.00583715 ) ) ) );
}
vec3 tfTonemap( vec3 color ) {
#if TF_TONE_MODE == 1
	return LinearToneMapping( color );
#elif TF_TONE_MODE == 2
	return ReinhardToneMapping( color );
#elif TF_TONE_MODE == 3
	return CineonToneMapping( color );
#elif TF_TONE_MODE == 4
	return ACESFilmicToneMapping( color );
#elif TF_TONE_MODE == 6
	return AgXToneMapping( color );
#elif TF_TONE_MODE == 7
	return NeutralToneMapping( color );
#else
	return color;
#endif
}
void main() {
	vec3 c = texture2D( tScene, vTfUv ).rgb;
#ifdef TF_COMP_AO
	float ao = texture2D( tAO, vTfUv ).r;
	c *= mix( 1.0, ao, uAOStrength * uAOAmbient );
#endif
	c += texture2D( tBloom, vTfUv ).rgb * uBloomIntensity;
	gl_FragColor = vec4( tfTonemap( c ), 1.0 );
	#include <colorspace_fragment>
	// dither ПОСЛЕ кодирования: ±0.5 кванта 8-бит убирает banding градиентов
	// неба/тумана (амплитуда ниже порога восприятия)
	gl_FragColor.rgb += ( tfCompIgn( gl_FragCoord.xy ) - 0.5 ) * ( uDither * ( 1.0 / 255.0 ) );
}`;

const TF_DEBUG_FRAG = `
uniform sampler2D tAO;
uniform sampler2D tDepth;
uniform sampler2D tNormals;
uniform sampler2D tVelocity;
uniform float uNear;
uniform float uFar;
uniform float uMode;
uniform float uHasNormals;
varying vec2 vTfUv;
void main() {
	if ( uMode < 1.5 ) {
		float a = texture2D( tAO, vTfUv ).r;
		gl_FragColor = vec4( a, a, a, 1.0 );
		return;
	}
	if ( uMode < 2.5 ) {
		float d = texture2D( tDepth, vTfUv ).r;
		float vz = ( uNear * uFar ) / ( ( uFar - uNear ) * d - uFar );
		float lin = clamp( -vz / uFar, 0.0, 1.0 );
		gl_FragColor = vec4( lin, lin, lin, 1.0 );
		return;
	}
	if ( uMode < 3.5 ) {
		vec3 n;
		if ( uHasNormals > 0.5 ) {
			vec4 nd = texture2D( tNormals, vTfUv );
			n = nd.a <= 0.0 ? vec3( 0.0 ) : normalize( nd.xyz );
		} else {
			float d = texture2D( tDepth, vTfUv ).r;
			if ( d >= 1.0 ) { gl_FragColor = vec4( 0.0, 0.0, 0.0, 1.0 ); return; }
			float vz = ( uNear * uFar ) / ( ( uFar - uNear ) * d - uFar );
			// приближение для дебага: проекция считается единичной (форма нормалей
			// важнее абсолютной точности)
			vec3 P = vec3( ( vTfUv * 2.0 - 1.0 ) * -vz, vz );
			n = normalize( cross( dFdx( P ), dFdy( P ) ) );
			if ( dot( n, P ) > 0.0 ) n = -n;
		}
		gl_FragColor = vec4( n * 0.5 + 0.5, 1.0 );
		return;
	}
	// motion vectors: RG = Δuv ×12 + 0.5, B = valid
	vec4 v = texture2D( tVelocity, vTfUv );
	gl_FragColor = vec4( v.xy * 12.0 + 0.5, v.z, 1.0 );
}`;

const TF_FXAA_FRAG = `
uniform sampler2D tColor;
uniform vec2 uTexel;
varying vec2 vTfUv;
float tfLuma( vec3 c ) { return dot( c, vec3( 0.299, 0.587, 0.114 ) ); }
void main() {
	vec2 uv = vTfUv;
	vec3 rgbM = texture2D( tColor, uv ).rgb;
	float lNW = tfLuma( texture2D( tColor, uv + vec2( -1.0, -1.0 ) * uTexel ).rgb );
	float lNE = tfLuma( texture2D( tColor, uv + vec2( 1.0, -1.0 ) * uTexel ).rgb );
	float lSW = tfLuma( texture2D( tColor, uv + vec2( -1.0, 1.0 ) * uTexel ).rgb );
	float lSE = tfLuma( texture2D( tColor, uv + vec2( 1.0, 1.0 ) * uTexel ).rgb );
	float lM = tfLuma( rgbM );
	float lMin = min( lM, min( min( lNW, lNE ), min( lSW, lSE ) ) );
	float lMax = max( lM, max( max( lNW, lNE ), max( lSW, lSE ) ) );
	if ( lMax - lMin < max( 0.0312, lMax * 0.125 ) ) {
		gl_FragColor = vec4( rgbM, 1.0 );  // плоская область — без работы
		return;
	}
	vec2 dir = vec2( -( ( lNW + lNE ) - ( lSW + lSE ) ), ( ( lNW + lSW ) - ( lNE + lSE ) ) );
	float dirReduce = max( ( lNW + lNE + lSW + lSE ) * 0.25 * ( 1.0 / 8.0 ), 1.0 / 128.0 );
	float rcpDirMin = 1.0 / max( 1e-4, min( abs( dir.x ), abs( dir.y ) ) );
	dir = min( vec2( 8.0 ), max( vec2( -8.0 ), dir * rcpDirMin ) ) * uTexel;
	vec3 rgbA = 0.5 * (
		texture2D( tColor, uv + dir * ( 1.0 / 3.0 - 0.5 ) ).rgb +
		texture2D( tColor, uv + dir * ( 2.0 / 3.0 - 0.5 ) ).rgb );
	vec3 rgbB = rgbA * 0.5 + 0.25 * (
		texture2D( tColor, uv + dir * -0.5 ).rgb +
		texture2D( tColor, uv + dir * 0.5 ).rgb );
	float lB = tfLuma( rgbB );
	gl_FragColor = vec4( ( lB < lMin || lB > lMax ) ? rgbA : rgbB, 1.0 );
	#include <colorspace_fragment>
	gl_FragColor.rgb += ( fract( 52.9829189 * fract( dot( gl_FragCoord.xy, vec2( 0.06711056, 0.00583715 ) ) ) ) - 0.5 ) * ( 1.0 / 255.0 );
}`;

const TF_VELOCITY_VERT = `
uniform mat4 uProjJittered;        // ТОЧНАЯ копия projectionMatrix beauty-прохода (джиттернутая)
uniform mat4 uPrevModelViewProj;   // НЕджиттернутый prev view-proj × prev matrixWorld (per-object)
varying vec2 vVel;
varying float vValid;
void main() {
	vec4 local = vec4( position, 1.0 );
#ifdef USE_INSTANCING
	local = instanceMatrix * local;   // prev instanceMatrix не отслеживается:
	                                  // инстансы считаются статичными относительно меша
	                                  // (ошибка = camera-only репроекция, clamp гасит)
#endif
	// curClip вычисляется В ТОМ ЖЕ порядке операций, что и beauty-проход three
	// (projectionMatrix * (modelViewMatrix * local)) — глубина фрагмента
	// бит-в-бит совпадает со сценой, поэтому depthFunc EQUAL отбирает только
	// реально видимые пиксели объекта (alpha-test «дыры» velocity не пишут).
	vec4 curClip = uProjJittered * ( modelViewMatrix * local );
	vec4 prevClip = uPrevModelViewProj * local;
	gl_Position = curClip;
	bool ok = curClip.w > 1e-4 && prevClip.w > 1e-4;
	vVel = ok ? ( curClip.xy / curClip.w - prevClip.xy / prevClip.w ) * 0.5 : vec2( 0.0 );
	vValid = ok ? 1.0 : 0.0;
}`;

const TF_VELOCITY_FRAG = `
varying vec2 vVel;
varying float vValid;
void main() {
	gl_FragColor = vec4( vVel, vValid, 1.0 );
}`;

const TF_TAA_RESOLVE_FRAG = `
uniform sampler2D tCurrent;    // текущий LDR-кадр (после композита)
uniform sampler2D tHistory;    // разрешённый предыдущий кадр
uniform sampler2D tDepth;      // глубина сцены (джиттернутая)
uniform sampler2D tVelocity;   // motion vectors (z = valid)
uniform mat4 uCurInvProj;      // инверсия ДЖИТТЕРНУТОЙ проекции (согласована с глубиной)
uniform mat4 uPrevViewProj;    // НЕджиттернутый view-proj предыдущего кадра
uniform mat4 uCamWorld;        // matrixWorld камеры текущего кадра
uniform vec2 uTexel;
uniform float uMix;            // доля текущего кадра (≈ 1/N накопления)
uniform float uHasVelocity;    // 1 = velocity-буфер доступен
uniform float uHistoryValid;   // 0 = первый кадр/сброс → вывод = current
varying vec2 vTfUv;
void main() {
	vec3 cur = texture2D( tCurrent, vTfUv ).rgb;
	if ( uHistoryValid < 0.5 ) { gl_FragColor = vec4( cur, 1.0 ); return; }
	// 3×3 окрестность → AABB (анти-гостинг кламп истории)
	vec3 nMin = cur;
	vec3 nMax = cur;
	for ( int y = -1; y <= 1; y++ ) {
		for ( int x = -1; x <= 1; x++ ) {
			if ( x == 0 && y == 0 ) continue;
			vec3 c = texture2D( tCurrent, vTfUv + vec2( float( x ), float( y ) ) * uTexel ).rgb;
			nMin = min( nMin, c );
			nMax = max( nMax, c );
		}
	}
	// --- репроекция ---
	vec2 prevUv = vTfUv;
	float usedVel = 0.0;
	if ( uHasVelocity > 0.5 ) {
		vec4 v = texture2D( tVelocity, vTfUv );
		if ( v.z > 0.5 ) { prevUv = vTfUv - v.xy; usedVel = 1.0; }
	}
	bool inB = true;
	if ( usedVel < 0.5 ) {
		// camera-only: мир из глубины (джиттернутая инверсия) → prev view-proj
		float d = texture2D( tDepth, vTfUv ).r;
		vec4 vView = uCurInvProj * vec4( vTfUv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0 );
		if ( abs( vView.w ) < 1e-6 ) {
			inB = false;
		} else {
			vec3 viewPos = vView.xyz / vView.w;
			vec3 worldPos;
			if ( d >= 1.0 ) {
				// небо: направление на «бесконечности» (трансляция камеры не влияет)
				vec3 dirV = normalize( viewPos );
				worldPos = uCamWorld[3].xyz + mat3( uCamWorld ) * dirV * 100000.0;
			} else {
				worldPos = ( uCamWorld * vec4( viewPos, 1.0 ) ).xyz;
			}
			vec4 prevClip = uPrevViewProj * vec4( worldPos, 1.0 );
			if ( prevClip.w > 0.0 ) {
				prevUv = ( prevClip.xy / prevClip.w ) * 0.5 + 0.5;
			} else {
				inB = false;
			}
		}
	}
	if ( prevUv.x < 0.0 || prevUv.x > 1.0 || prevUv.y < 0.0 || prevUv.y > 1.0 ) inB = false;
	vec3 outc;
	if ( inB ) {
		vec3 hist = texture2D( tHistory, prevUv ).rgb;
		hist = clamp( hist, nMin, nMax );
		outc = mix( hist, cur, uMix );
	} else {
		outc = cur;
	}
	gl_FragColor = vec4( outc, 1.0 );
}`;

const TF_TAA_BLIT_FRAG = `
uniform sampler2D tColor;
uniform vec2 uTexel;
uniform float uSharpen;
varying vec2 vTfUv;
void main() {
	vec3 c = texture2D( tColor, vTfUv ).rgb;
	if ( uSharpen > 0.0 ) {
		vec3 n = (
			texture2D( tColor, vTfUv + vec2( uTexel.x, 0.0 ) ).rgb +
			texture2D( tColor, vTfUv - vec2( uTexel.x, 0.0 ) ).rgb +
			texture2D( tColor, vTfUv + vec2( 0.0, uTexel.y ) ).rgb +
			texture2D( tColor, vTfUv - vec2( 0.0, uTexel.y ) ).rgb ) * 0.25;
		c += ( c - n ) * uSharpen;
	}
	gl_FragColor = vec4( c, 1.0 );
	#include <colorspace_fragment>
	gl_FragColor.rgb += ( fract( 52.9829189 * fract( dot( gl_FragCoord.xy, vec2( 0.06711056, 0.00583715 ) ) ) ) - 0.5 ) * ( 1.0 / 255.0 );
}`;

const TF_RAYS_BRIGHT_FRAG = `
uniform sampler2D tScene;
uniform sampler2D tDepth;
uniform float uThreshold;
varying vec2 vTfUv;
void main() {
	float d = texture2D( tDepth, vTfUv ).r;
	vec3 c = texture2D( tScene, vTfUv ).rgb;
	float sky = step( 0.9995, d );              // только небо = источник лучей
	float l = dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );
	float b = max( l - uThreshold, 0.0 );
	gl_FragColor = vec4( c * ( sky * b ), 1.0 );
}`;

const TF_RAYS_BLUR_FRAG = `
uniform sampler2D tRays;
uniform vec2 uSunUv;
uniform float uDensity;
uniform float uDecay;
uniform float uWeight;
varying vec2 vTfUv;
void main() {
	vec2 coord = vTfUv;
	vec2 delta = ( coord - uSunUv ) * uDensity / float( TF_RAYS_SAMPLES );
	float illum = 1.0;
	vec3 acc = vec3( 0.0 );
	for ( int i = 0; i < TF_RAYS_SAMPLES; i ++ ) {
		coord -= delta;
		if ( coord.x < 0.0 || coord.x > 1.0 || coord.y < 0.0 || coord.y > 1.0 ) break;
		acc += texture2D( tRays, coord ).rgb * illum;
		illum *= uDecay;
	}
	gl_FragColor = vec4( acc * uWeight / float( TF_RAYS_SAMPLES ), 1.0 );
}`;

const TF_BLOOM_BRIGHT_FRAG = `
uniform sampler2D tScene;
uniform float uThreshold;
uniform float uKnee;
varying vec2 vTfUv;
void main() {
	vec3 c = texture2D( tScene, vTfUv ).rgb;
	float l = max( c.r, max( c.g, c.b ) );
	// мягкое колено: квадратичный ramp в [t-k, t+k], выше порога — линейный вклад
	float k = max( 1e-4, uThreshold * uKnee );
	float soft = clamp( l - uThreshold + k, 0.0, 2.0 * k );
	soft = soft * soft / ( 4.0 * k );
	float contrib = max( soft, l - uThreshold ) / max( l, 1e-4 );
	gl_FragColor = vec4( c * contrib, 1.0 );
}`;

const TF_BLOOM_BLUR_FRAG = `
uniform sampler2D tBloomIn;
uniform vec2 uStep;   // texel * направление * разлёт
varying vec2 vTfUv;
void main() {
	vec3 c = texture2D( tBloomIn, vTfUv ).rgb * 0.2270270270;
	vec2 o1 = uStep * 1.3846153846;
	vec2 o2 = uStep * 3.2307692308;
	c += ( texture2D( tBloomIn, vTfUv + o1 ).rgb + texture2D( tBloomIn, vTfUv - o1 ).rgb ) * 0.3162162162;
	c += ( texture2D( tBloomIn, vTfUv + o2 ).rgb + texture2D( tBloomIn, vTfUv - o2 ).rgb ) * 0.0702702703;
	gl_FragColor = vec4( c, 1.0 );
}`;

const TF_FINAL_FRAG = `
uniform sampler2D tColor;
uniform sampler2D tRays;
uniform vec3 uRaysTint;
uniform float uRaysStrength;
uniform float uSharpen;
uniform vec2 uTexel;
uniform float uVignette;
uniform float uSaturation;
uniform vec3 uTint;
varying vec2 vTfUv;
void main() {
	vec3 c = texture2D( tColor, vTfUv ).rgb;
	if ( uSharpen > 0.0 ) {
		vec3 n = (
			texture2D( tColor, vTfUv + vec2( uTexel.x, 0.0 ) ).rgb +
			texture2D( tColor, vTfUv - vec2( uTexel.x, 0.0 ) ).rgb +
			texture2D( tColor, vTfUv + vec2( 0.0, uTexel.y ) ).rgb +
			texture2D( tColor, vTfUv - vec2( 0.0, uTexel.y ) ).rgb ) * 0.25;
		c += ( c - n ) * uSharpen;
	}
	c += texture2D( tRays, vTfUv ).rgb * uRaysTint * uRaysStrength;
	if ( uVignette > 0.0 ) {
		vec2 tfVg = vTfUv - 0.5;
		c *= 1.0 - uVignette * clamp( dot( tfVg, tfVg ) * 2.2, 0.0, 1.0 );
	}
	c = mix( vec3( dot( c, vec3( 0.2126, 0.7152, 0.0722 ) ) ), c, uSaturation );
	c *= uTint;
	gl_FragColor = vec4( c, 1.0 );
	#include <colorspace_fragment>
	gl_FragColor.rgb += ( fract( 52.9829189 * fract( dot( gl_FragCoord.xy, vec2( 0.06711056, 0.00583715 ) ) ) ) - 0.5 ) * ( 1.0 / 255.0 );
}`;

const TF_VELOCITY_LAYER = 1;

function tfHalton(index, base) {
	let f = 1;
	let r = 0;
	let i = index;
	while (i > 0) {
		f /= base;
		r += f * (i % base);
		i = Math.floor(i / base);
	}
	return r;
}

const TF_NORMAL_VERT = `
varying vec3 vTfNrmView;
varying float vTfViewZ;
void main() {
	vec4 local = vec4( position, 1.0 );
	vec3 objectNormal = normal;
#ifdef USE_INSTANCING
	local = instanceMatrix * local;
	// ИСПРАВЛЕНО (N8): деление на квадрат длины столбцов instanceMatrix —
	// тот же приём, что в three <defaultnormal_vertex>. Без него normalMatrix
	// (инверс-транспозиция modelViewMatrix, БЕЗ инстанса) применялся к
	// уже масштабированной нормали: на неравномерно масштабированных
	// инстансах (InstancedBatcher: деревья/камни/трава) нормали «уезжали»,
	// и SSAO в режиме quality='high' давал пятна.
	mat3 im = mat3( instanceMatrix );
	objectNormal /= vec3( dot( im[ 0 ], im[ 0 ] ), dot( im[ 1 ], im[ 1 ] ), dot( im[ 2 ], im[ 2 ] ) );
	objectNormal = im * objectNormal;
#endif
	vec4 mvPosition = modelViewMatrix * local;
	gl_Position = projectionMatrix * mvPosition;
	vTfNrmView = normalize( normalMatrix * objectNormal );
	vTfViewZ = -mvPosition.z;
}`;

const TF_NORMAL_FRAG = `
varying vec3 vTfNrmView;
varying float vTfViewZ;
void main() {
	vec3 n = normalize( vTfNrmView );
	if ( ! gl_FrontFacing ) n = -n;
	gl_FragColor = vec4( n, vTfViewZ );
}`;

const _ppSize = new THREE.Vector2();
const _ppClearColor = new THREE.Color();

const PostPipeline = class extends THREE.EventDispatcher {
	constructor(options = {}) {
		super();
		if (options.renderer === undefined || options.renderer === null) {
			throw new Error('ThreeForge: PostPipeline — нужен options.renderer (WebGLRenderer)');
		}
		this.renderer = options.renderer;
		this.scene = options.scene !== undefined && options.scene !== null ? options.scene : null;
		this.camera = options.camera !== undefined && options.camera !== null ? options.camera : null;
		this.fog = options.fog !== undefined ? options.fog : null;
		this.enabled = options.enabled !== false;
		this.profile = options.profile === true;

		this.quality = options.quality === 'high' ? 'high' : 'fast';
		let hasFloat = false;
		try {
			hasFloat = !!(this.renderer.extensions !== undefined &&
				(this.renderer.extensions.get('EXT_color_buffer_float') !== null ||
					this.renderer.extensions.get('EXT_color_buffer_half_float') !== null));
		} catch { hasFloat = false; }
		this.hdr = options.hdr !== undefined ? options.hdr === true : hasFloat;
		if (this.hdr && !hasFloat) {
			console.warn('ThreeForge: PostPipeline — EXT_color_buffer_float недоступен, HDR выключен (fallback LDR).');
			this.hdr = false;
		}

		this.samples = options.samples !== undefined ? options.samples : 0;
		this.fxaa = options.fxaa !== undefined ? options.fxaa : 'auto';
		this.taaOptions = Object.assign({
			enabled: false,
			samples: 16,
			mix: 0.1,
			sharpen: 0.35,
			velocityPass: true
		}, options.taa || {});
		if (this.taaOptions.velocityPass && !hasFloat) {
			console.warn('ThreeForge: PostPipeline — velocity-буфер требует float-RT; TAA будет camera-only.');
			this.taaOptions.velocityPass = false;
		}

		this.raysOptions = Object.assign({
			enabled: false,
			resolutionScale: 0.5,
			samples: 48,
			threshold: 0.5,
			density: 0.9,
			decay: 0.94,
			weight: 1.6,
			strength: 0.85,
			tint: new THREE.Color(1.0, 0.62, 0.28)
		}, options.godRays || {});
		this.sunDirection = options.sunDirection !== undefined ? options.sunDirection : null;

		// GK9: кино-грейд финального пасса (по умолчанию нейтрален = поведение v2.7).
		this.gradeOptions = Object.assign({
			vignette: 0,
			saturation: 1,
			tint: new Color(1, 1, 1)
		}, options.grade || {});
		// tint мог прийти числом/строкой через options.grade — нормализуем в Color (F1)
		if (this.gradeOptions.tint === null || this.gradeOptions.tint === undefined ||
			this.gradeOptions.tint.isColor !== true) {
			this.gradeOptions.tint = new Color(this.gradeOptions.tint);
		}
		// GK7: хук вьюмодели — вызывается ПОСЛЕ рендера сцены в текущий RT.
		this.scenePassHook = options.scenePassHook !== undefined ? options.scenePassHook : null;

	this.bloomOptions = Object.assign({
		enabled: false,
		threshold: 1.0,
		knee: 0.5,
		intensity: 0.35,
		resolutionScale: 0.25,
		iterations: 2
	}, options.bloom || {});

		this.aoOptions = Object.assign({
			enabled: true,
			samples: 16,
			resolutionScale: 0.5,
			// S2 (v2.9): контактные дефолты — AO это подсветка стыков, а не замена
			// теней: радиус порядка десятков см, умеренная интенсивность.
			radius: 0.5,
			bias: 0.03,
			rangeCheck: 1.0,
			intensity: 1.15,
			power: 1.6,
			fadeEnd: 0,
			strength: 1.0,
			blurSharpness: 4.0,
			// S3 (v2.9): доля ambient-составляющей, к которой применимо AO.
			// При lights = {hemi, sun, moon} считается каждый кадр из живых
			// интенсивностей; иначе — эта константа.
			ambientShare: 0.6,
			lights: null
		}, options.ao || {});

		this.debug = options.debug || 'none';

		this.prepassExclude = options.prepassExclude !== undefined ? options.prepassExclude.slice() : [];

		this.stats = { ms: 0, msScene: 0, msAO: 0, msBlur: 0, msComposite: 0, msNormals: 0, msVelocity: 0, msTaa: 0, msRays: 0, msBloom: 0, passes: 0 };

		this._w = 0;
		this._h = 0;
		this._aoW = 0;
		this._aoH = 0;
		this.rtBloomA = null;
		this.rtBloomB = null;
		this._engine = null;
		this._prevOverride = null;
		this._prevAutoReset = true;
		this._prevFogCS = 'srgb';
		this._transparentHidden = [];

		this._fsScene = new THREE.Scene();
		this._fsCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
		this._quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), null);
		this._quad.frustumCulled = false;
		this._fsScene.add(this._quad);

		const aoDefs = { TF_AO_SAMPLES: String(this.aoOptions.samples | 0) };
		if (this.quality === 'high') aoDefs.TF_AO_NORMALS = '';
		this.bloomBrightMat = new THREE.ShaderMaterial({
		uniforms: {
			tScene: { value: null },
			uThreshold: { value: this.bloomOptions.threshold },
			uKnee: { value: this.bloomOptions.knee }
		},
		vertexShader: TF_FS_VERT,
		fragmentShader: TF_BLOOM_BRIGHT_FRAG,
		depthTest: false,
		depthWrite: false,
		toneMapped: false
	});
	this.bloomBlurMat = new THREE.ShaderMaterial({
		uniforms: {
			tBloomIn: { value: null },
			uStep: { value: new THREE.Vector2(0, 0) }
		},
		vertexShader: TF_FS_VERT,
		fragmentShader: TF_BLOOM_BLUR_FRAG,
		depthTest: false,
		depthWrite: false,
		toneMapped: false
	});
	this.aoMat = new THREE.ShaderMaterial({
			defines: Object.assign({}, aoDefs),
			uniforms: {
				tDepth: { value: null },
				tNormals: { value: null },
				uProj: { value: this.camera !== null ? this.camera.projectionMatrix : new THREE.Matrix4() },
				uProjScale: { value: new THREE.Vector2(1, 1) },
				uNear: { value: 0.1 },
				uFar: { value: 1000 },
				uRadius: { value: this.aoOptions.radius },
				uBias: { value: this.aoOptions.bias },
				uRangeCheck: { value: this.aoOptions.rangeCheck || this.aoOptions.radius * 2.5 },
				uIntensity: { value: this.aoOptions.intensity },
				uPower: { value: this.aoOptions.power },
				uFadeEnd: { value: this.aoOptions.fadeEnd },
				uJitter: { value: new THREE.Vector2(0, 0) }
			},
			vertexShader: TF_FS_VERT,
			fragmentShader: TF_AO_FRAG,
			depthTest: false,
			depthWrite: false
		});
		this.blurMat = new THREE.ShaderMaterial({
			defines: this.quality === 'high' ? { TF_AO_NORMALS: '' } : {},
			uniforms: {
				tAO: { value: null },
				tDepth: { value: null },
				tNormals: { value: null },
				uNear: { value: 0.1 },
				uFar: { value: 1000 },
				uTexel: { value: new THREE.Vector2() },
				uSharpness: { value: this.aoOptions.blurSharpness }
			},
			vertexShader: TF_FS_VERT,
			fragmentShader: TF_AO_BLUR_FRAG,
			depthTest: false,
			depthWrite: false
		});
		this.compositeMat = new THREE.ShaderMaterial({
			defines: Object.assign({ TF_TONE_MODE: String(this.renderer.toneMapping | 0) },
				this.aoOptions.enabled === true ? { TF_COMP_AO: '' } : {}),
			uniforms: {
				tScene: { value: null },
				tAO: { value: null },
				uAOStrength: { value: this.aoOptions.strength },
				uAOAmbient: { value: this.aoOptions.ambientShare !== undefined ? this.aoOptions.ambientShare : 0.6 },
				tBloom: { value: null },
				uBloomIntensity: { value: 0 },
				uDither: { value: 1 }
			},
			vertexShader: TF_FS_VERT,
			fragmentShader: TF_COMPOSITE_FRAG,
			depthTest: false,
			depthWrite: false,
			toneMapped: false
		});
		if ((this.renderer.toneMapping | 0) === 5) {
			console.warn('ThreeForge: PostPipeline — CustomToneMapping не поддерживается композитом, используется passthrough');
		}
		this._toneMode = this.renderer.toneMapping | 0;
		this.debugMat = new THREE.ShaderMaterial({
			uniforms: {
				tAO: { value: null },
				tDepth: { value: null },
				tNormals: { value: null },
				tVelocity: { value: null },
				uNear: { value: 0.1 },
				uFar: { value: 1000 },
				uMode: { value: 1 },
				uHasNormals: { value: this.quality === 'high' ? 1 : 0 }
			},
			vertexShader: TF_FS_VERT,
			fragmentShader: TF_DEBUG_FRAG,
			depthTest: false,
			depthWrite: false,
			toneMapped: false
		});
		this.fxaaMat = new THREE.ShaderMaterial({
			uniforms: {
				tColor: { value: null },
				uTexel: { value: new THREE.Vector2() }
			},
			vertexShader: TF_FS_VERT,
			fragmentShader: TF_FXAA_FRAG,
			depthTest: false,
			depthWrite: false,
			toneMapped: false
		});
		this.normalMat = new THREE.ShaderMaterial({
			vertexShader: TF_NORMAL_VERT,
			fragmentShader: TF_NORMAL_FRAG,
			side: THREE.DoubleSide
		});

		this.velocityMat = new THREE.ShaderMaterial({
			uniforms: {
				uProjJittered: { value: new THREE.Matrix4() },
				uPrevModelViewProj: { value: new THREE.Matrix4() }
			},
			vertexShader: TF_VELOCITY_VERT,
			fragmentShader: TF_VELOCITY_FRAG,
			depthTest: true,
			depthFunc: THREE.EqualDepth,
			depthWrite: false,
			toneMapped: false
		});
		const self = this;
		this.velocityMat.onBeforeRender = function (renderer, scene, camera, geometry, object) {
			const entry = self._tracked.get(object);
			if (entry !== undefined) this.uniforms.uPrevModelViewProj.value.copy(entry.prevMVP);
			else this.uniforms.uPrevModelViewProj.value.copy(self._curViewProjClean);
		};
		this.taaResolveMat = new THREE.ShaderMaterial({
			uniforms: {
				tCurrent: { value: null },
				tHistory: { value: null },
				tDepth: { value: null },
				tVelocity: { value: null },
				uCurInvProj: { value: new THREE.Matrix4() },
				uPrevViewProj: { value: new THREE.Matrix4() },
				uCamWorld: { value: new THREE.Matrix4() },
				uTexel: { value: new THREE.Vector2() },
				uMix: { value: this.taaOptions.mix },
				uHasVelocity: { value: 0 },
				uHistoryValid: { value: 0 }
			},
			vertexShader: TF_FS_VERT,
			fragmentShader: TF_TAA_RESOLVE_FRAG,
			depthTest: false,
			depthWrite: false,
			toneMapped: false
		});
		this.taaBlitMat = new THREE.ShaderMaterial({
			uniforms: {
				tColor: { value: null },
				uTexel: { value: new THREE.Vector2() },
				uSharpen: { value: this.taaOptions.sharpen }
			},
			vertexShader: TF_FS_VERT,
			fragmentShader: TF_TAA_BLIT_FRAG,
			depthTest: false,
			depthWrite: false,
			toneMapped: false
		});
		this.raysBrightMat = new THREE.ShaderMaterial({
			uniforms: {
				tScene: { value: null },
				tDepth: { value: null },
				uThreshold: { value: this.raysOptions.threshold }
			},
			vertexShader: TF_FS_VERT,
			fragmentShader: TF_RAYS_BRIGHT_FRAG,
			depthTest: false,
			depthWrite: false,
			toneMapped: false
		});
		this.raysBlurMat = new THREE.ShaderMaterial({
			defines: { TF_RAYS_SAMPLES: String(this.raysOptions.samples | 0) },
			uniforms: {
				tRays: { value: null },
				uSunUv: { value: new THREE.Vector2(0.5, 0.5) },
				uDensity: { value: this.raysOptions.density },
				uDecay: { value: this.raysOptions.decay },
				uWeight: { value: this.raysOptions.weight }
			},
			vertexShader: TF_FS_VERT,
			fragmentShader: TF_RAYS_BLUR_FRAG,
			depthTest: false,
			depthWrite: false,
			toneMapped: false
		});
		this.finalMat = new THREE.ShaderMaterial({
			uniforms: {
				tColor: { value: null },
				tRays: { value: null },
				uRaysTint: { value: this.raysOptions.tint.clone() },
				uRaysStrength: { value: 0 },
				uSharpen: { value: this.taaOptions.sharpen },
				uTexel: { value: new THREE.Vector2() },
				uVignette: { value: this.gradeOptions.vignette },
				uSaturation: { value: this.gradeOptions.saturation },
				uTint: { value: this.gradeOptions.tint.clone() }
			},
			vertexShader: TF_FS_VERT,
			fragmentShader: TF_FINAL_FRAG,
			depthTest: false,
			depthWrite: false,
			toneMapped: false
		});
		this._raysFade = 0;
		this._sunUv = new THREE.Vector2(0.5, 0.5);
		this._sunProj = new THREE.Vector3();
		this._tracked = new Map();
		this._frameIdx = 0;
		this._histPing = 0;
		this._historyValid = false;
		this._jitterNdc = new THREE.Vector2();
		this._projClean = new THREE.Matrix4();
		this._projJittered = new THREE.Matrix4();
		this._invProjJittered = new THREE.Matrix4();
		this._curViewProjClean = new THREE.Matrix4();
		this._curViewProjJittered = new THREE.Matrix4();
		this._prevViewProjClean = null;
		if (this.camera !== null && this.camera.layers !== undefined) {
			this.camera.layers.enable(TF_VELOCITY_LAYER);
		}

		this.sceneRT = null;
		this.normalRT = null;
		this.aoRT = null;
		this.aoBlurRT = null;
		this.ldrRT = null;
		this.rtVelocity = null;
		this.rtTaaA = null;
		this.rtTaaB = null;
		this.rtRaysA = null;
		this.rtRaysB = null;
		this.rtPost = null;

		if (options.width !== undefined && options.height !== undefined) {
			this.setSize(options.width, options.height);
		}
	}

	/** GK9: кино-цветокоррекция финального пасса: {vignette 0..1, saturation, tint}. */
	setGrade(options = {}) {
		const g = this.gradeOptions;
		if (options.vignette !== undefined) g.vignette = options.vignette;
		if (options.saturation !== undefined) g.saturation = options.saturation;
		if (options.tint !== undefined) {
			g.tint.copy(options.tint !== null && options.tint.isColor === true ? options.tint : new Color(options.tint));
		}
		this._syncGrade();
		return this;
	}

	_syncGrade() {
		const g = this.gradeOptions;
		const u = this.finalMat.uniforms;
		u.uVignette.value = g.vignette;
		u.uSaturation.value = g.saturation;
		u.uTint.value.copy(g.tint);
	}

	attach(engine) {
		if (this._engine !== null) this.detach();
		if (engine === undefined || engine === null) {
			console.warn('ThreeForge: PostPipeline.attach — нужен Engine');
			return this;
		}
		this._engine = engine;
		this._prevOverride = engine.renderOverride;
		engine.postPipeline = this;
		this._boundRender = () => this.render();
		engine.renderOverride = this._boundRender;
		if (engine.renderer !== null && engine.renderer !== undefined) {
			this._prevAutoReset = engine.renderer.info.autoReset;
			engine.renderer.info.autoReset = false;
		}
		if (this.fog !== null) {
			this._prevFogCS = this.fog.shaderColorSpace;
			this.fog.setShaderColorSpace('linear');
		}
		return this;
	}

	detach() {
		const engine = this._engine;
		if (engine === null) return this;
		engine.renderOverride = this._prevOverride;
		if (engine.postPipeline === this) engine.postPipeline = null;
		if (engine.renderer !== null && engine.renderer !== undefined) {
			engine.renderer.info.autoReset = this._prevAutoReset;
		}
		if (this.fog !== null) this.fog.setShaderColorSpace(this._prevFogCS);
		this._engine = null;
		return this;
	}

	setSize(width, height) {
		width = Math.max(1, width | 0);
		height = Math.max(1, height | 0);
		this._w = width;
		this._h = height;
		const hdrType = this.hdr ? THREE.HalfFloatType : THREE.UnsignedByteType;

		if (this.sceneRT === null) {
			this.sceneRT = new THREE.WebGLRenderTarget(width, height, {
				type: hdrType,
				samples: this.samples,
				depthBuffer: true,
				stencilBuffer: false
			});
			if (this.hdr) this.sceneRT.texture.colorSpace = THREE.NoColorSpace;
			else this.sceneRT.texture.colorSpace = THREE.SRGBColorSpace;
			this.sceneRT.texture.generateMipmaps = false;
			this.sceneRT.depthTexture = new THREE.DepthTexture(width, height);
			this.sceneRT.depthTexture.type = THREE.UnsignedIntType;
		} else {
			this.sceneRT.setSize(width, height);
			this.sceneRT.depthTexture.image.width = width;
			this.sceneRT.depthTexture.image.height = height;
			this.sceneRT.depthTexture.needsUpdate = true;
		}

		const bScale = Math.min(1, Math.max(0.0625, this.bloomOptions.resolutionScale));
		const bw = Math.max(1, Math.round(width * bScale));
		const bh = Math.max(1, Math.round(height * bScale));
		const bOpts = { type: hdrType, depthBuffer: false, stencilBuffer: false };
		if (this.rtBloomA === null) {
			this.rtBloomA = new THREE.WebGLRenderTarget(bw, bh, bOpts);
			this.rtBloomB = new THREE.WebGLRenderTarget(bw, bh, bOpts);
		} else if (this.rtBloomA.width !== bw || this.rtBloomA.height !== bh) {
			this.rtBloomA.setSize(bw, bh);
			this.rtBloomB.setSize(bw, bh);
		}
		const aoScale = this.aoOptions.resolutionScale;
		this._aoW = Math.max(1, Math.round(width * aoScale));
		this._aoH = Math.max(1, Math.round(height * aoScale));
		if (this.aoRT === null) {
			this.aoRT = new THREE.WebGLRenderTarget(this._aoW, this._aoH, {
				type: THREE.UnsignedByteType, depthBuffer: false, stencilBuffer: false
			});
			this.aoBlurRT = new THREE.WebGLRenderTarget(this._aoW, this._aoH, {
				type: THREE.UnsignedByteType, depthBuffer: false, stencilBuffer: false
			});
		} else {
			this.aoRT.setSize(this._aoW, this._aoH);
			this.aoBlurRT.setSize(this._aoW, this._aoH);
		}

		if (this.quality === 'high') {
			if (this.normalRT === null) {
				this.normalRT = new THREE.WebGLRenderTarget(this._aoW, this._aoH, {
					type: THREE.HalfFloatType, depthBuffer: true, stencilBuffer: false
				});
				this.normalRT.texture.colorSpace = THREE.NoColorSpace;
			} else {
				this.normalRT.setSize(this._aoW, this._aoH);
				this.normalRT.depthTexture.image.width = this._aoW;
				this.normalRT.depthTexture.image.height = this._aoH;
				this.normalRT.depthTexture.needsUpdate = true;
			}
			if (this.normalRT.depthTexture === null) {
				this.normalRT.depthTexture = new THREE.DepthTexture(this._aoW, this._aoH);
				this.normalRT.depthTexture.type = THREE.UnsignedIntType;
			}
		}

		const needLdr = this._fxaaActive() || this.taaOptions.enabled === true;
		if (needLdr && this.ldrRT === null) {
			this.ldrRT = new THREE.WebGLRenderTarget(width, height, {
				type: THREE.UnsignedByteType, depthBuffer: false, stencilBuffer: false
			});
			this.ldrRT.texture.colorSpace = THREE.SRGBColorSpace;
		} else if (this.ldrRT !== null) {
			this.ldrRT.setSize(width, height);
		}

		if (this.raysOptions.enabled === true) {
			const rw = Math.max(1, Math.round(width * this.raysOptions.resolutionScale));
			const rh = Math.max(1, Math.round(height * this.raysOptions.resolutionScale));
			if (this.rtRaysA === null) {
				this.rtRaysA = new THREE.WebGLRenderTarget(rw, rh, { type: THREE.UnsignedByteType, depthBuffer: false, stencilBuffer: false });
				this.rtRaysA.texture.colorSpace = THREE.NoColorSpace;
				this.rtRaysB = new THREE.WebGLRenderTarget(rw, rh, { type: THREE.UnsignedByteType, depthBuffer: false, stencilBuffer: false });
				this.rtRaysB.texture.colorSpace = THREE.NoColorSpace;
			} else {
				this.rtRaysA.setSize(rw, rh);
				this.rtRaysB.setSize(rw, rh);
			}
		}

		if (this.taaOptions.enabled === true) {
			if (this.rtTaaA === null) {
				this.rtTaaA = new THREE.WebGLRenderTarget(width, height, {
					type: THREE.UnsignedByteType, depthBuffer: false, stencilBuffer: false
				});
				this.rtTaaA.texture.colorSpace = THREE.SRGBColorSpace;
				this.rtTaaB = new THREE.WebGLRenderTarget(width, height, {
					type: THREE.UnsignedByteType, depthBuffer: false, stencilBuffer: false
				});
				this.rtTaaB.texture.colorSpace = THREE.SRGBColorSpace;
			} else {
				this.rtTaaA.setSize(width, height);
				this.rtTaaB.setSize(width, height);
			}
			if (this.taaOptions.velocityPass === true) {
				if (this.rtVelocity === null) {
					this.rtVelocity = new THREE.WebGLRenderTarget(width, height, {
						type: THREE.HalfFloatType, depthBuffer: true, stencilBuffer: false
					});
					this.rtVelocity.texture.colorSpace = THREE.NoColorSpace;
				} else {
					this.rtVelocity.setSize(width, height);
				}
				this.rtVelocity.depthTexture = this.sceneRT.depthTexture;
			}
			this._historyValid = false;
		}
		return this;
	}

	_ensureLdr() {
		if (this.ldrRT === null) {
			this.ldrRT = new THREE.WebGLRenderTarget(this._w, this._h, {
				type: THREE.UnsignedByteType, depthBuffer: false, stencilBuffer: false
			});
			this.ldrRT.texture.colorSpace = THREE.SRGBColorSpace;
		} else if (this.ldrRT.width !== this._w || this.ldrRT.height !== this._h) {
			this.ldrRT.setSize(this._w, this._h);
		}
	}

	_fxaaActive() {
		if (this.enabled !== false && this.taaOptions.enabled === true) return false;
		return this.fxaa === true || (this.fxaa === 'auto' && this.samples === 0);
	}

	setAO(params) {
		const o = this.aoOptions;
		Object.assign(o, params);
		const u = this.aoMat.uniforms;
		if (params.radius !== undefined) u.uRadius.value = o.radius;
		if (params.bias !== undefined) u.uBias.value = o.bias;
		if (params.intensity !== undefined) u.uIntensity.value = o.intensity;
		if (params.power !== undefined) u.uPower.value = o.power;
		if (params.fadeEnd !== undefined) u.uFadeEnd.value = o.fadeEnd;
		if (params.rangeCheck !== undefined) u.uRangeCheck.value = o.rangeCheck || o.radius * 2.5;
		if (params.blurSharpness !== undefined) this.blurMat.uniforms.uSharpness.value = o.blurSharpness;
		if (params.strength !== undefined) this.compositeMat.uniforms.uAOStrength.value = o.strength;
		// S3 (v2.9): ambient-доля и привязка источников; фактическое значение
		// uniform uAOAmbient пересчитывается каждый кадр в _updateAOAmbient()
		if (params.ambientShare !== undefined) {
			o.ambientShare = Math.max(0, Math.min(1, Number(params.ambientShare) || 0));
		}
		if (params.lights !== undefined) o.lights = params.lights === false ? null : params.lights;
		if (params.enabled !== undefined) {
			const on = o.enabled === true;
			if (on) this.compositeMat.defines.TF_COMP_AO = '';
			else delete this.compositeMat.defines.TF_COMP_AO;
			this.compositeMat.needsUpdate = true;
		}
		return this;
	}

	setBloomEnabled(on) {
		this.bloomOptions.enabled = on === true;
		return this;
	}

	/**
	 * Переключение режима AO на лету: 'fast' (нормали из глубины) или
	 * 'high' (normal-prepass).
	 *
	 * ДОБАВЛЕНО: раньше `quality` можно было задать только в конструкторе —
	 * defines TF_AO_NORMALS и normalRT «запекались», и попытка поменять
	 * поле вручную оставляла пайплайн в несогласованном состоянии
	 * (шейдер с TF_AO_NORMALS читал tNormals = null).
	 *
	 * @param {'fast'|'high'} quality
	 * @returns {this}
	 */
	setQuality(quality) {
		const next = quality === 'high' ? 'high' : 'fast';
		if (next === this.quality) return this;
		this.quality = next;
		const high = next === 'high';
		if (high) {
			this.aoMat.defines.TF_AO_NORMALS = '';
			this.blurMat.defines.TF_AO_NORMALS = '';
		} else {
			delete this.aoMat.defines.TF_AO_NORMALS;
			delete this.blurMat.defines.TF_AO_NORMALS;
		}
		this.aoMat.needsUpdate = true;
		this.blurMat.needsUpdate = true;
		this.debugMat.uniforms.uHasNormals.value = high ? 1 : 0;
		if (!high && this.normalRT !== null) {
			if (this.normalRT.depthTexture !== null) this.normalRT.depthTexture.dispose();
			this.normalRT.dispose();
			this.normalRT = null;
		}
		if (this._w > 0) this.setSize(this._w, this._h);
		this.dispatchEvent({ type: 'quality', quality: next });
		return this;
	}

	/**
	 * Включение/выключение god-rays (v2.3). Создание RT отложено до setSize.
	 * @param {boolean} on
	 * @returns {this}
	 */
	setGodRays(on) {
		const next = on === true;
		if (next === this.raysOptions.enabled) return this;
		this.raysOptions.enabled = next;
		if (next === false && this.rtRaysA !== null) {
			this.rtRaysA.dispose();
			this.rtRaysB.dispose();
			this.rtRaysA = null;
			this.rtRaysB = null;
			this._raysFade = 0;
		}
		if (this._w > 0) this.setSize(this._w, this._h);
		this.dispatchEvent({ type: 'godrays', enabled: next });
		return this;
	}

	setGodRaysParams(params) {
		const o = this.raysOptions;
		Object.assign(o, params);
		const bu = this.raysBlurMat.uniforms;
		if (params.density !== undefined) bu.uDensity.value = o.density;
		if (params.decay !== undefined) bu.uDecay.value = o.decay;
		if (params.weight !== undefined) bu.uWeight.value = o.weight;
		if (params.threshold !== undefined) this.raysBrightMat.uniforms.uThreshold.value = o.threshold;
		if (params.tint !== undefined) this.finalMat.uniforms.uRaysTint.value.copy(o.tint);
		if (params.strength !== undefined) { }
		return this;
	}

	setAOSamples(n) {
		n = Math.max(4, Math.min(32, n | 0));
		if (this.aoOptions.samples === n) return this;
		this.aoOptions.samples = n;
		this.aoMat.defines.TF_AO_SAMPLES = String(n);
		this.aoMat.needsUpdate = true;
		return this;
	}

	setDebug(mode) {
		this.debug = mode || 'none';
		const m = { none: 0, ao: 1, depth: 2, normals: 3, velocity: 4 }[this.debug];
		this.debugMat.uniforms.uMode.value = m !== undefined ? m : 0;
		return this;
	}

	setTAA(params) {
		const o = this.taaOptions;
		const wasEnabled = o.enabled === true;
		Object.assign(o, params);
		if (params.samples !== undefined) o.samples = Math.max(2, Math.min(64, o.samples | 0));
		if (params.mix !== undefined) this.taaResolveMat.uniforms.uMix.value = o.mix;
		if (params.sharpen !== undefined) this.taaBlitMat.uniforms.uSharpen.value = o.sharpen;
		if (o.enabled === true && !wasEnabled) {
			this.resetHistory();
			if (this._w > 0) this.setSize(this._w, this._h);
		}
		if (this.camera !== null && this.camera.layers !== undefined && o.enabled === true) {
			this.camera.layers.enable(TF_VELOCITY_LAYER);
		}
		return this;
	}

	trackObject(object) {
		const add = (o) => {
			if (o.geometry === undefined || o.geometry === null) return;
			if (this._tracked.has(o)) return;
			o.updateWorldMatrix(true, false);
			this._tracked.set(o, {
				prevMatrixWorld: new THREE.Matrix4().copy(o.matrixWorld),
				prevMVP: new THREE.Matrix4()
			});
			o.layers.enable(TF_VELOCITY_LAYER);
		};
		object.traverse(add);
		return this;
	}

	untrackObject(object) {
		const rem = (o) => {
			if (this._tracked.has(o)) {
				o.layers.disable(TF_VELOCITY_LAYER);
				this._tracked.delete(o);
			}
		};
		object.traverse(rem);
		return this;
	}

	resetHistory() {
		this._historyValid = false;
		this._prevViewProjClean = null;
		this._frameIdx = 0;
		return this;
	}

	render() {
		const renderer = this.renderer;
		const scene = this.scene;
		const camera = this.camera;
		if (renderer === undefined || renderer === null || scene === null || camera === null) return;
		if (renderer.info.autoReset === false) renderer.info.reset();
		const tm = renderer.toneMapping | 0;
		if (tm !== this._toneMode) {
			this._toneMode = tm;
			this.compositeMat.defines.TF_TONE_MODE = String(tm);
			this.compositeMat.needsUpdate = true;
		}

		if (this.enabled === false) {
			renderer.setRenderTarget(null);
			renderer.render(scene, camera);
			if (this.scenePassHook !== null) this.scenePassHook(renderer, scene, camera);
			return;
		}

		renderer.getDrawingBufferSize(_ppSize);
		if (this._w !== _ppSize.x || this._h !== _ppSize.y || this.sceneRT === null) {
			this.setSize(_ppSize.x, _ppSize.y);
		}

		const tAll = this.profile ? _tfNow() : 0;
		const aoOn = (this.aoOptions.enabled === true && this.debug === 'none') || this.debug === 'ao';
		const taaOn = this.taaOptions.enabled === true && this.debug === 'none';
		const velocityOn = taaOn && this.taaOptions.velocityPass === true && this._tracked.size > 0;
		if (taaOn && (this.rtTaaA === null || (this.taaOptions.velocityPass && this.rtVelocity === null))) {
			this.setSize(this._w, this._h);
		}

		camera.updateMatrixWorld();
		camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
		this._projClean.copy(camera.projectionMatrix);
		this._curViewProjClean.multiplyMatrices(this._projClean, camera.matrixWorldInverse);
		if (taaOn) TF_SHADOW_UNIFORMS.tfShadowRot.value = (TF_SHADOW_UNIFORMS.tfShadowRot.value + 0.6180339887) % 1;
		else TF_SHADOW_UNIFORMS.tfShadowRot.value = 0;
		const _vis = (this.fog !== null && this.fog !== undefined && this.fog.visibility > 0)
			? this.fog.visibility : camera.far * 0.5;
		TF_SHADOW_UNIFORMS.tfShadowFade.value.set(
			Math.min(_vis * 0.55, camera.far * 0.45),
			Math.min(_vis * 1.05, camera.far * 0.8)
		);
		if (taaOn) {
			this._frameIdx++;
			const seqLen = Math.max(2, this.taaOptions.samples | 0);
			const jIdx = ((this._frameIdx - 1) % seqLen) + 1;
			this._jitterNdc.set(
				(tfHalton(jIdx, 2) - 0.5) * 2 / this._w,
				(tfHalton(jIdx, 3) - 0.5) * 2 / this._h
			);
			this._projJittered.copy(this._projClean);
			this._projJittered.elements[8] += this._jitterNdc.x;
			this._projJittered.elements[9] += this._jitterNdc.y;
			this._invProjJittered.copy(this._projJittered).invert();
			this._curViewProjJittered.multiplyMatrices(this._projJittered, camera.matrixWorldInverse);
			camera.projectionMatrix.copy(this._projJittered);
		}

		if (this.quality === 'high' && (aoOn || this.debug === 'normals')) {
			const t0 = this.profile ? _tfNow() : 0;
			this._hideForPrepass(scene);
			const prevOverride = scene.overrideMaterial;
			renderer.getClearColor(_ppClearColor);
			const prevAlpha = renderer.getClearAlpha();
			const prevShadowAuto = renderer.shadowMap.autoUpdate;
			renderer.setClearColor(0x000000, 0);
			renderer.shadowMap.autoUpdate = false;
			scene.overrideMaterial = this.normalMat;
			renderer.setRenderTarget(this.normalRT);
			renderer.render(scene, camera);
			scene.overrideMaterial = prevOverride;
			renderer.shadowMap.autoUpdate = prevShadowAuto;
			renderer.setClearColor(_ppClearColor, prevAlpha);
			this._restoreAfterPrepass();
			if (this.profile) this.stats.msNormals = _tfNow() - t0;
		}

		let t0 = this.profile ? _tfNow() : 0;
		renderer.setRenderTarget(this.sceneRT);
		renderer.render(scene, camera);
		if (this.scenePassHook !== null) this.scenePassHook(renderer, scene, camera);
		if (this.profile) this.stats.msScene = _tfNow() - t0;

		if (taaOn) camera.projectionMatrix.copy(this._projClean);

		if (aoOn) {
			t0 = this.profile ? _tfNow() : 0;
			this._updateAOAmbient();          // S3: доля ambient для композита
			this._updateCameraUniforms(taaOn);
			const useNormals = this.quality === 'high';
			this.aoMat.uniforms.tDepth.value = this.sceneRT.depthTexture;
			this.aoMat.uniforms.tNormals.value = useNormals ? this.normalRT.texture : null;
			this._quad.material = this.aoMat;
			renderer.setRenderTarget(this.aoRT);
			renderer.render(this._fsScene, this._fsCamera);
			if (this.profile) { this.stats.msAO = _tfNow() - t0; t0 = _tfNow(); }

			const bu = this.blurMat.uniforms;
			bu.tAO.value = this.aoRT.texture;
			bu.tDepth.value = this.sceneRT.depthTexture;
			bu.tNormals.value = useNormals ? this.normalRT.texture : null;
			bu.uTexel.value.set(1 / this._aoW, 1 / this._aoH);
			this._quad.material = this.blurMat;
			renderer.setRenderTarget(this.aoBlurRT);
			renderer.render(this._fsScene, this._fsCamera);
			if (this.profile) this.stats.msBlur = _tfNow() - t0;
		}

		if (velocityOn) {
			t0 = this.profile ? _tfNow() : 0;
			const prevVP = this._prevViewProjClean !== null ? this._prevViewProjClean : this._curViewProjClean;
			for (const entry of this._tracked.values()) {
				entry.prevMVP.multiplyMatrices(prevVP, entry.prevMatrixWorld);
			}
			this.velocityMat.uniforms.uProjJittered.value.copy(this._projJittered);
			if (this.rtVelocity.depthTexture !== this.sceneRT.depthTexture) {
				this.rtVelocity.depthTexture = this.sceneRT.depthTexture;
			}
			renderer.getClearColor(_ppClearColor);
			const prevAlpha = renderer.getClearAlpha();
			const prevShadowAuto = renderer.shadowMap.autoUpdate;
			const prevOverride = scene.overrideMaterial;
			const prevMask = camera.layers.mask;
			const prevAutoDepth = renderer.autoClearDepth;
			renderer.setClearColor(0x000000, 0);
			renderer.shadowMap.autoUpdate = false;
			renderer.autoClearDepth = false;
			camera.layers.set(TF_VELOCITY_LAYER);
			scene.overrideMaterial = this.velocityMat;
			renderer.setRenderTarget(this.rtVelocity);
			renderer.render(scene, camera);
			scene.overrideMaterial = prevOverride;
			camera.layers.mask = prevMask;
			renderer.shadowMap.autoUpdate = prevShadowAuto;
			renderer.autoClearDepth = prevAutoDepth;
			renderer.setClearColor(_ppClearColor, prevAlpha);
			if (this.profile) this.stats.msVelocity = _tfNow() - t0;
		}

		const raysOn = this.raysOptions.enabled === true && this.debug === 'none' && this.rtRaysA !== null;
		if (raysOn) {
			t0 = this.profile ? _tfNow() : 0;
			const sunDir = this.sunDirection !== null ? this.sunDirection
				: (this.fog !== null && this.fog !== undefined ? this.fog.uniforms.tfFogSunDir.value : null);
			let fadeTarget = 0;
			if (sunDir !== null && sunDir !== undefined) {
				this._sunProj.copy(sunDir).applyMatrix4(camera.matrixWorldInverse);
				if (this._sunProj.z < -0.02) {
					this._sunProj.copy(camera.position).addScaledVector(sunDir, 1000).project(camera);
					this._sunUv.set(this._sunProj.x * 0.5 + 0.5, this._sunProj.y * 0.5 + 0.5);
					fadeTarget = 1;
				}
			}
			this._raysFade += (fadeTarget - this._raysFade) * 0.08;
			const rb = this.raysBrightMat.uniforms;
			rb.tScene.value = this.sceneRT.texture;
			rb.tDepth.value = this.sceneRT.depthTexture;
			this._quad.material = this.raysBrightMat;
			renderer.setRenderTarget(this.rtRaysA);
			renderer.render(this._fsScene, this._fsCamera);
			const ru2 = this.raysBlurMat.uniforms;
			ru2.tRays.value = this.rtRaysA.texture;
			ru2.uSunUv.value.copy(this._sunUv);
			this._quad.material = this.raysBlurMat;
			renderer.setRenderTarget(this.rtRaysB);
			renderer.render(this._fsScene, this._fsCamera);
			if (this.profile) this.stats.msRays = _tfNow() - t0;
		} else {
			this._raysFade += (0 - this._raysFade) * 0.15;
		}

		const bloomOn = this.bloomOptions.enabled === true && this.debug === 'none';
		if (bloomOn) {
			t0 = this.profile ? _tfNow() : 0;
			if (this.rtBloomA === null) this.setSize(this._w, this._h);
			const bb = this.bloomBrightMat.uniforms;
			bb.tScene.value = this.sceneRT.texture;
			bb.uThreshold.value = this.bloomOptions.threshold;
			bb.uKnee.value = this.bloomOptions.knee;
			this._quad.material = this.bloomBrightMat;
			renderer.setRenderTarget(this.rtBloomA);
			renderer.render(this._fsScene, this._fsCamera);
			const bl = this.bloomBlurMat.uniforms;
			const bw = this.rtBloomA.width, bh = this.rtBloomA.height;
			const iters = this.bloomOptions.iterations >= 2 ? 2 : 1;
			for (let it = 0; it < iters; it++) {
				const spread = it === 0 ? 1 : 2.2;
				this._quad.material = this.bloomBlurMat;
				bl.tBloomIn.value = this.rtBloomA.texture;
				bl.uStep.value.set(spread / bw, 0);
				renderer.setRenderTarget(this.rtBloomB);
				renderer.render(this._fsScene, this._fsCamera);
				bl.tBloomIn.value = this.rtBloomB.texture;
				bl.uStep.value.set(0, spread / bh);
				renderer.setRenderTarget(this.rtBloomA);
				renderer.render(this._fsScene, this._fsCamera);
			}
			if (this.profile) this.stats.msBloom = _tfNow() - t0;
		}
		this.compositeMat.uniforms.tBloom.value = this.rtBloomA !== null ? this.rtBloomA.texture : null;
		this.compositeMat.uniforms.uBloomIntensity.value = bloomOn ? this.bloomOptions.intensity : 0;

		t0 = this.profile ? _tfNow() : 0;
		if (this.debug !== 'none') {
			this._historyValid = false;
			const du = this.debugMat.uniforms;
			this._updateCameraUniforms();
			du.tAO.value = this.aoBlurRT.texture;
			du.tDepth.value = this.sceneRT.depthTexture;
			du.tNormals.value = this.quality === 'high' ? this.normalRT.texture : null;
			du.tVelocity.value = this.rtVelocity !== null ? this.rtVelocity.texture : null;
			this._quad.material = this.debugMat;
			renderer.setRenderTarget(null);
			renderer.render(this._fsScene, this._fsCamera);
		} else {
			this.compositeMat.uniforms.tScene.value = this.sceneRT.texture;
			this.compositeMat.uniforms.tAO.value = this.aoBlurRT.texture;
			this._quad.material = this.compositeMat;
			if (taaOn) {
				this.compositeMat.uniforms.uDither.value = 0;
				this._ensureLdr();
				renderer.setRenderTarget(this.ldrRT);
				renderer.render(this._fsScene, this._fsCamera);
				if (this.profile) { this.stats.msComposite = _tfNow() - t0; t0 = _tfNow(); }
				const curRT = this._histPing === 0 ? this.rtTaaA : this.rtTaaB;
				const histRT = this._histPing === 0 ? this.rtTaaB : this.rtTaaA;
				const ru = this.taaResolveMat.uniforms;
				ru.tCurrent.value = this.ldrRT.texture;
				ru.tHistory.value = histRT.texture;
				ru.tDepth.value = this.sceneRT.depthTexture;
				ru.tVelocity.value = this.rtVelocity !== null ? this.rtVelocity.texture : null;
				ru.uCurInvProj.value.copy(this._invProjJittered);
				ru.uPrevViewProj.value.copy(this._prevViewProjClean !== null ? this._prevViewProjClean : this._curViewProjClean);
				ru.uCamWorld.value.copy(camera.matrixWorld);
				ru.uTexel.value.set(1 / this._w, 1 / this._h);
				ru.uHasVelocity.value = velocityOn ? 1 : 0;
				ru.uHistoryValid.value = this._historyValid ? 1 : 0;
				this._quad.material = this.taaResolveMat;
				renderer.setRenderTarget(curRT);
				renderer.render(this._fsScene, this._fsCamera);
				this._finalBlit(curRT.texture, raysOn);
				renderer.setRenderTarget(null);
				renderer.render(this._fsScene, this._fsCamera);
				this._historyValid = true;
				this._histPing = 1 - this._histPing;
				if (this._prevViewProjClean === null) this._prevViewProjClean = new THREE.Matrix4();
				this._prevViewProjClean.copy(this._curViewProjClean);
				for (const pair of this._tracked) {
					pair[1].prevMatrixWorld.copy(pair[0].matrixWorld);
				}
				if (this.profile) this.stats.msTaa = _tfNow() - t0;
			} else if (this._fxaaActive()) {
				this.compositeMat.uniforms.uDither.value = 0;
				this._ensureLdr();
				renderer.setRenderTarget(this.ldrRT);
				renderer.render(this._fsScene, this._fsCamera);
				this.fxaaMat.uniforms.tColor.value = this.ldrRT.texture;
				this.fxaaMat.uniforms.uTexel.value.set(1 / this._w, 1 / this._h);
				this._quad.material = this.fxaaMat;
				this._ensurePost();
				renderer.setRenderTarget(this.rtPost);
				renderer.render(this._fsScene, this._fsCamera);
				this._finalBlit(this.rtPost.texture, raysOn);
				renderer.setRenderTarget(null);
				renderer.render(this._fsScene, this._fsCamera);
			} else if (raysOn) {
				this.compositeMat.uniforms.uDither.value = 0;
				this._ensureLdr();
				renderer.setRenderTarget(this.ldrRT);
				renderer.render(this._fsScene, this._fsCamera);
				this._finalBlit(this.ldrRT.texture, true);
				renderer.setRenderTarget(null);
				renderer.render(this._fsScene, this._fsCamera);
			} else {
				this.compositeMat.uniforms.uDither.value = 1;
				renderer.setRenderTarget(null);
				renderer.render(this._fsScene, this._fsCamera);
			}
		}
		if (this.profile) {
			if (this.debug !== 'none' || !taaOn) this.stats.msComposite = _tfNow() - t0;
			this.stats.ms = _tfNow() - tAll;
			this.stats.passes = renderer.info.render.calls;
		}
	}

	_finalBlit(colorTex, rays) {
		this._syncGrade();
		const u = this.finalMat.uniforms;
		u.tColor.value = colorTex;
		u.tRays.value = this.rtRaysB !== null ? this.rtRaysB.texture : null;
		u.uRaysStrength.value = rays === true ? this.raysOptions.strength * this._raysFade : 0;
		u.uSharpen.value = this.taaOptions.enabled === true ? this.taaOptions.sharpen : 0;
		u.uTexel.value.set(1 / this._w, 1 / this._h);
		this._quad.material = this.finalMat;
		return this;
	}

	_ensurePost() {
		if (this.rtPost === null) {
			this.rtPost = new THREE.WebGLRenderTarget(this._w, this._h, { type: THREE.UnsignedByteType, depthBuffer: false, stencilBuffer: false });
			this.rtPost.texture.colorSpace = THREE.SRGBColorSpace;
		} else if (this.rtPost.width !== this._w || this.rtPost.height !== this._h) {
			this.rtPost.setSize(this._w, this._h);
		}
	}

	/**
	 * S3 (v2.9): доля ambient-составляющей в освещении кадра — композит гасит
	 * AO только её (uniform uAOAmbient). При `aoOptions.lights = {hemi, sun, moon}`
	 * берётся из живых интенсивностей источников каждый кадр; иначе —
	 * `aoOptions.ambientShare`. Физика: AO — это окклюзия НЕБЕСНОГО света,
	 * прямой свет светила редактирует теневая карта, а не AO.
	 */
	_updateAOAmbient() {
		const o = this.aoOptions;
		let share = o.ambientShare !== undefined ? o.ambientShare : 0.6;
		const L = o.lights;
		if (L !== null && L !== undefined) {
			const hemi = L.hemi !== undefined && L.hemi !== null ? Math.max(0, L.hemi.intensity || 0) : 0;
			const sun = L.sun !== undefined && L.sun !== null ? Math.max(0, L.sun.intensity || 0) : 0;
			const moon = L.moon !== undefined && L.moon !== null ? Math.max(0, L.moon.intensity || 0) : 0;
			const total = hemi + sun + moon;
			if (total > 1e-4) share = hemi / total;
		}
		this.compositeMat.uniforms.uAOAmbient.value = Math.max(0.15, Math.min(0.85, share));
	}

	_updateCameraUniforms(jittered = false) {
		const camera = this.camera;
		if (camera === null) return;
		const u = this.aoMat.uniforms;
		const useJitter = jittered === true;
		u.uProj.value = useJitter ? this._projJittered : camera.projectionMatrix;
		if (useJitter) u.uJitter.value.copy(this._jitterNdc);
		else u.uJitter.value.set(0, 0);
		u.uNear.value = camera.near;
		u.uFar.value = camera.far;
		const e = u.uProj.value.elements;
		u.uProjScale.value.set(e[0] !== 0 ? 1 / e[0] : 1, e[5] !== 0 ? 1 / e[5] : 1);
		this.blurMat.uniforms.uNear.value = camera.near;
		this.blurMat.uniforms.uFar.value = camera.far;
		this.debugMat.uniforms.uNear.value = camera.near;
		this.debugMat.uniforms.uFar.value = camera.far;
		this.debugMat.uniforms.uHasNormals.value = this.quality === 'high' ? 1 : 0;
	}

	_hideForPrepass(scene) {
		const list = this._transparentHidden;
		list.length = 0;
		scene.traverse(obj => {
			if (obj.visible === false) return;
			const m = obj.material;
			if (m === undefined || m === null) return;
			const transparent = Array.isArray(m) ? m.some(mm => mm !== undefined && mm.transparent) : m.transparent === true;
			if (transparent) {
				obj.visible = false;
				list.push(obj);
			}
		});
		for (const obj of this.prepassExclude) {
			if (obj.visible === true) {
				obj.visible = false;
				list.push(obj);
			}
		}
	}

	_restoreAfterPrepass() {
		const list = this._transparentHidden;
		for (let i = 0; i < list.length; i++) list[i].visible = true;
		list.length = 0;
	}

	dispose() {
		this.detach();
		if (this.rtBloomA !== null) { this.rtBloomA.dispose(); this.rtBloomB.dispose(); }
		this.bloomBrightMat.dispose();
		this.bloomBlurMat.dispose();
		if (this.sceneRT !== null) {
			this.sceneRT.dispose();
			if (this.sceneRT.depthTexture !== null && this.sceneRT.depthTexture !== undefined) {
				this.sceneRT.depthTexture.dispose();
			}
		}
		if (this.normalRT !== null) { this.normalRT.dispose(); if (this.normalRT.depthTexture) this.normalRT.depthTexture.dispose(); }
		if (this.aoRT !== null) this.aoRT.dispose();
		if (this.aoBlurRT !== null) this.aoBlurRT.dispose();
		if (this.ldrRT !== null) this.ldrRT.dispose();
		if (this.rtVelocity !== null) {
			this.rtVelocity.depthTexture = null;
			this.rtVelocity.dispose();
		}
		if (this.rtTaaA !== null) this.rtTaaA.dispose();
		if (this.rtTaaB !== null) this.rtTaaB.dispose();
		if (this.rtRaysA !== null) this.rtRaysA.dispose();
		if (this.rtRaysB !== null) this.rtRaysB.dispose();
		if (this.rtPost !== null) this.rtPost.dispose();
		for (const pair of this._tracked) pair[0].layers.disable(TF_VELOCITY_LAYER);
		this._tracked.clear();
		this.aoMat.dispose();
		this.blurMat.dispose();
		this.compositeMat.dispose();
		this.debugMat.dispose();
		this.fxaaMat.dispose();
		this.normalMat.dispose();
		this.velocityMat.dispose();
		this.taaResolveMat.dispose();
		this.taaBlitMat.dispose();
		this.raysBrightMat.dispose();
		this.raysBlurMat.dispose();
		this.finalMat.dispose();
		this._quad.geometry.dispose();
	}
};

const TF_DITHER_PARS_GLSL = `
uniform float uDitherFade;
float tfDitherIGN( vec2 position ) {
	return fract( 52.9829189 * fract( dot( position, vec2( 0.06711056, 0.00583715 ) ) ) );
}`;

const TF_DITHER_MAIN_GLSL = `
if ( uDitherFade < 1.0 ) {
	if ( tfDitherIGN( gl_FragCoord.xy ) > uDitherFade ) discard;
}`;

function installDitherLODPatch(material, uniform) {
	if (material === undefined || material === null) return material;
	if (material.__tfDither === uniform) return material;
	if (material.__tfDither !== undefined) {
		console.warn('ThreeForge: installDitherLODPatch — материал уже используется другим LOD-уровнем; дизер для него пропущен (нужен отдельный экземпляр материала на уровень).');
		return material;
	}
	material.__tfDither = uniform;
	tfAddProgramCacheKey(material, 'dither');
	tfRecordPatch(material, { name: 'dither', replay: (copy) => installDitherLODPatch(copy, uniform) });
	tfChainOnBeforeCompile(material, function (shader, renderer) {
		shader.uniforms.uDitherFade = uniform;
		const parsTag = '#include <clipping_planes_pars_fragment>';
		const mainTag = '#include <clipping_planes_fragment>';
		if (shader.fragmentShader.indexOf(parsTag) === -1 || shader.fragmentShader.indexOf(mainTag) === -1) {
			console.warn('ThreeForge: dither-патч — clipping-чанки не найдены, материал без дизера');
			return;
		}
		shader.fragmentShader = shader.fragmentShader
			.replace(parsTag, parsTag + '\n' + TF_DITHER_PARS_GLSL)
			.replace(mainTag, mainTag + '\n' + TF_DITHER_MAIN_GLSL);
	});
	return material;
}

const _lodV1 = new THREE.Vector3();
const _lodV2 = new THREE.Vector3();
const _lodSphere = new THREE.Sphere();

const LODGroup = class extends THREE.Group {
	constructor(options = {}) {
		super();
		this.isLODGroup = true;
		this.camera = options.camera || null;
		this.metric = options.metric === 'screen' ? 'screen' : 'distance';
		this.hysteresis = options.hysteresis !== undefined ? options.hysteresis : 0.08;
		this.dither = options.dither !== false;
		this.ditherTime = options.ditherTime !== undefined ? options.ditherTime : 0.35;
		this.radius = options.radius !== undefined ? options.radius : 1;
		this.levels = [];
		this._current = 0;
		this._shown = 0;
		this._transition = null;
		this._autoPatch = options.autoPatch !== false;
	}

	addLevel(object, threshold = 0) {
		const uniform = { value: 1 };
		const level = { object, threshold, uniform };
		this.levels.push(level);
		this.levels.sort((a, b) => this.metric === 'screen'
			? b.threshold - a.threshold
			: a.threshold - b.threshold);
		this.add(object);
		if (this._autoPatch) this._patchLevel(level);
		for (let i = 0; i < this.levels.length; i++) {
			this.levels[i].object.visible = i === 0;
		}
		this._current = 0;
		this._shown = 0;
		return this;
	}

	_patchLevel(level) {
		level.object.traverse(obj => {
			if (obj.material === undefined) return;
			const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
			const out = [];
			for (const m of mats) out.push(installDitherLODPatch(m, level.uniform));
			if (Array.isArray(obj.material)) obj.material = out;
			else obj.material = out[0];
		});
	}

	_boundary(i) {
		const lv = this.levels[i];
		if (this.metric === 'distance') return lv.threshold;
		const cam = this.camera;
		if (cam === null || cam.isPerspectiveCamera !== true) return lv.threshold;
		const tanHalf = Math.tan(cam.fov * 0.5 * Math.PI / 180);
		const ratio = Math.max(1e-6, lv.threshold);
		return this.radius / (ratio * tanHalf);
	}

	update(dt = 1 / 60) {
		const levels = this.levels;
		const cam = this.camera;
		if (cam === null || levels.length === 0) return this;
		if (!(dt > 0)) dt = 1 / 60;
		this.updateMatrixWorld(true);
		cam.updateMatrixWorld();
		_lodV1.setFromMatrixPosition(this.matrixWorld);
		cam.getWorldPosition(_lodV2);
		const dist = _lodV1.distanceTo(_lodV2);

		let idx = this._current;
		const hUp = 1 + this.hysteresis;
		const hDown = 1 - this.hysteresis;
		while (idx < levels.length - 1 && dist > this._boundary(idx + 1) * hUp) idx++;
		while (idx > 0 && dist < this._boundary(idx) * hDown) idx--;
		this._current = idx;

		const dithered = this.dither === true && this.ditherTime > 0;
		const tr = this._transition;

		if (tr !== null && (dithered === false || tr.to !== idx)) {
			levels[tr.to].object.visible = false;
			levels[tr.to].uniform.value = 1;
			if (tr.from !== this._shown) {
				levels[tr.from].object.visible = false;
				levels[tr.from].uniform.value = 1;
			}
			this._transition = null;
		}

		if (dithered === false) {
			if (idx !== this._shown) {
				levels[this._shown].object.visible = false;
				levels[this._shown].uniform.value = 1;
				levels[idx].object.visible = true;
				levels[idx].uniform.value = 1;
				this._shown = idx;
			}
			return this;
		}

		if (this._transition === null) {
			if (idx !== this._shown) {
				this._transition = { from: this._shown, to: idx, t: 0 };
				levels[this._shown].object.visible = true;
				levels[this._shown].uniform.value = 1;
				levels[idx].object.visible = true;
				levels[idx].uniform.value = 0;
			} else {
				levels[idx].object.visible = true;
				levels[idx].uniform.value = 1;
			}
			return this;
		}

		const cur = this._transition;
		cur.t += dt;
		const p = Math.min(1, cur.t / Math.max(1e-4, this.ditherTime));
		levels[cur.from].uniform.value = 1 - p;
		levels[cur.to].uniform.value = p;
		if (p >= 1) {
			levels[cur.from].object.visible = false;
			levels[cur.from].uniform.value = 1;
			levels[cur.to].uniform.value = 1;
			this._shown = cur.to;
			this._transition = null;
		}
		return this;
	}

	forceLevel(i) {
		if (i < 0 || i >= this.levels.length) return this;
		for (let k = 0; k < this.levels.length; k++) {
			this.levels[k].object.visible = k === i;
			this.levels[k].uniform.value = 1;
		}
		this._current = i;
		this._shown = i;
		this._transition = null;
		return this;
	}

	dispose() {
		for (const lv of this.levels) {
			lv.object.visible = true;
			lv.uniform.value = 1;
			this.remove(lv.object);
		}
		this.levels.length = 0;
		this._transition = null;
		this._current = 0;
		this._shown = 0;
		return this;
	}

	/**
	 * Радиус для screen-метрики: наименьшая сфера, накрывающая все уровни.
	 *
	 * ИСПРАВЛЕНО (N7): раньше брался максимум радиусов сфер детей БЕЗ учёта их
	 * смещения от начала группы — для модели, чья геометрия offset'нута
	 * (типичный экспорт из DCC: pivot в углу меша), радиус занижался в разы,
	 * screen-порог срабатывал рано и детальная модель переключалась на LOD0
	 * ещё вблизи. Теперь считается `dist(центр группы → центр сферы) + radius`.
	 *
	 * Мировой масштаб группы не учитывается — задавайте `radius` опцией,
	 * если уровни масштабируются по-разному.
	 *
	 * @returns {number} Новый this.radius.
	 */
	computeRadius() {
		this.updateWorldMatrix(true, true);
		_lodV1.setFromMatrixPosition(this.matrixWorld);
		let r = 0;
		for (const lv of this.levels) {
			lv.object.updateWorldMatrix(true, true);
			lv.object.traverse(obj => {
				const g = obj.geometry;
				if (g === undefined || g === null) return;
				if (g.boundingSphere === null) g.computeBoundingSphere();
				if (g.boundingSphere === null) return;
				_lodSphere.copy(g.boundingSphere).applyMatrix4(obj.matrixWorld);
				r = Math.max(r, _lodV1.distanceTo(_lodSphere.center) + _lodSphere.radius);
			});
		}
		this.radius = r > 0 ? r : 1;
		return this.radius;
	}
};

const _scBox = new THREE.Box3();
const _scFrustum = new THREE.Frustum();
const _scMat = new THREE.Matrix4();

const _scSpherePool = [];
function _scScratch(depth) {
	let s = _scSpherePool[depth];
	if (s === undefined) { s = new THREE.Sphere(); _scSpherePool[depth] = s; }
	return s;
}
const _scBvhSphere = new THREE.Sphere();

/**
 * Мировая bounding-сфера объекта.
 *
 * Приоритет источника: `object.boundingSphere` у InstancedMesh/CullGroup
 * («живая» сфера батчера) → `geometry.boundingSphere` → union сфер детей
 * (рекурсивно, для Group без геометрии) → `Box3.setFromObject()`.
 *
 * @param {THREE.Object3D} object - Объект (мировые матрицы должны быть свежими).
 * @param {THREE.Sphere} out - Куда писать результат.
 * @param {number} [depth=0] - Внутреннее: уровень рекурсии (индекс скретча).
 * @returns {THREE.Sphere|null} `out`, либо `null`, если границ нет вовсе.
 */
function computeWorldSphere(object, out, depth = 0) {
	if (object.boundingSphere !== undefined && object.boundingSphere !== null &&
		(object.isInstancedMesh === true || object.isCullGroup === true)) {
		return out.copy(object.boundingSphere).applyMatrix4(object.matrixWorld);
	}
	if (object.geometry !== undefined && object.geometry !== null) {
		const g = object.geometry;
		if (g.boundingSphere === null) g.computeBoundingSphere();
		if (g.boundingSphere !== null) return out.copy(g.boundingSphere).applyMatrix4(object.matrixWorld);
	}
	const children = object.children;
	if (children.length > 0) {
		const scratch = _scScratch(depth);
		let found = false;
		for (let i = 0; i < children.length; i++) {
			const child = children[i];
			child.updateWorldMatrix(false, true);
			if (computeWorldSphere(child, scratch, depth + 1) !== null) {
				if (!found) { out.copy(scratch); found = true; }
				else out.union(scratch);
			}
		}
		if (found) return out;
	}
	_scBox.setFromObject(object);
	if (_scBox.isEmpty()) return null;
	return _scBox.getBoundingSphere(out);
}

const CullBVH = class {
	constructor() {
		this.items = [];
		this.cx = null; this.cy = null; this.cz = null; this.cr = null;
		this.left = null; this.right = null;
		this.start = null; this.count = null;
		this.nodeCount = 0;
	}

	build(items) {
		this.items = items;
		const n = items.length;
		const cap = Math.max(4, 2 * n + 2);
		this.cx = new Float32Array(cap); this.cy = new Float32Array(cap);
		this.cz = new Float32Array(cap); this.cr = new Float32Array(cap);
		this.left = new Int32Array(cap).fill(-1); this.right = new Int32Array(cap).fill(-1);
		this.start = new Int32Array(cap); this.count = new Int32Array(cap);
		this.nodeCount = 0;
		if (n > 0) this._buildNode(0, n);
		return this;
	}

	_buildNode(from, to) {
		const node = this.nodeCount++;
		if (this.nodeCount >= this.cx.length) return node;
		let minX = Infinity, minY = Infinity, minZ = Infinity;
		let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
		for (let i = from; i < to; i++) {
			const s = this.items[i].sphere;
			const c = s.center, r = s.radius;
			if (c.x - r < minX) minX = c.x - r;
			if (c.y - r < minY) minY = c.y - r;
			if (c.z - r < minZ) minZ = c.z - r;
			if (c.x + r > maxX) maxX = c.x + r;
			if (c.y + r > maxY) maxY = c.y + r;
			if (c.z + r > maxZ) maxZ = c.z + r;
		}
		this.cx[node] = (minX + maxX) * 0.5;
		this.cy[node] = (minY + maxY) * 0.5;
		this.cz[node] = (minZ + maxZ) * 0.5;
		this.cr[node] = 0.5 * Math.sqrt((maxX - minX) * (maxX - minX) + (maxY - minY) * (maxY - minY) + (maxZ - minZ) * (maxZ - minZ));
		const n = to - from;
		if (n <= 2) {
			this.left[node] = -1; this.right[node] = -1;
			this.start[node] = from; this.count[node] = n;
			return node;
		}
		const ex = maxX - minX, ey = maxY - minY, ez = maxZ - minZ;
		let axis, pivot;
		if (ex >= ey && ex >= ez) { axis = 0; pivot = (minX + maxX) * 0.5; }
		else if (ey >= ez) { axis = 1; pivot = (minY + maxY) * 0.5; }
		else { axis = 2; pivot = (minZ + maxZ) * 0.5; }
		let lo = from, hi = to - 1;
		while (lo <= hi) {
			const c = this.items[lo].sphere.center;
			const v = axis === 0 ? c.x : axis === 1 ? c.y : c.z;
			if (v < pivot) { lo++; }
			else {
				const t = this.items[lo]; this.items[lo] = this.items[hi]; this.items[hi] = t;
				hi--;
			}
		}
		if (lo === from || lo === to) {
			this.left[node] = -1; this.right[node] = -1;
			this.start[node] = from; this.count[node] = n;
			return node;
		}
		this.start[node] = from; this.count[node] = n;
		this.left[node] = this._buildNode(from, lo);
		this.right[node] = this._buildNode(lo, to);
		return node;
	}

	_growStack(need) {
		let st = this._stack;
		if (st === undefined) { st = this._stack = new Int32Array(256); }
		if (st.length >= need) return st;
		let n = st.length;
		while (n < need) n *= 2;
		const next = new Int32Array(n);
		next.set(st.subarray(0, Math.min(st.length, need)));
		this._stack = next;
		return next;
	}

	query(frustum, out) {
		if (this.nodeCount === 0) return out;
		let stack = this._growStack(2);
		let sp = 0;
		stack[sp++] = 0;
		const sphere = _scBvhSphere;
		while (sp > 0) {
			const node = stack[--sp];
			sphere.center.set(this.cx[node], this.cy[node], this.cz[node]);
			sphere.radius = this.cr[node];
			if (!frustum.intersectsSphere(sphere)) continue;
			if (this.left[node] === -1) {
				const st = this.start[node], c = this.count[node];
				for (let i = st; i < st + c; i++) {
					const item = this.items[i];
					if (frustum.intersectsSphere(item.sphere)) out.push(item.ref);
				}
			} else {
				if (sp + 2 > stack.length) stack = this._growStack(sp + 2);
				stack[sp++] = this.left[node];
				stack[sp++] = this.right[node];
			}
		}
		return out;
	}

	clear() {
		this.items = [];
		this.cx = null; this.cy = null; this.cz = null; this.cr = null;
		this.left = null; this.right = null;
		this.start = null; this.count = null;
		this.nodeCount = 0;
		return this;
	}
};

const SceneCuller = class extends THREE.EventDispatcher {
	constructor(options = {}) {
		super();
		this.camera = options.camera || null;
		this.enabled = options.enabled !== false;
		this.nodes = [];
		this._dynamic = [];
		this._bvh = new CullBVH();
		this._bvhDirty = true;
		this._visibleBuf = [];
		this._frame = 0;
		this.stats = { total: 0, visible: 0, culled: 0, ms: 0 };
	}

	add(object, options = {}) {
		if (object === undefined || object === null || object.isObject3D !== true) {
			if (object !== undefined && object !== null) {
				console.warn('ThreeForge: SceneCuller.add — ожидался THREE.Object3D, получено: ' + typeof object);
			}
			return null;
		}
		const node = {
			object,
			sphere: new THREE.Sphere(new THREE.Vector3(), 0),
			dynamic: options.dynamic === true,
			culled: false,
			userVisible: true,
			mark: -1
		};
		object.updateWorldMatrix(true, true);
		if (computeWorldSphere(object, node.sphere) === null) node.sphere.radius = Infinity;
		this.nodes.push(node);
		if (node.dynamic) this._dynamic.push(node);
		this._bvhDirty = true;
		return node;
	}

	remove(object) {
		const i = this.nodes.findIndex(n => n.object === object);
		if (i === -1) return this;
		const node = this.nodes[i];
		if (node.culled) { node.object.visible = node.userVisible; node.culled = false; }
		this.nodes.splice(i, 1);
		const d = this._dynamic.indexOf(node);
		if (d !== -1) this._dynamic.splice(d, 1);
		this._bvhDirty = true;
		return this;
	}

	refresh(object = null) {
		const list = object === null ? this.nodes : this.nodes.filter(n => n.object === object);
		for (const n of list) {
			n.object.updateWorldMatrix(true, true);
			if (computeWorldSphere(n.object, n.sphere) === null) n.sphere.radius = Infinity;
		}
		this._bvhDirty = true;
		return this;
	}

	/**
	 * Вернуть видимость всем отсечённым объектам (то, что было скрыто самим
	 * куллером; пользовательские `visible = false` не трогаем — для каждого
	 * узла запомнен `userVisible`).
	 * @returns {this}
	 */
	restoreAll() {
		for (let i = 0; i < this.nodes.length; i++) {
			const n = this.nodes[i];
			if (n.culled) { n.object.visible = n.userVisible; n.culled = false; }
			n.mark = -1;
		}
		this.stats.visible = this.nodes.length;
		this.stats.culled = 0;
		return this;
	}

	update() {
		if (!this.enabled || this.camera === null) return this.restoreAll();
		const t0 = _tfNow();
		const camera = this.camera;
		camera.updateMatrixWorld();
		camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
		_scMat.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
		_scFrustum.setFromProjectionMatrix(_scMat);

		for (let i = 0; i < this._dynamic.length; i++) {
			const n = this._dynamic[i];
			n.object.updateWorldMatrix(true, false);
			computeWorldSphere(n.object, n.sphere);
		}
		if (this._bvhDirty) {
			const items = [];
			for (let i = 0; i < this.nodes.length; i++) {
				const n = this.nodes[i];
				if (!n.dynamic) items.push({ sphere: n.sphere, ref: n });
			}
			this._bvh.build(items);
			this._bvhDirty = false;
		}

		this._frame++;
		const frame = this._frame;
		const buf = this._visibleBuf;
		buf.length = 0;
		this._bvh.query(_scFrustum, buf);
		for (let i = 0; i < buf.length; i++) buf[i].mark = frame;
		for (let i = 0; i < this._dynamic.length; i++) {
			const n = this._dynamic[i];
			if (n.sphere.radius === Infinity || _scFrustum.intersectsSphere(n.sphere)) n.mark = frame;
		}
		let visible = 0, culled = 0;
		for (let i = 0; i < this.nodes.length; i++) {
			const n = this.nodes[i];
			const vis = n.mark === frame;
			if (vis) {
				visible++;
				if (n.culled) { n.object.visible = n.userVisible; n.culled = false; }
			} else {
				culled++;
				if (!n.culled) { n.userVisible = n.object.visible; n.object.visible = false; n.culled = true; }
			}
		}
		const s = this.stats;
		s.total = this.nodes.length; s.visible = visible; s.culled = culled;
		s.ms = _tfNow() - t0;
		return this;
	}

	dispose() {
		this.restoreAll();
		this.nodes.length = 0;
		this._dynamic.length = 0;
		this._visibleBuf.length = 0;
		this._bvh.clear();
	}
};

const _ocV = new THREE.Vector3();
const _ocFrustum = new THREE.Frustum();
const _ocPV = new THREE.Matrix4();
const _ocCorners = [];
for (let i = 0; i < 8; i++) _ocCorners.push(new THREE.Vector3());

const OcclusionCuller = class extends THREE.EventDispatcher {
	constructor(options = {}) {
		super();
		this.camera = options.camera || null;
		this.gridWidth = options.gridWidth !== undefined ? options.gridWidth : 128;
		this.gridHeight = options.gridHeight !== undefined ? options.gridHeight : 72;
		this.hysteresis = options.hysteresis !== undefined ? options.hysteresis : 3;
		this.bias = options.bias !== undefined ? options.bias : 0.1;
		this.enabled = options.enabled !== false;
		this.depthGrid = new Float32Array(this.gridWidth * this.gridHeight);
		this.occluders = [];
		this.occludees = [];
		this.stats = { occluded: 0, visible: 0, tested: 0, ms: 0, cellsFilled: 0 };
	}

	addOccluder(source, options = {}) {
		if (source === undefined || source === null ||
			(source.isBox3 !== true && source.isObject3D !== true)) {
			if (source !== undefined && source !== null) {
				console.warn('ThreeForge: OcclusionCuller.addOccluder — ожидался Box3 или Object3D, получено: ' + typeof source);
			}
			return null;
		}
		const entry = { source, box: new THREE.Box3(), dynamic: options.dynamic === true };
		this._refreshOccluder(entry);
		this.occluders.push(entry);
		return entry;
	}

	removeOccluder(entry) {
		const i = this.occluders.indexOf(entry);
		if (i !== -1) this.occluders.splice(i, 1);
		return this;
	}

	addOccludee(object, options = {}) {
		if (object === undefined || object === null || object.isObject3D !== true) {
			if (object !== undefined && object !== null) {
				console.warn('ThreeForge: OcclusionCuller.addOccludee — ожидался THREE.Object3D, получено: ' + typeof object);
			}
			return null;
		}
		const node = {
			object,
			sphere: new THREE.Sphere(new THREE.Vector3(), 0),
			dynamic: options.dynamic === true,
			hiddenFrames: 0,
			culled: false,
			userVisible: true
		};
		object.updateWorldMatrix(true, true);
		if (options.sphere !== undefined && options.sphere !== null) {
			node.sphere.copy(options.sphere);
		} else if (computeWorldSphere(object, node.sphere) === null) {
			node.sphere.radius = Infinity;
		}
		this.occludees.push(node);
		return node;
	}

	removeOccludee(object) {
		const i = this.occludees.findIndex(n => n.object === object);
		if (i === -1) return this;
		const node = this.occludees[i];
		if (node.culled) { node.object.visible = node.userVisible; node.culled = false; }
		this.occludees.splice(i, 1);
		return this;
	}

	_refreshOccluder(entry) {
		const src = entry.source;
		if (src.isBox3 === true) entry.box.copy(src);
		else {
			src.updateWorldMatrix(true, true);
			entry.box.setFromObject(src);
		}
	}

	/** Вернуть видимость всем скрытым окклюдии (см. SceneCuller.restoreAll). */
	restoreAll() {
		for (let i = 0; i < this.occludees.length; i++) this._showOccludee(this.occludees[i]);
		this.stats.occluded = 0;
		return this;
	}

	update() {
		if (!this.enabled || this.camera === null) return this.restoreAll();
		const t0 = _tfNow();
		const camera = this.camera;
		camera.updateMatrixWorld();
		camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
		_ocPV.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
		_ocFrustum.setFromProjectionMatrix(_ocPV);
		const view = camera.matrixWorldInverse;
		const proj = camera.projectionMatrix;
		const near = camera.near;
		const W = this.gridWidth, H = this.gridHeight;
		const grid = this.depthGrid;
		grid.fill(Infinity);

		let cellsFilled = 0;
		for (let oi = 0; oi < this.occluders.length; oi++) {
			const occ = this.occluders[oi];
			if (occ.dynamic) this._refreshOccluder(occ);
			const box = occ.box;
			if (box.isEmpty()) continue;
			if (!_ocFrustum.intersectsBox(box)) continue;
			let minVZ = Infinity;
			let nearCross = false;
			let minNX = Infinity, maxNX = -Infinity, minNY = Infinity, maxNY = -Infinity;
			let ci = 0;
			for (let sx = 0; sx < 2; sx++)
				for (let sy = 0; sy < 2; sy++)
					for (let sz = 0; sz < 2; sz++) {
						const c = _ocCorners[ci++];
						c.set(sx ? box.max.x : box.min.x, sy ? box.max.y : box.min.y, sz ? box.max.z : box.min.z);
						c.applyMatrix4(view);
						const vz = -c.z;
						if (vz < near * 0.9) { nearCross = true; }
						if (vz < minVZ) minVZ = vz;
						c.applyMatrix4(proj);
						const nx = c.x, ny = c.y;
						if (nx < minNX) minNX = nx;
						if (nx > maxNX) maxNX = nx;
						if (ny < minNY) minNY = ny;
						if (ny > maxNY) maxNY = ny;
					}
			if (nearCross || minVZ === Infinity || !Number.isFinite(minNX)) continue;
			if (maxNX < -1 || minNX > 1 || maxNY < -1 || minNY > 1) continue;
			let x0 = Math.floor((minNX * 0.5 + 0.5) * W), x1 = Math.floor((maxNX * 0.5 + 0.5) * W);
			let y0 = Math.floor((minNY * 0.5 + 0.5) * H), y1 = Math.floor((maxNY * 0.5 + 0.5) * H);
			if (x0 < 0) x0 = 0; if (y0 < 0) y0 = 0;
			if (x1 > W - 1) x1 = W - 1; if (y1 > H - 1) y1 = H - 1;
			for (let gy = y0; gy <= y1; gy++) {
				const row = gy * W;
				for (let gx = x0; gx <= x1; gx++) {
					const idx = row + gx;
					if (minVZ < grid[idx]) { grid[idx] = minVZ; cellsFilled++; }
				}
			}
		}

		let occluded = 0, visible = 0, tested = 0;
		for (let i = 0; i < this.occludees.length; i++) {
			const node = this.occludees[i];
			const obj = node.object;
			if (node.dynamic) {
				obj.updateWorldMatrix(true, true);
				computeWorldSphere(obj, node.sphere);
			}
			const sph = node.sphere;
			if (sph.radius === Infinity) { this._showOccludee(node); visible++; continue; }
			if (!obj.visible && !node.culled) continue;
			if (!_ocFrustum.intersectsSphere(sph)) { this._showOccludee(node); continue; }
			tested++;
			_ocV.copy(sph.center).applyMatrix4(view);
			const cvz = -_ocV.z;
			const zNearObj = cvz - sph.radius;
			let isVisible = true;
			if (cvz - sph.radius < near || cvz <= 1e-4) {
				isVisible = true;
			} else {
				_ocV.copy(sph.center).applyMatrix4(_ocPV);
				const ndcX = _ocV.x, ndcY = _ocV.y;
				if (!Number.isFinite(ndcX) || !Number.isFinite(ndcY)) {
					isVisible = true;
				} else {
					const e = proj.elements;
					const rNx = sph.radius * e[0] / cvz;
					const rNy = sph.radius * e[5] / cvz;
					let x0 = Math.floor(((ndcX - rNx) * 0.5 + 0.5) * W);
					let x1 = Math.floor(((ndcX + rNx) * 0.5 + 0.5) * W);
					let y0 = Math.floor(((ndcY - rNy) * 0.5 + 0.5) * H);
					let y1 = Math.floor(((ndcY + rNy) * 0.5 + 0.5) * H);
					if (x0 < 0) x0 = 0; if (y0 < 0) y0 = 0;
					if (x1 > W - 1) x1 = W - 1; if (y1 > H - 1) y1 = H - 1;
					isVisible = false;
					const zTest = zNearObj + this.bias;
					outer:
					for (let gy = y0; gy <= y1; gy++) {
						const row = gy * W;
						for (let gx = x0; gx <= x1; gx++) {
							if (grid[row + gx] > zTest) { isVisible = true; break outer; }
						}
					}
				}
			}
			if (isVisible) {
				node.hiddenFrames = 0;
				this._showOccludee(node);
				visible++;
			} else {
				node.hiddenFrames++;
				if (node.hiddenFrames >= this.hysteresis && !node.culled) {
					node.userVisible = obj.visible;
					obj.visible = false;
					node.culled = true;
				}
				if (node.culled) occluded++;
			}
		}
		const s = this.stats;
		s.occluded = occluded; s.visible = visible; s.tested = tested;
		s.cellsFilled = cellsFilled;
		s.ms = _tfNow() - t0;
		return this;
	}

	/**
	 * Сменить разрешение сетки глубин (по умолчанию 128×72).
	 * ДОБАВЛЕНО: раньше gridWidth/gridHeight можно было задать только в
	 * конструкторе, а depthGrid оставался старого размера — подстройка
	 * качества под устройство была невозможна без пересоздания culler'а.
	 * @param {number} w
	 * @param {number} h
	 * @returns {this}
	 */
	setGridSize(w, h) {
		w = Math.max(4, w | 0);
		h = Math.max(4, h | 0);
		if (w === this.gridWidth && h === this.gridHeight) return this;
		this.gridWidth = w;
		this.gridHeight = h;
		this.depthGrid = new Float32Array(w * h);
		return this;
	}

	_showOccludee(node) {
		node.hiddenFrames = 0;
		if (node.culled) {
			node.object.visible = node.userVisible;
			node.culled = false;
		}
	}

	getDepthGrid(out = null) {
		const dst = out !== null && out.length === this.depthGrid.length ? out : new Float32Array(this.depthGrid.length);
		const cam = this.camera;
		const far = cam !== null ? cam.far : 1000;
		for (let i = 0; i < dst.length; i++) {
			const d = this.depthGrid[i];
			dst[i] = d === Infinity ? 1 : Math.min(1, d / far);
		}
		return dst;
	}

	dispose() {
		this.restoreAll();
		this.occluders.length = 0;
		this.occludees.length = 0;
	}
};

const _bvhE1 = new THREE.Vector3();
const _bvhE2 = new THREE.Vector3();

const MeshBVH = class {
	constructor(geometry, options = {}) {
		const pos = geometry.attributes !== undefined ? geometry.attributes.position : null;
		if (pos === undefined || pos === null) throw new Error('MeshBVH: geometry без position-атрибута');
		if (pos.isInterleavedBufferAttribute === true) throw new Error('MeshBVH: interleaved position не поддерживается');
		this.geometry = geometry;
		this.indexed = geometry.index !== null;
		this.triCount = Math.floor((this.indexed ? geometry.index.count : pos.count) / 3);
		this.empty = this.triCount <= 0;
		this.leafSize = Math.max(1, options.leafSize !== undefined ? options.leafSize | 0 : 6);
		const n = this.triCount;
		this.order = new Uint32Array(n);
		for (let i = 0; i < n; i++) this.order[i] = i;
		this.centroids = new Float32Array(n * 3);
		const pa = pos.array;
		const ia = this.indexed ? geometry.index.array : null;
		for (let t = 0; t < n; t++) {
			const i0 = ia !== null ? ia[t * 3] : t * 3;
			const i1 = ia !== null ? ia[t * 3 + 1] : t * 3 + 1;
			const i2 = ia !== null ? ia[t * 3 + 2] : t * 3 + 2;
			this.centroids[t * 3] = (pa[i0 * 3] + pa[i1 * 3] + pa[i2 * 3]) / 3;
			this.centroids[t * 3 + 1] = (pa[i0 * 3 + 1] + pa[i1 * 3 + 1] + pa[i2 * 3 + 1]) / 3;
			this.centroids[t * 3 + 2] = (pa[i0 * 3 + 2] + pa[i1 * 3 + 2] + pa[i2 * 3 + 2]) / 3;
		}
		const cap = Math.max(8, 4 * Math.ceil(n / this.leafSize) + 16);
		this.boxMin = new Float32Array(cap * 3);
		this.boxMax = new Float32Array(cap * 3);
		this.left = new Int32Array(cap).fill(-1);
		this.right = new Int32Array(cap).fill(-1);
		this.start = new Int32Array(cap);
		this.count = new Int32Array(cap);
		this.nodeCount = 0;
		this._stack = new Int32Array(128);
		if (n > 0) this._build(0, n);
	}

	_growStack(need) {
		let st = this._stack;
		if (st.length >= need) return st;
		let n = st.length;
		while (n < need) n *= 2;
		const next = new Int32Array(n);
		next.set(st.subarray(0, Math.min(st.length, need)));
		this._stack = next;
		return next;
	}

	_triBox(t, minOut, maxOut) {
		const pos = this.geometry.attributes.position.array;
		const ia = this.indexed ? this.geometry.index.array : null;
		const tri = this.order[t];
		const i0 = (ia !== null ? ia[tri * 3] : tri * 3) * 3;
		const i1 = (ia !== null ? ia[tri * 3 + 1] : tri * 3 + 1) * 3;
		const i2 = (ia !== null ? ia[tri * 3 + 2] : tri * 3 + 2) * 3;
		minOut[0] = Math.min(pos[i0], pos[i1], pos[i2]);
		minOut[1] = Math.min(pos[i0 + 1], pos[i1 + 1], pos[i2 + 1]);
		minOut[2] = Math.min(pos[i0 + 2], pos[i1 + 2], pos[i2 + 2]);
		maxOut[0] = Math.max(pos[i0], pos[i1], pos[i2]);
		maxOut[1] = Math.max(pos[i0 + 1], pos[i1 + 1], pos[i2 + 1]);
		maxOut[2] = Math.max(pos[i0 + 2], pos[i1 + 2], pos[i2 + 2]);
	}

	_build(from, to) {
		const node = this.nodeCount++;
		const n3 = node * 3;
		const mn = this._bmn !== undefined ? this._bmn : (this._bmn = [0, 0, 0]);
		const mx = this._bmx !== undefined ? this._bmx : (this._bmx = [0, 0, 0]);
		this.boxMin[n3] = Infinity; this.boxMin[n3 + 1] = Infinity; this.boxMin[n3 + 2] = Infinity;
		this.boxMax[n3] = -Infinity; this.boxMax[n3 + 1] = -Infinity; this.boxMax[n3 + 2] = -Infinity;
		for (let t = from; t < to; t++) {
			this._triBox(t, mn, mx);
			if (mn[0] < this.boxMin[n3]) this.boxMin[n3] = mn[0];
			if (mn[1] < this.boxMin[n3 + 1]) this.boxMin[n3 + 1] = mn[1];
			if (mn[2] < this.boxMin[n3 + 2]) this.boxMin[n3 + 2] = mn[2];
			if (mx[0] > this.boxMax[n3]) this.boxMax[n3] = mx[0];
			if (mx[1] > this.boxMax[n3 + 1]) this.boxMax[n3 + 1] = mx[1];
			if (mx[2] > this.boxMax[n3 + 2]) this.boxMax[n3 + 2] = mx[2];
		}
		this.start[node] = from;
		this.count[node] = to - from;
		const n = to - from;
		if (n <= this.leafSize || this.nodeCount + 2 >= this.left.length) {
			this.left[node] = -1;
			this.right[node] = -1;
			return node;
		}
		let cMinX = Infinity, cMinY = Infinity, cMinZ = Infinity;
		let cMaxX = -Infinity, cMaxY = -Infinity, cMaxZ = -Infinity;
		const c = this.centroids;
		for (let t = from; t < to; t++) {
			const tri = this.order[t];
			const x = c[tri * 3], y = c[tri * 3 + 1], z = c[tri * 3 + 2];
			if (x < cMinX) cMinX = x; if (x > cMaxX) cMaxX = x;
			if (y < cMinY) cMinY = y; if (y > cMaxY) cMaxY = y;
			if (z < cMinZ) cMinZ = z; if (z > cMaxZ) cMaxZ = z;
		}
		const ex = cMaxX - cMinX, ey = cMaxY - cMinY, ez = cMaxZ - cMinZ;
		let axis, cMin, cMax;
		if (ex >= ey && ex >= ez) { axis = 0; cMin = cMinX; cMax = cMaxX; }
		else if (ey >= ez) { axis = 1; cMin = cMinY; cMax = cMaxY; }
		else { axis = 2; cMin = cMinZ; cMax = cMaxZ; }
		const extent = cMax - cMin;
		if (extent <= 1e-9) {
			this.left[node] = -1;
			this.right[node] = -1;
			return node;
		}
		const NB = 12;
		const bCount = this._bCount !== undefined ? this._bCount : (this._bCount = new Int32Array(NB));
		bCount.fill(0);
		const invExt = NB / extent;
		for (let t = from; t < to; t++) {
			const tri = this.order[t];
			let b = ((c[tri * 3 + axis] - cMin) * invExt) | 0;
			if (b >= NB) b = NB - 1;
			if (b < 0) b = 0;
			bCount[b]++;
		}
		const half = n * 0.5;
		let splitBucket = -1, acc = 0, bestDiff = Infinity;
		for (let b = 0; b < NB - 1; b++) {
			acc += bCount[b];
			if (acc === 0 || acc === n) continue;
			const diff = Math.abs(acc - half);
			if (diff < bestDiff) { bestDiff = diff; splitBucket = b; }
		}
		if (splitBucket === -1) {
			this.left[node] = -1;
			this.right[node] = -1;
			return node;
		}
		let lo = from, hi = to - 1;
		while (lo <= hi) {
			const tri = this.order[lo];
			let b = ((c[tri * 3 + axis] - cMin) * invExt) | 0;
			if (b >= NB) b = NB - 1;
			if (b < 0) b = 0;
			if (b <= splitBucket) lo++;
			else {
				this.order[lo] = this.order[hi];
				this.order[hi] = tri;
				hi--;
			}
		}
		if (lo === from || lo === to) {
			this.left[node] = -1;
			this.right[node] = -1;
			return node;
		}
		this.left[node] = this._build(from, lo);
		this.right[node] = this._build(lo, to);
		return node;
	}

	_rayBox(ox, oy, oz, dx, dy, dz, node, best) {
		const n3 = node * 3;
		let tmin = 0, tmax = best;
		let invD = 1 / dx;
		let t1 = (this.boxMin[n3] - ox) * invD;
		let t2 = (this.boxMax[n3] - ox) * invD;
		if (invD < 0) { const tt = t1; t1 = t2; t2 = tt; }
		if (t1 > tmin) tmin = t1;
		if (t2 < tmax) tmax = t2;
		if (tmin > tmax) return -1;
		invD = 1 / dy;
		t1 = (this.boxMin[n3 + 1] - oy) * invD;
		t2 = (this.boxMax[n3 + 1] - oy) * invD;
		if (invD < 0) { const tt = t1; t1 = t2; t2 = tt; }
		if (t1 > tmin) tmin = t1;
		if (t2 < tmax) tmax = t2;
		if (tmin > tmax) return -1;
		invD = 1 / dz;
		t1 = (this.boxMin[n3 + 2] - oz) * invD;
		t2 = (this.boxMax[n3 + 2] - oz) * invD;
		if (invD < 0) { const tt = t1; t1 = t2; t2 = tt; }
		if (t1 > tmin) tmin = t1;
		if (t2 < tmax) tmax = t2;
		if (tmin > tmax) return -1;
		return tmin;
	}

	raycast(origin, direction, maxDistance = Infinity) {
		const ox = origin.x, oy = origin.y, oz = origin.z;
		const dx = direction.x, dy = direction.y, dz = direction.z;
		if (dx === 0 && dy === 0 && dz === 0) return null;
		if (this.empty === true || this.nodeCount === 0) return null;
		let best = maxDistance;
		let bestFace = -1, bestU = 0, bestV = 0;
		let stack = this._stack;
		let sp = 0;
		stack[sp++] = 0;
		const pos = this.geometry.attributes.position.array;
		const ia = this.indexed ? this.geometry.index.array : null;
		while (sp > 0) {
			const node = stack[--sp];
			const tEntry = this._rayBox(ox, oy, oz, dx, dy, dz, node, best);
			if (tEntry < 0) continue;
			if (this.left[node] === -1) {
				const s = this.start[node], cnt = this.count[node];
				for (let t = s; t < s + cnt; t++) {
					const tri = this.order[t];
					const a = (ia !== null ? ia[tri * 3] : tri * 3) * 3;
					const b = (ia !== null ? ia[tri * 3 + 1] : tri * 3 + 1) * 3;
					const cc = (ia !== null ? ia[tri * 3 + 2] : tri * 3 + 2) * 3;
					const e1x = pos[b] - pos[a], e1y = pos[b + 1] - pos[a + 1], e1z = pos[b + 2] - pos[a + 2];
					const e2x = pos[cc] - pos[a], e2y = pos[cc + 1] - pos[a + 1], e2z = pos[cc + 2] - pos[a + 2];
					const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
					const det = e1x * px + e1y * py + e1z * pz;
					if (det > -1e-10 && det < 1e-10) continue;
					const invDet = 1 / det;
					const sx = ox - pos[a], sy = oy - pos[a + 1], sz = oz - pos[a + 2];
					const u = (sx * px + sy * py + sz * pz) * invDet;
					if (u < 0 || u > 1) continue;
					const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
					const v = (dx * qx + dy * qy + dz * qz) * invDet;
					if (v < 0 || u + v > 1) continue;
					const tt = (e2x * qx + e2y * qy + e2z * qz) * invDet;
					if (tt > 1e-6 && tt < best) {
						best = tt; bestFace = tri; bestU = u; bestV = v;
					}
				}
			} else {
				const l = this.left[node], r = this.right[node];
				const tl = this._rayBox(ox, oy, oz, dx, dy, dz, l, best);
				const tr = this._rayBox(ox, oy, oz, dx, dy, dz, r, best);
				if (sp + 2 > stack.length) stack = this._growStack(sp + 2);
				if (tl >= 0 && tr >= 0) {
					if (tl <= tr) { stack[sp++] = r; stack[sp++] = l; }
					else { stack[sp++] = l; stack[sp++] = r; }
				} else if (tl >= 0) {
					stack[sp++] = l;
				} else if (tr >= 0) {
					stack[sp++] = r;
				}
			}
		}
		if (bestFace === -1) return null;
		return { distance: best, faceIndex: bestFace, u: bestU, v: bestV, point: null, normal: null };
	}

	resolveHit(hit, wantNormal = true) {
		if (hit === null) return null;
		const pos = this.geometry.attributes.position.array;
		const ia = this.indexed ? this.geometry.index.array : null;
		const tri = hit.faceIndex;
		const a = (ia !== null ? ia[tri * 3] : tri * 3) * 3;
		const b = (ia !== null ? ia[tri * 3 + 1] : tri * 3 + 1) * 3;
		const cc = (ia !== null ? ia[tri * 3 + 2] : tri * 3 + 2) * 3;
		const w0 = 1 - hit.u - hit.v;
		if (hit.point === null) hit.point = new THREE.Vector3();
		hit.point.set(
			pos[a] * w0 + pos[b] * hit.u + pos[cc] * hit.v,
			pos[a + 1] * w0 + pos[b + 1] * hit.u + pos[cc + 1] * hit.v,
			pos[a + 2] * w0 + pos[b + 2] * hit.u + pos[cc + 2] * hit.v
		);
		if (wantNormal) {
			_bvhE1.set(pos[b] - pos[a], pos[b + 1] - pos[a + 1], pos[b + 2] - pos[a + 2]);
			_bvhE2.set(pos[cc] - pos[a], pos[cc + 1] - pos[a + 1], pos[cc + 2] - pos[a + 2]);
			if (hit.normal === null) hit.normal = new THREE.Vector3();
			hit.normal.crossVectors(_bvhE1, _bvhE2).normalize();
		}
		return hit;
	}
};

const _rmInv = new THREE.Matrix4();
const _rmOrigin = new THREE.Vector3();
const _rmDir = new THREE.Vector3();
const _rmNormalMat = new THREE.Matrix3();

function raycastMesh(mesh, bvh, origin, direction, maxDistance = Infinity) {
	mesh.updateWorldMatrix(true, false);
	_rmInv.copy(mesh.matrixWorld).invert();
	_rmOrigin.copy(origin).applyMatrix4(_rmInv);
	_rmDir.copy(direction).add(origin).applyMatrix4(_rmInv).sub(_rmOrigin);
	const hit = bvh.raycast(_rmOrigin, _rmDir, maxDistance);
	if (hit === null) return null;
	bvh.resolveHit(hit);
	hit.point.applyMatrix4(mesh.matrixWorld);
	_rmNormalMat.getNormalMatrix(mesh.matrixWorld);
	hit.normal.applyMatrix3(_rmNormalMat).normalize();
	return hit;
}

let key_counter = 0;

const _sbV = new THREE.Vector3();
const _sbN = new THREE.Vector3();
const _sbNM = new THREE.Matrix3();
const _sbColor = new THREE.Color();
const _sbIdentity = new THREE.Matrix4();

const StaticBatcher = {
	/**
	 * Слить набор `{geometry, matrix, color?}` в массив `BufferGeometry`.
	 *
	 * Авторазбиение по `maxVertices` (Uint16-индекс), `useUint32: true` — один меш.
	 * Атрибуты: position (трансформирован `matrix`), normal (`normalMatrix` +
	 * ренормализация), uv, color (vertexColor × `item.color`). Смешанные наборы
	 * атрибутов заполняются нейтрально: normal = (0,1,0), uv = (0,0), color = (1,1,1).
	 *
	 * ИСПРАВЛЕНО (P3): прежняя версия писала данные через `Array.push` по одному
	 * числу — на 100k вершин это ~2.4 млн push'ов с ростом ordinary-массива и
	 * последующей конверсией в Float32Array. Теперь два прохода: сначала план
	 * (размеры и разбиение на чанки), затем запись сразу в предвыделенные
	 * типизированные массивы. Порядок вершин и результат идентичны прежним.
	 *
	 * @param {Array<{geometry:THREE.BufferGeometry, matrix:THREE.Matrix4, color?:THREE.ColorRepresentation}>} items
	 * @param {{maxVertices?:number, useUint32?:boolean, vertexColors?:boolean}} [options]
	 * @returns {THREE.BufferGeometry[]}
	 */
	mergeGeometries(items, options = {}) {
		const maxVertices = options.maxVertices !== undefined ? options.maxVertices : 65000;
		const useUint32 = options.useUint32 === true;
		const anyColor = options.vertexColors === true || items.some(it =>
			(it.color !== undefined && it.color !== null) ||
			(it.geometry.attributes !== undefined && it.geometry.attributes.color !== undefined));

		const plan = [];
		let cur = null;
		for (let it = 0; it < items.length; it++) {
			const item = items[it];
			const geo = item.geometry;
			const posAttr = geo.attributes !== undefined ? geo.attributes.position : undefined;
			if (posAttr === undefined || posAttr === null) continue;
			if (posAttr.isInterleavedBufferAttribute === true) {
				console.warn('ThreeForge: StaticBatcher — interleaved geometry пропущена');
				continue;
			}
			const n = posAttr.count;
			const idx = geo.index;
			const ic = idx !== null ? idx.count : n;
			if (cur === null || (!useUint32 && cur.vcount > 0 && cur.vcount + n > maxVertices)) {
				cur = { entries: [], vcount: 0, icount: 0 };
				plan.push(cur);
			}
			const hasTint = item.color !== undefined && item.color !== null;
			const t = hasTint ? _sbColor.set(item.color) : null;
			cur.entries.push({
				n, ic, base: cur.vcount,
				pos: posAttr.array,
				nrm: geo.attributes.normal !== undefined ? geo.attributes.normal.array : null,
				uv: geo.attributes.uv !== undefined ? geo.attributes.uv.array : null,
				uvCount: geo.attributes.uv !== undefined ? geo.attributes.uv.itemSize : 2,
				col: geo.attributes.color !== undefined ? geo.attributes.color.array : null,
				ia: idx !== null ? idx.array : null,
				matrix: (item.matrix !== undefined && item.matrix !== null) ? item.matrix : _sbIdentity,
				tr: hasTint ? t.r : 1, tg: hasTint ? t.g : 1, tb: hasTint ? t.b : 1
			});
			cur.vcount += n;
			cur.icount += ic;
		}

		const out = [];
		for (let c = 0; c < plan.length; c++) {
			const chunk = plan[c];
			if (chunk.vcount === 0) continue;
			const positions = new Float32Array(chunk.vcount * 3);
			const normals = new Float32Array(chunk.vcount * 3);
			const uvs = new Float32Array(chunk.vcount * 2);
			const colors = anyColor ? new Float32Array(chunk.vcount * 3) : null;
			const index = chunk.vcount > 65535 ? new Uint32Array(chunk.icount) : new Uint16Array(chunk.icount);

			let iBase = 0;
			for (let e = 0; e < chunk.entries.length; e++) {
				const en = chunk.entries[e];
				const m = en.matrix;
				const base = en.base;
				const n = en.n;
				const pa = en.pos, na = en.nrm, ua = en.uv, ca = en.col;
				const tr = en.tr, tg = en.tg, tb = en.tb;
				_sbNM.getNormalMatrix(m);
				for (let v = 0; v < n; v++) {
					const src = v * 3;
					const dst = (base + v) * 3;
					_sbV.set(pa[src], pa[src + 1], pa[src + 2]).applyMatrix4(m);
					positions[dst] = _sbV.x;
					positions[dst + 1] = _sbV.y;
					positions[dst + 2] = _sbV.z;
					if (na !== null) {
						_sbN.set(na[src], na[src + 1], na[src + 2]).applyMatrix3(_sbNM).normalize();
					} else {
						_sbN.set(0, 1, 0);
					}
					normals[dst] = _sbN.x;
					normals[dst + 1] = _sbN.y;
					normals[dst + 2] = _sbN.z;
					const dstUv = (base + v) * 2;
					if (ua !== null) {
						uvs[dstUv] = ua[v * 2];
						uvs[dstUv + 1] = ua[v * 2 + 1];
					}
					if (colors !== null) {
						let r = tr, g = tg, b = tb;
						if (ca !== null) { r *= ca[src]; g *= ca[src + 1]; b *= ca[src + 2]; }
						colors[dst] = r; colors[dst + 1] = g; colors[dst + 2] = b;
					}
				}
				const ia = en.ia;
				if (ia === null) {
					for (let i = 0; i < n; i++) index[iBase + i] = base + i;
				} else {
					for (let i = 0; i < en.ic; i++) index[iBase + i] = base + ia[i];
				}
				iBase += en.ic;
			}

			const g = new THREE.BufferGeometry();
			g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
			g.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
			g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
			if (colors !== null) g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
			g.setIndex(new THREE.BufferAttribute(index, 1));
			g.computeBoundingSphere();
			g.computeBoundingBox();
			out.push(g);
		}
		return out;
	},

	batchByMaterial(objects, options = {}) {
		const parent = options.parent !== undefined ? options.parent : null;
		const removeOriginals = options.removeOriginals !== false;
		const groups = new Map();
		const batched = [];
		for (const obj of objects) {
			if (obj.geometry === undefined || obj.material === undefined) continue;
			if (obj.isInstancedMesh === true || obj.isSkinnedMesh === true) {
				console.warn('ThreeForge: StaticBatcher — ' + (obj.name || obj.type) +
					' пропущен (InstancedMesh/SkinnedMesh не подлежат статическому батчингу)');
				continue;
			}
			const override = options.materialOverride !== undefined && options.materialOverride !== null
				? options.materialOverride : null;
			if (override === null && Array.isArray(obj.material)) {
				console.warn('ThreeForge: StaticBatcher — ' + (obj.name || obj.type) +
					' пропущен (мульти-материал; передайте materialOverride или разбейте меши по материалам)');
				continue;
			}
			const mat = override !== null ? override : obj.material;
			const key = mat.uuid !== undefined ? mat.uuid : 'mat#' + (key_counter++);
			let g = groups.get(key);
			if (g === undefined) { g = { material: mat, items: [] }; groups.set(key, g); }
			g.items.push({ geometry: obj.geometry, matrix: obj.matrixWorld.clone() });
			batched.push(obj);
		}
		const meshes = [];
		for (const g of groups.values()) {
			const geos = StaticBatcher.mergeGeometries(g.items, options);
			for (const geo of geos) {
				const mesh = new THREE.Mesh(geo, g.material);
				mesh.castShadow = options.castShadow !== false;
				mesh.receiveShadow = options.receiveShadow !== false;
				if (parent !== null) parent.add(mesh);
				meshes.push(mesh);
			}
		}
		if (removeOriginals) {
			for (const obj of batched) {
				if (obj.parent !== null) obj.parent.remove(obj);
			}
		}
		return meshes;
	}
};

function buildTerrainWorkerSource(palette = null) {
	let P = palette !== null && palette !== undefined ? palette : {
		sand: [TERRAIN_SAND.r, TERRAIN_SAND.g, TERRAIN_SAND.b],
		snow: [TERRAIN_SNOW.r, TERRAIN_SNOW.g, TERRAIN_SNOW.b],
		rock: [TERRAIN_ROCK.r, TERRAIN_ROCK.g, TERRAIN_ROCK.b],
		grassA: [TERRAIN_GRASS_A.r, TERRAIN_GRASS_A.g, TERRAIN_GRASS_A.b],
		grassB: [TERRAIN_GRASS_B.r, TERRAIN_GRASS_B.g, TERRAIN_GRASS_B.b]
	};
	const PAL_KEYS = ['sand', 'snow', 'rock', 'grassA', 'grassB'];
	if (palette !== null && palette !== undefined && typeof palette === 'object' && !Array.isArray(palette)) {
		const copy = {};
		for (const k of PAL_KEYS) copy[k] = palette[k];
		P = copy;
	} else if (palette !== null && palette !== undefined) {
		console.warn('ThreeForge: buildTerrainWorkerSource — palette должен быть объектом ' +
			'{sand,snow,rock,grassA,grassB} (например terrain._palRGB); взяты цвета по умолчанию.');
	}
	if (palette !== null && palette !== undefined) {
		for (const k of PAL_KEYS) {
			const v = P[k];
			const okArr = Array.isArray(v) && v.length >= 3 && Number.isFinite(v[0]) && Number.isFinite(v[1]) && Number.isFinite(v[2]);
			const okObj = v !== null && typeof v === 'object' && Number.isFinite(v.r) && Number.isFinite(v.g) && Number.isFinite(v.b);
			if (!okArr && !okObj) {
				console.warn('ThreeForge: buildTerrainWorkerSource — палитра.' + k +
					' не похожа на [r,g,b]/{r,g,b}; взят цвет по умолчанию. Ожидаемый формат: terrain._palRGB.');
				const def = { sand: [TERRAIN_SAND.r, TERRAIN_SAND.g, TERRAIN_SAND.b],
					snow: [TERRAIN_SNOW.r, TERRAIN_SNOW.g, TERRAIN_SNOW.b],
					rock: [TERRAIN_ROCK.r, TERRAIN_ROCK.g, TERRAIN_ROCK.b],
					grassA: [TERRAIN_GRASS_A.r, TERRAIN_GRASS_A.g, TERRAIN_GRASS_A.b],
					grassB: [TERRAIN_GRASS_B.r, TERRAIN_GRASS_B.g, TERRAIN_GRASS_B.b] }[k];
				P[k] = def;
			}
		}
	}
	const palJSON = (c) => Array.isArray(c) ? '{r:' + c[0] + ',g:' + c[1] + ',b:' + c[2] + '}' : '{r:' + c.r + ',g:' + c.g + ',b:' + c.b + '}';
	return [
		'/* ThreeForge terrain worker — сгенерирован из классов движка (toString) */',
		'const SIMPLEX_GRAD3 = new Float32Array(' + JSON.stringify(Array.from(SIMPLEX_GRAD3)) + ');',
		'const SIMPLEX_F2 = ' + SIMPLEX_F2 + ';',
		'const SIMPLEX_G2 = ' + SIMPLEX_G2 + ';',
		'const TERRAIN_SAND = ' + palJSON(P.sand) + ';',
		'const TERRAIN_SNOW = ' + palJSON(P.snow) + ';',
		'const TERRAIN_ROCK = ' + palJSON(P.rock) + ';',
		'const TERRAIN_GRASS_A = ' + palJSON(P.grassA) + ';',
		'const TERRAIN_GRASS_B = ' + palJSON(P.grassB) + ';',
		'const createPRNG = ' + createPRNG.toString() + ';',
		'const SimplexNoise = ' + SimplexNoise.toString() + ';',
		'const fbm = ' + fbm.toString() + ';',
		'const Terrain = ' + Terrain.toString() + ';',
		'let __terrain = null;',
		'self.onmessage = function ( e ) {',
		'	const msg = e.data;',
		'	if ( msg.cmd === "init" ) {',
		'		__terrain = new Terrain( msg.params );',
		'		self.postMessage( { id: msg.id, cmd: "ready" } );',
		'	} else if ( msg.cmd === "build" ) {',
		'		try {',
		'			const a = __terrain.buildChunkArrays( msg.chunkX, msg.chunkZ, msg.size, msg.segments, { skirt: msg.skirt, stitch: msg.stitch } );',
		'			self.postMessage( {',
		'				id: msg.id, cmd: "built", chunkX: msg.chunkX, chunkZ: msg.chunkZ,',
		'				arrays: { positions: a.positions, normals: a.normals, colors: a.colors, uvs: a.uvs, index: a.index }',
		'			}, [ a.positions.buffer, a.normals.buffer, a.colors.buffer, a.uvs.buffer, a.index.buffer ] );',
		'		} catch ( err ) {',
		'			self.postMessage( { id: msg.id, cmd: "error", error: String( ( err && err.message ) || err ) } );',
		'		}',
		'	}',
		'};'
	].join('\n');
}

const _tsKey = (cx, cz) => cx + ',' + cz;

const TerrainStreamer = class extends THREE.EventDispatcher {
	constructor(options = {}) {
		super();
		this.terrain = options.terrain;
		if (this.terrain === undefined || this.terrain === null) throw new Error('TerrainStreamer: нужен terrain');
		this.parent = options.parent !== null && options.parent !== undefined ? options.parent : null;
		this.material = options.material;
		this.chunkSize = options.chunkSize !== undefined ? options.chunkSize : 64;
		this.viewDistance = options.viewDistance !== undefined ? options.viewDistance : 5;
		this.lodRings = options.lodRings !== undefined ? options.lodRings : [
			{ maxDist: 1, segments: 48 },
			{ maxDist: 3, segments: 24 },
			{ maxDist: 5, segments: 12 }
		];
		this.skirtCells = options.skirtCells !== undefined ? options.skirtCells : 2.5;
		this.budgetMs = options.budgetMs !== undefined ? options.budgetMs : 4;
		this.workers = options.workers !== undefined ? options.workers : 0;
		this.maxInFlight = options.maxInFlight !== undefined ? options.maxInFlight : Math.max(2, this.workers * 2);
		this.workerTimeoutMs = options.workerTimeoutMs !== undefined ? options.workerTimeoutMs : 30000;
		this.focus = options.focus || null;
		this.focusPosition = new THREE.Vector3();
		this.yOffset = options.yOffset !== undefined ? options.yOffset : 0;
		this.onChunkBuilt = options.onChunkBuilt || null;
		this.onChunkRemoved = options.onChunkRemoved || null;

		this.chunks = new Map();
		this._queue = [];
		this._inFlight = new Map();
		this._reqId = 1;
		this._workerPool = [];
		this._workerUrl = null;
		this.stats = { built: 0, removed: 0, queued: 0, inFlight: 0, lastBuildMs: 0, chunks: 0 };
		this._lastCenter = null;
		this._disposed = false;
		this._neededSet = null;
		this._queuedKeys = new Map();

		if (this.workers > 0) this._initWorkers();
	}

	_segmentsForRing(ring) {
		const rings = this.lodRings;
		for (let i = 0; i < rings.length; i++) {
			if (ring <= rings[i].maxDist) return rings[i].segments | 0;
		}
		return rings[rings.length - 1].segments | 0;
	}

	_initWorkers() {
		if (typeof Worker === 'undefined' || typeof Blob === 'undefined' || typeof URL === 'undefined' ||
			URL.createObjectURL === undefined) {
			console.warn('ThreeForge: TerrainStreamer — Web Worker недоступен, переход на sync-сборку');
			this.workers = 0;
			return;
		}
		const source = buildTerrainWorkerSource(this.terrain._palRGB);
		this._workerUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
		const params = {
			seed: this.terrain.seed,
			scale: this.terrain.scale,
			amplitude: this.terrain.amplitude,
			octaves: this.terrain.octaves,
			ridgeMix: this.terrain.ridgeMix,
			waterLevel: this.terrain.waterLevel,
			palette: this.terrain._palRGB
		};
		for (let i = 0; i < this.workers; i++) {
			let w;
			try {
				w = new Worker(this._workerUrl);
			} catch (err) {
				// F2: Chrome на file:// бросает синхронный SecurityError для blob-воркеров
				console.warn('ThreeForge: TerrainStreamer — Worker недоступен (' + ((err && err.message) || err) + '), переход на sync-сборку');
				this.workers = 0;
				break;
			}
			const entry = { worker: w, busy: false, ready: false, failed: false };
			w.onmessage = (e) => this._onWorkerMessage(entry, e.data);
			w.onerror = (e) => {
				console.warn('ThreeForge: TerrainStreamer worker error:', (e && e.message) || e);
				entry.busy = false;
				entry.failed = true;
				for (const [id, req] of this._inFlight) {
					if (req.entry === entry) {
						this._inFlight.delete(id);
						if (req.cmd === 'build' && req.job !== undefined) {
							this._enqueue(req.job.cx, req.job.cz, req.job.seg, req.job.prio);
						}
					}
				}
			};
			const id = this._reqId++;
			this._inFlight.set(id, { cmd: 'init', entry, t0: _tfNow() });
			w.postMessage({ id, cmd: 'init', params });
			this._workerPool.push(entry);
		}
	}

	_checkWorkerHealth() {
		if (this._workerPool.length === 0) {
			this.workers = 0;
			return false;
		}
		let anyAlive = false;
		for (const w of this._workerPool) {
			if (!w.failed) { anyAlive = true; break; }
		}
		if (!anyAlive) {
			console.warn('ThreeForge: TerrainStreamer — все воркеры недоступны, переход на sync-сборку');
			for (const w of this._workerPool) w.worker.terminate();
			this._workerPool.length = 0;
			this.workers = 0;
			return false;
		}
		return true;
	}

	_freeWorker() {
		for (let i = 0; i < this._workerPool.length; i++) {
			const w = this._workerPool[i];
			if (w.ready && !w.busy && !w.failed) return w;
		}
		return null;
	}

	_dispatchWorker(job) {
		const w = this._freeWorker();
		if (w === null) return false;
		const id = this._reqId++;
		w.busy = true;
		this._inFlight.set(id, { cmd: 'build', entry: w, job, t0: _tfNow() });
		w.worker.postMessage({
			id, cmd: 'build',
			chunkX: job.cx, chunkZ: job.cz,
			size: this.chunkSize, segments: job.seg,
			skirt: job.skirt, stitch: job.stitch
		});
		return true;
	}

	_expireStaleRequests(now) {
		const timeout = this.workerTimeoutMs;
		if (!(timeout > 0) || this._inFlight.size === 0) return;
		for (const [id, req] of this._inFlight) {
			if (now - req.t0 < timeout) continue;
			this._inFlight.delete(id);
			const entry = req.entry;
			if (entry !== undefined && entry.failed !== true) {
				console.warn('ThreeForge: TerrainStreamer — воркер не ответил за ' +
					timeout + 'мс (' + req.cmd + '), помечен неисправным; задание переставлено в очередь.');
				entry.failed = true;
				entry.busy = false;
				try { entry.worker.terminate(); } catch { }
			}
			if (req.cmd === 'build' && req.job !== undefined) {
				this._enqueue(req.job.cx, req.job.cz, req.job.seg, req.job.prio);
			}
		}
	}

	_onWorkerMessage(entry, msg) {
		const req = this._inFlight.get(msg.id);
		if (req === undefined) return;
		this._inFlight.delete(msg.id);
		if (req.cmd === 'init') {
			entry.ready = msg.cmd === 'ready';
			entry.busy = false;
			return;
		}
		entry.busy = false;
		if (msg.cmd === 'built') {
			this._assemble(msg.chunkX, msg.chunkZ, req.job.seg, msg.arrays);
		} else {
			console.warn('ThreeForge: TerrainStreamer — воркер не собрал чанк:', msg.error);
		}
	}

	_updateFocus() {
		const f = this.focus;
		if (f === null) return;
		if (f.isObject3D === true) f.getWorldPosition(this.focusPosition);
		else this.focusPosition.copy(f);
	}

	update() {
		if (this._disposed === true) return this;
		this._expireStaleRequests(_tfNow());
		this._updateFocus();
		const fp = this.focusPosition;
		const size = this.chunkSize;
		const ccx = Math.floor(fp.x / size);
		const ccz = Math.floor(fp.z / size);
		const centerChanged = this._lastCenter === null || this._lastCenter.x !== ccx || this._lastCenter.z !== ccz;
		if (this._lastCenter === null) this._lastCenter = { x: ccx, z: ccz };
		else { this._lastCenter.x = ccx; this._lastCenter.z = ccz; }

		const R = this.viewDistance;
		if (this._neededSet === null || this._neededSet === undefined) this._neededSet = new Set();
		const needed = this._neededSet;
		needed.clear();

		if (centerChanged || this.chunks.size === 0) {
			for (let dz = -R; dz <= R; dz++) {
				for (let dx = -R; dx <= R; dx++) {
					const cx = ccx + dx, cz = ccz + dz;
					const ring = Math.max(Math.abs(dx), Math.abs(dz));
					const seg = this._segmentsForRing(ring);
					const key = _tsKey(cx, cz);
					needed.add(key);
					const existing = this.chunks.get(key);
					if (existing !== undefined) {
						if (existing.seg === seg && existing.state !== 'removed') continue;
						existing.stale = true;
					}
					this._enqueue(cx, cz, seg, ring);
				}
			}
			for (const [key, chunk] of this.chunks) {
				if (needed.has(key)) continue;
				if (Math.max(Math.abs(chunk.cx - ccx), Math.abs(chunk.cz - ccz)) > R + 1) {
					this._removeChunk(key, chunk);
				}
			}
		}

		this._queue.sort((a, b) => a.prio - b.prio);
		this.stats.queued = this._queue.length;

		const t0 = _tfNow();
		let builtThisFrame = 0;
		let guard = this._queue.length + this._inFlight.size + 8;
		while (this._queue.length > 0 && guard-- > 0) {
			if (this.workers > 0 && this._checkWorkerHealth()) {
				if (this._countBuildsInFlight() >= this.maxInFlight) break;
				const w = this._freeWorker();
				if (w === null) break;
				const job = this._dequeue();
				if (!this._jobStillNeeded(job)) continue;
				this._prepareJob(job);
				this._dispatchWorker(job);
				continue;
			}
			if (_tfNow() - t0 > this.budgetMs && builtThisFrame > 0) break;
			const job = this._dequeue();
			if (!this._jobStillNeeded(job)) continue;
			this._prepareJob(job);
			this._buildSync(job);
			builtThisFrame++;
			if (_tfNow() - t0 > this.budgetMs) break;
		}
		this.stats.inFlight = this._countBuildsInFlight();
		this.stats.chunks = this.chunks.size;
		this.stats.queued = this._queue.length;
		return this;
	}

	_countBuildsInFlight() {
		let n = 0;
		for (const req of this._inFlight.values()) if (req.cmd === 'build') n++;
		return n;
	}

	_enqueue(cx, cz, seg, ring) {
		const key = _tsKey(cx, cz);
		if (this._jobInFlight(cx, cz, seg)) return;
		const queued = this._queuedKeys.get(key);
		if (queued !== undefined) {
			if (queued.seg === seg) return;
			queued.seg = seg;
			queued.prio = ring;
			return;
		}
		const job = { cx, cz, seg, prio: ring, key, skirt: 0, stitch: null };
		this._queue.push(job);
		this._queuedKeys.set(key, job);
	}

	_dequeue() {
		const job = this._queue.shift();
		if (job !== undefined && this._queuedKeys.get(job.key) === job) this._queuedKeys.delete(job.key);
		return job;
	}

	_jobInFlight(cx, cz, seg) {
		for (const req of this._inFlight.values()) {
			if (req.cmd === 'build' && req.job.cx === cx && req.job.cz === cz && req.job.seg === seg) return true;
		}
		return false;
	}

	_jobStillNeeded(job) {
		const existing = this.chunks.get(job.key);
		if (existing !== undefined && existing.seg === job.seg && !existing.stale) return false;
		return true;
	}

	_prepareJob(job) {
		const step = this.chunkSize / job.seg;
		job.skirt = step * this.skirtCells;
		const fp = this.focusPosition;
		const size = this.chunkSize;
		const ccx = Math.floor(fp.x / size);
		const ccz = Math.floor(fp.z / size);
		const ringOf = (cx, cz) => Math.max(Math.abs(cx - ccx), Math.abs(cz - ccz));
		const segN = this._segmentsForRing(ringOf(job.cx, job.cz + 1));
		const segS = this._segmentsForRing(ringOf(job.cx, job.cz - 1));
		const segW = this._segmentsForRing(ringOf(job.cx - 1, job.cz));
		const segE = this._segmentsForRing(ringOf(job.cx + 1, job.cz));
		if (segN !== job.seg || segS !== job.seg || segW !== job.seg || segE !== job.seg) {
			job.stitch = { north: segN, south: segS, west: segW, east: segE };
		} else {
			job.stitch = null;
		}
	}

	_buildSync(job) {
		const t0 = _tfNow();
		const arrays = this.terrain.buildChunkArrays(job.cx, job.cz, this.chunkSize, job.seg,
			{ skirt: job.skirt, stitch: job.stitch });
		this._assemble(job.cx, job.cz, job.seg, arrays);
		this.stats.lastBuildMs = _tfNow() - t0;
	}

	_assemble(cx, cz, seg, arrays) {
		const key = _tsKey(cx, cz);
		const geo = new THREE.BufferGeometry();
		geo.setAttribute('position', new THREE.BufferAttribute(arrays.positions, 3));
		geo.setAttribute('normal', new THREE.BufferAttribute(arrays.normals, 3));
		geo.setAttribute('color', new THREE.BufferAttribute(arrays.colors, 3));
		geo.setAttribute('uv', new THREE.BufferAttribute(arrays.uvs, 2));
		geo.setIndex(new THREE.BufferAttribute(arrays.index, 1));
		geo.computeBoundingSphere();
		const material = typeof this.material === 'function' ? this.material({ cx, cz, seg }) : this.material;
		const mesh = new THREE.Mesh(geo, material);
		mesh.position.set(cx * this.chunkSize, this.yOffset, cz * this.chunkSize);
		mesh.matrixAutoUpdate = false;
		mesh.updateMatrix();
		mesh.receiveShadow = true;
		mesh.name = 'tfTerrainChunk_' + key;
		const old = this.chunks.get(key);
		const chunk = { cx, cz, seg, mesh, state: 'ready', stale: false };
		this.chunks.set(key, chunk);
		if (old !== undefined && old.mesh !== null) {
			if (old.mesh.parent !== null) old.mesh.parent.remove(old.mesh);
			old.mesh.geometry.dispose();
		}
		if (this.parent !== null) this.parent.add(mesh);
		this.stats.built++;
		if (this.onChunkBuilt !== null) this.onChunkBuilt(chunk);
		this.dispatchEvent({ type: 'chunkbuilt', chunk });
	}

	_removeChunk(key, chunk) {
		this.chunks.delete(key);
		if (chunk.mesh !== null) {
			if (chunk.mesh.parent !== null) chunk.mesh.parent.remove(chunk.mesh);
			chunk.mesh.geometry.dispose();
			this.stats.removed++;
			if (this.onChunkRemoved !== null) this.onChunkRemoved(chunk);
			this.dispatchEvent({ type: 'chunkremoved', chunk });
		}
	}

	height(x, z) {
		return this.terrain.height(x, z);
	}

	/**
	 * Гото́вый чанк, накрывающий мировую точку (x, z), либо undefined.
	 * ДОБАВЛЕНО: типичный геймплейный запрос («на каком чанке стоит игрок»,
	 * «какая LOD-сетка сейчас под ногами») раньше требовал ручного _tsKey.
	 */
	getChunkAt(x, z) {
		return this.chunks.get(_tsKey(Math.floor(x / this.chunkSize), Math.floor(z / this.chunkSize)));
	}

	/** Индексы чанка, накрывающего мировую точку. */
	chunkIndexAt(x, z) {
		return { cx: Math.floor(x / this.chunkSize), cz: Math.floor(z / this.chunkSize) };
	}

	forceRebuildAll() {
		for (const chunk of this.chunks.values()) chunk.stale = true;
		const ccx = Math.floor(this.focusPosition.x / this.chunkSize);
		const ccz = Math.floor(this.focusPosition.z / this.chunkSize);
		for (const chunk of this.chunks.values()) {
			const ring = Math.max(Math.abs(chunk.cx - ccx), Math.abs(chunk.cz - ccz));
			this._enqueue(chunk.cx, chunk.cz, this._segmentsForRing(ring), ring);
		}
		this._lastCenter = null;
		return this;
	}

	dispose() {
		this._disposed = true;
		for (const w of this._workerPool) w.worker.terminate();
		this._workerPool.length = 0;
		this.workers = 0;
		if (this._workerUrl !== null && typeof URL !== 'undefined' && URL.revokeObjectURL !== undefined) {
			URL.revokeObjectURL(this._workerUrl);
			this._workerUrl = null;
		}
		for (const [key, chunk] of [...this.chunks]) this._removeChunk(key, chunk);
		this._queue.length = 0;
		this._queuedKeys.clear();
		this._inFlight.clear();
	}
};

const TERRAIN_TEXTURE_KINDS = ['grass', 'rock', 'snow', 'sand', 'dirt', 'gravel'];

const TF_TERRAIN_TEX_STYLE = {
	grass: { amp: 0.20, tint: [0.95, 1.00, 0.90], grain: 0.07, grainMode: 'mix', albedoA: [0.19, 0.31, 0.12], albedoB: [0.41, 0.54, 0.23] },
	rock: { amp: 0.26, tint: [1.00, 0.99, 0.97], grain: 0.05, grainMode: 'mix', albedoA: [0.30, 0.29, 0.27], albedoB: [0.58, 0.56, 0.52] },
	snow: { amp: 0.07, tint: [0.97, 0.99, 1.04], grain: 0.55, grainMode: 'sparkle', albedoA: [0.82, 0.86, 0.94], albedoB: [1.00, 1.00, 1.00] },
	sand: { amp: 0.13, tint: [1.04, 1.00, 0.92], grain: 0.06, grainMode: 'mix', albedoA: [0.70, 0.62, 0.43], albedoB: [0.87, 0.80, 0.61] },
	dirt: { amp: 0.20, tint: [1.03, 0.97, 0.89], grain: 0.06, grainMode: 'mix', albedoA: [0.28, 0.20, 0.13], albedoB: [0.48, 0.37, 0.25] },
	gravel: { amp: 0.24, tint: [1.00, 0.99, 0.95], grain: 0.06, grainMode: 'mix', albedoA: [0.38, 0.37, 0.35], albedoB: [0.64, 0.62, 0.57] }
};

function _tfHash2i(ix, iy, seed) {
	let h = (Math.imul(ix | 0, 374761393) + Math.imul(iy | 0, 668265263) + Math.imul(seed | 0, 1442695041)) | 0;
	h = Math.imul(h ^ (h >>> 13), 1274126177);
	return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const _tfSmooth = (a, b, x) => {
	const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
	return t * t * (3 - 2 * t);
};

function _tfTileValue(x, y, period, seed) {
	const xi = Math.floor(x), yi = Math.floor(y);
	const xf = x - xi, yf = y - yi;
	const ux = xf * xf * (3 - 2 * xf);
	const uy = yf * yf * (3 - 2 * yf);
	const wx = ((xi % period) + period) % period;
	const wy = ((yi % period) + period) % period;
	const wx1 = (wx + 1) % period;
	const wy1 = (wy + 1) % period;
	const a = _tfHash2i(wx, wy, seed), b = _tfHash2i(wx1, wy, seed);
	const c = _tfHash2i(wx, wy1, seed), d = _tfHash2i(wx1, wy1, seed);
	const top = a + (b - a) * ux;
	const bot = c + (d - c) * ux;
	return top + (bot - top) * uy;
}

function _tfTileFbm(u, v, cells, octaves, seed, gain = 0.5) {
	let amp = 1, sum = 0, f = cells, norm = 0;
	for (let o = 0; o < octaves; o++) {
		sum += amp * _tfTileValue(u * f, v * f, f, seed + o * 131);
		norm += amp;
		amp *= gain;
		f *= 2;
	}
	return norm > 0 ? sum / norm : 0;
}

function _tfTileRidge(u, v, cells, octaves, seed, gain = 0.5) {
	let amp = 1, sum = 0, f = cells, norm = 0;
	for (let o = 0; o < octaves; o++) {
		const n = _tfTileValue(u * f, v * f, f, seed + o * 131);
		sum += amp * (1 - Math.abs(n * 2 - 1));
		norm += amp;
		amp *= gain;
		f *= 2;
	}
	return norm > 0 ? sum / norm : 0;
}

const _tfVorScratch = { f1: 0, fh: 0, fr: 0 };
function _tfTileVoronoi(u, v, cells, seed) {
	const cx = Math.floor(u * cells), cy = Math.floor(v * cells);
	let f1 = 1e9, fh = 0.5, fr = 0.5;
	for (let oy = -1; oy <= 1; oy++) {
		for (let ox = -1; ox <= 1; ox++) {
			const gx = cx + ox, gy = cy + oy;
			const wx = ((gx % cells) + cells) % cells;
			const wy = ((gy % cells) + cells) % cells;
			const hs = _tfHash2i(wx * 3 + 1, wy * 5 + 2, seed);
			const hr = _tfHash2i(wx * 13 + 7, wy * 17 + 11, seed + 271);
			const px = (wx + 0.15 + 0.7 * hs) / cells;
			const py = (wy + 0.15 + 0.7 * _tfHash2i(wx * 7 + 3, wy * 11 + 5, seed + 77)) / cells;
			let dx = u - px, dy = v - py;
			if (dx > 0.5) dx -= 1; else if (dx < -0.5) dx += 1;
			if (dy > 0.5) dy -= 1; else if (dy < -0.5) dy += 1;
			const d = Math.sqrt(dx * dx + dy * dy);
			if (d < f1) { f1 = d; fh = hs; fr = hr; }
		}
	}
	_tfVorScratch.f1 = f1;
	_tfVorScratch.fh = fh;
	_tfVorScratch.fr = fr;
	return _tfVorScratch;
}

function _tfNormalizeField(field) {
	let min = Infinity, max = -Infinity;
	for (let i = 0; i < field.length; i++) {
		const v = field[i];
		if (v < min) min = v;
		if (v > max) max = v;
	}
	const span = max - min;
	if (span < 1e-9) { field.fill(0.5); return field; }
	const inv = 1 / span;
	for (let i = 0; i < field.length; i++) field[i] = (field[i] - min) * inv;
	return field;
}

function _tfTerrainFields(kind, n, seed) {
	const k = TERRAIN_TEXTURE_KINDS.indexOf(kind) !== -1 ? kind : 'grass';
	const height = new Float32Array(n * n);
	const grain = new Float32Array(n * n);
	const inv = 1 / n;
	for (let y = 0; y < n; y++) {
		const v = (y + 0.5) * inv;
		for (let x = 0; x < n; x++) {
			const u = (x + 0.5) * inv;
			const i = y * n + x;
			let h = 0, g = 0;
			switch (k) {
				case 'grass': {
					const wu = u + (_tfTileFbm(u, v, 4, 2, seed + 11) - 0.5) * 0.14;
					const wv = v + (_tfTileFbm(u, v, 4, 2, seed + 29) - 0.5) * 0.14;
					h = _tfTileFbm(wu, wv, 10, 4, seed) * 0.5
						+ _tfTileFbm(wu, wv * 3, 24, 2, seed + 53) * 0.5;
					g = _tfHash2i(x, y, seed + 911);
					break;
				}
				case 'rock': {
					const r = _tfTileRidge(u, v, 5, 4, seed + 7);
					const c = _tfTileFbm(u, v, 4, 3, seed + 71);
					const crack = 1 - _tfSmooth(0.0, 0.085, Math.abs(c - 0.5));
					h = r * 0.72 + _tfTileFbm(u, v, 22, 3, seed + 17) * 0.2 - crack * 0.45;
					g = _tfHash2i(x, y, seed + 917);
					break;
				}
				case 'snow': {
					h = _tfTileFbm(u, v, 5, 3, seed, 0.42) * 0.75
						+ _tfTileFbm(u, v, 17, 2, seed + 37) * 0.25;
					const s = _tfHash2i(x, y, seed + 997);
					g = s * s * s * s * s * s;
					break;
				}
				case 'sand': {
					const w = _tfTileFbm(u, v, 4, 2, seed + 5);
					const w2 = _tfTileFbm(u, v, 7, 2, seed + 61);
					const TAU = Math.PI * 2;
					const r1 = 0.5 + 0.5 * Math.sin(TAU * (6 * u + 2 * v + 1.1 * (w - 0.5)));
					const r2 = 0.5 + 0.5 * Math.sin(TAU * (9 * u - 3 * v + 0.8 * (w2 - 0.5)));
					h = r1 * 0.55 + r2 * 0.3 + _tfTileFbm(u, v, 34, 2, seed + 83) * 0.15;
					g = _tfHash2i(x, y, seed + 929);
					break;
				}
				case 'dirt': {
					const spots = _tfSmooth(0.52, 0.74, _tfTileFbm(u, v, 5, 2, seed + 3));
					h = _tfTileFbm(u, v, 9, 4, seed) * 0.62
						+ _tfTileFbm(u, v, 28, 2, seed + 43) * 0.28 - spots * 0.35;
					g = _tfHash2i(x, y, seed + 937);
					break;
				}
				case 'gravel':
				default: {
					const vor = _tfTileVoronoi(u, v, 9, seed + 13);
					const d = vor.f1 * 9;
					const rad = 0.30 + 0.55 * vor.fr;
					const pebble = 1 - _tfSmooth(rad * 0.55, rad, d);
					h = pebble * 0.68 + (vor.fh - 0.5) * 0.42 * pebble
						+ _tfTileFbm(u, v, 30, 2, seed + 67) * 0.18;
					g = _tfHash2i(x, y, seed + 941);
					break;
				}
			}
			height[i] = h;
			grain[i] = g;
		}
	}
	_tfNormalizeField(height);
	return { height, grain, kind: k };
}

function tfNormalMapFromHeight(height, size, strength = 2.2) {
	const n = Math.max(2, size | 0);
	const data = new Uint8Array(n * n * 4);
	const s = strength !== undefined ? strength : 2.2;
	for (let y = 0; y < n; y++) {
		const ym = ((y - 1) + n) % n, yp = (y + 1) % n;
		for (let x = 0; x < n; x++) {
			const xm = ((x - 1) + n) % n, xp = (x + 1) % n;
			const hL = height[y * n + xm], hR = height[y * n + xp];
			const hD = height[ym * n + x], hU = height[yp * n + x];
			let nx = (hL - hR) * s, ny = (hD - hU) * s, nz = 1;
			const inv = 1 / (Math.sqrt(nx * nx + ny * ny + nz * nz) || 1);
			nx *= inv; ny *= inv; nz *= inv;
			const o = (y * n + x) * 4;
			data[o] = Math.round((nx * 0.5 + 0.5) * 255);
			data[o + 1] = Math.round((ny * 0.5 + 0.5) * 255);
			data[o + 2] = Math.round((nz * 0.5 + 0.5) * 255);
			data[o + 3] = 255;
		}
	}
	const tex = new DataTexture(data, n, n, RGBAFormat, UnsignedByteType);
	tex.wrapS = tex.wrapT = RepeatWrapping;
	tex.minFilter = LinearMipmapLinearFilter;
	tex.magFilter = LinearFilter;
	tex.generateMipmaps = true;
	tex.needsUpdate = true;
	return tex;
}

function _tfPackRGBA(data, n, srgb, anisotropy) {
	const tex = new DataTexture(data, n, n, RGBAFormat, UnsignedByteType);
	if (srgb === true) tex.colorSpace = SRGBColorSpace;
	tex.wrapS = tex.wrapT = RepeatWrapping;
	tex.minFilter = LinearMipmapLinearFilter;
	tex.magFilter = LinearFilter;
	tex.generateMipmaps = true;
	if (anisotropy > 1) tex.anisotropy = anisotropy;
	tex.needsUpdate = true;
	return tex;
}

/**
 * Процедурная цветовая карта terрейна (тайлящаяся).
 * @param {string} [kind='grass'] Один из TERRAIN_TEXTURE_KINDS.
 * @param {number} [size=256]
 * @param {{seed?:number, mode?:'detail'|'albedo', contrast?:number, anisotropy?:number}} [options]
 *   mode 'detail' (по умолчанию) — яркость вокруг 1.0: карта УМНОЖАЕТСЯ на
 *   vertexColors террейна (палитра Terrain остаётся ведущей);
 *   mode 'albedo' — полноцветная текстура (для материалов без vertexColors).
 * @returns {THREE.DataTexture}
 */
function createTerrainTexture(kind = 'grass', size = 256, options = {}) {
	const n = Math.max(8, size | 0);
	const seed = options.seed !== undefined ? options.seed : 1337;
	const mode = options.mode === 'albedo' ? 'albedo' : 'detail';
	const contrast = options.contrast !== undefined ? options.contrast : 1;
	const anisotropy = options.anisotropy !== undefined ? options.anisotropy : 4;
	const k = TERRAIN_TEXTURE_KINDS.indexOf(kind) !== -1 ? kind : 'grass';
	if (k !== kind) {
		console.warn('ThreeForge: createTerrainTexture — неизвестный вид "' + kind + '", взят "grass". Виды: ' + TERRAIN_TEXTURE_KINDS.join(', '));
	}
	const st = TF_TERRAIN_TEX_STYLE[k];
	const fields = _tfTerrainFields(k, n, seed);
	const data = new Uint8Array(n * n * 4);
	const clamp255 = (v) => (v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255));
	for (let i = 0; i < n * n; i++) {
		const h = 0.5 + (fields.height[i] - 0.5) * contrast;
		const g = fields.grain[i];
		let r, gr, b;
		if (mode === 'detail') {
			let lum = 1 + (h - 0.5) * 2 * st.amp;
			if (st.grainMode === 'sparkle') lum += g * st.grain;
			else lum += (g - 0.5) * st.grain;
			r = lum * st.tint[0]; gr = lum * st.tint[1]; b = lum * st.tint[2];
		} else {
			const A = st.albedoA, B = st.albedoB;
			r = A[0] + (B[0] - A[0]) * h;
			gr = A[1] + (B[1] - A[1]) * h;
			b = A[2] + (B[2] - A[2]) * h;
			if (st.grainMode === 'sparkle') { r += g * 0.35; gr += g * 0.35; b += g * 0.35; }
			else { const m = 0.94 + 0.12 * g; r *= m; gr *= m; b *= m; }
		}
		const o = i * 4;
		data[o] = clamp255(r); data[o + 1] = clamp255(gr); data[o + 2] = clamp255(b); data[o + 3] = 255;
	}
	return _tfPackRGBA(data, n, true, anisotropy);
}

/**
 * Процедурная normal-карта террейна (из того же поля высот, что и цвет —
 * микрорельеф согласован с яркостью).
 * @returns {THREE.DataTexture}
 */
function createTerrainNormalMap(kind = 'grass', size = 256, options = {}) {
	const n = Math.max(8, size | 0);
	const seed = options.seed !== undefined ? options.seed : 1337;
	const k = TERRAIN_TEXTURE_KINDS.indexOf(kind) !== -1 ? kind : 'grass';
	const fields = _tfTerrainFields(k, n, seed);
	const tex = tfNormalMapFromHeight(fields.height, n, options.normalStrength !== undefined ? options.normalStrength : 2.2);
	if (options.anisotropy !== undefined && options.anisotropy > 1) tex.anisotropy = options.anisotropy;
	return tex;
}

/**
 * Комплект «цвет + нормаль» из ОДНОГО прохода генерации (дешевле пары
 * отдельных вызовов: поля высот/зерна считаются один раз).
 * @returns {{map:THREE.DataTexture, normalMap:THREE.DataTexture, height:Float32Array}}
 */
function createTerrainTextureSet(kind = 'grass', size = 256, options = {}) {
	const n = Math.max(8, size | 0);
	const seed = options.seed !== undefined ? options.seed : 1337;
	const mode = options.mode === 'albedo' ? 'albedo' : 'detail';
	const contrast = options.contrast !== undefined ? options.contrast : 1;
	const anisotropy = options.anisotropy !== undefined ? options.anisotropy : 4;
	const k = TERRAIN_TEXTURE_KINDS.indexOf(kind) !== -1 ? kind : 'grass';
	const st = TF_TERRAIN_TEX_STYLE[k];
	const fields = _tfTerrainFields(k, n, seed);
	const data = new Uint8Array(n * n * 4);
	const clamp255 = (v) => (v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255));
	for (let i = 0; i < n * n; i++) {
		const h = 0.5 + (fields.height[i] - 0.5) * contrast;
		const g = fields.grain[i];
		let r, gr, b;
		if (mode === 'detail') {
			let lum = 1 + (h - 0.5) * 2 * st.amp;
			if (st.grainMode === 'sparkle') lum += g * st.grain;
			else lum += (g - 0.5) * st.grain;
			r = lum * st.tint[0]; gr = lum * st.tint[1]; b = lum * st.tint[2];
		} else {
			const A = st.albedoA, B = st.albedoB;
			r = A[0] + (B[0] - A[0]) * h;
			gr = A[1] + (B[1] - A[1]) * h;
			b = A[2] + (B[2] - A[2]) * h;
			if (st.grainMode === 'sparkle') { r += g * 0.35; gr += g * 0.35; b += g * 0.35; }
			else { const m = 0.94 + 0.12 * g; r *= m; gr *= m; b *= m; }
		}
		const o = i * 4;
		data[o] = clamp255(r); data[o + 1] = clamp255(gr); data[o + 2] = clamp255(b); data[o + 3] = 255;
	}
	return {
		map: _tfPackRGBA(data, n, true, anisotropy),
		normalMap: tfNormalMapFromHeight(fields.height, n, options.normalStrength !== undefined ? options.normalStrength : 2.2),
		height: fields.height
	};
}

let _tfWhiteTex1 = null;
let _tfFlatNormalTex4 = null;
function _tfGetWhiteTex() {
	if (_tfWhiteTex1 === null) {
		const d = new Uint8Array([255, 255, 255, 255]);
		_tfWhiteTex1 = new DataTexture(d, 1, 1, RGBAFormat, UnsignedByteType);
		_tfWhiteTex1.colorSpace = SRGBColorSpace;
		_tfWhiteTex1.wrapS = _tfWhiteTex1.wrapT = RepeatWrapping;
		_tfWhiteTex1.needsUpdate = true;
	}
	return _tfWhiteTex1;
}
function _tfGetFlatNormalTex() {
	if (_tfFlatNormalTex4 === null) {
		const d = new Uint8Array(4 * 4);
		for (let i = 0; i < 4; i++) { d[i * 4] = 128; d[i * 4 + 1] = 128; d[i * 4 + 2] = 255; d[i * 4 + 3] = 255; }
		_tfFlatNormalTex4 = new DataTexture(d, 2, 2, RGBAFormat, UnsignedByteType);
		_tfFlatNormalTex4.wrapS = _tfFlatNormalTex4.wrapT = RepeatWrapping;
		_tfFlatNormalTex4.needsUpdate = true;
	}
	return _tfFlatNormalTex4;
}

const TF_TERRAIN_DETAIL_GLSL = `
uniform sampler2D uTfGrassMap;
uniform sampler2D uTfGrassNrm;
uniform sampler2D uTfRockMap;
uniform sampler2D uTfRockNrm;
uniform sampler2D uTfSnowMap;
uniform sampler2D uTfSnowNrm;
uniform sampler2D uTfSandMap;
uniform sampler2D uTfSandNrm;
uniform vec4 uTfTerrainParams;   // (sandEdge, slopeRock, snowStart, snowEnd) — мировой Y
uniform vec4 uTfTerrainParams2;  // (texWorldSize, detail, normalStrength, roughMix)
uniform vec4 uTfTerrainRough;    // roughness слоёв: (grass, rock, snow, sand)
varying vec3 vTfTWorld;
varying vec3 vTfTNrm;

// Веса слоёв — зеркало Terrain._terrainColorRGB с плавными переходами.
// Гарантированно w.x + w.y + w.z + w.w == 1.
vec4 tfTerrainWeights( vec3 wp, vec3 wn ) {
	float h = wp.y;
	float slope = 1.0 - clamp( wn.y, 0.0, 1.0 );
	float sand = 1.0 - smoothstep( uTfTerrainParams.x - 2.5, uTfTerrainParams.x, h );
	float steep = smoothstep( uTfTerrainParams.y - 0.12, uTfTerrainParams.y + 0.12, slope );
	float high = smoothstep( uTfTerrainParams.z - 2.5, uTfTerrainParams.z + 2.5, h );
	float zone = max( steep, high ) * ( 1.0 - sand );
	float tSnow = smoothstep( uTfTerrainParams.z, uTfTerrainParams.w, h );
	float snow = zone * tSnow;
	float rock = zone - snow;
	float grass = max( 0.0, 1.0 - sand - zone );
	return vec4( grass, rock, snow, sand );
}

vec3 tfTerrainDetail( vec3 wp, vec4 w, out vec3 nrmTS ) {
	float s = max( uTfTerrainParams2.x, 0.05 );
	vec2 uvG = wp.xz / s;
	vec2 uvR = wp.xz / ( s * 1.19 ) + 0.37;   // разные масштабы и сдвиги —
	vec2 uvS = wp.xz / ( s * 0.83 ) + 0.71;   // слои не синхронизируются
	vec2 uvA = wp.xz / ( s * 1.07 ) + 0.13;   // в единую сетку
	vec3 cG = texture2D( uTfGrassMap, uvG ).rgb;
	vec3 cR = texture2D( uTfRockMap, uvR ).rgb;
	vec3 cS = texture2D( uTfSnowMap, uvS ).rgb;
	vec3 cA = texture2D( uTfSandMap, uvA ).rgb;
	vec3 nG = texture2D( uTfGrassNrm, uvG ).xyz * 2.0 - 1.0;
	vec3 nR = texture2D( uTfRockNrm, uvR ).xyz * 2.0 - 1.0;
	vec3 nS = texture2D( uTfSnowNrm, uvS ).xyz * 2.0 - 1.0;
	vec3 nA = texture2D( uTfSandNrm, uvA ).xyz * 2.0 - 1.0;
	nrmTS = normalize( nG * w.x + nR * w.y + nS * w.z + nA * w.w + vec3( 0.0, 0.0, 0.3 ) );
	return cG * w.x + cR * w.y + cS * w.z + cA * w.w;
}
`;

const TF_TERRAIN_DETAIL_VERT = `
vec4 tfTW4 = vec4( transformed, 1.0 );
#ifdef USE_INSTANCING
	tfTW4 = instanceMatrix * tfTW4;
#endif
vTfTWorld = ( modelMatrix * tfTW4 ).xyz;
vec3 tfTN0 = objectNormal;
#ifdef USE_INSTANCING
	tfTN0 = mat3( instanceMatrix ) * tfTN0;
#endif
vTfTNrm = normalize( mat3( modelMatrix ) * tfTN0 );
`;

const TF_TERRAIN_DETAIL_COLOR = `
vec4 tfTW = tfTerrainWeights( vTfTWorld, normalize( vTfTNrm ) );
vec3 tfTNormalTS = vec3( 0.0, 0.0, 1.0 );
vec3 tfTDet = tfTerrainDetail( vTfTWorld, tfTW, tfTNormalTS );
diffuseColor.rgb *= mix( vec3( 1.0 ), tfTDet, uTfTerrainParams2.y );
`;

const TF_TERRAIN_DETAIL_ROUGH = `
roughnessFactor = mix( roughnessFactor, dot( uTfTerrainRough, tfTW ), uTfTerrainParams2.w );
`;

const TF_TERRAIN_DETAIL_NORMAL = `
{
	vec3 tfN = normalize( vTfTNrm ) * faceDirection;
	vec3 tfBase = abs( tfN.x ) > 0.9 ? vec3( 0.0, 0.0, 1.0 ) : vec3( 1.0, 0.0, 0.0 );
	vec3 tfT = normalize( tfBase - tfN * dot( tfN, tfBase ) );
	vec3 tfB = cross( tfN, tfT );
	vec3 tfN2 = normalize( tfN + ( tfT * tfTNormalTS.x + tfB * tfTNormalTS.y ) * uTfTerrainParams2.z );
	normal = normalize( mat3( viewMatrix ) * tfN2 );
}
`;

/**
 * Живые униформы detail-патча. options.textures = {grass:{map,normalMap}, ...};
 * пропущенные слоты — нейтральные заглушки (белая карта / плоская нормаль).
 * Параметры бленда: из options.terrain (waterLevel/amplitude) ИЛИ options.blend
 * ({sandEdge, slopeRock, snowStart, snowEnd}) + options.yOffset (сдвиг мира).
 */
function createTerrainDetailUniforms(options = {}) {
	const sets = options.textures !== undefined && options.textures !== null ? options.textures : {};
	const slot = (kind) => {
		const s = sets[kind];
		return {
			map: s !== undefined && s !== null && s.map !== undefined && s.map !== null ? s.map : _tfGetWhiteTex(),
			normalMap: s !== undefined && s !== null && s.normalMap !== undefined && s.normalMap !== null ? s.normalMap : _tfGetFlatNormalTex()
		};
	};
	const g = slot('grass'), r = slot('rock'), sn = slot('snow'), sa = slot('sand');
	const terrain = options.terrain !== undefined && options.terrain !== null ? options.terrain : null;
	const yOffset = options.yOffset !== undefined ? options.yOffset : 0;
	const amp = terrain !== null && Number.isFinite(terrain.amplitude) ? terrain.amplitude : 40;
	const wl = terrain !== null && Number.isFinite(terrain.waterLevel) ? terrain.waterLevel : -6;
	const blend = options.blend !== undefined && options.blend !== null ? options.blend : {};
	const sandEdge = (blend.sandEdge !== undefined ? blend.sandEdge : wl + 1.5) + yOffset;
	const slopeRock = blend.slopeRock !== undefined ? blend.slopeRock : 0.35;
	const snowStart = (blend.snowStart !== undefined ? blend.snowStart : amp * 0.72) + yOffset;
	const snowEnd = (blend.snowEnd !== undefined ? blend.snowEnd : amp * 0.92) + yOffset;
	const rough = options.rough !== undefined && options.rough !== null ? options.rough : [0.92, 0.78, 0.5, 0.85];
	return {
		uTfGrassMap: { value: g.map }, uTfGrassNrm: { value: g.normalMap },
		uTfRockMap: { value: r.map }, uTfRockNrm: { value: r.normalMap },
		uTfSnowMap: { value: sn.map }, uTfSnowNrm: { value: sn.normalMap },
		uTfSandMap: { value: sa.map }, uTfSandNrm: { value: sa.normalMap },
		uTfTerrainParams: { value: new Vector4(sandEdge, slopeRock, snowStart, Math.max(snowEnd, snowStart + 1e-3)) },
		uTfTerrainParams2: { value: new Vector4(
			options.texWorldSize !== undefined ? options.texWorldSize : 6,
			options.detail !== undefined ? options.detail : 0.75,
			options.normalStrength !== undefined ? options.normalStrength : 1,
			options.roughMix !== undefined ? options.roughMix : 0.85) },
		uTfTerrainRough: { value: new Vector4(
			rough[0] !== undefined ? rough[0] : 0.92,
			rough[1] !== undefined ? rough[1] : 0.78,
			rough[2] !== undefined ? rough[2] : 0.5,
			rough[3] !== undefined ? rough[3] : 0.85) }
	};
}

/**
 * Патч детализации для MeshStandard/PhysicalMaterial (и других материалов с
 * чанками map/roughness/normal — проверяется наличие тегов, иначе warning).
 * @param {THREE.Material} material
 * @param {object} [options] те же поля, что у createTerrainDetailUniforms.
 * @returns {THREE.Material} тот же материал (патчуется на месте).
 */
function installTerrainDetailPatch(material, options = {}) {
	if (material === undefined || material === null) return material;
	if (material.__tfTerrainDetailPatched === true) return material;
	const uniforms = options.uniforms !== undefined && options.uniforms !== null
		? options.uniforms
		: createTerrainDetailUniforms(options);
	material.__tfTerrainDetailPatched = true;
	material.__tfTerrainUniforms = uniforms;
	tfAddProgramCacheKey(material, 'terrainDetail');
	tfRecordPatch(material, { name: 'terrainDetail', replay: (copy) => installTerrainDetailPatch(copy, Object.assign({}, options, { uniforms })) });
	tfChainOnBeforeCompile(material, function (shader) {
		for (const key in uniforms) shader.uniforms[key] = uniforms[key];
		const vCommon = '#include <common>';
		const vProj = '#include <project_vertex>';
		const fCommon = '#include <common>';
		const fColor = '#include <color_fragment>';
		const fRough = '#include <roughnessmap_fragment>';
		const fNormal = '#include <normal_fragment_maps>';
		if (shader.vertexShader.indexOf(vCommon) === -1 || shader.vertexShader.indexOf(vProj) === -1 ||
			shader.fragmentShader.indexOf(fCommon) === -1 || shader.fragmentShader.indexOf(fColor) === -1 ||
			shader.fragmentShader.indexOf(fRough) === -1 || shader.fragmentShader.indexOf(fNormal) === -1) {
			console.warn('ThreeForge: terrain detail patch — нужные чанки не найдены ' +
				'(ожидается MeshStandard/PhysicalMaterial); материал останется без детализации');
			return;
		}
		shader.vertexShader = shader.vertexShader
			.replace(vCommon, vCommon + '\nvarying vec3 vTfTWorld;\nvarying vec3 vTfTNrm;')
			.replace(vProj, vProj + '\n' + TF_TERRAIN_DETAIL_VERT);
		shader.fragmentShader = shader.fragmentShader
			.replace(fCommon, fCommon + '\n' + TF_TERRAIN_DETAIL_GLSL)
			.replace(fColor, fColor + '\n' + TF_TERRAIN_DETAIL_COLOR)
			.replace(fRough, fRough + '\n' + TF_TERRAIN_DETAIL_ROUGH)
			.replace(fNormal, fNormal + '\n' + TF_TERRAIN_DETAIL_NORMAL);
	});
	return material;
}

/**
 * Готовый материал террейна: MeshStandardMaterial (vertexColors) + патч
 * детализации + (опционально) туман и CSM-тени.
 *
 * @param {object} [options]
 * @param {Terrain} [options.terrain] источник параметров бленда (waterLevel, amplitude).
 * @param {number} [options.yOffset=0] вертикальный сдвиг чанков (мировой Y).
 * @param {object|false} [options.textures] {grass,rock,snow,sand} → {map, normalMap};
 *   undefined/true — сгенерировать процедурно; false — материал БЕЗ detail-патча.
 * @param {number|false} [options.detail=0.75] сила детали (0..1); false — без патча.
 * @param {number} [options.normalStrength=1] сила микрорельефа нормали.
 * @param {number} [options.texWorldSize=6] мировых единиц на тайл текстуры.
 * @param {number} [options.roughMix=0.85] доля per-layer roughness.
 * @param {number[]} [options.rough] [grass, rock, snow, sand].
 * @param {number} [options.textureSize=256] размер генерируемых текстур.
 * @param {number} [options.textureSeed=1337] seed генератора текстур.
 * @param {'detail'|'albedo'} [options.textureMode='detail']
 * @param {number} [options.textureNormalStrength=2.2] normalStrength генерируемых текстур (R3).
 * @param {number} [options.textureContrast] контраст генерируемых текстур (R3).
 * @param {number} [options.textureAnisotropy] анизотропия генерируемых текстур (R3).
 * @param {FogManager|null} [options.fog] установить installFogPatch.
 * @param {boolean} [options.sunShadow=true] установить installSunShadowPatch (CSM).
 * @param {object} [options.blend] {sandEdge, slopeRock, snowStart, snowEnd} —
 *   ручные пороги бленда (иначе из terrain).
 * Плюс стандартные поля MeshStandardMaterial: color, roughness, metalness,
 * side, flatShading, dithering, vertexColors.
 * @returns {THREE.MeshStandardMaterial} material.tfTerrain — API рантайм-правок.
 */
function createTerrainMaterial(options = {}) {
	const wantDetail = options.textures !== false && options.detail !== false;
	let sets = null;
	let ownedTextures = null;
	if (wantDetail) {
		if (typeof options.textures === 'object' && options.textures !== null) {
			sets = options.textures;
		} else {
			const size = options.textureSize !== undefined ? options.textureSize : 256;
			const seedBase = options.textureSeed !== undefined ? options.textureSeed : 1337;
			const mode = options.textureMode !== undefined ? options.textureMode : 'detail';
			sets = {};
			ownedTextures = [];
			const kinds = ['grass', 'rock', 'snow', 'sand'];
			for (let i = 0; i < kinds.length; i++) {
				const set = createTerrainTextureSet(kinds[i], size, {
					seed: seedBase + i * 1013, mode,
					normalStrength: options.textureNormalStrength !== undefined ? options.textureNormalStrength : 2.2,
					contrast: options.textureContrast,
					anisotropy: options.textureAnisotropy
				});
				sets[kinds[i]] = set;
				ownedTextures.push(set.map, set.normalMap);
			}
		}
	}
	const material = new MeshStandardMaterial({
		color: options.color !== undefined ? options.color : 0xffffff,
		roughness: options.roughness !== undefined ? options.roughness : 0.95,
		metalness: options.metalness !== undefined ? options.metalness : 0,
		vertexColors: options.vertexColors !== undefined ? options.vertexColors : true,
		flatShading: options.flatShading === true,
		dithering: options.dithering !== undefined ? options.dithering : true,
		side: options.side !== undefined ? options.side : THREE.FrontSide
	});
	material.name = 'tfTerrainMaterial';
	if (wantDetail) {
		installTerrainDetailPatch(material, Object.assign({}, options, { textures: sets }));
	}
	if (options.fog !== undefined && options.fog !== null) installFogPatch(material, options.fog);
	if (options.sunShadow !== false) installSunShadowPatch(material);

	const uniforms = material.__tfTerrainUniforms !== undefined ? material.__tfTerrainUniforms : null;
	const setParam2 = (idx, v) => {
		if (uniforms !== null && Number.isFinite(v)) uniforms.uTfTerrainParams2.value.setComponent(idx, v);
		return material.tfTerrain;
	};
	material.tfTerrain = {
		uniforms, sets, ownedTextures,
		setDetail(v) { return setParam2(1, v); },
		setNormalStrength(v) { return setParam2(2, v); },
		setTexWorldSize(v) { return setParam2(0, v); },
		setRoughMix(v) { return setParam2(3, v); },
		/** Ручная правка порогов бленда (мировой Y, yOffset уже учтён). */
		setBlend(b) {
			if (uniforms === null || b === undefined || b === null) return material.tfTerrain;
			const p = uniforms.uTfTerrainParams.value;
			if (b.sandEdge !== undefined) p.x = b.sandEdge;
			if (b.slopeRock !== undefined) p.y = b.slopeRock;
			if (b.snowStart !== undefined) p.z = b.snowStart;
			if (b.snowEnd !== undefined) p.w = Math.max(b.snowEnd, p.z + 1e-3);
			return material.tfTerrain;
		},
		/** Заменить текстуры слоя ('grass'|'rock'|'snow'|'sand') на рантайме. */
		setTexture(kind, set) {
			if (uniforms === null || set === undefined || set === null) return material.tfTerrain;
			const cap = kind.charAt(0).toUpperCase() + kind.slice(1);
			const mapU = uniforms['uTf' + cap + 'Map'];
			const nrmU = uniforms['uTf' + cap + 'Nrm'];
			if (mapU === undefined || nrmU === undefined) {
				console.warn('ThreeForge: tfTerrain.setTexture — неизвестный слой "' + kind + '"');
				return material.tfTerrain;
			}
			if (set.map !== undefined && set.map !== null) mapU.value = set.map;
			if (set.normalMap !== undefined && set.normalMap !== null) nrmU.value = set.normalMap;
			return material.tfTerrain;
		}
	};
	return material;
}

const TF_SWAY_TIME = { value: 0 };

const TF_SWAY_GLSL = `
uniform float tfSwayTime;
uniform vec4 tfSwayParams; // (strength, speed, freq, maskHeight)
`;

const TF_SWAY_VERT = `
vec4 tfSwayW4 = vec4( transformed, 1.0 );
#ifdef USE_INSTANCING
	tfSwayW4 = instanceMatrix * tfSwayW4;
#endif
tfSwayW4 = modelMatrix * tfSwayW4;
float tfSwayMask = pow( clamp( position.y / max( tfSwayParams.w, 1e-3 ), 0.0, 1.0 ), 1.4 );
float tfSwayPh = tfSwayW4.x * tfSwayParams.z + tfSwayW4.z * tfSwayParams.z * 0.77;
float tfSwayS = sin( tfSwayTime * tfSwayParams.y + tfSwayPh ) * 0.65
	+ sin( tfSwayTime * tfSwayParams.y * 1.93 + tfSwayPh * 1.71 ) * 0.35;
transformed.x += tfSwayS * tfSwayParams.x * tfSwayMask;
transformed.z += tfSwayS * tfSwayParams.x * 0.55 * tfSwayMask;
`;

/**
 * Патч «ветра» для любого материала с #include <begin_vertex>
 * (Lambert/Standard/Physical). timeUniform — общий {value} clock.
 */
function installSwayPatch(material, options = {}) {
	if (material === undefined || material === null) return material;
	if (material.__tfSwayPatched === true) return material;
	const uniforms = options.uniforms !== undefined && options.uniforms !== null ? options.uniforms : {
		tfSwayTime: options.timeUniform !== undefined && options.timeUniform !== null ? options.timeUniform : TF_SWAY_TIME,
		tfSwayParams: { value: new Vector4(
			options.strength !== undefined ? options.strength : 0.1,
			options.speed !== undefined ? options.speed : 1.6,
			options.freq !== undefined ? options.freq : 0.45,
			options.maskHeight !== undefined ? options.maskHeight : 1) }
	};
	material.__tfSwayPatched = true;
	material.__tfSwayUniforms = uniforms;
	tfAddProgramCacheKey(material, 'sway');
	tfRecordPatch(material, { name: 'sway', replay: (copy) => installSwayPatch(copy, Object.assign({}, options, { uniforms })) });
	tfChainOnBeforeCompile(material, function (shader) {
		shader.uniforms.tfSwayTime = uniforms.tfSwayTime;
		shader.uniforms.tfSwayParams = uniforms.tfSwayParams;
		const vCommon = '#include <common>';
		const vBegin = '#include <begin_vertex>';
		if (shader.vertexShader.indexOf(vCommon) === -1 || shader.vertexShader.indexOf(vBegin) === -1) {
			console.warn('ThreeForge: sway patch — чанки <common>/<begin_vertex> не найдены, материал останется без ветра');
			return;
		}
		shader.vertexShader = shader.vertexShader
			.replace(vCommon, vCommon + '\n' + TF_SWAY_GLSL)
			.replace(vBegin, vBegin + '\n' + TF_SWAY_VERT);
	});
	return material;
}

function _tfColorize(geo, color) {
	const c = color.isColor === true ? color : new Color(color);
	const count = geo.attributes.position.count;
	const arr = new Float32Array(count * 3);
	for (let i = 0; i < count; i++) {
		arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b;
	}
	geo.setAttribute('color', new BufferAttribute(arr, 3));
	return geo;
}

function _tfMergeGeometries(parts) {
	const geos = [];
	let total = 0;
	let allUv = true;
	for (let i = 0; i < parts.length; i++) {
		const g = parts[i].index !== null ? parts[i].toNonIndexed() : parts[i];
		if (g.attributes.normal === undefined) g.computeVertexNormals();
		if (g.attributes.color === undefined) _tfColorize(g, 0xffffff);
		if (g.attributes.uv === undefined) allUv = false;
		total += g.attributes.position.count;
		geos.push(g);
	}
	const pos = new Float32Array(total * 3);
	const nrm = new Float32Array(total * 3);
	const col = new Float32Array(total * 3);
	const uv = allUv ? new Float32Array(total * 2) : null;
	let vo = 0;
	for (let i = 0; i < geos.length; i++) {
		const g = geos[i];
		const c = g.attributes.position.count;
		pos.set(g.attributes.position.array.subarray(0, c * 3), vo * 3);
		nrm.set(g.attributes.normal.array.subarray(0, c * 3), vo * 3);
		col.set(g.attributes.color.array.subarray(0, c * 3), vo * 3);
		if (uv !== null) uv.set(g.attributes.uv.array.subarray(0, c * 2), vo * 2);
		vo += c;
	}
	const merged = new BufferGeometry();
	merged.setAttribute('position', new BufferAttribute(pos, 3));
	merged.setAttribute('normal', new BufferAttribute(nrm, 3));
	merged.setAttribute('color', new BufferAttribute(col, 3));
	if (uv !== null) merged.setAttribute('uv', new BufferAttribute(uv, 2));
	merged.computeBoundingSphere();
	return merged;
}

/** Ёлка: ствол-цилиндр + ярусы конусов (вершинные цвета, ~60 треуг.). */
function createTreeGeometry(options = {}) {
	const h = options.height !== undefined ? options.height : 3.6;
	const tiers = Math.max(1, options.tiers !== undefined ? options.tiers : 3);
	const trunkColor = new Color(options.trunkColor !== undefined ? options.trunkColor : 0x59412c);
	const leafColor = new Color(options.leafColor !== undefined ? options.leafColor : 0x2f5d24);
	const leafTip = new Color(options.leafTipColor !== undefined ? options.leafTipColor : 0x52873c);
	const trunkH = h * 0.38;
	const parts = [];
	const trunk = new THREE.CylinderGeometry(h * 0.032, h * 0.058, trunkH, 6, 1, false);
	trunk.translate(0, trunkH * 0.5, 0);
	_tfColorize(trunk, trunkColor);
	parts.push(trunk);
	const coneH = h * 0.34;
	for (let i = 0; i < tiers; i++) {
		const t = tiers > 1 ? i / (tiers - 1) : 0;
		const r = h * 0.30 * (1 - t * 0.38);
		const ch = coneH * (1 - t * 0.18);
		const yBase = trunkH * 0.62 + i * coneH * 0.52;
		const cone = new THREE.ConeGeometry(r, ch, 8, 1, false);
		cone.translate(0, yBase + ch * 0.5, 0);
		_tfColorize(cone, leafColor.clone().lerp(leafTip, t * 0.55));
		parts.push(cone);
	}
	return _tfMergeGeometries(parts);
}

/** Валун: икосаэдр с гранёным шумовым displacement'ом (плоские фасеты). */
function createRockGeometry(options = {}) {
	const r = options.radius !== undefined ? options.radius : 0.5;
	const seed = options.seed !== undefined ? options.seed : 7;
	const base = new THREE.IcosahedronGeometry(r, options.detail !== undefined ? options.detail : 1);
	const g = base.index !== null ? base.toNonIndexed() : base;
	const pos = g.attributes.position;
	const rnd = createPRNG(seed);
	for (let i = 0; i < pos.count; i += 3) {
		const k = 0.72 + rnd() * 0.55;
		const kx = k * (0.85 + rnd() * 0.3);
		const ky = k * (0.55 + rnd() * 0.4);
		const kz = k * (0.85 + rnd() * 0.3);
		for (let j = 0; j < 3; j++) {
			const ix = i + j;
			pos.setXYZ(ix, pos.getX(ix) * kx, pos.getY(ix) * ky, pos.getZ(ix) * kz);
		}
	}
	pos.needsUpdate = true;
	g.computeVertexNormals();
	const c = new Color(options.color !== undefined ? options.color : 0x6d6a63);
	const col = new Float32Array(pos.count * 3);
	for (let i = 0; i < pos.count; i++) {
		const s = 0.82 + rnd() * 0.36;
		col[i * 3] = c.r * s; col[i * 3 + 1] = c.g * s; col[i * 3 + 2] = c.b * s * 0.96;
	}
	g.setAttribute('color', new BufferAttribute(col, 3));
	g.computeBoundingSphere();
	return g;
}

/** Куст: несколько смятых икосаэдров-«комков» с вариацией зелени. */
function createBushGeometry(options = {}) {
	const blobs = Math.max(1, options.blobs !== undefined ? options.blobs : 3);
	const r = options.radius !== undefined ? options.radius : 0.34;
	const seed = options.seed !== undefined ? options.seed : 17;
	const base = new Color(options.color !== undefined ? options.color : 0x37592b);
	const lite = new Color(options.colorLight !== undefined ? options.colorLight : 0x4f7c37);
	const rnd = createPRNG(seed);
	const parts = [];
	for (let b = 0; b < blobs; b++) {
		const ico = new THREE.IcosahedronGeometry(r * (0.7 + rnd() * 0.55), 1);
		const g = ico.index !== null ? ico.toNonIndexed() : ico;
		const pos = g.attributes.position;
		for (let i = 0; i < pos.count; i += 3) {
			const k = 0.85 + rnd() * 0.3;
			for (let j = 0; j < 3; j++) {
				const ix = i + j;
				pos.setXYZ(ix, pos.getX(ix) * k, pos.getY(ix) * k * 0.8, pos.getZ(ix) * k);
			}
		}
		pos.needsUpdate = true;
		g.computeVertexNormals();
		g.translate((rnd() - 0.5) * r * 1.7, r * (0.5 + rnd() * 0.35), (rnd() - 0.5) * r * 1.7);
		_tfColorize(g, base.clone().lerp(lite, rnd() * 0.75));
		parts.push(g);
	}
	return _tfMergeGeometries(parts);
}

/** Пучок травы: изогнутые «лезвия» с градиентом корень→кончик (DoubleSide). */
function createGrassGeometry(options = {}) {
	const blades = Math.max(1, options.blades !== undefined ? options.blades : 7);
	const h = options.height !== undefined ? options.height : 0.55;
	const seed = options.seed !== undefined ? options.seed : 3;
	const rnd = createPRNG(seed);
	const base = new Color(options.colorBase !== undefined ? options.colorBase : 0x2b4a1c);
	const tip = new Color(options.colorTip !== undefined ? options.colorTip : 0x5c8a3a);
	const segs = 3;
	const verts = [];
	const cols = [];
	const spread = options.spread !== undefined ? options.spread : 0.16;
	const cScratch = new Color();
	for (let b = 0; b < blades; b++) {
		const bh = h * (0.55 + rnd() * 0.7);
		const ang = rnd() * Math.PI * 2;
		const dirX = Math.cos(ang), dirZ = Math.sin(ang);
		const px = -dirZ, pz = dirX;
		const cx = dirX * spread * (0.25 + rnd() * 0.75);
		const cz = dirZ * spread * (0.25 + rnd() * 0.75);
		const bend = (rnd() - 0.5) * 0.9;
		const w0 = 0.016 + rnd() * 0.016;
		const tint = 0.8 + rnd() * 0.45;
		const row = (s) => {
			const t = s / segs;
			const y = bh * t;
			const lean = bend * t * t * bh * 0.75;
			const w = w0 * (1 - t * 0.92);
			return {
				lx: cx - px * w + dirX * lean, ly: y, lz: cz - pz * w + dirZ * lean,
				rx: cx + px * w + dirX * lean, ry: y, rz: cz + pz * w + dirZ * lean,
				t
			};
		};
		for (let s = 0; s < segs; s++) {
			const a = row(s), bn = row(s + 1);
			cScratch.copy(base).lerp(tip, a.t);
			const c0r = cScratch.r * tint, c0g = cScratch.g * tint, c0b = cScratch.b * tint;
			cScratch.copy(base).lerp(tip, bn.t);
			const c1r = cScratch.r * tint, c1g = cScratch.g * tint, c1b = cScratch.b * tint;
			verts.push(a.lx, a.ly, a.lz, a.rx, a.ry, a.rz, bn.rx, bn.ry, bn.rz);
			cols.push(c0r, c0g, c0b, c0r, c0g, c0b, c1r, c1g, c1b);
			verts.push(a.lx, a.ly, a.lz, bn.rx, bn.ry, bn.rz, bn.lx, bn.ly, bn.lz);
			cols.push(c0r, c0g, c0b, c1r, c1g, c1b, c1r, c1g, c1b);
		}
	}
	const geo = new BufferGeometry();
	geo.setAttribute('position', new BufferAttribute(new Float32Array(verts), 3));
	geo.setAttribute('color', new BufferAttribute(new Float32Array(cols), 3));
	geo.computeVertexNormals();
	geo.computeBoundingSphere();
	return geo;
}

/** Материал растительности по умолчанию: Lambert + vertexColors (+ DoubleSide для травы). */
function createDetailMaterial(type, options = {}) {
	const mat = new THREE.MeshLambertMaterial({
		vertexColors: true,
		side: (type === 'grass' || type === 'flower') ? DoubleSide : THREE.FrontSide
	});
	mat.name = 'tfDetail_' + type;
	// F5: слабый emissive — стилизованный «светящийся» ковёр (цветы/трава) ночью
	if (options.emissive !== undefined && options.emissive !== null) mat.emissive.set(options.emissive);
	if (options.fog !== undefined && options.fog !== null) installFogPatch(mat, options.fog);
	return mat;
}

/* --- GK1: процедурный низполи-меч ----------------------------------- */

/**
 * Стилизованный меч: 4-гранный клинок с остриём, перекрестье, рукоять, навершие.
 * Начало координат — перекрестье (точка хвата); клинок направлен +Y.
 * Для «воткнутых» гигантских мечей в scatterProps используйте baseRotation.
 */
function createSwordGeometry(options = {}) {
	const bladeLength = options.bladeLength !== undefined ? options.bladeLength : 1.05;
	const bladeWidth = options.bladeWidth !== undefined ? options.bladeWidth : 0.085;
	const bladeThickness = options.bladeThickness !== undefined ? options.bladeThickness : 0.022;
	const guardWidth = options.guardWidth !== undefined ? options.guardWidth : 0.34;
	const guardHeight = options.guardHeight !== undefined ? options.guardHeight : 0.045;
	const guardDepth = options.guardDepth !== undefined ? options.guardDepth : 0.035;
	const gripLength = options.gripLength !== undefined ? options.gripLength : 0.24;
	const gripRadius = options.gripRadius !== undefined ? options.gripRadius : 0.019;
	const pommelRadius = options.pommelRadius !== undefined ? options.pommelRadius : 0.045;
	const bladeColor = new Color(options.bladeColor !== undefined ? options.bladeColor : 0xb9c2cf);
	const guardColor = new Color(options.guardColor !== undefined ? options.guardColor : 0x6b5a33);
	const gripColor = new Color(options.gripColor !== undefined ? options.gripColor : 0x3a2b22);
	const parts = [];
	const straight = bladeLength * 0.78;
	const squash = bladeThickness / bladeWidth;
	const blade = new THREE.CylinderGeometry(bladeWidth * 0.72, bladeWidth, straight, 4, 1, false);
	blade.rotateY(Math.PI / 4);
	blade.scale(1, 1, squash);
	blade.translate(0, straight * 0.5, 0);
	_tfColorize(blade, bladeColor);
	parts.push(blade);
	const tipH = bladeLength - straight;
	const tip = new THREE.ConeGeometry(bladeWidth * 0.72, tipH, 4, 1, false);
	tip.rotateY(Math.PI / 4);
	tip.scale(1, 1, squash);
	tip.translate(0, straight + tipH * 0.5, 0);
	_tfColorize(tip, bladeColor);
	parts.push(tip);
	const guard = new THREE.BoxGeometry(guardWidth, guardHeight, guardDepth);
	guard.translate(0, -guardHeight * 0.5, 0);
	_tfColorize(guard, guardColor);
	parts.push(guard);
	const grip = new THREE.CylinderGeometry(gripRadius, gripRadius * 1.12, gripLength, 6, 1, false);
	grip.translate(0, -guardHeight - gripLength * 0.5, 0);
	_tfColorize(grip, gripColor);
	parts.push(grip);
	const pommel = new THREE.IcosahedronGeometry(pommelRadius, 0);
	pommel.translate(0, -guardHeight - gripLength - pommelRadius * 0.6, 0);
	_tfColorize(pommel, guardColor);
	parts.push(pommel);
	const geo = _tfMergeGeometries(parts);
	for (let i = 0; i < parts.length; i++) parts[i].dispose();
	geo.computeBoundingSphere();
	return geo;
}

/* --- GK2: стилизованный кулак для вьюмодели ------------------------- */

/**
 * Низполи-кулак (перчатка): ладонь, блок пальцев, большой палец, манжета.
 * Ориентация: пальцы -Z, тыльная сторона +Z (под хват вертикальной рукояти).
 */
function createFistGeometry(options = {}) {
	const s = options.scale !== undefined ? options.scale : 1;
	const skin = new Color(options.color !== undefined ? options.color : 0xc9a186);
	const cuffColor = new Color(options.cuffColor !== undefined ? options.cuffColor : 0x4a3a2c);
	const parts = [];
	const palm = new THREE.BoxGeometry(0.085, 0.095, 0.105);
	_tfColorize(palm, skin);
	parts.push(palm);
	const fingers = new THREE.BoxGeometry(0.082, 0.052, 0.075);
	fingers.translate(0, 0.028, -0.062);
	_tfColorize(fingers, skin);
	parts.push(fingers);
	const thumb = new THREE.BoxGeometry(0.03, 0.062, 0.036);
	thumb.rotateZ(-0.5);
	thumb.translate(-0.055, 0.012, -0.03);
	_tfColorize(thumb, skin);
	parts.push(thumb);
	const wrist = new THREE.CylinderGeometry(0.036, 0.042, 0.09, 6, 1, false);
	wrist.rotateX(Math.PI / 2);
	wrist.translate(0, -0.01, 0.085);
	_tfColorize(wrist, skin);
	parts.push(wrist);
	const cuff = new THREE.CylinderGeometry(0.05, 0.056, 0.05, 6, 1, false);
	cuff.rotateX(Math.PI / 2);
	cuff.translate(0, -0.012, 0.115);
	_tfColorize(cuff, cuffColor);
	parts.push(cuff);
	const geo = _tfMergeGeometries(parts);
	for (let i = 0; i < parts.length; i++) parts[i].dispose();
	geo.scale(s, s, s);
	geo.computeBoundingSphere();
	return geo;
}

/* --- GK3: цветок для поля деталей ----------------------------------- */

/**
 * Низполи-цветок: стебель (2 перекрещённых квада, как у травы), головка
 * из petal-квадов и сердцевина. Вершинные цвета — под vertexColors деталей;
 * качание совместимо с installSwayPatch (маска по position.y).
 */
function createFlowerGeometry(options = {}) {
	const rnd = tfGameRng(options.seed !== undefined ? options.seed : 11);
	const petals = Math.max(4, options.petals !== undefined ? options.petals | 0 : 5);
	const headR = options.headRadius !== undefined ? options.headRadius : 0.05;
	const stemH = options.stemHeight !== undefined ? options.stemHeight : 0.22;
	const stemColor = new Color(options.stemColor !== undefined ? options.stemColor : 0x4d6b3a);
	const petalColor = new Color(options.petalColor !== undefined ? options.petalColor : 0xe8e4f2);
	const centerColor = new Color(options.centerColor !== undefined ? options.centerColor : 0xe9c86a);
	const parts = [];
	for (let i = 0; i < 2; i++) {
		const q = new THREE.PlaneGeometry(0.016, stemH, 1, 2);
		q.translate(0, stemH * 0.5, 0);
		q.rotateY(i * Math.PI / 2);
		_tfColorize(q, stemColor);
		parts.push(q);
	}
	for (let i = 0; i < petals; i++) {
		const a = (i / petals) * Math.PI * 2 + rnd() * 0.3;
		const p = new THREE.PlaneGeometry(headR * 0.95, headR * 1.25, 1, 1);
		p.translate(0, headR * 0.62, 0);
		p.rotateX(-0.9);
		p.rotateY(a);
		p.translate(0, stemH, 0);
		_tfColorize(p, petalColor);
		parts.push(p);
	}
	const c = new THREE.PlaneGeometry(headR * 0.8, headR * 0.8);
	c.rotateX(-Math.PI / 2);
	c.translate(0, stemH + headR * 0.18, 0);
	_tfColorize(c, centerColor);
	parts.push(c);
	const geo = _tfMergeGeometries(parts);
	for (let i = 0; i < parts.length; i++) parts[i].dispose();
	geo.computeBoundingSphere();
	return geo;
}


const TF_DETAIL_DEFAULTS = {
	tree: { enabled: true, maxRing: 4, density: 1, castShadow: true, pageSize: 1024, budget: 12000, scale: 1, sway: { strength: 0.06, speed: 1.05, freq: 0.22, maskHeight: 3.6 } },
	rock: { enabled: true, maxRing: 5, density: 1, castShadow: true, pageSize: 1024, budget: 8000, scale: 1, sway: null },
	bush: { enabled: true, maxRing: 2, density: 1, castShadow: true, pageSize: 2048, budget: 16000, scale: 0.9, sway: { strength: 0.08, speed: 1.7, freq: 0.5, maskHeight: 0.9 } },
	grass: { enabled: true, maxRing: 1, density: 1, castShadow: false, pageSize: 4096, budget: 40000, scale: 1, sway: { strength: 0.11, speed: 2.4, freq: 0.85, maskHeight: 0.6 } },
	flower: { enabled: true, maxRing: 2, density: 1, castShadow: false, pageSize: 4096, budget: 30000, scale: 1, sway: { strength: 0.09, speed: 2.0, freq: 0.7, maskHeight: 0.35 } }
};
const TF_DETAIL_TYPES = ['tree', 'rock', 'bush', 'grass', 'flower'];

const _tdMat4 = new Matrix4();
const _tdQuat = new Quaternion();
const _tdPos = new Vector3();
const _tdScale = new Vector3(1, 1, 1);
const _tdColor = new Color();
const _tdEuler = new THREE.Euler();
const _tdFocus = new Vector3();

const TerrainDetailManager = class extends EventDispatcher {
	/**
	 * @param {object} options
	 * @param {Terrain} [options.terrain] (иначе берётся из streamer.terrain)
	 * @param {TerrainStreamer} [options.streamer] источник событий чанков.
	 * @param {THREE.Object3D} [options.parent] куда вешать страницы инстансов.
	 * @param {number} [options.scatterCount=420] сэмплов scatter() на чанк.
	 * @param {number} [options.chunkSize] размер чанка (дефолт — streamer.chunkSize, иначе 64) (R3).
	 * @param {number} [options.seed] seed PRNG заселения (дефолт — terrain.seed) (R3).
	 * @param {object} [options.focus] камера/Object3D/Vector3 — фокус LOD-колец
	 *   (дефолт — streamer.focus) (R3).
	 * @param {FogManager|null} [options.fog] туман движка для создаваемых
	 *   материалов растительности (R3).
	 * @param {object} [options.types] частичный оверрайд TF_DETAIL_DEFAULTS
	 *   ({tree: {maxRing, density, enabled, scale, budget, castShadow, sway}, ...}).
	 * @param {object} [options.geometries] {tree, rock, bush, grass} — свои меши.
	 * @param {object} [options.materials] {tree, ...} — свои материалы.
	 * @param {object|false} [options.sway] {tree:{...}, ...} — оверрайд ветра;
	 *   false — ветер выключен везде.
	 * @param {number} [options.budgetMs=3] бюджет заселения на кадр.
	 * @param {Function} [options.scatter] своя функция рассеивания
	 *   (chunkX, chunkZ, size, count) → items (формат Terrain.scatter).
	 * @param {number} [options.yOffset] вертикальный сдвиг мира (из streamer).
	 */
	constructor(options = {}) {
		super();
		this.name = 'TerrainDetailManager';
		this.streamer = options.streamer !== undefined && options.streamer !== null ? options.streamer : null;
		this.terrain = options.terrain !== undefined && options.terrain !== null
			? options.terrain
			: (this.streamer !== null ? this.streamer.terrain : null);
		if (this.terrain === null) throw new Error('TerrainDetailManager: нужен terrain или streamer');
		this.parent = options.parent !== undefined && options.parent !== null
			? options.parent
			: (this.streamer !== null && this.streamer.parent !== null ? this.streamer.parent : null);
		this.chunkSize = options.chunkSize !== undefined ? options.chunkSize
			: (this.streamer !== null ? this.streamer.chunkSize : 64);
		this.yOffset = options.yOffset !== undefined ? options.yOffset
			: (this.streamer !== null ? this.streamer.yOffset : 0);
		this.scatterCount = options.scatterCount !== undefined ? options.scatterCount : 420;
		this.seed = options.seed !== undefined ? options.seed : (this.terrain.seed !== undefined ? this.terrain.seed : 0);
		this.budgetMs = options.budgetMs !== undefined ? options.budgetMs : 3;
		this.scatterFn = options.scatter !== undefined && options.scatter !== null
			? options.scatter
			: (cx, cz, size, count) => this.terrain.scatter(cx, cz, size, count);
		this.focus = options.focus !== undefined ? options.focus : null;

		this._timeUniform = { value: 0 };
		this._owned = [];

		const tOver = options.types !== undefined && options.types !== null ? options.types : {};
		const sOver = options.sway;
		this.types = {};
		this.batchers = {};
		const geos = options.geometries !== undefined && options.geometries !== null ? options.geometries : {};
		const mats = options.materials !== undefined && options.materials !== null ? options.materials : {};
		for (let i = 0; i < TF_DETAIL_TYPES.length; i++) {
			const type = TF_DETAIL_TYPES[i];
			const def = TF_DETAIL_DEFAULTS[type];
			const over = tOver[type] !== undefined && tOver[type] !== null ? tOver[type] : {};
			const cfg = Object.assign({}, def, over);
			if (sOver === false) cfg.sway = null;
			else if (sOver !== undefined && sOver !== null && sOver[type] !== undefined) {
				cfg.sway = sOver[type] === null ? null : Object.assign({}, cfg.sway, sOver[type]);
			}
			cfg._swayMaskExplicit =
				(over.sway !== undefined && over.sway !== null && over.sway.maskHeight !== undefined) ||
				(sOver !== undefined && sOver !== null && sOver !== false &&
					sOver[type] !== undefined && sOver[type] !== null && sOver[type].maskHeight !== undefined);
			this.types[type] = cfg;
			if (cfg.enabled === false) continue;
			let geometry = geos[type] !== undefined && geos[type] !== null ? geos[type] : null;
			if (geometry === null) {
				geometry = type === 'tree' ? createTreeGeometry()
					: type === 'rock' ? createRockGeometry({ seed: this.seed + 7 })
						: type === 'bush' ? createBushGeometry({ seed: this.seed + 17 })
							: type === 'flower' ? createFlowerGeometry({ seed: this.seed + 29 })
								: createGrassGeometry({ seed: this.seed + 3 });
				this._owned.push(geometry);
			}
			let material = mats[type] !== undefined && mats[type] !== null ? mats[type] : null;
			if (material === null) {
				material = createDetailMaterial(type, { fog: options.fog !== undefined ? options.fog : null, emissive: cfg.emissive });
				this._owned.push(material);
				if (cfg.sway !== null) {
					const sway = Object.assign({}, cfg.sway);
					if (cfg._swayMaskExplicit !== true && geometry.boundingSphere !== null) {
						sway.maskHeight = Math.max(0.1, geometry.boundingSphere.radius * 2);
					}
					installSwayPatch(material, Object.assign({ timeUniform: this._timeUniform }, sway));
				}
			}
			this.batchers[type] = new InstancedBatcher({
				geometry, material,
				pageSize: cfg.pageSize,
				parent: this.parent,
				useColor: true,
				castShadow: cfg.castShadow === true,
				receiveShadow: false,
				bounds: 'grow',
				frustumCulled: true
			});
		}

		this._items = new Map();
		this._popQueue = [];
		this._queuedKeys = new Set();
		this._dirty = false;
		this.stats = { chunks: 0, queued: 0 };
		for (let i = 0; i < TF_DETAIL_TYPES.length; i++) this.stats[TF_DETAIL_TYPES[i]] = 0;

		this._boundBuilt = (e) => this._onChunkBuilt(e.chunk);
		this._boundRemoved = (e) => this._onChunkRemoved(e.chunk);
		if (this.streamer !== null) {
			this.streamer.addEventListener('chunkbuilt', this._boundBuilt);
			this.streamer.addEventListener('chunkremoved', this._boundRemoved);
			for (const chunk of this.streamer.chunks.values()) this._onChunkBuilt(chunk);
		}
	}

	_onChunkBuilt(chunk) {
		const key = chunk.cx + ',' + chunk.cz;
		const ring = this.ringOf(chunk.cx, chunk.cz);
		const existing = this._items.get(key);
		if (existing === undefined) {
			if (this._queuedKeys.has(key)) return;
			this._popQueue.push({ cx: chunk.cx, cz: chunk.cz, key, mode: 'populate' });
			this._queuedKeys.add(key);
			this.stats.queued = this._popQueue.length;
			return;
		}
		if (existing.ring === ring || !this._eligChanged(existing.ring, ring)) return;
		this._enqueueSync(chunk.cx, chunk.cz, key);
	}

	_enqueueSync(cx, cz, key) {
		for (let i = 0; i < this._popQueue.length; i++) {
			const j = this._popQueue[i];
			if (j.key === key) {
				if (j.mode !== 'full') j.mode = 'sync';
				return;
			}
		}
		this._popQueue.push({ cx, cz, key, mode: 'sync' });
		this._queuedKeys.add(key);
		this.stats.queued = this._popQueue.length;
	}

	_eligChanged(ring0, ring1) {
		for (let i = 0; i < TF_DETAIL_TYPES.length; i++) {
			const cfg = this.types[TF_DETAIL_TYPES[i]];
			if (cfg === undefined || cfg.enabled === false) continue;
			if ((ring0 <= cfg.maxRing) !== (ring1 <= cfg.maxRing)) return true;
		}
		return false;
	}

	_onChunkRemoved(chunk) {
		const key = chunk.cx + ',' + chunk.cz;
		if (this._queuedKeys.has(key)) {
			const i = this._popQueue.findIndex((j) => j.key === key);
			if (i !== -1) this._popQueue.splice(i, 1);
			this._queuedKeys.delete(key);
			this.stats.queued = this._popQueue.length;
		}
		this.removeChunk(chunk.cx, chunk.cz);
	}

	_focusPosition(out) {
		if (this.streamer !== null) return out.copy(this.streamer.focusPosition);
		const f = this.focus;
		if (f !== null && f !== undefined) {
			if (f.isObject3D === true) return f.getWorldPosition(out);
			if (f.x !== undefined) return out.copy(f);
		}
		return out.set(0, 0, 0);
	}

	/** Кольцо LOD (Чебышёв) чанка от текущего фокуса. */
	ringOf(cx, cz) {
		const fp = this._focusPosition(_tdFocus);
		const ccx = Math.floor(fp.x / this.chunkSize);
		const ccz = Math.floor(fp.z / this.chunkSize);
		return Math.max(Math.abs(cx - ccx), Math.abs(cz - ccz));
	}

	/** Немедленно заселить чанк (вне очереди). Повторный вызов пересоздаёт инстансы. */
	populateChunk(cx, cz) {
		const key = cx + ',' + cz;
		if (this._items.has(key)) this.removeChunk(cx, cz);
		const qi = this._popQueue.findIndex((j) => j.key === key);
		if (qi !== -1) { this._popQueue.splice(qi, 1); this._queuedKeys.delete(key); this.stats.queued = this._popQueue.length; }
		this._populateNow(cx, cz, key);
		return this;
	}

	_itemRand(cx, cz, i) {
		const h = (Math.imul(cx, 73856093) ^ Math.imul(cz, 19349663) ^
			Math.imul(this.seed + 1, 83492791) ^ Math.imul(i + 1, 2654435761)) >>> 0;
		return createPRNG(h);
	}

	_populateNow(cx, cz, key) {
		const ring = this.ringOf(cx, cz);
		const rec = { ring };
		for (let i = 0; i < TF_DETAIL_TYPES.length; i++) rec[TF_DETAIL_TYPES[i]] = null;
		this._items.set(key, rec);
		const items = this.scatterFn(cx, cz, this.chunkSize, this.scatterCount);
		const added = this._addTypes(cx, cz, rec, ring, items, null);
		this.stats.chunks = this._items.size;
		if (added > 0) this._dirty = true;
		this.dispatchEvent({ type: 'chunkpopulated', cx, cz, ring, added });
	}

	/**
	 * Добавить инстансы типов из addSet (null — все проходящие по кольцу).
	 * Возвращает число добавленных. Элементы, не попавшие в addSet, не
	 * затрагиваются вовсе (их PRNG независим).
	 */
	_addTypes(cx, cz, rec, ring, items, addSet) {
		let added = 0;
		for (let i = 0; i < items.length; i++) {
			const it = items[i];
			const type = it.type;
			if (addSet !== null && addSet[type] !== true) continue;
			const cfg = this.types[type];
			const batcher = this.batchers[type];
			if (cfg === undefined || cfg.enabled === false || batcher === undefined) continue;
			if (ring > cfg.maxRing) continue;
			const rnd = this._itemRand(cx, cz, i);
			const r = rnd();
			if (cfg.density < 1 && r > cfg.density) continue;
			if (this.stats[type] >= cfg.budget) continue;
			const s = it.scale * (cfg.scale !== undefined ? cfg.scale : 1) * (0.85 + 0.3 * rnd());
			_tdPos.set(it.position.x, it.position.y + this.yOffset, it.position.z);
			if (type === 'rock') {
				_tdEuler.set((rnd() - 0.5) * 0.6, it.rotationY, (rnd() - 0.5) * 0.6);
			} else {
				_tdEuler.set(0, it.rotationY, 0);
			}
			_tdQuat.setFromEuler(_tdEuler);
			const sy = type === 'rock' ? s * (0.7 + rnd() * 0.5) : s;
			_tdScale.set(s, sy, s);
			_tdMat4.compose(_tdPos, _tdQuat, _tdScale);
			const v = 0.82 + 0.36 * rnd();
			if (type === 'rock') _tdColor.setRGB(v * 1.02, v, v * 0.94);
			else if (type === 'tree') _tdColor.setRGB(v * 0.92, v * 1.05, v * 0.86);
			else if (type === 'bush') _tdColor.setRGB(v * 0.9, v * 1.07, v * 0.84);
			else _tdColor.setRGB(v * (0.85 + 0.3 * rnd()), v * 1.08, v * 0.8);
			const handle = batcher.add(_tdMat4, _tdColor);
			if (rec[type] === null) rec[type] = [];
			rec[type].push(handle);
			this.stats[type]++;
			added++;
		}
		return added;
	}

	_syncChunk(cx, cz, key, ring) {
		const rec = this._items.get(key);
		if (rec === undefined) return;
		const addSet = {};
		let needScatter = false;
		let removed = 0;
		for (let i = 0; i < TF_DETAIL_TYPES.length; i++) {
			const type = TF_DETAIL_TYPES[i];
			const cfg = this.types[type];
			if (cfg === undefined || cfg.enabled === false) continue;
			const want = ring <= cfg.maxRing;
			const have = rec[type] !== null;
			if (want && !have) { addSet[type] = true; needScatter = true; }
			else if (!want && have) {
				const batcher = this.batchers[type];
				const handles = rec[type];
				if (batcher !== undefined) {
					for (let j = 0; j < handles.length; j++) batcher.remove(handles[j]);
				}
				removed += handles.length;
				this.stats[type] -= handles.length;
				rec[type] = null;
			}
		}
		let added = 0;
		if (needScatter) {
			const items = this.scatterFn(cx, cz, this.chunkSize, this.scatterCount);
			added = this._addTypes(cx, cz, rec, ring, items, addSet);
		}
		rec.ring = ring;
		if (added > 0 || removed > 0) this._dirty = true;
		this.dispatchEvent({ type: 'chunksynced', cx, cz, ring, added, removed });
	}

	/** Снять всю растительность чанка. */
	removeChunk(cx, cz) {
		const key = cx + ',' + cz;
		const rec = this._items.get(key);
		if (rec === undefined) return this;
		let removed = 0;
		for (let i = 0; i < TF_DETAIL_TYPES.length; i++) {
			const type = TF_DETAIL_TYPES[i];
			const handles = rec[type];
			if (handles === null) continue;
			const batcher = this.batchers[type];
			if (batcher !== undefined) {
				for (let j = 0; j < handles.length; j++) {
					batcher.remove(handles[j]);
					removed++;
				}
			}
			this.stats[type] -= handles.length;
		}
		this._items.delete(key);
		this.stats.chunks = this._items.size;
		if (removed > 0) this._dirty = true;
		this.dispatchEvent({ type: 'chunkcleared', cx, cz, removed });
		return this;
	}

	/**
	 * Перезаселить чанки (после смены density/maxRing/после clear()): все
	 * занятые + все готовые чанки стримера ставятся в очередь full-заданиями
	 * и обрабатываются в пределах budgetMs (без фриза на больших мирах).
	 */
	refresh() {
		const keys = new Set(this._items.keys());
		if (this.streamer !== null) {
			for (const key of this.streamer.chunks.keys()) keys.add(key);
		}
		for (const key of keys) {
			if (this._queuedKeys.has(key)) {
				const job = this._popQueue.find((j) => j.key === key);
				if (job !== undefined) job.mode = 'full';
				continue;
			}
			const p = key.split(',');
			this._popQueue.push({ cx: +p[0], cz: +p[1], key, mode: 'full' });
			this._queuedKeys.add(key);
		}
		this.stats.queued = this._popQueue.length;
		return this;
	}

	/** Мгновенно снять всё. */
	clear() {
		for (const key of [...this._items.keys()]) {
			const p = key.split(',');
			this.removeChunk(+p[0], +p[1]);
		}
		this._popQueue.length = 0;
		this._queuedKeys.clear();
		this._flush();
		return this;
	}

	_flush() {
		for (let i = 0; i < TF_DETAIL_TYPES.length; i++) {
			const b = this.batchers[TF_DETAIL_TYPES[i]];
			if (b !== undefined) b.flush();
		}
		this._dirty = false;
	}

	/** Кадровый тик: ветер + очередь заселения/синхронизации в пределах budgetMs. */
	update(dt) {
		if (dt > 0 && Number.isFinite(dt)) this._timeUniform.value += dt;
		if (this._popQueue.length > 0) {
			const t0 = _tfNow();
			while (this._popQueue.length > 0) {
				const job = this._popQueue.shift();
				this._queuedKeys.delete(job.key);
				if (this.streamer !== null && !this.streamer.chunks.has(job.key)) continue;
				const ring = this.ringOf(job.cx, job.cz);
				const rec = this._items.get(job.key);
				if (job.mode === 'full') {
					if (rec !== undefined) this.removeChunk(job.cx, job.cz);
					this._populateNow(job.cx, job.cz, job.key);
				} else if (job.mode === 'sync') {
					if (rec === undefined) continue;
					this._syncChunk(job.cx, job.cz, job.key, ring);
				} else {
					if (rec !== undefined) continue;
					this._populateNow(job.cx, job.cz, job.key);
				}
				if (_tfNow() - t0 > this.budgetMs) break;
			}
			this.stats.queued = this._popQueue.length;
		}
		if (this._dirty) this._flush();
		return this;
	}

	dispose() {
		if (this.streamer !== null) {
			this.streamer.removeEventListener('chunkbuilt', this._boundBuilt);
			this.streamer.removeEventListener('chunkremoved', this._boundRemoved);
		}
		this.clear();
		for (let i = 0; i < TF_DETAIL_TYPES.length; i++) {
			const b = this.batchers[TF_DETAIL_TYPES[i]];
			if (b !== undefined) b.dispose();
		}
		for (let i = 0; i < this._owned.length; i++) {
			const res = this._owned[i];
			if (res !== null && typeof res.dispose === 'function') res.dispose();
		}
		this._owned.length = 0;
		this.batchers = {};
	}
};

const TF_WATER_WAVES_GLSL = `
uniform float uTime;
uniform vec4 uWaves[ 4 ];    // (kx, ky, amplitude, |k|)
uniform vec4 uWaveSpeeds;    // фазовая скорость каждой волны

float tfWaterH( vec2 p ) {
	float h = 0.0;
	for ( int i = 0; i < 4; i ++ ) {
		h += sin( dot( p, uWaves[ i ].xy ) + uTime * uWaveSpeeds[ i ] ) * uWaves[ i ].z;
	}
	return h;
}

// Нормаль — производные той же суммы (gloss-блик не «рвётся» на стыках).
// crest — нормированная «гребёнчатость» для пены.
vec3 tfWaterNormal( vec2 p, float nrmScale, out float crest ) {
	vec2 d = vec2( 0.0 );
	crest = 0.0;
	float ampK = 0.0;
	for ( int i = 0; i < 4; i ++ ) {
		float ph = dot( p, uWaves[ i ].xy ) + uTime * uWaveSpeeds[ i ];
		d += uWaves[ i ].xy * ( cos( ph ) * uWaves[ i ].z );
		crest += max( sin( ph ), 0.0 ) * uWaves[ i ].z * uWaves[ i ].w;
		ampK += uWaves[ i ].z * uWaves[ i ].w;
	}
	crest = ampK > 0.0 ? crest / ampK : 0.0;
	return normalize( vec3( - d.x * nrmScale, 1.0, - d.y * nrmScale ) );
}
`;

const TF_WATER_VERT = `
uniform float uVertWaveAmp;
varying vec3 vWPos;
varying float vViewDepth;
${TF_WATER_WAVES_GLSL}
void main() {
	vec4 wp = modelMatrix * vec4( position, 1.0 );
	if ( uVertWaveAmp > 0.0 ) {
		// вершинные волны у камеры; у краёв плоскости гасятся — нет шва
		// с берегом и «кипения» сетки вдали (там хватит нормалей фрагмента)
		float fade = 1.0 - smoothstep( 20.0, 150.0, length( cameraPosition.xz - wp.xz ) );
		wp.y += tfWaterH( wp.xz ) * uVertWaveAmp * fade;
	}
	vWPos = wp.xyz;
	vec4 mv = viewMatrix * wp;
	vViewDepth = - mv.z;
	gl_Position = projectionMatrix * mv;
}
`;

const TF_WATER_FRAG = `
varying vec3 vWPos;
varying float vViewDepth;
uniform vec3 uDeepColor;
uniform vec3 uShallowColor;
uniform vec3 uFoamColor;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uSunIntensity;
uniform vec3 uTint;
uniform float uShadowFade;
uniform vec4 uParams;      // (normalStrength, foamScale, opacity, specStrength)
uniform vec4 uParams2;     // (gloss, skyGlow, foamThreshold, shoreRange)
uniform vec4 uShoreParams; // (worldSize>0 — включено, centerX, centerZ, reserved)
uniform sampler2D uShoreMap;
${TF_WATER_WAVES_GLSL}
${TF_FOG_GLSL}

void main() {
	vec3 V = normalize( cameraPosition - vWPos );
	float crest = 0.0;
	vec3 N = tfWaterNormal( vWPos.xz, uParams.x, crest );
	float fres = pow( clamp( 1.0 - max( dot( N, V ), 0.0 ), 0.0, 1.0 ), 5.0 );
	fres = 0.02 + 0.98 * fres;
	vec3 sunDir = normalize( uSunDir + vec3( 0.0, 1e-4, 0.0 ) );
	float sunUp = smoothstep( -0.06, 0.10, sunDir.y );

	// отражённое небо: процедурный градиент + ореол солнца
	vec3 R = reflect( - V, N );
	vec3 sky = mix( uHorizon, uZenith, smoothstep( -0.08, 0.55, R.y ) );
	sky += uSunColor * ( pow( max( dot( R, sunDir ), 0.0 ), 24.0 ) * uParams2.y * uSunIntensity * sunUp );

	// толща: у камеры мель (прозрачнее), вдали глубина
	float dist = length( cameraPosition - vWPos );
	vec3 body = mix( uShallowColor, uDeepColor, smoothstep( 6.0, 130.0, dist ) );

	// солнечный блик («дорожка»): узкий Phong по полусфере волн
	vec3 H = normalize( V + sunDir );
	float spec = pow( max( dot( N, H ), 0.0 ), uParams2.x );
	spec *= uParams.w * uSunIntensity * sunUp * ( 0.75 + 0.25 * uShadowFade );

	// пена: гребни волн + береговая полоса по shore-карте высот (если есть).
	// Ветвление заменено на step-маски: texture2D вне однородного потока
	// дала бы производные-артефакты на границе ветви.
	float foamC = smoothstep( uParams2.z, min( uParams2.z + 0.24, 1.0 ), crest ) * uParams.y;
	vec2 suv = ( vWPos.xz - uShoreParams.yz ) / max( uShoreParams.x, 1e-4 ) + 0.5;
	float inShore = step( 0.0, suv.x ) * step( suv.x, 1.0 ) * step( 0.0, suv.y ) * step( suv.y, 1.0 ) * step( 0.5, uShoreParams.x );
	float dh = ( texture2D( uShoreMap, clamp( suv, 0.0, 1.0 ) ).r * 2.0 - 1.0 ) * uParams2.w;
	float foamS = smoothstep( -0.9, -0.2, dh ) * ( 1.0 - smoothstep( 0.25, 1.0, dh ) ) * inShore * uParams.y * 1.1;
	float foam = clamp( foamC + foamS, 0.0, 1.0 );

	vec3 col = mix( body, sky, fres ) * uTint;
	col += uSunColor * spec;
	col = mix( col, uFoamColor * uTint, foam );
	float alpha = clamp( uParams.z + fres * 0.55 + foam * 0.5, 0.0, 1.0 );
	if ( ! gl_FrontFacing ) {
		// взгляд из-под воды: мутный «потолок» (FogManager.submerge доработает)
		col = mix( uDeepColor * 0.4, uShallowColor * 0.55, 0.4 ) * uTint;
		alpha = max( alpha, 0.86 );
	}
	gl_FragColor = vec4( col, alpha );
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
	// туман движка — ПОСЛЕ тонмаппинга/sRGB (конвенция FogManager 'srgb';
	// с PostPipeline ('linear') чанки выше — no-op, и микс остаётся линейным)
	gl_FragColor.rgb = tfApplyFog( gl_FragColor.rgb, vWPos, vViewDepth );
}
`;

const TF_WATER_DEFAULT_WAVES = [
	{ direction: 0.35, length: 38, amplitude: 0.16, speed: 1.1 },
	{ direction: 1.31, length: 17, amplitude: 0.09, speed: 1.5 },
	{ direction: 2.53, length: 9, amplitude: 0.045, speed: 2.0 },
	{ direction: 4.02, length: 4.6, amplitude: 0.02, speed: 2.7 }
];

const _wsCamPos = new Vector3();

/**
 * Shore-карта высот для береговой пены: R = (height - level)/range*0.5 + 0.5.
 * Печётся из Terrain один раз (или периодически) вокруг центра мира/игрока.
 * @param {Terrain} terrain
 * @param {{centerX?:number, centerZ?:number, worldSize?:number, size?:number, range?:number, level?:number, yOffset?:number}} [options]
 * @returns {THREE.DataTexture}
 */
function createShoreHeightTexture(terrain, options = {}) {
	if (terrain === undefined || terrain === null || typeof terrain.height !== 'function') {
		console.warn('ThreeForge: createShoreHeightTexture — нужен Terrain (или объект с height(x,z))');
		return _tfGetWhiteTex();
	}
	const n = Math.max(8, options.size !== undefined ? options.size : 256);
	const worldSize = options.worldSize !== undefined ? options.worldSize : 512;
	const cx = options.centerX !== undefined ? options.centerX : 0;
	const cz = options.centerZ !== undefined ? options.centerZ : 0;
	const level = options.level !== undefined ? options.level : terrain.waterLevel;
	const range = options.range !== undefined ? options.range : 10;
	const yOffset = options.yOffset !== undefined ? options.yOffset : 0;
	const data = new Uint8Array(n * n * 4);
	const half = worldSize * 0.5;
	const invRange = 1 / (range > 1e-6 ? range : 1e-6);
	for (let y = 0; y < n; y++) {
		const wz = cz - half + (y + 0.5) / n * worldSize;
		for (let x = 0; x < n; x++) {
			const wx = cx - half + (x + 0.5) / n * worldSize;
			const h = terrain.height(wx, wz) + yOffset - level;
			const r = Math.min(1, Math.max(0, h * invRange * 0.5 + 0.5));
			const o = (y * n + x) * 4;
			data[o] = Math.round(r * 255);
			data[o + 1] = data[o]; data[o + 2] = data[o]; data[o + 3] = 255;
		}
	}
	const tex = new DataTexture(data, n, n, RGBAFormat, UnsignedByteType);
	tex.wrapS = tex.wrapT = ClampToEdgeWrapping;
	tex.minFilter = LinearFilter;
	tex.magFilter = LinearFilter;
	tex.generateMipmaps = false;
	tex.needsUpdate = true;
	return tex;
}

const WaterSurface = class extends Mesh {
	/**
	 * @param {object} [options]
	 * @param {number} [options.level=0] уровень воды (waterLevel террейна).
	 * @param {number} [options.size=1400] размер плоскости (мировые единицы).
	 * @param {number} [options.segments=96] сегменты сетки (для вершинных волн).
	 * @param {object|null} [options.follow] камера/Object3D/Vector3/{position:Vector3} —
	 *   плоскость следует за ним со снапом на ячейку (волны мировые — фаза не плывёт).
	 * @param {Array} [options.waves] 4 волны: {direction (рад) ИЛИ dir {x,y},
	 *   length (длина волны), amplitude, speed}. Меньше 4 — дополнятся дефолтом.
	 * @param {boolean} [options.vertexWaves=true] вершинное смещение у камеры.
	 * @param {number} [options.vertexWaveAmp=1] амплитуда вершинных волн
	 *   (vertexWaves=false → 0) (R3).
	 * @param {FogManager|null} [options.fog] общие униформы тумана движка.
	 * @param {SunCycle|null} [options.sunCycle] bindSunCycle сразу.
	 * @param {THREE.Vector3} [options.sunDir] направление солнца (или живой объект).
	 * Цвета: colorDeep, colorShallow, colorFoam, zenith, horizon.
	 * Параметры: normalStrength, foamScale, opacity, specStrength, gloss,
	 * skyGlow, foamThreshold, shoreRange, depthWrite, renderOrder, timeScale.
	 */
	constructor(options = {}) {
		const size = options.size !== undefined ? options.size : 1400;
		const segments = Math.max(1, options.segments !== undefined ? options.segments : 96);
		const geometry = new THREE.PlaneGeometry(size, size, segments, segments);
		geometry.rotateX(-Math.PI / 2);

		const fog = options.fog !== undefined && options.fog !== null ? options.fog : null;
		if (fog !== null && fog.uniforms === undefined) {
			console.warn('ThreeForge: WaterSurface — options.fog без .uniforms (нужен FogManager); вода останется без тумана');
		}
		const fogU = fog !== null && fog.uniforms !== undefined ? fog.uniforms : _tfDefaultFogUniforms();

		const uniforms = {
			uTime: { value: 0 },
			uWaves: { value: [new Vector4(), new Vector4(), new Vector4(), new Vector4()] },
			uWaveSpeeds: { value: new Vector4(1, 1, 1, 1) },
			uVertWaveAmp: { value: 1 },
			uDeepColor: { value: new Color(options.colorDeep !== undefined ? options.colorDeep : 0x0d3244) },
			uShallowColor: { value: new Color(options.colorShallow !== undefined ? options.colorShallow : 0x2f7f92) },
			uFoamColor: { value: new Color(options.colorFoam !== undefined ? options.colorFoam : 0xe8f2f4) },
			uZenith: { value: new Color(options.zenith !== undefined ? options.zenith : 0x3f6fb5) },
			uHorizon: { value: new Color(options.horizon !== undefined ? options.horizon : 0x9fc0dd) },
			uSunDir: { value: options.sunDir !== undefined && options.sunDir !== null ? options.sunDir : new Vector3(0.4, 0.6, 0.2).normalize() },
			uSunColor: { value: new Color(0xfff4e2) },
			uSunIntensity: { value: options.sunIntensity !== undefined ? options.sunIntensity : 3.0 },
			uTint: { value: new Color(1, 1, 1) },
			uShadowFade: { value: 1 },
			uParams: { value: new Vector4(
				options.normalStrength !== undefined ? options.normalStrength : 1.0,
				options.foamScale !== undefined ? options.foamScale : 0.8,
				options.opacity !== undefined ? options.opacity : 0.42,
				options.specStrength !== undefined ? options.specStrength : 0.55) },
			uParams2: { value: new Vector4(
				options.gloss !== undefined ? options.gloss : 380,
				options.skyGlow !== undefined ? options.skyGlow : 0.35,
				options.foamThreshold !== undefined ? options.foamThreshold : 0.62,
				options.shoreRange !== undefined ? options.shoreRange : 10) },
			uShoreParams: { value: new Vector4(0, 0, 0, 0) },
			uShoreMap: { value: _tfGetWhiteTex() },
			tfFogColor: fogU.tfFogColor,
			tfFogParams: fogU.tfFogParams,
			tfFogHeight: fogU.tfFogHeight,
			tfFogInscatter: fogU.tfFogInscatter,
			tfFogSunDir: fogU.tfFogSunDir
		};
		const material = new ShaderMaterial({
			uniforms,
			vertexShader: TF_WATER_VERT,
			fragmentShader: TF_WATER_FRAG,
			transparent: true,
			side: DoubleSide,
			depthWrite: options.depthWrite !== undefined ? options.depthWrite : true,
			fog: false
		});
		material.name = 'tfWaterMaterial';
		super(geometry, material);
		this.name = 'tfWaterSurface';
		this.renderOrder = options.renderOrder !== undefined ? options.renderOrder : -1;

		this.uniforms = uniforms;
		this.size = size;
		this.segments = segments;
		this.cellSize = size / segments;
		this.level = options.level !== undefined ? options.level : 0;
		this.time = 0;
		this.timeScale = options.timeScale !== undefined ? options.timeScale : 1;
		this.follow = options.follow !== undefined ? options.follow : null;
		this._waves = [];
		this.setWaves(options.waves);
		this.uniforms.uVertWaveAmp.value = options.vertexWaves === false
			? 0
			: (options.vertexWaveAmp !== undefined ? options.vertexWaveAmp : 1);
		this.position.y = this.level;
		if (options.sunCycle !== undefined && options.sunCycle !== null) this.bindSunCycle(options.sunCycle);
	}

	/**
	 * Волны: [{direction (радианы) | dir: {x,y}, length, amplitude, speed}] —
	 * до 4 штук (недостающие — из TF_WATER_DEFAULT_WAVES).
	 */
	setWaves(list) {
		const src = list !== undefined && list !== null ? list : [];
		const waves = [];
		const uW = this.uniforms.uWaves.value;
		const uS = this.uniforms.uWaveSpeeds.value;
		for (let i = 0; i < 4; i++) {
			const w = src[i] !== undefined && src[i] !== null ? src[i] : TF_WATER_DEFAULT_WAVES[i];
			let dx, dy;
			if (w.dir !== undefined && w.dir !== null) {
				dx = w.dir.x !== undefined ? w.dir.x : w.dir[0];
				dy = w.dir.y !== undefined ? w.dir.y : w.dir[1];
			} else {
				const a = w.direction !== undefined ? w.direction : TF_WATER_DEFAULT_WAVES[i].direction;
				dx = Math.cos(a); dy = Math.sin(a);
			}
			if (!(Number.isFinite(dx) && Number.isFinite(dy))) { dx = 1; dy = 0; }
			const l = Math.sqrt(dx * dx + dy * dy);
			if (l > 1e-6) { dx /= l; dy /= l; } else { dx = 1; dy = 0; }
			const len = Math.max(0.5, w.length !== undefined ? w.length : TF_WATER_DEFAULT_WAVES[i].length);
			const k = Math.PI * 2 / len;
			const amp = Math.max(0, w.amplitude !== undefined ? w.amplitude : TF_WATER_DEFAULT_WAVES[i].amplitude);
			const speed = w.speed !== undefined ? w.speed : TF_WATER_DEFAULT_WAVES[i].speed;
			waves.push({ kx: dx * k, ky: dy * k, amp, speed });
			uW[i].set(dx * k, dy * k, amp, k);
			uS.setComponent(i, Number.isFinite(speed) ? speed : 1);
		}
		this._waves = waves;
		return this;
	}

	setLevel(y) {
		if (Number.isFinite(y)) {
			this.level = y;
			this.position.y = y;
		}
		return this;
	}

	/**
	 * Подключить SunCycle: контракт waterUniforms (uSunColor/uSunIntensity/
	 * uTint/uShadowFade пишет сам цикл) + живые sunDirection/zenith/horizon.
	 */
	bindSunCycle(cycle) {
		if (cycle === undefined || cycle === null) return this;
		if (cycle.sunDirection !== undefined && cycle.sunDirection !== null) this.uniforms.uSunDir.value = cycle.sunDirection;
		if (cycle.zenithColor !== undefined && cycle.zenithColor !== null) this.uniforms.uZenith.value = cycle.zenithColor;
		if (cycle.horizonColor !== undefined && cycle.horizonColor !== null) this.uniforms.uHorizon.value = cycle.horizonColor;
		cycle.waterUniforms = this.uniforms;
		this._sunCycle = cycle;
		return this;
	}

	unbindSunCycle() {
		if (this._sunCycle !== undefined && this._sunCycle !== null && this._sunCycle.waterUniforms === this.uniforms) {
			this._sunCycle.waterUniforms = null;
		}
		this._sunCycle = null;
		return this;
	}

	/** Береговая пена: shore-карта высот (createShoreHeightTexture) +.rect мира. */
	setShoreHeightTexture(texture, rect) {
		if (texture === undefined || texture === null || rect === undefined || rect === null) return this;
		this.uniforms.uShoreMap.value = texture;
		this.uniforms.uShoreParams.value.set(
			rect.worldSize !== undefined ? rect.worldSize : 512,
			rect.centerX !== undefined ? rect.centerX : 0,
			rect.centerZ !== undefined ? rect.centerZ : 0,
			0);
		if (rect.range !== undefined) this.uniforms.uParams2.value.w = rect.range;
		return this;
	}

	/** Высота волн в мировой точке — JS-зеркало tfWaterH (тот же порядок ops). */
	heightAt(x, z, t) {
		const time = t !== undefined ? t : this.time;
		const w = this._waves;
		let h = 0;
		for (let i = 0; i < w.length; i++) {
			h += Math.sin(x * w[i].kx + z * w[i].ky + time * w[i].speed) * w[i].amp;
		}
		return this.level + h;
	}

	isUnderwater(cameraOrY) {
		const y = cameraOrY !== undefined && cameraOrY !== null
			? (cameraOrY.position !== undefined ? cameraOrY.position.y : cameraOrY)
			: this.level + 1;
		return y < this.level;
	}

	/** Кадровый тик (система Engine): время волн + follow за камерой. */
	update(dt) {
		if (!(dt > 0) || !Number.isFinite(dt)) dt = 0;
		this.time += dt * this.timeScale;
		this.uniforms.uTime.value = this.time;
		const f = this.follow;
		if (f !== null && f !== undefined) {
			if (f.isObject3D === true) f.getWorldPosition(_wsCamPos);
			else if (f.position !== undefined && f.position !== null && f.position.isVector3 === true) _wsCamPos.copy(f.position);
			else _wsCamPos.copy(f);
			if (!Number.isFinite(_wsCamPos.x) || !Number.isFinite(_wsCamPos.z)) return this;
			const cell = this.cellSize;
			this.position.x = Math.round(_wsCamPos.x / cell) * cell;
			this.position.z = Math.round(_wsCamPos.z / cell) * cell;
			this.position.y = this.level;
		}
		return this;
	}

	dispose() {
		this.unbindSunCycle();
		if (this.parent !== null && this.parent !== undefined) this.parent.remove(this);
		this.geometry.dispose();
		this.material.dispose();
	}
};

/**
 * @param {object} [options]
 * Сцена/ядро: scene, camera, engine, physics (PhysicsWorld), fog (FogManager),
 *   sunCycle (или lights — риг createLightRig: возьмётся lights.cycle),
 *   group (своя группа; иначе создаётся и добавляется в scene), yOffset.
 * Рельеф: terrain — Terrain-инстанс ИЛИ объект параметров Terrain
 *   (seed/scale/amplitude/octaves/ridgeMix/waterLevel/palette — читаются и из
 *   плоских options).
 * Стример: streamer — объект опций TerrainStreamer (chunkSize/viewDistance/
 *   lodRings/workers/budgetMs/skirtCells/maxInFlight/workerTimeoutMs) ИЛИ
 *   плоские поля того же имени; focus по умолчанию — camera.
 * Материал: material — Material-инстанс | false (чистый vertexColors) |
 *   объект опций createTerrainMaterial; textures — false | объект опций
 *   генерации {size, seed, mode, contrast} | готовые наборы {grass, rock, ...}.
 * Детали: details — false | объект опций TerrainDetailManager.
 * Вода: water — false | объект опций WaterSurface (follow по умолчанию camera).
 * autoPhysics — false отключает автопривязку heightfield (default true).
 * Приоритеты систем Engine: priorityStreamer/priorityDetails/priorityWater.
 * @returns {object} system — фасад (поля + методы, см. реализацию).
 */
function createTerrainSystem(options = {}) {
	const scene = options.scene !== undefined && options.scene !== null ? options.scene : null;
	const camera = options.camera !== undefined && options.camera !== null ? options.camera : null;
	const engine = options.engine !== undefined && options.engine !== null ? options.engine : null;
	const physics = options.physics !== undefined && options.physics !== null ? options.physics : null;
	const fog = options.fog !== undefined && options.fog !== null ? options.fog : null;
	const sunCycle = options.sunCycle !== undefined && options.sunCycle !== null
		? options.sunCycle
		: (options.lights !== undefined && options.lights !== null && options.lights.cycle !== undefined && options.lights.cycle !== null
			? options.lights.cycle : null);
	const ownsGroup = options.group === undefined || options.group === null;
	const group = ownsGroup ? new Group() : options.group;
	if (group.name === '' || group.name === undefined) group.name = 'tfTerrainSystem';
	if (ownsGroup && scene !== null) scene.add(group);
	const yOffset = options.yOffset !== undefined ? options.yOffset : 0;

	const tIsInstance = options.terrain !== undefined && options.terrain !== null &&
		typeof options.terrain === 'object' && typeof options.terrain.height === 'function';
	const tOpts = !tIsInstance && typeof options.terrain === 'object' && options.terrain !== null ? options.terrain : {};
	const terrain = tIsInstance ? options.terrain : new Terrain({
		seed: tOpts.seed !== undefined ? tOpts.seed : options.seed,
		scale: tOpts.scale !== undefined ? tOpts.scale : options.scale,
		amplitude: tOpts.amplitude !== undefined ? tOpts.amplitude : options.amplitude,
		octaves: tOpts.octaves !== undefined ? tOpts.octaves : options.octaves,
		ridgeMix: tOpts.ridgeMix !== undefined ? tOpts.ridgeMix : options.ridgeMix,
		waterLevel: tOpts.waterLevel !== undefined ? tOpts.waterLevel : options.waterLevel,
		palette: tOpts.palette !== undefined ? tOpts.palette : options.palette,
		scatterWeights: tOpts.scatterWeights !== undefined ? tOpts.scatterWeights : options.scatterWeights
	});

	const sOpts = options.streamer !== undefined && options.streamer !== null ? options.streamer : {};
	const matOptsIn = typeof options.material === 'object' && options.material !== null ? options.material : {};
	let material = null;
	let materialOwned = false;
	let ownedTextures = null;
	let textureSets = null;
	if (options.material !== undefined && options.material !== null && options.material.isMaterial === true) {
		material = options.material;
	} else if (options.material === false) {
		material = new MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0, dithering: true });
		material.name = 'tfTerrainFlat';
		if (fog !== null) installFogPatch(material, fog);
		materialOwned = true;
	} else {
		const matOpts = Object.assign({}, matOptsIn);
		const t = options.textures;
		if (t === false) {
			matOpts.textures = false;
		} else if (t !== undefined && t !== null && t !== true && typeof t === 'object' &&
			(t.grass !== undefined || t.rock !== undefined || t.snow !== undefined || t.sand !== undefined)) {
			matOpts.textures = t;
		} else if (t !== undefined && t !== null && typeof t === 'object') {
			if (t.size !== undefined) matOpts.textureSize = t.size;
			if (t.seed !== undefined) matOpts.textureSeed = t.seed;
			if (t.mode !== undefined) matOpts.textureMode = t.mode;
			if (t.contrast !== undefined) matOpts.textureContrast = t.contrast;
			if (t.normalStrength !== undefined) matOpts.textureNormalStrength = t.normalStrength;
			if (t.anisotropy !== undefined) matOpts.textureAnisotropy = t.anisotropy;
		}
		if (matOpts.terrain === undefined) matOpts.terrain = terrain;
		if (matOpts.yOffset === undefined) matOpts.yOffset = yOffset;
		if (matOpts.fog === undefined) matOpts.fog = fog;
		if (matOpts.sunShadow === undefined && options.sunShadow !== undefined) matOpts.sunShadow = options.sunShadow;
		if (matOpts.textureSize === undefined && options.textureSize !== undefined) matOpts.textureSize = options.textureSize;
		if (matOpts.textureSeed === undefined && options.textureSeed !== undefined) matOpts.textureSeed = options.textureSeed;
		material = createTerrainMaterial(matOpts);
		materialOwned = true;
		if (material.tfTerrain !== undefined && material.tfTerrain !== null) {
			textureSets = material.tfTerrain.sets;
			ownedTextures = material.tfTerrain.ownedTextures;
		}
	}

	const focusDefault = options.focus !== undefined && options.focus !== null ? options.focus : camera;
	const streamer = new TerrainStreamer({
		terrain,
		parent: group,
		material,
		chunkSize: sOpts.chunkSize !== undefined ? sOpts.chunkSize : options.chunkSize,
		viewDistance: sOpts.viewDistance !== undefined ? sOpts.viewDistance : options.viewDistance,
		lodRings: sOpts.lodRings !== undefined ? sOpts.lodRings : options.lodRings,
		skirtCells: sOpts.skirtCells !== undefined ? sOpts.skirtCells : options.skirtCells,
		budgetMs: sOpts.budgetMs !== undefined ? sOpts.budgetMs : options.budgetMs,
		workers: sOpts.workers !== undefined ? sOpts.workers : (options.workers !== undefined ? options.workers : 2),
		maxInFlight: sOpts.maxInFlight !== undefined ? sOpts.maxInFlight : options.maxInFlight,
		workerTimeoutMs: sOpts.workerTimeoutMs !== undefined ? sOpts.workerTimeoutMs : options.workerTimeoutMs,
		focus: sOpts.focus !== undefined && sOpts.focus !== null ? sOpts.focus : focusDefault,
		yOffset
	});

	let details = null;
	if (options.details !== false) {
		const dOpts = typeof options.details === 'object' && options.details !== null ? options.details : {};
		details = new TerrainDetailManager(Object.assign({
			terrain, streamer, parent: group, yOffset,
			fog: dOpts.fog !== undefined ? dOpts.fog : fog
		}, dOpts));
	}

	let water = null;
	if (options.water !== false && terrain.waterLevel !== undefined) {
		const wOpts = typeof options.water === 'object' && options.water !== null ? options.water : {};
		water = new WaterSurface(Object.assign({
			level: terrain.waterLevel + yOffset,
			follow: wOpts.follow !== undefined ? wOpts.follow : camera,
			fog,
			size: wOpts.size !== undefined ? wOpts.size : Math.max(800, streamer.chunkSize * (streamer.viewDistance * 2 + 4))
		}, wOpts));
		group.add(water);
		if (sunCycle !== null) water.bindSunCycle(sunCycle);
	}

	if (fog !== null) {
		fog.waterLevel = terrain.waterLevel + yOffset;
		if (scene !== null && (scene.fog === undefined || scene.fog === null)) {
			scene.fog = new THREE.Fog(0x9fc0dd, 60, 448);
		}
	}
	let physicsBound = null;
	const heightFn = (x, z) => terrain.height(x, z) + yOffset;
	if (physics !== null && options.autoPhysics !== false) {
		physics.setHeightfield(heightFn);
		physicsBound = physics;
	}
	if (engine !== null) {
		engine.addSystem(streamer, options.priorityStreamer !== undefined ? options.priorityStreamer : 10);
		if (details !== null) engine.addSystem(details, options.priorityDetails !== undefined ? options.priorityDetails : 20);
		if (water !== null) engine.addSystem(water, options.priorityWater !== undefined ? options.priorityWater : 30);
	}

	const _snapV3 = new Vector3();
	const system = {
		group, terrain, streamer, material, details, water,
		textures: textureSets,
		engine, scene, camera,
		focus: streamer.focus,

		get waterLevel() { return terrain.waterLevel + yOffset; },
		get yOffset() { return yOffset; },

		/** Аналитическая высота рельефа (без yOffset). */
		height(x, z) { return terrain.height(x, z); },
		/** Высота ВИДИМОЙ поверхности (с yOffset). */
		groundHeight(x, z) { return terrain.height(x, z) + yOffset; },
		normal(x, z, out, eps) { return terrain.normal(x, z, out !== undefined ? out : _snapV3, eps); },
		/** Высота воды с волнами (или уровень, если воды нет). */
		waterHeightAt(x, z, t) { return water !== null ? water.heightAt(x, z, t) : terrain.waterLevel + yOffset; },
		/** Поставить Object3D/Vector3 на рельеф. clearance — зазор вверх. */
		snapToGround(target, clearance = 0) {
			if (target === undefined || target === null) return target;
			if (target.isObject3D === true) {
				target.position.y = terrain.height(target.position.x, target.position.z) + yOffset + clearance;
			} else if (target.y !== undefined) {
				target.y = terrain.height(target.x, target.z) + yOffset + clearance;
			}
			return target;
		},
		/** Сменить фокус стримера (и колец LOD растительности). */
		setFocus(f) {
			streamer.focus = f;
			this.focus = f;
			return this;
		},
		bindPhysics(p) {
			const world = p !== undefined && p !== null ? p : physics;
			if (world !== null && typeof world.setHeightfield === 'function') {
				world.setHeightfield(heightFn);
				physicsBound = world;
			}
			return this;
		},
		unbindPhysics() {
			if (physicsBound !== null && typeof physicsBound.setHeightfield === 'function') {
				if (physicsBound.heightfield === heightFn) physicsBound.setHeightfield(null);
				physicsBound = null;
			}
			return this;
		},
		/** Ручной тик (когда Engine не передан — системы не зарегистрированы). */
		update(dt) {
			if (engine !== null) return this;
			streamer.update();
			if (details !== null) details.update(dt);
			if (water !== null) water.update(dt);
			return this;
		},
		dispose() {
			if (engine !== null) {
				engine.removeSystem(streamer);
				if (details !== null) engine.removeSystem(details);
				if (water !== null) engine.removeSystem(water);
			}
			if (details !== null) details.dispose();
			streamer.dispose();
			if (water !== null) water.dispose();
			this.unbindPhysics();
			if (materialOwned && material !== null) material.dispose();
			if (ownedTextures !== null) {
				for (let i = 0; i < ownedTextures.length; i++) {
					if (ownedTextures[i] !== null && typeof ownedTextures[i].dispose === 'function') ownedTextures[i].dispose();
				}
			}
			if (ownsGroup && group.parent !== null && group.parent !== undefined) group.parent.remove(group);
		}
	};
	return system;
}

const TF_SKY_VERT = `
varying vec3 vTfSkyDir;
void main() {
	vec4 wp = modelMatrix * vec4( position, 1.0 );
	vTfSkyDir = wp.xyz - cameraPosition;
	gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const TF_SKY_FRAG = `
varying vec3 vTfSkyDir;

// --- контракт SunCycle (часть 1.5, _apply) ---
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uSunColor;
uniform float uSunIntensity;
uniform float uNightFactor;
// --- контракт FogManager (часть 1.75, _commit): количество + общий цвет ---
uniform float uSkyFogAmt;
uniform vec3 tfFogColor;
// --- H1 (v2.9): горизонтальная вуаль: полоса у горизонта сходится к tfFogColor
// --- независимо от uSkyFogAmt (см. секцию 7) ---
uniform float uHorizonVeil;
uniform float uVeilHeight;
// --- контракт WeatherManager (часть 1.9, _updateLightning) ---
uniform float uFlash;
uniform vec3 uFlashColor;
// --- живые векторы SunCycle (bindSunCycle) ---
uniform vec3 uSunDir;
uniform vec3 uMoonDir;
// --- вид ---
uniform float uTime;
uniform vec4 uSunParams;    // (угловой радиус диска [рад], power ореола, сила ореола, HDR диска)
uniform vec4 uMoonParams;   // (угловой радиус [рад], широкий ореол, яркость, «моря»)
uniform vec4 uStarParams;   // (плотность, яркость, скорость мерцания, глубина мерцания)
uniform vec4 uStarParams2;  // (масштаб слоя A, масштаб слоя B, яркость B, цветовая температура)
uniform vec4 uSkyParams;    // (gradStart, gradEnd, закатное свечение, затемнение под горизонтом)

// Хеш Dave Hoskins (13/12): дешёвый, без видимой решётки.
float tfSkyHash13( vec3 p3 ) {
	p3 = fract( p3 * 0.1031 );
	p3 += dot( p3, p3.zyx + 31.32 );
	return fract( ( p3.x + p3.y ) * p3.z );
}
float tfSkyHash12( vec2 p ) {
	vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
	p3 += dot( p3, p3.yzx + 33.33 );
	return fract( ( p3.x + p3.y ) * p3.z );
}
float tfSkyNoise2( vec2 p ) {
	vec2 i = floor( p ), f = fract( p );
	vec2 u = f * f * ( 3.0 - 2.0 * f );
	float a = tfSkyHash12( i );
	float b = tfSkyHash12( i + vec2( 1.0, 0.0 ) );
	float c = tfSkyHash12( i + vec2( 0.0, 1.0 ) );
	float d = tfSkyHash12( i + vec2( 1.0, 1.0 ) );
	return mix( mix( a, b, u.x ), mix( c, d, u.x ), u.y );
}

// Слой звёзд: хеш-ячейки на решётке направлений; звезда всегда внутри своей
// ячейки (центр 0.3..0.7, радиус ядра ≤ 0.26) — соседние ячейки не нужны, швов нет.
vec3 tfStarsLayer( vec3 dir, float scale, float thresh, float bright ) {
	vec3 q = dir * scale;
	vec3 cell = floor( q );
	vec3 f = q - cell;
	if ( tfSkyHash13( cell ) < thresh ) return vec3( 0.0 );   // когерентная ветвь: ячейка пуста
	vec3 pt = 0.3 + 0.4 * vec3(
		tfSkyHash13( cell + 1.7 ),
		tfSkyHash13( cell + 3.1 ),
		tfSkyHash13( cell + 5.3 ) );
	float d = length( f - pt );
	float core = 1.0 - smoothstep( 0.0, 0.26, d );
	core *= core;
	// мерцание: фаза и «характер» — из хеша ячейки (детерминированно)
	float ph = tfSkyHash13( cell + 7.9 ) * 6.2831853;
	float tw = 1.0 - uStarParams.w * ( 0.5 - 0.5 * sin( uTime * uStarParams.z + ph ) );
	float b = mix( 0.3, 1.0, pow( tfSkyHash13( cell + 9.2 ), 1.6 ) ) * bright * tw;
	// температура: часть звёзд тёплые/холодные (uStarParams2.w — доля цветных)
	vec3 tint = mix( vec3( 1.0 ), mix( vec3( 1.0, 0.85, 0.7 ), vec3( 0.72, 0.83, 1.0 ),
		tfSkyHash13( cell + 11.4 ) ), uStarParams2.w );
	return tint * ( core * b );
}

void main() {
	vec3 dir = normalize( vTfSkyDir );
	float up = dir.y;
	vec3 sunDir = normalize( uSunDir );
	vec3 moonDir = normalize( uMoonDir );
	float amt = clamp( uSkyFogAmt, 0.0, 1.0 );
	// S1: светила — прямой свет, в мгле гаснут раньше рассеянного градиента
	float celFade = pow( 1.0 - amt, 1.6 );

	// --- 1. градиент зенит → горизонт ---
	float g = smoothstep( uSkyParams.x, uSkyParams.y, up );
	vec3 col = mix( uHorizon, uZenith, g );
	col *= mix( 1.0, uSkyParams.w, smoothstep( -0.01, -0.35, up ) );

	// --- 2. закатное свечение (sunsetFactor 1:1 с SunCycle._compute) ---
	float se = sunDir.y;
	float ss = ( se - 0.03 ) / 0.11;
	float sunset = exp( - ss * ss );
	vec3 sunFlat = normalize( vec3( sunDir.x, 0.0, sunDir.z ) + vec3( 1e-5 ) );
	vec3 dirFlat = normalize( vec3( dir.x, 0.0, dir.z ) + vec3( 1e-5 ) );
	float azim = max( dot( dirFlat, sunFlat ), 0.0 );
	float bandUp = up / ( 0.09 + 0.13 * sunset );
	float band = exp( - bandUp * bandUp );
	col += uSunColor * ( sunset * azim * azim * azim * band * uSkyParams.z * ( 1.0 - amt * 0.85 ) );

	// --- 3. солнце: диск + ореол (HDR) ---
	float sunVis = smoothstep( -0.14, -0.03, se );
	float cosSun = max( dot( dir, sunDir ), 0.0 );
	float angSun = length( cross( dir, sunDir ) );   // ≈ sin(угла) — точнее у нуля, чем acos
	float sR = uSunParams.x;
	float disk = 1.0 - smoothstep( sR * 0.82, sR, angSun );
	// яркость диска НЕ гаснет синхронно uSunIntensity: на закате диск остаётся
	// ярким пятном (mix 0.45..1.5), пока не сядет за горизонт (sunVis)
	float diskAmp = uSunParams.w * mix( 0.45, 1.5, clamp( uSunIntensity / 3.3, 0.0, 1.0 ) ) * sunVis * celFade;
	col += uSunColor * ( disk * diskAmp );
	float haloAmp = uSunParams.z * sunVis *
		( 0.4 + 0.6 * clamp( uSunIntensity * 0.45, 0.0, 1.0 ) ) * celFade;
	col += uSunColor * ( pow( cosSun, uSunParams.y ) * haloAmp );

	// --- 4. луна: диск + «моря» + ореолы ---
	float night = clamp( uNightFactor, 0.0, 1.0 );
	float mVis = smoothstep( -0.06, 0.02, moonDir.y ) * night;
	if ( mVis > 0.002 ) {
		float cosM = max( dot( dir, moonDir ), 0.0 );
		float angM = length( cross( dir, moonDir ) );
		float mR = uMoonParams.x;
		float mDisk = 1.0 - smoothstep( mR * 0.9, mR, angM );
		// касательный базис луны → UV диска для «морей»
		vec3 mUp3 = abs( moonDir.y ) < 0.9 ? vec3( 0.0, 1.0, 0.0 ) : vec3( 1.0, 0.0, 0.0 );
		vec3 mt = normalize( cross( mUp3, moonDir ) );
		vec3 mb = cross( moonDir, mt );
		vec2 muv = vec2( dot( dir, mt ), dot( dir, mb ) ) / max( mR, 1e-4 );
		float mare = tfSkyNoise2( muv * 5.5 ) * 0.65 + tfSkyNoise2( muv * 13.5 ) * 0.35;
		vec3 moonCol = vec3( 0.84, 0.89, 1.0 );
		col += moonCol * ( mDisk * ( 1.0 - uMoonParams.w * ( 1.0 - mare ) ) * uMoonParams.z * mVis * celFade );
		col += vec3( 0.55, 0.65, 0.95 ) * ( pow( cosM, 260.0 ) * 0.5 + pow( cosM, 26.0 ) * uMoonParams.y ) * mVis * celFade;
	}

	// --- 5. звёзды (ночь, выше горизонта, не в закатной полосе) ---
	float starVis = night * smoothstep( -0.03, 0.22, up ) * celFade *
		( 1.0 - 0.8 * sunset * band * azim );
	if ( starVis > 0.002 ) {
		float dens = clamp( uStarParams.x, 0.0, 1.0 );
		vec3 sA = tfStarsLayer( dir, uStarParams2.x, 1.0 - dens * 0.021, 1.0 );
		vec3 sB = tfStarsLayer( dir, uStarParams2.y, 1.0 - dens * 0.012, uStarParams2.z );
		col += ( sA + sB ) * ( uStarParams.y * starVis );
	}

	// --- 6. молния (линейный аддитив — тонмаппинг сожмёт до «белой» вспышки) ---
	float fl = uFlash * ( 1.0 - amt * 0.55 );
	if ( fl > 0.001 ) {
		float hz = 1.0 - smoothstep( -0.05, 0.6, up );
		col += uFlashColor * ( fl * ( 1.6 + 1.4 * hz ) );
	}

	// --- 7. вывод: линейный → тонмаппинг → sRGB → скай-туман (конвенция воды) ---
	gl_FragColor = vec4( col, 1.0 );
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
	// S1: нелинейная маска — горизонт затягивает первым (×1.25 у горизонта,
	// ×0.35 у зенита), но pow(amt,4) догоняет зенит: dense (0.85) → зенит ≈0.82,
	// под водой (0.92) → 1.0. В густом тумане небо — сплошной цвет тумана:
	// ни горизонта, ни светил (celFade) не прорисовывается.
	float hMask = 1.0 - smoothstep( -0.06, 0.5, up );
	float fogMask = clamp( amt * ( hMask * 1.25 + 0.35 ) + pow( amt, 4.0 ), 0.0, 1.0 );
	// H1 (v2.9): горизонтальная вуаль. Террейн у горизонта затуманен ДО КОНЦА
	// (linear/exp2-фог на бесконечности = 1) и равен tfFogColor в sRGB-конвенции;
	// без вуали его силуэт жёстко обрезается о цвет неба (ночью skyFog ≈ 0 —
	// разрыв максимален). Вуаль = 1 чуть ниже горизонта и плавно (квадратично)
	// сходит к 0 к uVeilHeight: непрерывность C0 на линии силуэта при любом
	// uSkyFogAmt. Звёзды/закат в полосе вуали приглушаются — физично (экстинкция).
	float veil = uHorizonVeil * ( 1.0 - smoothstep( -0.02, uVeilHeight, up ) );
	veil *= veil;
	fogMask = clamp( max( fogMask, veil ), 0.0, 1.0 );
	gl_FragColor.rgb = mix( gl_FragColor.rgb, tfFogColor, fogMask );
}
`;

const _sdCamPos = new Vector3();

const SkyDome = class extends Mesh {
	/**
	 * @param {object} [options]
	 * @param {number} [options.radius=2400] радиус купола (мировые единицы;
	 *   реальный размер = 0.98·camera.far — scale ставит follow/FogManager).
	 * @param {number} [options.segments=32] тесселяция сферы (всё считает
	 *   фрагментный шейдер по направлению — сетка нужна только гладкая).
	 * @param {THREE.PerspectiveCamera|object|null} [options.follow] камера —
	 *   купол следует за ней (позиция) и масштабируется под 0.98·far (autoScale).
	 * @param {boolean} [options.autoScale=true] масштабировать под camera.far.
	 * @param {SunCycle|null} [options.sunCycle] bindSunCycle сразу.
	 * @param {FogManager|null} [options.fog] bindFog сразу (общий tfFogColor).
	 * @param {WeatherManager|null} [options.weather] bindWeather сразу (uFlash).
	 * @param {number} [options.timeScale=1] множитель времени (мерцание звёзд).
	 * @param {number} [options.renderOrder=10] порядок в opaque-очереди: после
	 *   геометрии — купол дорисовывает только «пустые» пиксели (без overdraw).
	 * Солнце: sunSizeDeg (0.9), sunHaloPower (18), sunHalo (0.42), sunHDR (2.6).
	 * Луна: moonSizeDeg (1.15), moonHalo (0.09), moonBrightness (1.35), moonMare (0.22).
	 * Звёзды: starDensity (0.7), starBrightness (1.35), starTwinkleSpeed (2.2),
	 *   starTwinkle (0.35), starScaleA (90), starScaleB (175), starBrightB (0.38),
	 *   starColorMix (0.55).
	 * Небо: gradientStart (-0.05), gradientEnd (0.55), sunsetGlow (0.9),
	 *   belowDarken (0.32), flashColor (0xdfe9ff).
	 * Вуаль горизонта (H1, v2.9): horizonVeil (1) — сила сведения неба к цвету
	 *   тумана у горизонта (применяется bindFog), veilHeight (0.3) — высота
	 *   полосы по dir.y; непрерывность затуманенного террейна на силуэте.
	 */
	constructor(options = {}) {
		const radius = options.radius !== undefined ? options.radius : 2400;
		const segments = Math.max(8, options.segments !== undefined ? options.segments : 32);
		const geometry = new THREE.SphereGeometry(radius, segments, Math.max(6, segments >> 1));
		const deg = Math.PI / 180;
		const uniforms = {
			uTime: { value: 0 },
			uZenith: { value: new Color(0x3f6fb5) },
			uHorizon: { value: new Color(0x9fc0dd) },
			uSunColor: { value: new Color(0xfff4e2) },
			uSunIntensity: { value: 3.3 },
			uNightFactor: { value: 0 },
			uSkyFogAmt: { value: 0 },
			// H1 (v2.9): горизонтальная вуаль (0, пока не привязан FogManager)
			uHorizonVeil: { value: 0 },
			uVeilHeight: { value: options.veilHeight !== undefined ? options.veilHeight : 0.3 },
			tfFogColor: { value: new Color(0.62, 0.75, 0.87) },
			uFlash: { value: 0 },
			uFlashColor: { value: new Color(options.flashColor !== undefined ? options.flashColor : 0xdfe9ff) },
			uSunDir: { value: new Vector3(0, 1, 0) },
			uMoonDir: { value: new Vector3(0, -1, 0) },
			uSunParams: { value: new Vector4(
				(options.sunSizeDeg !== undefined ? options.sunSizeDeg : 0.9) * deg,
				options.sunHaloPower !== undefined ? options.sunHaloPower : 18,
				options.sunHalo !== undefined ? options.sunHalo : 0.42,
				options.sunHDR !== undefined ? options.sunHDR : 2.6) },
			uMoonParams: { value: new Vector4(
				(options.moonSizeDeg !== undefined ? options.moonSizeDeg : 1.15) * deg,
				options.moonHalo !== undefined ? options.moonHalo : 0.09,
				options.moonBrightness !== undefined ? options.moonBrightness : 1.35,
				options.moonMare !== undefined ? options.moonMare : 0.22) },
			uStarParams: { value: new Vector4(
				options.starDensity !== undefined ? options.starDensity : 0.7,
				options.starBrightness !== undefined ? options.starBrightness : 1.35,
				options.starTwinkleSpeed !== undefined ? options.starTwinkleSpeed : 2.2,
				options.starTwinkle !== undefined ? options.starTwinkle : 0.35) },
			uStarParams2: { value: new Vector4(
				options.starScaleA !== undefined ? options.starScaleA : 90,
				options.starScaleB !== undefined ? options.starScaleB : 175,
				options.starBrightB !== undefined ? options.starBrightB : 0.38,
				options.starColorMix !== undefined ? options.starColorMix : 0.55) },
			uSkyParams: { value: new Vector4(
				options.gradientStart !== undefined ? options.gradientStart : -0.05,
				options.gradientEnd !== undefined ? options.gradientEnd : 0.55,
				options.sunsetGlow !== undefined ? options.sunsetGlow : 0.9,
				options.belowDarken !== undefined ? options.belowDarken : 0.32) }
		};
		const material = new ShaderMaterial({
			uniforms,
			vertexShader: TF_SKY_VERT,
			fragmentShader: TF_SKY_FRAG,
			side: THREE.BackSide,
			depthWrite: false,
			depthTest: true,
			transparent: false,
			fog: false
		});
		material.name = 'tfSkyMaterial';
		super(geometry, material);
		this.name = 'tfSkyDome';
		this.renderOrder = options.renderOrder !== undefined ? options.renderOrder : 10;
		this.frustumCulled = false;

		this.radius = radius;
		this.uniforms = uniforms;
		this.time = 0;
		this.timeScale = options.timeScale !== undefined ? options.timeScale : 1;
		this.follow = options.follow !== undefined ? options.follow : null;
		this.autoScale = options.autoScale !== false;
		// H1 (v2.9): сила горизонтальной вуали (применяется bindFog)
		this.horizonVeil = options.horizonVeil !== undefined ? options.horizonVeil : 1;

		this._sunCycle = null;
		this._fog = null;
		this._fogPrev = null;
		this._weather = null;
		this._weatherPrev = null;
		this._neutralFogColor = uniforms.tfFogColor.value;

		if (options.sunCycle !== undefined && options.sunCycle !== null) this.bindSunCycle(options.sunCycle);
		if (options.fog !== undefined && options.fog !== null) this.bindFog(options.fog);
		if (options.weather !== undefined && options.weather !== null) this.bindWeather(options.weather);
	}

	/**
	 * Привязать SunCycle: контракт skyUniforms (uZenith/uHorizon/uSunColor/
	 * uSunIntensity/uNightFactor пишет _apply) + ЖИВЫЕ sunDirection/moonDirection/
	 * zenithColor/horizonColor/sunColor в .value униформ (без копий).
	 */
	bindSunCycle(cycle) {
		if (cycle === undefined || cycle === null) return this;
		cycle.skyUniforms = this.uniforms;
		const U = this.uniforms;
		if (cycle.sunDirection !== undefined && cycle.sunDirection !== null) U.uSunDir.value = cycle.sunDirection;
		if (cycle.moonDirection !== undefined && cycle.moonDirection !== null) U.uMoonDir.value = cycle.moonDirection;
		if (cycle.zenithColor !== undefined && cycle.zenithColor !== null) U.uZenith.value = cycle.zenithColor;
		if (cycle.horizonColor !== undefined && cycle.horizonColor !== null) U.uHorizon.value = cycle.horizonColor;
		if (cycle.sunColor !== undefined && cycle.sunColor !== null) U.uSunColor.value = cycle.sunColor;
		U.uSunIntensity.value = Number.isFinite(cycle.sunIntensity) ? cycle.sunIntensity : 0;
		U.uNightFactor.value = Number.isFinite(cycle.nightFactor) ? cycle.nightFactor : 0;
		this._sunCycle = cycle;
		return this;
	}

	unbindSunCycle() {
		const c = this._sunCycle;
		if (c !== null && c !== undefined && c.skyUniforms === this.uniforms) c.skyUniforms = null;
		this._sunCycle = null;
		return this;
	}

	/**
	 * Привязать FogManager: fog.sky (follow + scale 0.98·far из _commit),
	 * fog.skyRadius, fog.skyUniforms (uSkyFogAmt) и общий цвет тумана —
	 * .value подменяется на живой Color менеджера (FogManager мутирует его
	 * на месте, обёртка общая с CloudLayer — одна запись видна всем).
	 */
	bindFog(fog) {
		if (fog === undefined || fog === null) return this;
		if (fog.uniforms === undefined) {
			console.warn('ThreeForge: SkyDome.bindFog — нужен FogManager (или объект с .uniforms); небо останется без скай-тумана');
			return this;
		}
		if (this._fog === null) {
			this._fogPrev = { sky: fog.sky, skyRadius: fog.skyRadius, skyUniforms: fog.skyUniforms };
		}
		this._fog = fog;
		fog.sky = this;
		fog.skyRadius = this.radius;
		fog.skyUniforms = this.uniforms;
		this.uniforms.tfFogColor.value = fog.uniforms.tfFogColor.value;
		// H1 (v2.9): включаем горизонтальную вуаль — непрерывность тумана на силуэте
		this.uniforms.uHorizonVeil.value = this.horizonVeil;
		return this;
	}

	unbindFog() {
		const fog = this._fog;
		if (fog === null) return this;
		if (fog.sky === this && this._fogPrev !== null) {
			fog.sky = this._fogPrev.sky;
			fog.skyRadius = this._fogPrev.skyRadius;
			if (fog.skyUniforms === this.uniforms) fog.skyUniforms = this._fogPrev.skyUniforms;
		} else if (fog.skyUniforms === this.uniforms) {
			fog.skyUniforms = this._fogPrev !== null ? this._fogPrev.skyUniforms : null;
		}
		this._fog = null;
		this._fogPrev = null;
		this.uniforms.tfFogColor.value = this._neutralFogColor;
		this.uniforms.uHorizonVeil.value = 0;   // H1: без FogManager вуали нет
		return this;
	}

	/** Привязать WeatherManager: weather.skyUniforms = uniforms (контракт uFlash). */
	bindWeather(weather) {
		if (weather === undefined || weather === null) return this;
		if (this._weather === null) {
			this._weatherPrev = weather.skyUniforms !== undefined ? weather.skyUniforms : null;
		}
		this._weather = weather;
		weather.skyUniforms = this.uniforms;
		return this;
	}

	unbindWeather() {
		const w = this._weather;
		if (w !== null && w !== undefined) {
			if (w.skyUniforms === this.uniforms) w.skyUniforms = this._weatherPrev;
		}
		this._weather = null;
		this._weatherPrev = null;
		return this;
	}

	/** Кадровый тик (система Engine): время (мерцание) + follow за камерой. */
	update(dt) {
		if (!(dt > 0) || !Number.isFinite(dt)) dt = 0;
		if (dt > 0.25) dt = 0.25;
		this.time += dt * this.timeScale;
		this.uniforms.uTime.value = this.time;
		const fog = this._fog;
		if (fog !== null && fog.sky === this && fog.camera !== null && fog.camera !== undefined) return this;
		const f = this.follow;
		if (f === null || f === undefined) return this;
		if (f.isObject3D === true) f.getWorldPosition(_sdCamPos);
		else if (f.position !== undefined && f.position !== null && f.position.isVector3 === true) _sdCamPos.copy(f.position);
		else if (f.isVector3 === true) _sdCamPos.copy(f);
		else return this;
		if (!Number.isFinite(_sdCamPos.x) || !Number.isFinite(_sdCamPos.y) || !Number.isFinite(_sdCamPos.z)) return this;
		this.position.copy(_sdCamPos);
		if (this.autoScale === true && f.far !== undefined && Number.isFinite(f.far) && f.far > 0) {
			this.scale.setScalar(Math.max(1e-4, f.far * 0.98 / this.radius));
		}
		return this;
	}

	getState() {
		const U = this.uniforms;
		return {
			time: +this.time.toFixed(1),
			nightFactor: +U.uNightFactor.value.toFixed(3),
			sunIntensity: +U.uSunIntensity.value.toFixed(3),
			skyFog: +U.uSkyFogAmt.value.toFixed(3),
			flash: +U.uFlash.value.toFixed(3),
			bound: {
				sunCycle: this._sunCycle !== null,
				fog: this._fog !== null,
				weather: this._weather !== null
			}
		};
	}

	/**
	 * Освобождение: отвязка всех контрактов + геометрия/материал.
	 * ВНИМАНИЕ: детей (CloudLayer) не уничтожает — dispose() облаков отдельный
	 * (или через createSkySystem.dispose(), который разбирает всё сам).
	 */
	dispose() {
		this.unbindSunCycle();
		this.unbindFog();
		this.unbindWeather();
		if (this.parent !== null && this.parent !== undefined) this.parent.remove(this);
		this.geometry.dispose();
		this.material.dispose();
	}
};

const TF_CLOUD_WRAP = 128;

const TF_CLOUD_VERT = `
varying vec3 vTfCloudDir;
void main() {
	vec4 wp = modelMatrix * vec4( position, 1.0 );
	vTfCloudDir = wp.xyz - cameraPosition;
	gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const TF_CLOUD_FRAG = `
varying vec3 vTfCloudDir;

uniform float uTime;
uniform vec2 uWindOff;        // дрейф ветра (шумовое пространство, wrap TF_CLOUD_WRAP)
uniform vec4 uCloudParams;    // (покрытие 0..1, мягкость, непрозрачность, масштаб шума)
uniform vec4 uCloudParams2;   // (высота листа, доменное искажение, шаг к солнцу, кайма)
uniform vec4 uCloudFade;      // (дист-fade start, end, горизонт-soft, усиление молнии)
uniform vec3 uCloudBright;
uniform vec3 uCloudDark;
uniform float uDarken;        // затемнение в осадки (погода)
// --- контракт SunCycle (обычно общие {value}-объекты с SkyDome) ---
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uSunColor;
uniform float uSunIntensity;
uniform float uNightFactor;
// --- контракт FogManager ---
uniform float uSkyFogAmt;
uniform vec3 tfFogColor;
// --- контракт WeatherManager ---
uniform float uFlash;
uniform vec3 uFlashColor;
// --- живое направление солнца ---
uniform vec3 uSunDir;

#ifndef TF_CLOUD_OCTAVES
#define TF_CLOUD_OCTAVES 5
#endif
#define TF_CLOUD_WRAP_F 128.0

// Периодный хеш: mod решётки делает шум TF_CLOUD_WRAP-периодичным — дрейф
// ветра заворачивается без шва, а координаты хеша остаются малыми (точность fp32).
float tfClHash21( vec2 p ) {
	p = mod( p, TF_CLOUD_WRAP_F );
	p = fract( p * vec2( 123.34, 456.21 ) );
	p += dot( p, p + 34.56 );
	return fract( p.x * p.y );
}
float tfClNoise( vec2 p ) {
	vec2 i = floor( p ), f = fract( p );
	vec2 u = f * f * ( 3.0 - 2.0 * f );
	float a = tfClHash21( i );
	float b = tfClHash21( i + vec2( 1.0, 0.0 ) );
	float c = tfClHash21( i + vec2( 0.0, 1.0 ) );
	float d = tfClHash21( i + vec2( 1.0, 1.0 ) );
	return mix( mix( a, b, u.x ), mix( c, d, u.x ), u.y );
}
// 2 октавы — поле искажения и «освещённый» сэмпл (дешёвые проходы)
float tfClFbm2( vec2 p ) {
	return tfClNoise( p ) * 0.65 + tfClNoise( p * 2.0 + vec2( 13.7, 7.3 ) ) * 0.35;
}
// 5 октав (define) — основная плотность. Множитель частоты ЦЕЛЫЙ (×2):
// период суммы остаётся TF_CLOUD_WRAP_F.
float tfClFbm( vec2 p ) {
	float s = 0.0, a = 0.5, n = 0.0;
	for ( int i = 0; i < TF_CLOUD_OCTAVES; i ++ ) {
		s += a * tfClNoise( p );
		n += a;
		p = p * 2.0 + vec2( 17.1, 9.2 );
		a *= 0.5;
	}
	return s / n;
}

void main() {
	vec3 dir = normalize( vTfCloudDir );
	float up = dir.y;
	// Полоса гашения у горизонта начинается ТОЧНО с clamp знаменателя проекции:
	// в «мёртвой» зоне (up < uCloudFade.z) лист перестаёт отвечать на up —
	// зона отбрасывается целиком, вертикальных «размазов» у горизонта нет
	float hFade = smoothstep( uCloudFade.z, uCloudFade.z * 3.0 + 0.02, up );
	if ( hFade <= 0.003 ) discard;
	vec2 sheet = dir.xz / max( up, uCloudFade.z ) * uCloudParams2.x;
	float pd = length( sheet );
	float dFade = 1.0 - smoothstep( uCloudFade.x, uCloudFade.y, pd );
	if ( dFade <= 0.003 ) discard;

	// --- плотность: 5-октавный FBM с доменным искажением ---
	vec2 q = sheet * uCloudParams.w + uWindOff;
	vec2 wvec = vec2( tfClFbm2( q ), tfClFbm2( q + vec2( 5.2, 1.3 ) ) ) - 0.5;
	vec2 qw = q + wvec * uCloudParams2.y;
	float base = tfClFbm( qw );
	// покрытие → порог: cov=0 → t=0.86 (почти нет облаков), cov=1 → t=0.14 (сплошняк)
	float cov = clamp( uCloudParams.x, 0.0, 1.0 );
	float t = mix( 0.86, 0.14, cov );
	float mask = smoothstep( t, t + max( uCloudParams.y, 0.02 ), base );
	if ( mask <= 0.004 ) discard;

	// --- освещение ---
	vec3 sunDir = normalize( uSunDir );
	float sunUp = smoothstep( -0.1, 0.14, sunDir.y );
	float sunAmt = max( dot( dir, sunDir ), 0.0 );
	// сэмпл плотности со сдвигом к солнцу → толщина (низкое солнце = длиннее путь)
	// сэмпл ТОГО ЖЕ поля плотности со сдвигом к солнцу → толщина: если по
	// лучу к солнцу облако ещё плотное (lit выше порога) — мы в толще (темно);
	// на освещённой кромке lit падает ниже порога — край просвечивает
	// («серебряная кайма»), на теневой кромке — темно (физично).
	// Длина шага ОГРАНИЧЕНА (×1.5): у низкого солнца неограниченный шаг
	// ушёл бы за длину корреляции поля — толщина выродилась бы в шум
	float sunLen = min( 1.5, 1.0 / max( abs( sunDir.y ), 0.25 ) );
	vec2 sunOff = normalize( sunDir.xz + vec2( 1e-5 ) ) * ( uCloudParams2.z * sunLen );
	float lit = tfClFbm( qw + sunOff );
	// ×0.8 — толщина не достигает 1: множественное рассеяние оставляет
	// свету путь даже в ядре (иначе полдень давал бы «синие пятна»)
	float thick = smoothstep( t, t + max( uCloudParams.y, 0.02 ), lit ) * 0.8;
	float thin = 1.0 - thick;                       // 1 = тонкий освещённый край
	// ambient из живой палитры неба; skyLight — свет НЕБА: в сумерках его много
	// (горизонт сияет закатом), ночью — минимум; день/ночь — автоматически
	float skyLight = 0.12 + 0.88 * smoothstep( -0.18, 0.3, sunDir.y );
	vec3 ambient = mix( uHorizon * 0.55 + uZenith * 0.22, uHorizon * 0.9 + uZenith * 0.55, thin );
	ambient *= skyLight * uDarken;
	ambient += vec3( 0.045 ) * skyLight * uDarken;   // низ: тени не «в чёрное»
	// ночь: облака холоднеют и ловят слабый лунный ambient зенита
	ambient = mix( ambient, ambient * vec3( 0.75, 0.82, 1.0 ) + uZenith * 0.02,
		clamp( uNightFactor, 0.0, 1.0 ) * 0.6 );
	// прямое солнце: просвет тонких краёв + «серебряная кайма» против солнца
	float iSun = clamp( uSunIntensity, 0.0, 4.0 );
	// 0.25 — пол множественного рассеяния: ядро не проваливается в черноту;
	// uDarken — в осадки свет НЕ доходит до вершин: direct и кайма гаснут тоже
	vec3 direct = uSunColor * ( iSun * 0.34 ) * ( 0.25 + 0.75 * pow( thin, 1.35 ) ) * ( 0.3 + 0.7 * sunUp ) * uDarken;
	float silver = pow( sunAmt, 7.0 ) * uCloudParams2.w * thin * sunUp *
		clamp( iSun * 0.4, 0.0, 1.2 ) * ( 0.35 + 0.65 * uDarken );
	vec3 cCol = mix( uCloudDark * ambient, uCloudBright * ( ambient + direct ), smoothstep( 0.1, 0.75, thin ) );
	cCol += uSunColor * silver;
	// сумеречная кайма: низкое солнце красит тонкие края тёплым
	// (sunsetFactor — та же формула, что в SunCycle._compute и SkyDome)
	float ssC = ( sunDir.y - 0.03 ) / 0.11;
	float sunsetC = exp( - ssC * ssC );
	cCol += uSunColor * ( sunsetC * pow( sunAmt, 3.0 ) * 0.4 * thin );
	// воздушная перспектива: дальние облака растворяются в небе — иначе
	// спрессованная у горизонта полоса читается чёрными «обрывками»
	vec3 bg = mix( uHorizon, uZenith, smoothstep( -0.05, 0.55, up ) );
	float aerial = smoothstep( uCloudFade.x * 0.45, uCloudFade.y, pd ) * 0.9;
	cCol = mix( cCol, bg * ( 0.55 + 0.45 * skyLight ), aerial );

	// --- молния: ядро/низ вспыхивает сильнее краёв (общий uFlash с куполом) ---
	float amt = clamp( uSkyFogAmt, 0.0, 1.0 );
	float fl = uFlash * ( 1.0 - amt * 0.4 ) * uCloudFade.w;
	if ( fl > 0.001 ) cCol += uFlashColor * ( fl * ( 0.9 + 0.7 * thick ) );

	// --- вывод: та же конвенция, что SkyDome/WaterSurface ---
	float alpha = clamp( mask * uCloudParams.z * hFade * dFade, 0.0, 1.0 );
	gl_FragColor = vec4( cCol, alpha );
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
	// S1: скай-туман растворяет облака (dense → цвет = цвет тумана = цвет неба)
	float cFog = clamp( amt * 1.15 + pow( amt, 4.0 ), 0.0, 1.0 );
	gl_FragColor.rgb = mix( gl_FragColor.rgb, tfFogColor, cFog );
}
`;

const _clCamPos = new Vector3();

const CloudLayer = class extends Mesh {
	/**
	 * @param {object} [options]
	 * @param {number} [options.radius=2364] радиус сферы (≈ 0.985·радиус купола).
	 * @param {number} [options.segments=32] тесселяция.
	 * @param {number} [options.coverage=0.42] базовое покрытие 0..1 (погода
	 *   добавляет сверху: дождь +0.42, гроза +0.64, снег +0.30).
	 * @param {number} [options.softness=0.24] мягкость края (порог smoothstep).
	 * @param {number} [options.opacity=0.92] общая непрозрачность.
	 * @param {number} [options.scale=0.9] пространственная частота шума
	 *   (больше = мельче облака).
	 * @param {number} [options.height=1] высота «облачного листа» (угловая
	 *   проекция: меньше = облака «выше» и мельче у зенита).
	 * @param {number} [options.warp=0.65] сила доменного искажения.
	 * @param {number} [options.lightStep=0.4] шаг сэмпла к солнцу (толщина).
	 * @param {number} [options.silver=0.55] сила «серебряной каймы».
	 * @param {number} [options.fadeStart=7] дистанционный fade листа (начало).
	 * @param {number} [options.fadeEnd=18] дистанционный fade листа (конец).
	 * @param {number} [options.horizonSoft=0.05] начало полосы гашения у
	 *   горизонта; оно же — clamp знаменателя проекции листа (полоса тянется
	 *   до horizonSoft·3 + 0.02).
	 * @param {number} [options.flashBoost=1.7] усиление подсветки молнией.
	 * @param {number} [options.brightness=1.3] HDR-яркость освещённых облаков
	 *   (>1 — bloom/god-rays подхватывают яркие кромки).
	 * @param {THREE.ColorRepresentation} [options.colorBright=0xf4f7fb]
	 * @param {THREE.ColorRepresentation} [options.colorDark=0x8b98ac]
	 * @param {number} [options.windSpeed=2.4] дрейф без погоды (м/с).
	 * @param {number} [options.windAngle=0.6] направление дрейфа без погоды (рад).
	 * @param {number} [options.windFactor=0.02] шумовых единиц/с на м/с ветра.
	 * @param {number} [options.coverageResponse=4.5] время сглаживания покрытия (с).
	 * @param {number} [options.octaves=5] октавы основного FBM (define —
	 *   смена значения вызывает рекомпиляцию программы).
	 * @param {number} [options.renderOrder=-5] порядок в transparent-очереди:
	 *   облака ДО воды (-1) и погодных полей (0) — дождь/снег видны на их фоне.
	 * @param {object|null} [options.follow] камера (автономный режим).
	 * @param {boolean} [options.autoScale=true] масштабировать под camera.far.
	 * @param {SunCycle|null} [options.sunCycle] bindSunCycle сразу (автономно).
	 * @param {WeatherManager|null} [options.weather] bindWeather сразу.
	 */
	constructor(options = {}) {
		const radius = options.radius !== undefined ? options.radius : 2364;
		const segments = Math.max(8, options.segments !== undefined ? options.segments : 32);
		const geometry = new THREE.SphereGeometry(radius, segments, Math.max(6, segments >> 1));
		const octaves = Math.min(8, Math.max(1, options.octaves !== undefined ? options.octaves | 0 : 5));
		const uniforms = {
			uTime: { value: 0 },
			uWindOff: { value: new Vector2(0, 0) },
			uCloudParams: { value: new Vector4(
				options.coverage !== undefined ? options.coverage : 0.42,
				options.softness !== undefined ? options.softness : 0.24,
				options.opacity !== undefined ? options.opacity : 0.92,
				options.scale !== undefined ? options.scale : 0.9) },
			uCloudParams2: { value: new Vector4(
				options.height !== undefined ? options.height : 1,
				options.warp !== undefined ? options.warp : 0.65,
				options.lightStep !== undefined ? options.lightStep : 0.4,
				options.silver !== undefined ? options.silver : 0.55) },
			uCloudFade: { value: new Vector4(
				options.fadeStart !== undefined ? options.fadeStart : 7,
				options.fadeEnd !== undefined ? options.fadeEnd : 18,
				options.horizonSoft !== undefined ? options.horizonSoft : 0.05,
				options.flashBoost !== undefined ? options.flashBoost : 1.7) },
			uCloudBright: { value: new Color(options.colorBright !== undefined ? options.colorBright : 0xf4f7fb)
				.multiplyScalar(options.brightness !== undefined ? options.brightness : 1.3) },
			uCloudDark: { value: new Color(options.colorDark !== undefined ? options.colorDark : 0x8b98ac) },
			uDarken: { value: 1 },
			uZenith: { value: new Color(0x3f6fb5) },
			uHorizon: { value: new Color(0x9fc0dd) },
			uSunColor: { value: new Color(0xfff4e2) },
			uSunIntensity: { value: 3.3 },
			uNightFactor: { value: 0 },
			uSkyFogAmt: { value: 0 },
			tfFogColor: { value: new Color(0.62, 0.75, 0.87) },
			uFlash: { value: 0 },
			uFlashColor: { value: new Color(options.flashColor !== undefined ? options.flashColor : 0xdfe9ff) },
			uSunDir: { value: new Vector3(0, 1, 0) }
		};
		const material = new ShaderMaterial({
			defines: { TF_CLOUD_OCTAVES: String(octaves) },
			uniforms,
			vertexShader: TF_CLOUD_VERT,
			fragmentShader: TF_CLOUD_FRAG,
			side: THREE.BackSide,
			transparent: true,
			depthWrite: false,
			depthTest: true,
			fog: false
		});
		material.name = 'tfCloudMaterial';
		super(geometry, material);
		this.name = 'tfCloudLayer';
		this.renderOrder = options.renderOrder !== undefined ? options.renderOrder : -5;
		this.frustumCulled = false;

		this.radius = radius;
		this.uniforms = uniforms;
		this.octaves = octaves;
		this.baseCoverage = Math.min(1, Math.max(0, options.coverage !== undefined ? options.coverage : 0.42));
		this.coverage = this.baseCoverage;
		this.windSpeed = options.windSpeed !== undefined ? options.windSpeed : 2.4;
		this.windAngle = options.windAngle !== undefined ? options.windAngle : 0.6;
		this.windFactor = options.windFactor !== undefined ? options.windFactor : 0.02;
		this.coverageResponse = options.coverageResponse !== undefined ? options.coverageResponse : 4.5;
		this.timeScale = options.timeScale !== undefined ? options.timeScale : 1;
		this.follow = options.follow !== undefined ? options.follow : null;
		this.autoScale = options.autoScale !== false;

		this.time = 0;
		this._windX = 0;
		this._windY = 0;
		this._darken = 1;
		this._weather = null;
		this._sunCycle = null;
		this._fog = null;
		this._fogPrev = null;
		this._weatherU = null;
		this._weatherUPrev = null;
		this._attached = null;
		this._ownsTime = true;
		this._neutralFogColor = uniforms.tfFogColor.value;

		if (options.sunCycle !== undefined && options.sunCycle !== null) this.bindSunCycle(options.sunCycle);
		if (options.fog !== undefined && options.fog !== null) this.bindFog(options.fog);
		if (options.weather !== undefined && options.weather !== null) this.bindWeather(options.weather);
	}

	/**
	 * Разделить униформы с куполом: ОБЪЕКТЫ {value} из sky.uniforms подставляются
	 * в материал облаков — одна запись SunCycle/FogManager/WeatherManager видна
	 * обоим материалам (тот же приём, что у FogManager/частиц). uTime — общий:
	 * облака перестают тикать сами (иначе двойной ход времени).
	 */
	shareSkyUniforms(sky) {
		if (sky === undefined || sky === null || sky.uniforms === undefined) {
			console.warn('ThreeForge: CloudLayer.shareSkyUniforms — нужен SkyDome (или объект с .uniforms)');
			return this;
		}
		const S = sky.uniforms, U = this.uniforms;
		const keys = [
			'uZenith', 'uHorizon', 'uSunColor', 'uSunIntensity', 'uNightFactor',
			'uSunDir', 'uSkyFogAmt', 'tfFogColor', 'uFlash', 'uFlashColor', 'uTime'
		];
		for (let i = 0; i < keys.length; i++) {
			const k = keys[i];
			if (S[k] !== undefined && U[k] !== undefined) U[k] = S[k];
		}
		this._ownsTime = false;
		return this;
	}

	/**
	 * Присоединить к куполу (делает createSkySystem): shareSkyUniforms +
	 * sky.add(this) — follow/scale наследуются от купола (FogManager двигает
	 * и масштабирует обоих одной записью).
	 */
	attachTo(skyDome) {
		if (skyDome === undefined || skyDome === null) return this;
		this.shareSkyUniforms(skyDome);
		skyDome.add(this);
		this._attached = skyDome;
		this.follow = null;
		return this;
	}

	/**
	 * Автономная привязка SunCycle (когда купола нет): те же ЖИВЫЕ объекты,
	 * что у SkyDome.bindSunCycle. cycle.skyUniforms занимается ТОЛЬКО если
	 * свободен (иначе фасад уже привязал купол — конфликт записей не нужен).
	 */
	bindSunCycle(cycle) {
		if (cycle === undefined || cycle === null) return this;
		const U = this.uniforms;
		if (cycle.sunDirection !== undefined && cycle.sunDirection !== null) U.uSunDir.value = cycle.sunDirection;
		if (cycle.zenithColor !== undefined && cycle.zenithColor !== null) U.uZenith.value = cycle.zenithColor;
		if (cycle.horizonColor !== undefined && cycle.horizonColor !== null) U.uHorizon.value = cycle.horizonColor;
		if (cycle.sunColor !== undefined && cycle.sunColor !== null) U.uSunColor.value = cycle.sunColor;
		U.uSunIntensity.value = Number.isFinite(cycle.sunIntensity) ? cycle.sunIntensity : 0;
		U.uNightFactor.value = Number.isFinite(cycle.nightFactor) ? cycle.nightFactor : 0;
		if (cycle.skyUniforms === null || cycle.skyUniforms === undefined) cycle.skyUniforms = this.uniforms;
		this._sunCycle = cycle;
		return this;
	}

	unbindSunCycle() {
		const c = this._sunCycle;
		if (c !== null && c !== undefined && c.skyUniforms === this.uniforms) c.skyUniforms = null;
		this._sunCycle = null;
		return this;
	}

	/**
	 * Автономная привязка FogManager (когда купола нет): fog.sky = облака
	 * (follow + scale 0.98·far из _commit), fog.skyRadius, fog.skyUniforms
	 * (uSkyFogAmt), tfFogColor.value → живой Color менеджера.
	 */
	bindFog(fog) {
		if (fog === undefined || fog === null) return this;
		if (fog.uniforms === undefined) {
			console.warn('ThreeForge: CloudLayer.bindFog — нужен FogManager (или объект с .uniforms); облака останутся без скай-тумана');
			return this;
		}
		if (this._fog === null) {
			this._fogPrev = { sky: fog.sky, skyRadius: fog.skyRadius, skyUniforms: fog.skyUniforms };
		}
		this._fog = fog;
		fog.sky = this;
		fog.skyRadius = this.radius;
		fog.skyUniforms = this.uniforms;
		this.uniforms.tfFogColor.value = fog.uniforms.tfFogColor.value;
		return this;
	}

	unbindFog() {
		const fog = this._fog;
		if (fog === null) return this;
		if (fog.sky === this && this._fogPrev !== null) {
			fog.sky = this._fogPrev.sky;
			fog.skyRadius = this._fogPrev.skyRadius;
			if (fog.skyUniforms === this.uniforms) fog.skyUniforms = this._fogPrev.skyUniforms;
		} else if (fog.skyUniforms === this.uniforms) {
			fog.skyUniforms = this._fogPrev !== null ? this._fogPrev.skyUniforms : null;
		}
		this._fog = null;
		this._fogPrev = null;
		this.uniforms.tfFogColor.value = this._neutralFogColor;
		return this;
	}

	/**
	 * Автономный контракт uFlash (когда купола нет): weather.skyUniforms =
	 * uniforms облаков — WeatherManager._updateLightning пишет молнии сюда.
	 */
	bindWeatherUniforms(weather) {
		if (weather === undefined || weather === null) return this;
		if (this._weatherU === null) {
			this._weatherUPrev = weather.skyUniforms !== undefined ? weather.skyUniforms : null;
		}
		this._weatherU = weather;
		weather.skyUniforms = this.uniforms;
		return this;
	}

	unbindWeatherUniforms() {
		const w = this._weatherU;
		if (w !== null && w !== undefined && w.skyUniforms === this.uniforms) {
			w.skyUniforms = this._weatherUPrev;
		}
		this._weatherU = null;
		this._weatherUPrev = null;
		return this;
	}

	/**
	 * Привязать WeatherManager: coverage/darken/ветер следуют погоде.
	 * (Контракт uFlash — НЕ здесь: weather.skyUniforms привязывает SkyDome/фасад.)
	 */
	bindWeather(weather) {
		this._weather = weather !== undefined && weather !== null ? weather : null;
		return this;
	}

	unbindWeather() {
		this._weather = null;
		return this;
	}

	/** Ручное покрытие 0..1 (без погоды/поверх базового — погода всё равно добавит). */
	setCoverage(v) {
		this.baseCoverage = Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0));
		return this;
	}

	/** Кадровый тик (система Engine): время, ветер, покрытие, follow (автономно). */
	update(dt) {
		if (!(dt > 0) || !Number.isFinite(dt)) dt = 0;
		if (dt > 0.25) dt = 0.25;
		if (this._ownsTime === true) {
			this.time += dt * this.timeScale;
			this.uniforms.uTime.value = this.time;
		}
		const w = this._weather;
		let tCov = this.baseCoverage;
		let tDark = 1;
		let ws = this.windSpeed;
		let wa = this.windAngle;
		if (w !== null && w !== undefined) {
			const rain = Number.isFinite(w.rain) && w.rain > 0 ? w.rain : 0;
			const snow = Number.isFinite(w.snow) && w.snow > 0 ? w.snow : 0;
			const storm = w.mode === 'storm' ? 1 : 0;
			tCov = Math.min(1, this.baseCoverage + 0.42 * rain + 0.30 * snow + 0.22 * storm);
			tDark = 1 - 0.45 * Math.min(1, rain + 0.3 * storm) - 0.10 * snow;
			if (Number.isFinite(w.windSpeed)) ws = Math.max(0.35, w.windSpeed);
			if (Number.isFinite(w.windAngle)) wa = w.windAngle;
		}
		const k = 1 - Math.exp(-dt / Math.max(0.25, this.coverageResponse));
		this.coverage += (tCov - this.coverage) * k;
		this._darken += (tDark - this._darken) * k;
		this.uniforms.uCloudParams.value.x = this.coverage;
		this.uniforms.uDarken.value = this._darken;
		const wf = this.windFactor * ws * dt;
		if (Number.isFinite(wf)) {
			const W = TF_CLOUD_WRAP;
			this._windX = ((this._windX + Math.cos(wa) * wf) % W + W) % W;
			this._windY = ((this._windY + Math.sin(wa) * wf) % W + W) % W;
			this.uniforms.uWindOff.value.set(this._windX, this._windY);
		}
		const fogDrv = this._fog !== null && this._fog.sky === this &&
			this._fog.camera !== null && this._fog.camera !== undefined;
		if (this._attached === null && !fogDrv) {
			const f = this.follow;
			if (f !== null && f !== undefined) {
				if (f.isObject3D === true) f.getWorldPosition(_clCamPos);
				else if (f.position !== undefined && f.position !== null && f.position.isVector3 === true) _clCamPos.copy(f.position);
				else if (f.isVector3 === true) _clCamPos.copy(f);
				else return this;
				if (!Number.isFinite(_clCamPos.x) || !Number.isFinite(_clCamPos.y) || !Number.isFinite(_clCamPos.z)) return this;
				this.position.copy(_clCamPos);
				if (this.autoScale === true && f.far !== undefined && Number.isFinite(f.far) && f.far > 0) {
					this.scale.setScalar(Math.max(1e-4, f.far * 0.98 / this.radius));
				}
			}
		}
		return this;
	}

	getState() {
		return {
			coverage: +this.coverage.toFixed(3),
			baseCoverage: +this.baseCoverage.toFixed(3),
			darken: +this._darken.toFixed(3),
			windSpeed: +this.windSpeed.toFixed(2),
			windOff: [+this._windX.toFixed(2), +this._windY.toFixed(2)],
			octaves: this.octaves,
			attached: this._attached !== null
		};
	}

	dispose() {
		this.unbindSunCycle();
		this.unbindWeather();
		this.unbindFog();
		this.unbindWeatherUniforms();
		if (this.parent !== null && this.parent !== undefined) this.parent.remove(this);
		this._attached = null;
		this.geometry.dispose();
		this.material.dispose();
	}
};

/**
 * @param {object} [options]
 * Ядро: scene, camera, engine, fog (FogManager), sunCycle (или lights — риг
 *   createLightRig: возьмётся lights.cycle), weather (WeatherManager),
 *   post (PostPipeline), water (WaterSurface — привязать к sunCycle, если ещё
 *   не привязана), group (своя группа; иначе создаётся и добавляется в scene;
 *   группа ДОЛЖНА оставаться в начале координат — купол позиционируется
 *   мировой позицией камеры).
 * Небо: sky — false (без купола) | объект опций SkyDome (radius/segments/
 *   sunSizeDeg/starDensity/... — см. JSDoc SkyDome; follow по умолчанию camera).
 * Облака: clouds — false (без облаков) | объект опций CloudLayer (coverage/
 *   softness/warp/octaves/... — см. JSDoc CloudLayer; radius по умолчанию
 *   0.985·radius купола).
 * priority — приоритет системы Engine (по умолчанию 5).
 * autoBind — false отключает автопривязку SunCycle/Fog/Weather/Post/Water
 *   (default true; объекты, явно переданные в sky/clouds-опциях, привязываются
 *   их конструкторами как обычно).
 * @returns {object} фасад {group, sky, clouds, uniforms, update, setTime,
 *   setCloudCoverage, getState, dispose}.
 */
function createSkySystem(options = {}) {
	const scene = options.scene !== undefined && options.scene !== null ? options.scene : null;
	const camera = options.camera !== undefined && options.camera !== null ? options.camera : null;
	const engine = options.engine !== undefined && options.engine !== null ? options.engine : null;
	const fog = options.fog !== undefined && options.fog !== null ? options.fog : null;
	const weather = options.weather !== undefined && options.weather !== null ? options.weather : null;
	const post = options.post !== undefined && options.post !== null ? options.post : null;
	const water = options.water !== undefined && options.water !== null ? options.water : null;
	const sunCycle = options.sunCycle !== undefined && options.sunCycle !== null
		? options.sunCycle
		: (options.lights !== undefined && options.lights !== null && options.lights.cycle !== undefined && options.lights.cycle !== null
			? options.lights.cycle : null);
	const autoBind = options.autoBind !== false;

	const ownsGroup = options.group === undefined || options.group === null;
	const group = ownsGroup ? new Group() : options.group;
	if (group.name === '' || group.name === undefined) group.name = 'tfSkySystem';
	if (ownsGroup && scene !== null) scene.add(group);

	const skyOptsIn = typeof options.sky === 'object' && options.sky !== null ? options.sky : {};
	let sky = null;
	if (options.sky !== false) {
		sky = new SkyDome(Object.assign({ follow: camera }, skyOptsIn));
		group.add(sky);
	}

	const cloudOptsIn = typeof options.clouds === 'object' && options.clouds !== null ? options.clouds : {};
	let clouds = null;
	if (options.clouds !== false) {
		clouds = new CloudLayer(Object.assign({
			radius: sky !== null ? sky.radius * 0.985 : 2364,
			follow: sky === null ? camera : null
		}, cloudOptsIn));
		if (sky !== null) {
			clouds.attachTo(sky);
		} else {
			group.add(clouds);
		}
	}

	const primary = sky !== null ? sky : clouds;
	let cycleBound = false, fogBound = false, weatherBound = false, waterBound = false;
	if (primary !== null && autoBind) {
		if (sunCycle !== null && primary._sunCycle === null) {
			primary.bindSunCycle(sunCycle);
			cycleBound = primary._sunCycle === sunCycle;
		}
		if (fog !== null && primary._fog === null) {
			primary.bindFog(fog);
			fogBound = primary._fog === fog;
		}
		if (weather !== null && sky !== null && sky._weather === null) {
			sky.bindWeather(weather);
			weatherBound = weather.skyUniforms === sky.uniforms;
		} else if (weather !== null && sky === null && clouds !== null &&
			(weather.skyUniforms === null || weather.skyUniforms === undefined)) {
			clouds.bindWeatherUniforms(weather);
			weatherBound = weather.skyUniforms === clouds.uniforms;
		}
		if (weather !== null && clouds !== null) clouds.bindWeather(weather);
		if (water !== null && sunCycle !== null &&
			(water._sunCycle === null || water._sunCycle === undefined) &&
			typeof water.bindSunCycle === 'function') {
			water.bindSunCycle(sunCycle);
			waterBound = true;
		}
	}
	let postBound = false;
	if (post !== null && autoBind) {
		if (Array.isArray(post.prepassExclude)) {
			if (sky !== null && post.prepassExclude.indexOf(sky) === -1) post.prepassExclude.push(sky);
			if (clouds !== null && post.prepassExclude.indexOf(clouds) === -1) post.prepassExclude.push(clouds);
			postBound = true;
		}
		if ((post.sunDirection === null || post.sunDirection === undefined) && sunCycle !== null) {
			post.sunDirection = sunCycle.sunDirection;
		}
	}

	const tick = {
		name: 'tfSkySystem',
		update(dt) {
			if (sky !== null) sky.update(dt);
			if (clouds !== null) clouds.update(dt);
		}
	};
	if (engine !== null) engine.addSystem(tick, options.priority !== undefined ? options.priority : 5);

	const system = {
		group, sky, clouds,
		uniforms: primary !== null ? primary.uniforms : null,
		engine, scene, camera, fog, sunCycle, weather, post,

		/** Ручной тик (когда Engine не передан — система не зарегистрирована). */
		update(dt) {
			if (engine !== null) return this;
			tick.update(dt);
			return this;
		},
		/** Время суток — транзит в SunCycle.setTime (без цикла — no-op). */
		setTime(hours) {
			if (sunCycle !== null) sunCycle.setTime(hours);
			return this;
		},
		/** Базовое покрытие облаков 0..1 (погода добавляет сверху). */
		setCloudCoverage(v) {
			if (clouds !== null) clouds.setCoverage(v);
			return this;
		},
		getState() {
			return {
				sky: sky !== null ? sky.getState() : null,
				clouds: clouds !== null ? clouds.getState() : null
			};
		},
		dispose() {
			if (engine !== null) engine.removeSystem(tick);
			if (postBound && Array.isArray(post.prepassExclude)) {
				if (sky !== null) {
					const ix = post.prepassExclude.indexOf(sky);
					if (ix !== -1) post.prepassExclude.splice(ix, 1);
				}
				if (clouds !== null) {
					const iy = post.prepassExclude.indexOf(clouds);
					if (iy !== -1) post.prepassExclude.splice(iy, 1);
				}
			}
			if (waterBound && water !== null && typeof water.unbindSunCycle === 'function') water.unbindSunCycle();
			if (weatherBound) {
				if (sky !== null) sky.unbindWeather();
				else if (clouds !== null) clouds.unbindWeatherUniforms();
			}
			if (fogBound && primary !== null) primary.unbindFog();
			if (cycleBound && primary !== null) primary.unbindSunCycle();
			if (clouds !== null) clouds.dispose();
			if (sky !== null) sky.dispose();
			if (ownsGroup && group.parent !== null && group.parent !== undefined) group.parent.remove(group);
		}
	};
	return system;
}

export {
	Engine, InstancedBatcher, CullGroup,
	SunLight, SunLightShadow, PointLight, SunCycle,
	SUN_CASCADE_COUNT, SUN_CASCADE_FADE,
	getSunCascadeCount, setSunCascadeCount,
	getShadowQuality, setShadowQuality,
	SHADOW_QUALITY_PRESETS, SHADOW_QUALITY_ORDER, applyShadowQuality,
	SunShadowHelper,
	FirstPersonController, ViewModel, FloatingProps, Hud,
	installStylizedPatch, createStylizedMaterial, createGradientMap,
	installSunShadowPatch, TF_SUN_SHADOW_FN, TF_SHADOW_UNIFORMS,
	tfAddProgramCacheKey, tfRecordPatch, tfChainOnBeforeCompile, cloneMaterialPatched,
	DirectionalLight, SpotLight, LightManager, LIGHT_FLICKER, tfFlickerValue,
	createLightRig, installEmissivePatch, applyEmissiveOptions, EmissiveManager,
	TF_EMISSIVE_GLSL, TF_EMISSIVE_TIME, createEmissiveTexture, createEmissiveMaterial,
	EMISSIVE_TEXTURE_KINDS,
	FogManager, installFogPatch, TF_FOG_GLSL, FOG_PRESETS, FOG_PRESET_ORDER,
	ParticleManager, ParticleField, ParticleSystem, WeatherManager,
	createParticleAtlas, createParticleMaterial, TFInstancedBufferGeometry,
	TF_TILE_PAD, TF_TILE_SCALE, TF_TILE_PAD_UV,
	TF_PARTICLES_GLSL_COMMON_VERT, TF_PARTICLES_SPRITE_VERT, TF_PARTICLES_STREAK_VERT,
	TF_PARTICLES_CPU_VERT, TF_PARTICLES_FRAG,
	TF_PSTRIDE, TF_P_POS, TF_P_VEL, TF_P_AGE, TF_P_INVLIFE, TF_P_SIZE0, TF_P_SIZE1,
	TF_P_ROT0, TF_P_ROTV, TF_P_C0, TF_P_C1, TF_P_ALPHA, TF_P_FADEIN, TF_P_DRAG,
	TF_P_GSCALE, TF_P_TILE, TF_P_STRETCH, TF_P_WINDF, TF_P_TURBA, TF_P_TURBF,
	TF_QUALITY_MUL, TF_QUALITY_ORDER, TF_QUALITY_TIERS,
	WEATHER_MODES, WEATHER_ORDER, defaultFogUniforms,
	createPRNG, SimplexNoise, fbm, SIMPLEX_GRAD3, SIMPLEX_F2, SIMPLEX_G2,
	Terrain, TERRAIN_SAND, TERRAIN_SNOW, TERRAIN_ROCK, TERRAIN_GRASS_A, TERRAIN_GRASS_B,
	RigidBody, SpatialHashGrid, PhysicsWorld,
	InputManager, AudioManager,
	TF_FS_VERT, TF_AO_FRAG, TF_AO_BLUR_FRAG, TF_COMPOSITE_FRAG, TF_DEBUG_FRAG,
	TF_FXAA_FRAG, TF_NORMAL_VERT, TF_NORMAL_FRAG, PostPipeline,
	TF_VELOCITY_VERT, TF_VELOCITY_FRAG, TF_TAA_RESOLVE_FRAG, TF_TAA_BLIT_FRAG,
	TF_VELOCITY_LAYER, tfHalton,
	TF_RAYS_BRIGHT_FRAG, TF_RAYS_BLUR_FRAG, TF_FINAL_FRAG,
	TF_BLOOM_BRIGHT_FRAG, TF_BLOOM_BLUR_FRAG,
	TF_DITHER_PARS_GLSL, TF_DITHER_MAIN_GLSL, installDitherLODPatch, LODGroup,
	computeWorldSphere, CullBVH, SceneCuller,
	OcclusionCuller,
	MeshBVH, raycastMesh,
	StaticBatcher,
	buildTerrainWorkerSource, TerrainStreamer,
	TERRAIN_TEXTURE_KINDS, TF_TERRAIN_TEX_STYLE,
	createTerrainTexture, createTerrainNormalMap, createTerrainTextureSet,
	tfNormalMapFromHeight,
	TF_TERRAIN_DETAIL_GLSL, TF_TERRAIN_DETAIL_VERT,
	TF_TERRAIN_DETAIL_COLOR, TF_TERRAIN_DETAIL_ROUGH, TF_TERRAIN_DETAIL_NORMAL,
	createTerrainDetailUniforms, installTerrainDetailPatch, createTerrainMaterial,
	TF_SWAY_TIME, TF_SWAY_GLSL, TF_SWAY_VERT, installSwayPatch,
	createTreeGeometry, createRockGeometry, createBushGeometry, createGrassGeometry,
	createSwordGeometry, createFistGeometry, createFlowerGeometry, scatterProps,
	createDetailMaterial, TF_DETAIL_DEFAULTS, TF_DETAIL_TYPES, TerrainDetailManager,
	TF_WATER_WAVES_GLSL, TF_WATER_VERT, TF_WATER_FRAG, TF_WATER_DEFAULT_WAVES,
	createShoreHeightTexture, WaterSurface,
	createTerrainSystem,
	TF_SKY_VERT, TF_SKY_FRAG, SkyDome,
	TF_CLOUD_WRAP, TF_CLOUD_VERT, TF_CLOUD_FRAG, CloudLayer,
	createSkySystem
};
