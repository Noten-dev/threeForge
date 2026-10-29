# ThreeForge Engine v2.6.0 — QUICKSTART

Практическое руководство по интеграции. Полный справочник — [API.md](API.md), история изменений — [CHANGELOG.md](CHANGELOG.md).

**TL;DR для агента:**
1. Один ESM-файл `threeforge-v2_6_0.js`, зависимость ровно одна — `three` **r186** (bare-import).
2. Ядро — `Engine` (fixed-timestep цикл); всё остальное — опциональные системы, подключаемые через `engine.addSystem(system, priority)`.
3. Контракт системы: `{ fixedUpdate?(h, engine), update?(dt, alpha, engine) }` — оба метода опциональны.
4. Крупные сборки «одним вызовом»: `createTerrainSystem(...)` и `createSkySystem(...)` — фасады, которые сами связывают и регистрируют subsystems.
5. `PostPipeline` подключается особым образом: `post.attach(engine)` (ставит `engine.renderOverride`).
6. `PhysicsWorld` — НЕ система: у него `step(dt)`, оборачивайте в `fixedUpdate`.

---

## 1. Подключение

### Браузер (import map)

```html
<script type="importmap">
{
  "imports": {
    "three": "https://unpkg.com/three@0.186.0/build/three.module.js",
    "threeforge": "./threeforge-v2_6_0.js"
  }
}
</script>
<script type="module">
  import * as THREE from 'three';
  import { Engine, createLightRig } from 'threeforge';
  // ...
</script>
```

### Сборщик (Vite / webpack / Rollup)

```bash
npm i three@0.186.0
```

Положите `threeforge-v2_6_0.js` в проект (например, `src/lib/`) и импортируйте напрямую:

```js
import { Engine } from './lib/threeforge-v2_6_0.js';
```

> Требуется именно **r186**: модуль использует `THREE.Timer` (в r186 замена устаревшего `Clock`) и внутренние классы теней, которых нет в публичном экспорте более старых версий.

---

## 2. Минимальный запуск

Сцена + игровой цикл + дневной свет + туман:

```js
import * as THREE from 'three';
import { Engine, createLightRig, FogManager } from 'threeforge';

const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 5000);
camera.position.set(0, 8, 30);

// Свет: солнце с CSM-тенями + hemi + луна + SunCycle (время суток)
const lights = createLightRig({ scene });
lights.setTime(10); // 10 утра

// Туман: пресеты auto | clear | haze | fog | dense
const fog = new FogManager({ scene, waterLevel: 0 });
fog.setPreset('haze');

// Движок: fixed-timestep цикл; renderer.render вызывается сам
const engine = new Engine({ renderer, scene, camera });
engine.addSystem(lights);   // update(dt) — время суток
engine.addSystem(fog);      // update(dt) — плавные переходы тумана
engine.start();

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});
```

**Как работает цикл.** `Engine` держит аккумулятор времени: `fixedUpdate(h)` всех систем вызывается строго `fixedTimeStep` (по умолчанию 1/60 с) раз в секунду — детерминированная физика; `update(dt, alpha, engine)` — каждый кадр, где `alpha ∈ [0,1)` — доля накопленного шага для интерполяции рендера. Защита от «спирали смерти»: `maxSubSteps` (5) и `maxFrameDelta` (0.25 с). Статистика — `engine.stats` (`fps`, `frameTime`, `renderMs`, `simSteps`); per-system тайминги — опция `profile: true` + `engine.getProfile()`.

События `Engine` (`EventDispatcher`): `start`, `stop`, `pause`, `resume`, `update` (каждый кадр, до систем), `postrender`, `dispose`.

---

## 3. Открытый мир: террейн + небо + погода

Фасады собирают связку «процедурный террейн со стримингом чанков + растительность + вода + небо + облака + погода» и сами регистрируют системы в `Engine`.

```js
import {
  Engine, createLightRig, FogManager, PhysicsWorld,
  ParticleManager, WeatherManager, PostPipeline,
  createTerrainSystem, createSkySystem
} from 'threeforge';

// ...renderer/scene/camera/engine/lights/fog как в разделе 2...

// Физика (до террейна — фасад сам привяжет heightfield)
const physics = new PhysicsWorld();
engine.addSystem({ fixedUpdate: h => physics.step(h) }, -10); // раньше остальных

// Частицы (нужны погоде) и погода
const particles = new ParticleManager({ scene, camera, fog });
engine.addSystem(particles);
const weather = new WeatherManager({ particles, fog, camera, waterLevel: 0 });
engine.addSystem(weather);
weather.setMode('clear'); // 'clear' | 'rain' | 'snow' | 'storm'

// Постобработка: SSAO (вкл. по умолчанию) + TAA + god-rays + bloom
const post = new PostPipeline({ renderer, scene, camera, fog, quality: 'high' });
post.setTAA({ enabled: true });
post.setGodRays(true);
post.setBloomEnabled(true);
post.attach(engine); // sets engine.renderOverride

// Террейн: чанки через Web Workers, материал с процедурными текстурами,
// растительность/камни, вода. Все подобъекты настраиваются или отключаются (false).
const world = createTerrainSystem({
  scene, camera, engine, physics, fog, lights,
  terrain: { seed: 7, amplitude: 48, scale: 0.004, octaves: 5, waterLevel: -6 },
  streamer: { chunkSize: 128, viewDistance: 5, workers: 2, budgetMs: 6 },
  water: {},       // false — без воды
  details: {},     // false — без растительности
});

// Небо: купол (солнце/луна/звёзды/молнии) + процедурные облака.
// Автопривязка: SunCycle, Fog, Weather, PostPipeline (god-rays), вода.
const sky = createSkySystem({
  scene, camera, engine, fog, lights, weather, post,
  water: world.water,
  sky: { radius: 2400 },
  clouds: { coverage: 0.35 },
});

// Игрок на рельефе
const player = new THREE.Object3D();
player.position.set(0, 0, 0);
scene.add(player);
engine.addSystem({
  update() {
    world.snapToGround(player, 1.8); // поставить на видимую поверхность + зазор
    camera.position.copy(player.position);
  }
}, 100);

// Полезные методы фасада террейна:
world.height(x, z);            // аналитическая высота (без yOffset)
world.groundHeight(x, z);      // высота видимой поверхности
world.waterHeightAt(x, z, t);  // вода с волнами
world.normal(x, z, out);       // нормаль рельефа
world.setFocus(otherObject);   // сменить центр стриминга
sky.setTime(18.5);             // вечер; sky.setCloudCoverage(0.7)
weather.cycleMode();           // следующая погода
```

Свойства террейна (`Terrain`): `scale` (частота шума), `amplitude`, `octaves`, `ridgeMix` (гребни), `waterLevel`, `seed`, `palette`. Детали стримера — в API.md → `TerrainStreamer`.

---

## 4. Физика

```js
import { PhysicsWorld } from 'threeforge';

const physics = new PhysicsWorld({
  gravity: new THREE.Vector3(0, -25, 0), // клонируется; дефолт (0, -25, 0)
  iterations: 12,                        // решатель импульсов
  recordContacts: true,                  // собирать world.contacts
});

// Тела: shape 'sphere' (radius) | 'box' (halfExtents, AABB);
// type: динамические по умолчанию, статика — mass: 0 / isStatic
const ball = physics.addBody({
  shape: 'sphere', radius: 0.5, mass: 2,
  position: new THREE.Vector3(0, 30, 0),
  velocity: new THREE.Vector3(3, 0, 0),
  restitution: 0.4, friction: 0.6,
});
const crate = physics.addBody({
  shape: 'box', halfExtents: new THREE.Vector3(1, 1, 1),
  position: new THREE.Vector3(4, 20, 0), mass: 5,
});

// Шаг — вручную или через Engine (фиксированный шаг!):
engine.addSystem({ fixedUpdate: h => physics.step(h) }, -10);

// Синхронизация мешей (в обычной update-системе):
engine.addSystem({
  update(dt, alpha) {
    ballMesh.position.copy(ball.position);
    crateMesh.position.copy(crate.position);
    crateMesh.quaternion.copy(crate.quaternion);
  }
}, 50);

// Запросы и воздействия:
physics.raycast(origin, dir, 100);       // → {body, point, distance} | null
physics.explode(pos, 12, 30);            // радиальный импульс (спад линейный)
physics.setHeightfield((x, z) => world.height(x, z)); // рельеф как коллайдер
physics.removeBody(ball);                // будит соседей (F4)
```

Особенности: тела засыпают (`sleepDelay`, `sleepThreshold`) — спящее тело участвует в контактах как статик, пока удар не разбудит; broadphase автоматически переключается на `SpatialHashGrid` (при `bodies ≥ hashThreshold` и `awake ≥ hashAwakeMin`); `nanGuard` изолирует тела с NaN; `maxStep` (0.1 с) страхует от «прострела» после фриза вкладки.

---

## 5. Ввод и звук

```js
import { InputManager, AudioManager } from 'threeforge';

const input = new InputManager(renderer.domElement);
input.connect();
input.bind('jump', 'Space');
input.bind('sprint', 'ShiftLeft');
input.bindAxis('moveX', 'KeyA', 'KeyD');       // (ось, минус-клавиша, плюс-клавиша, gamepadAxis?)
input.bindAxis('moveZ', 'KeyS', 'KeyW');

// Мышь: pointer lock только по пользовательскому жесту
renderer.domElement.addEventListener('click', () => input.lockPointer());

engine.addSystem({
  update(dt) {
    const mx = input.axis('moveX'), mz = input.axis('moveZ'); // [-1..1], клавиатура+геймпад
    if (input.isDown('sprint')) { /* ... */ }
    if (input.isPressed('jump')) { /* срабатывает один кадр */ }
    const md = input.consumeMouseDelta();
    yaw -= md.dx * 0.0022;
    pitch = Math.max(-1.5, Math.min(1.5, pitch - md.dy * 0.0022));
    input.endFrame(); // ОБЯЗАТЕЛЬНО в конце кадра (сбрасывает pressed/released)
  }
}, 200);

// Звук: WebAudio, процедурные тоны + свои буферы
const audio = new AudioManager();
audio.setListener(camera);
addEventListener('pointerdown', () => audio.unlock(), { once: true }); // жест обязателен
audio.playTone({ freq: 440, freqEnd: 220, duration: 0.25, gain: 0.2, type: 'sine' });
const noise = audio.makeNoiseBuffer({ seconds: 2, color: 'pink' }); // 'white' | 'pink'
audio.registerBuffer('wind', noise);
audio.playAmbient('wind', { gain: 0.15, loop: true }); // play(name, {gain, loop, rate, position})
// Погоде можно передать аудио: new WeatherManager({ ..., audio }) — звуки дождя/грома.
```

---

## 6. Частицы

Два уровня: **GPU-поля** (`ParticleField` — миллионы частиц, симуляция в вершинном шейдере) и **CPU-пул** (`ParticleSystem` — гибкие эмиттеры). Менеджер владеет атласом, гравитацией/ветром и качеством.

```js
import { ParticleManager } from 'threeforge';

const pm = new ParticleManager({ scene, camera, fog, quality: 'high' });
engine.addSystem(pm); // fixedUpdate + update — контракт Engine

// CPU-система: искры из точки
const sparks = pm.createSystem({ capacity: 512, additive: true });
sparks.addEmitter({
  position: new THREE.Vector3(0, 2, 0),
  rate: 60,                 // частиц/с
  maxPerStep: 16,
  life: { min: 0.6, max: 1.4 },   // диапазоны — {min,max} или число
  size0: 0.14, size1: 0.0,
  speed: { min: 2, max: 6 },
  spreadRadius: 0.3,        // конус/сфера рассеяния (или spreadBox)
  color0: new THREE.Color(1.0, 0.7, 0.2),
  color1: new THREE.Color(0.6, 0.1, 0.0),
  drag: 1.2, gravityScale: 0.4,
});
sparks.burst({ position: new THREE.Vector3(0, 2, 0), life: 1, speed: 8,
               color0: new THREE.Color(1, 1, 0.6), size0: 0.2 }, 120); // залп

pm.setQuality('medium'); // качество/бюджет частиц на лету
```

---

## 7. Оптимизация больших сцен

```js
import {
  InstancedBatcher, SceneCuller, OcclusionCuller, LODGroup, StaticBatcher
} from 'threeforge';

// Инстансинг: одна geometry+material, страницы по pageSize, per-instance цвет
const batcher = new InstancedBatcher({
  geometry: new THREE.IcosahedronGeometry(0.6, 1),
  material: new THREE.MeshStandardMaterial({ roughness: 0.9 }),
  parent: scene, pageSize: 1024, useColor: true, castShadow: true,
});
const h = batcher.add(new THREE.Matrix4().setPosition(x, y, z), new THREE.Color(0x88aa55));
batcher.setTransform(h, pos, quat, scale); // дешёвый апдейт без матриц
batcher.flush();                            // залить изменения в GPU

// Frustum-куллинг (BVH по мировым сферам):
const culler = new SceneCuller({ camera });
culler.add(someMesh);          // можно {dynamic: true} для движущихся
engine.addSystem(culler);      // update() — контракт совместим

// Софтверный Hi-Z окклюзионный куллинг (CPU, без GPU-запросов):
const occl = new OcclusionCuller({ camera, gridWidth: 128, gridHeight: 72 });
occl.addOccluder(buildingMesh);  // крупные непрозрачные
occl.addOccludee(crateMesh);     // что прятать за ними
engine.addSystem(occl);

// LOD с dither-cross-fade (без щелчков геометрии):
const lod = new LODGroup();
lod.addLevel(highPolyMesh, 0);   // (object, порог дистанции)
lod.addLevel(midPolyMesh, 40);
lod.addLevel(billboard, 120);
scene.add(lod);
engine.addSystem(lod);

// Статический батчинг: слить неподвижные меши {geometry, matrix, color?}
// в массив BufferGeometry (авторазбиение по maxVertices под Uint16-индекс)
const geoms = StaticBatcher.mergeGeometries([
  { geometry: rockGeo, matrix: new THREE.Matrix4().setPosition(1, 0, 0) },
  { geometry: rockGeo, matrix: new THREE.Matrix4().setPosition(9, 0, 4), color: 0x997755 },
]);
for (const g of geoms) scene.add(new THREE.Mesh(g, sharedMaterial));
```

Для потокового террейна отдельный класс — `TerrainStreamer` (используется внутри `createTerrainSystem`).

---

## 8. Жизненный цикл и ресурсы

```js
// Порядок teardown — обратный созданию:
sky.dispose();       // отвязывает контракты SunCycle/Fog/Weather/Post/Water
world.dispose();     // streamer/details/water, heightfield, материал, текстуры, группа
post.dispose();      // освобождает render targets (включая god-rays/TAA)
particles.destroySystem(sparks);
pm.dispose();        // все поля/системы + атлас
weather.dispose();
lights.dispose();
input.dispose();
audio.dispose();
engine.dispose();    // останавливает цикл, обнуляет ссылки
renderer.dispose();
```

Все `dispose()` идемпотентны и безопасны после `engine.dispose()` (N12/F-фиксы).

---

## 8.5. Тени (v2.7 Shadow Overhaul)

### Пресет качества одним вызовом

```js
import { applyShadowQuality } from './threeforge/threeforge-v2_6_0.js';

// на загрузке уровня (смена каскадов/тапов recompiles шейдеры — не зовите в бою):
applyShadowQuality('ultra', { rig: lights, lights: lightManager });
// 'low' | 'medium' | 'high' (= прежнее поведение) | 'ultra' — или свой объект-пресет
```

Пресет настраивает: каскады CSM, Vogel-тапы PCF, soft-режим, размеры карт
солнца/луны/слотов `LightManager`, бюджет и частоту обновлений.

### Ручная настройка

```js
import { setSunCascadeCount, setShadowQuality } from './threeforge/threeforge-v2_6_0.js';

setSunCascadeCount(4);                       // 1..4 каскада (ДО первого рендера!)
rig.sun.shadow.setSplitLambda(0.6);          // 0 = log-сплиты, 1 = uniform
rig.sun.shadow.setCascadeTiles([2, 1, 1, 1]); // ближний каскад вдвое детальнее
rig.sun.shadow.setCascadeFade(0.15);         // шире бленд между каскадами

setShadowQuality({
  taps: 16,                                  // Vogel-тапов PCF (дефолт 12)
  soft: { mix: 0.6, depthGrowth: 0.4, radius: 3 }, // мягкие тени (×2 сэмплинга)
  fadeAllLights: true                        // туманный фейд для dir/spot/point
});
```

### Лунные тени

```js
const rig = createLightRig({
  scene, camera,
  moonShadow: { mapSize: 1024, range: 60 },  // castShadow включён сразу — без
});                                          // рекомпиляций в рантайме
// ночью SunCycle сам включает shadow-проход луны и следит фрустумом за камерой.
// v2.9 (D2): карта луны рендерится один раз на ПЕРВОМ кадре при любом времени
// суток (needsUpdate=true из рига) — иначе днём sampler2DShadow в PCF/PCFSoft
// получил бы плейсхолдер без COMPARE_MODE (GL INVALID_OPERATION на всех draw).
```

### Бюджет обновлений (много факелов/ламп)

```js
const lights = new LightManager({
  scene, camera, maxPointLights: 8, pointShadowSlots: 2,
  shadowBudget: 1,   // не более 1 рендера теневой карты на кадр (round-robin)
  shadowRate: 10     // статичным источникам хватает 10 Гц
});
lights.add(torch, { shadow: true });                  // унаследует 10 Гц
lights.add(playerLamp, { shadow: true, shadowRate: 0 }); // каждый кадр
```

Первый рендер карты источника — всегда вне бюджета (иначе чёрные тени).
Ночью `SunCycle` плавно уводит `sun.shadow.intensity` в 0 — застывшая карта
заката больше не рисуется на ночной сцене.

### Отладка

```js
import { SunShadowHelper } from './threeforge/threeforge-v2_6_0.js';
const helper = new SunShadowHelper(rig.sun);
scene.add(helper);
engine.addSystem({ update: () => helper.update(camera) }, 90);
// wireframe-фрустумы каскадов (цвет = каскад) + направление света; F-клавишей
// через helper.visible можно включать/выключать
```

---

## 8.6. Gameplay Kit (v2.8): игра от первого лица

Готовое демо — `examples/sword-field.html` (запуск: `node tools/dev/serve.mjs`, открыть `/`).
Минимальная сборка «ночная стилизованная игра от первого лица»:

```js
import * as THREE from 'three';
import * as TF from 'threeforge';

// ...renderer/scene/camera/engine, rig = createLightRig({scene}), fog, world = createTerrainSystem(...)...

// Ночь, пастельный пост-грейд (GK9) + bloom на звёзды
rig.setTime(22.6);
const post = new TF.PostPipeline({
  renderer, scene, camera, fog,
  bloom: { enabled: true, threshold: 1.05, intensity: 0.42 },
  grade: { vignette: 0.34, saturation: 1.1, tint: 0xc9d2ff },
  // v2.9 (S3): AO гасит только ambient-составляющую; доля берётся из живых
  // интенсивностей рига (ночью выше, днём почти не трогает солнечный свет)
  ao: { lights: { hemi: rig.hemi, sun: rig.sun, moon: rig.moon } }
});
post.attach(engine);

// Поле цветов (GK3): details: { types: { flower: { density: 1.6 } } } в createTerrainSystem.

// Ходьба от первого лица (GK6) + вьюмодель кулак+меч (GK2/GK7)
const input = new TF.InputManager(renderer.domElement);
const ctl = new TF.FirstPersonController({ camera, input, groundFn: (x, z) => world.groundHeight(x, z) });
ctl.attach(engine);
renderer.domElement.addEventListener('click', () => ctl.lock());

const vm = new TF.ViewModel({ camera });
const fist = new THREE.Mesh(TF.createFistGeometry(), TF.createStylizedMaterial({ color: 0xc9a186 }));
fist.add(new THREE.Mesh(TF.createSwordGeometry({ bladeLength: 0.92 }), TF.createStylizedMaterial({ color: 0xb9c2cf, rim: 0.55 })));
vm.add(fist, { offset: { x: 0.3, y: -0.33, z: -0.62 } });
vm.attach(engine);                                    // ОБЯЗАТЕЛЬНО после post.attach
engine.addSystem({ update: dt => vm.update(dt, ctl) }, 50);

// Гигантские воткнутые мечи (GK1/GK4) + парящие острова (GK5)
const swords = TF.scatterProps({
  geometry: TF.createSwordGeometry(), material: giantMat,
  count: 52, seed: 5, radius: 150, chunkSize: 64,
  heightFn: (x, z) => world.groundHeight(x, z),
  scale: [7, 15], tiltMax: 0.24, sink: 1.4, baseRotation: [Math.PI, 0, 0]
});
scene.add(swords.group);

const floating = new TF.FloatingProps();
floating.add(skyRock, { amp: 1.2, freq: 0.02, rotSpeed: 0.008, tilt: 0.015 });
floating.attach(engine);

// HUD-плашка как в референсе (GK10)
const hud = new TF.Hud({ title: 'ИГРА', hints: ['Tab — вернуться в конструктор', 'Esc — меню игры'] });
engine.start();
```

Стилизованный вид (GK8): `createStylizedMaterial({ color, steps: 3, rim: 0.4 })` —
MeshToonMaterial со ступенчатым светом и rim-френелем; работает с fog/тенями v2.7/sway.

**Single-file сборка.** `npm run standalone` собирает `examples/sword-field-standalone.html` —
ОДИН самодостаточный файл (three r186 + движок + демо инлайнятся классическим `<script>`,
без import map и сервера): открывается двойным кликом с диска (file://), воркеры террейна
поднимаются из Blob. Пересобрать после правок движка/демо: `npm run standalone`.
Проверка бандла встроена в сборку (acorn-парсинг + headless-прогон three+движок в node vm).

## 9. Чек-лист типичных ошибок

| Симптом | Причина / решение |
|---|---|
| Физика «взрывается» после сворачивания вкладки | Не через `Engine`: `step(dt)` получает огромный dt. Используйте `fixedUpdate`-обёртку или полагайтесь на `maxStep`/`maxFrameDelta` |
| Тени солнца пропадают вдалеке | `SunLight`/CSM: держите `lights.cycle` подключённым к `Engine`; для `DirectionalLight` зовите `fitShadowCamera()` (T4). Дальность CSM = `min(shadow.camera.far, camera.far)` — поднимите `shadowFar` в `createLightRig` |
| Тени «кипят»/мерцают при движении | CSM снапается на тексельную сетку автоматически; для `DirectionalLight.followCamera` не отключайте `snap`; поднимите `shadowMapSize` |
| После `setSunCascadeCount` тени пропали/артефакты | Меняйте каскады ДО первого рендера (define шейдера глобальный); TF-материалы пересобираются сами, чужие — через `material.needsUpdate = true` |
| Много точечных теней — просел FPS | `LightManager`: `shadowBudget` (грантов/кадр) + `shadowRate` (Гц); куб-карта = 6 граней, держите 1–2 теневых слота |
| `PostPipeline` не рисует | Нужен `post.attach(engine)`; `renderer` обязателен в конструкторе; при своём цикле — `engine.renderOverride` |
| TAA «мажет» движущиеся объекты | Динамику нужно регистрировать: `post.trackObject(mesh)` (motion vectors) |
| Небо не видно / купол уезжает | Группа `createSkySystem` должна оставаться в начале координат — купол позиционируется мировой позицией камеры |
| Звук молчит | `audio.unlock()` по пользовательскому жесту; pointer lock — тоже только по жесту |
| `isPressed` не срабатывает повторно | В конце каждого кадра нужен `input.endFrame()` |
| Дыры в террейне при лагах воркеров | `TerrainStreamer`: настройте `workerTimeoutMs` — пул сам деградирует в sync (T11/T13) |
| NaN-частицы съедают capacity | Ужеsanitize-ровано (T12), но не передавайте NaN в конфиги эмиттеров |
| Старая версия three | Нужна r186: `THREE.Timer`, внутренние shadow-классы |

---

## 10. Шпаргалка: что чем является

| Задача | Инструмент |
|---|---|
| Игровой цикл, системы, пауза | `Engine` |
| Время суток, солнце/луна, палитра неба | `SunCycle` (или риг `createLightRig`) |
| Тени солнца (каскады, 1–4) | `SunLight` + `installSunShadowPatch`; каскады/сплиты — `setSunCascadeCount`, `shadow.setSplitLambda/setCascadeTiles` |
| Качество теней (тапы/soft/пресеты) | `setShadowQuality`, `applyShadowQuality('ultra', { rig, lights })` |
| Отладка каскадов | `SunShadowHelper(sun)` + `helper.update(camera)` |
| Туман (пресеты, высота, вода) | `FogManager` + `installFogPatch` |
| Погода (дождь/снег/гроза, ветер, молнии) | `WeatherManager` |
| Частицы | `ParticleManager` → `createField` (GPU) / `createSystem` (CPU) |
| Процедурный рельеф (математика) | `Terrain`, `SimplexNoise`, `fbm`, `createPRNG` |
| Рельеф в игре (чанки, текстуры, флора, вода) | `createTerrainSystem` |
| Небо и облака | `createSkySystem` (`SkyDome`, `CloudLayer`) |
| Физика тел | `PhysicsWorld` + `RigidBody` |
| Ввод (клавиатура/мышь/геймпад) | `InputManager` |
| Звук | `AudioManager` |
| Постобработка (AO/TAA/bloom/god-rays/FXAA) | `PostPipeline` |
| Инстансинг | `InstancedBatcher` |
| Куллинг | `SceneCuller` (frustum), `OcclusionCuller` (Hi-Z) |
| LOD | `LODGroup` + `installDitherLODPatch` |
| Светящиеся текстуры (окна, лава) | `EmissiveManager` / `installEmissivePatch` |
| Бюджет источников света | `LightManager` |
| Бюджет обновлений теневых карт | `LightManager` (`shadowBudget`, `shadowRate`, `setShadowRate`) |
