# ThreeForge Engine v2.6.0 — справочник API

Единый **ESM-модуль** для **three.js r186** (единственный импорт — `three`, других зависимостей нет).
Файл: `threeforge-v2_6_0.js`. Все системы **опциональны**: подключайте только то, что нужно.

**Экспортов: 186** — 40 классов, 49 функций, 39 GLSL-чанков, 58 констант/пресетов.

> **v2.7 Shadow Overhaul**: каскады 1–4 (`setSunCascadeCount`), тиры PCF и soft-режим
> (`setShadowQuality`), пресеты (`applyShadowQuality`), лунные тени, бюджет обновлений
> `LightManager`, отладочный `SunShadowHelper`. Дефолты совпадают с v2.6 — см. [CHANGELOG.md](CHANGELOG.md).

> **v2.8 Gameplay Kit**: стилизованный toon-материал с rim (`createStylizedMaterial`),
> FP-контроллер (`FirstPersonController`), вьюмодель (`ViewModel`), рассеивание пропсов
> (`scatterProps`), процедурные меч/кулак/цветок, тип детали `flower`, парящие объекты
> (`FloatingProps`), DOM-`Hud`, кино-грейд `PostPipeline` (виньетка/насыщенность/тон).
> Дефолты нейтральны — см. [CHANGELOG.md](CHANGELOG.md). Демо: `examples/sword-field.html`.

> Сопутствующие документы: [QUICKSTART.md](QUICKSTART.md) — рабочие примеры интеграции;
> [CHANGELOG.md](CHANGELOG.md) — история исправлений (метки T/L/R/S/N/M в комментариях кода).

## Оглавление

- [Интеграция](#интеграция)
- [Обзор экспортов](#обзор-экспортов)
- [Часть 1: ядро](#часть-1-ядро)
- [Часть 1.5: свет и тени](#часть-15-свет-и-тени)
- [Часть 1.55: гигиена шейдерных патчей](#часть-155-гигиена-шейдерных-патчей)
- [Часть 1.58: Gameplay Kit (v2.8)](#часть-158-gameplay-kit-v28)
- [Часть 1.6: источники света, LightManager, emissive](#часть-16-источники-света-lightmanager-emissive)
- [Часть 1.75: туман](#часть-175-туман)
- [Часть 1.9: частицы и погода](#часть-19-частицы-и-погода)
- [Часть 2: шум, террейн, физика, ввод, звук](#часть-2-шум-террейн-физика-ввод-звук)
- [Часть 3: продвинутый рендеринг](#часть-3-продвинутый-рендеринг)
- [Часть 4: игровой террейн](#часть-4-игровой-террейн)
- [Часть 5: небо](#часть-5-небо)

## Интеграция

### Подключение

Модуль импортирует `three` как bare-specifier — в браузере нужна import map (или сборщик: Vite/webpack/Rollup — достаточно положить файл в проект и импортировать):

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
import { Engine, createLightRig, PhysicsWorld } from 'threeforge';
</script>
```

### Контракт систем Engine

`engine.addSystem(system, priority)` принимает любой объект с опциональными методами:

```js
{
  fixedUpdate(h, engine) {},      // строгий фиксированный шаг (физика)
  update(dt, alpha, engine) {}    // каждый кадр; alpha ∈ [0,1) — интерполяция
}
```

Системы вызываются в порядке `priority` (меньше — раньше). Большинство менеджеров движка
(`FogManager`, `WeatherManager`, `ParticleManager`, `SunCycle`, фасады `createTerrainSystem`/`createSkySystem`)
уже соответствуют контракту или имеют совместимый `update(dt)` — подключайте их через `addSystem`.
`PhysicsWorld` — исключение: у него `step(dt)`, оборачивайте: `engine.addSystem({ fixedUpdate: h => physics.step(h) })`.

### Типовая иерархия систем (приоритеты)

| Система | Роль | Куда |
|---|---|---|
| `SunCycle` / риг `createLightRig` | время суток, свет | `update(dt)` |
| `PhysicsWorld` | симуляция тел | `fixedUpdate(h)` |
| `TerrainStreamer` | чанки террейна | `update(dt)` (внутренний бюджет) |
| `FogManager` | туман (пресеты, авто, погода) | `update(dt)` |
| `WeatherManager` | погода: осадки, ветер, молнии | `update(dt)` |
| `ParticleManager` | частицы (GPU/CPU) | `update(dt, camera)` |
| `SceneCuller` / `OcclusionCuller` | отсечение невидимого | `update(dt)` |
| `PostPipeline` | постобработка | `attach(engine)` — сама ставит `renderOverride` |

Фасады `createTerrainSystem` и `createSkySystem` связывают всё автоматически (см. их описания и QUICKSTART).

## Обзор экспортов

- **часть 1: ядро** (3): `Engine`, `InstancedBatcher`, `CullGroup`
- **часть 1.5: свет и тени** (17): `SunLight`, `SunLightShadow`, `PointLight`, `SunCycle`, `SUN_CASCADE_COUNT`, `SUN_CASCADE_FADE`, `getSunCascadeCount`, `setSunCascadeCount`, `getShadowQuality`, `setShadowQuality`, `SHADOW_QUALITY_PRESETS`, `SHADOW_QUALITY_ORDER`, `applyShadowQuality`, `SunShadowHelper`, `installSunShadowPatch`, `TF_SUN_SHADOW_FN`, `TF_SHADOW_UNIFORMS`
- **часть 1.55: гигиена шейдерных патчей** (4): `tfAddProgramCacheKey`, `tfRecordPatch`, `tfChainOnBeforeCompile`, `cloneMaterialPatched`
- **часть 1.6: источники света, LightManager, emissive** (14): `DirectionalLight`, `SpotLight`, `LightManager`, `LIGHT_FLICKER`, `tfFlickerValue`, `createLightRig`, `installEmissivePatch`, `applyEmissiveOptions`, `EmissiveManager`, `TF_EMISSIVE_GLSL`, `TF_EMISSIVE_TIME`, `createEmissiveTexture`, `createEmissiveMaterial`, `EMISSIVE_TEXTURE_KINDS`
- **часть 1.75: туман** (5): `FogManager`, `installFogPatch`, `TF_FOG_GLSL`, `FOG_PRESETS`, `FOG_PRESET_ORDER`
- **часть 1.9: частицы и погода** (41): `ParticleManager`, `ParticleField`, `ParticleSystem`, `WeatherManager`, `createParticleAtlas`, `createParticleMaterial`, `TFInstancedBufferGeometry`, `TF_TILE_PAD`, `TF_TILE_SCALE`, `TF_TILE_PAD_UV`, `TF_PARTICLES_GLSL_COMMON_VERT`, `TF_PARTICLES_SPRITE_VERT`, `TF_PARTICLES_STREAK_VERT`, `TF_PARTICLES_CPU_VERT`, `TF_PARTICLES_FRAG`, `TF_PSTRIDE`, `TF_P_POS`, `TF_P_VEL`, `TF_P_AGE`, `TF_P_INVLIFE`, `TF_P_SIZE0`, `TF_P_SIZE1`, `TF_P_ROT0`, `TF_P_ROTV`, `TF_P_C0`, `TF_P_C1`, `TF_P_ALPHA`, `TF_P_FADEIN`, `TF_P_DRAG`, `TF_P_GSCALE`, `TF_P_TILE`, `TF_P_STRETCH`, `TF_P_WINDF`, `TF_P_TURBA`, `TF_P_TURBF`, `TF_QUALITY_MUL`, `TF_QUALITY_ORDER`, `TF_QUALITY_TIERS`, `WEATHER_MODES`, `WEATHER_ORDER`, `defaultFogUniforms`
- **часть 2: шум, террейн, физика, ввод, звук** (17): `createPRNG`, `SimplexNoise`, `fbm`, `SIMPLEX_GRAD3`, `SIMPLEX_F2`, `SIMPLEX_G2`, `Terrain`, `TERRAIN_SAND`, `TERRAIN_SNOW`, `TERRAIN_ROCK`, `TERRAIN_GRASS_A`, `TERRAIN_GRASS_B`, `RigidBody`, `SpatialHashGrid`, `PhysicsWorld`, `InputManager`, `AudioManager`
- **часть 3: продвинутый рендеринг** (33): `TF_FS_VERT`, `TF_AO_FRAG`, `TF_AO_BLUR_FRAG`, `TF_COMPOSITE_FRAG`, `TF_DEBUG_FRAG`, `TF_FXAA_FRAG`, `TF_NORMAL_VERT`, `TF_NORMAL_FRAG`, `PostPipeline`, `TF_VELOCITY_VERT`, `TF_VELOCITY_FRAG`, `TF_TAA_RESOLVE_FRAG`, `TF_TAA_BLIT_FRAG`, `TF_VELOCITY_LAYER`, `tfHalton`, `TF_RAYS_BRIGHT_FRAG`, `TF_RAYS_BLUR_FRAG`, `TF_FINAL_FRAG`, `TF_BLOOM_BRIGHT_FRAG`, `TF_BLOOM_BLUR_FRAG`, `TF_DITHER_PARS_GLSL`, `TF_DITHER_MAIN_GLSL`, `installDitherLODPatch`, `LODGroup`, `computeWorldSphere`, `CullBVH`, `SceneCuller`, `OcclusionCuller`, `MeshBVH`, `raycastMesh`, `StaticBatcher`, `buildTerrainWorkerSource`, `TerrainStreamer`
- **часть 4: игровой террейн** (33): `TERRAIN_TEXTURE_KINDS`, `TF_TERRAIN_TEX_STYLE`, `createTerrainTexture`, `createTerrainNormalMap`, `createTerrainTextureSet`, `tfNormalMapFromHeight`, `TF_TERRAIN_DETAIL_GLSL`, `TF_TERRAIN_DETAIL_VERT`, `TF_TERRAIN_DETAIL_COLOR`, `TF_TERRAIN_DETAIL_ROUGH`, `TF_TERRAIN_DETAIL_NORMAL`, `createTerrainDetailUniforms`, `installTerrainDetailPatch`, `createTerrainMaterial`, `TF_SWAY_TIME`, `TF_SWAY_GLSL`, `TF_SWAY_VERT`, `installSwayPatch`, `createTreeGeometry`, `createRockGeometry`, `createBushGeometry`, `createGrassGeometry`, `createDetailMaterial`, `TF_DETAIL_DEFAULTS`, `TF_DETAIL_TYPES`, `TerrainDetailManager`, `TF_WATER_WAVES_GLSL`, `TF_WATER_VERT`, `TF_WATER_FRAG`, `TF_WATER_DEFAULT_WAVES`, `createShoreHeightTexture`, `WaterSurface`, `createTerrainSystem`
- **часть 5: небо** (8): `TF_SKY_VERT`, `TF_SKY_FRAG`, `SkyDome`, `TF_CLOUD_WRAP`, `TF_CLOUD_VERT`, `TF_CLOUD_FRAG`, `CloudLayer`, `createSkySystem`

## Часть 1: ядро

> ThreeForge Engine — часть 1: ядро (Engine + InstancedBatcher) Восстановлено из минифицированного бандла в читаемый вид + исправлены баги. Код находится внутри общей IIFE бандла three.js r186, поэтому используем читаемые алиасы для минифицированных классов библиотеки.

### Engine

*extends `EventDispatcher`; строка 36*

Игровой цикл с фиксированным шагом физики: `fixedUpdate(h)` систем вызывается строго `fixedTimeStep` раз в секунду (аккумулятор, защита от «спирали смерти» — `maxSubSteps`, `maxFrameDelta`), `update(dt, alpha)` — каждый кадр; `alpha` — доля аккумулятора для интерполяции рендера. Работает через `renderer.setAnimationLoop` (если renderer задан) или rAF.

**`new Engine(options)`**

| Опция | По умолчанию | Описание |
|---|---|---|
| `fixedTimeStep` | `1 / 60` | фиксированный шаг симуляции, с |
| `maxSubSteps` | `5` | потолок fixed-шагов за один кадр (защита от «спирали смерти») |
| `maxFrameDelta` | `0.25` | Максимальная дельта одного кадра, с. Всё, что сверху, отбрасывается: после возврата на вкладку или долгой сборки чанков кадр не должен «проталкивать»… |
| `interpolation` | `true` | считать alpha — долю накопленного шага для интерполяции рендера |
| `renderer` | `null` | WebGLRenderer: цикл через renderer.setAnimationLoop + авто-рендер scene/camera (иначе rAF без рендера) |
| `scene` | `null` | THREE.Scene для авто-рендера |
| `camera` | `null` | камера для авто-рендера |
| `renderOverride` | `null` | функция(engine, dt, alpha), ЗАМЕНЯЮЩАЯ прямой renderer.render (точка подключения PostPipeline/SSAO) |
| `profile` | `false` | per-system тайминги (EMA мс) в this._profile |

**Методы:**

| Сигнатура | Описание |
|---|---|
| `addSystem(system, priority = 0)` |  |
| `removeSystem(system)` |  |
| `start()` |  |
| `stop()` |  |
| `pause()` |  |
| `resume()` |  |
| `step(h = this.fixedTimeStep)` | Ручной одиночный шаг (отладка, тесты, покадровая запись). |
| `frame(dt)` | Один кадр с ЯВНОЙ дельтой времени. |
| `getProfile()` | снимок профиля систем, отсортированный по суммарной стоимости. |
| `resetProfile()` |  |
| `dispose()` | Остановка цикла + освобождение всех ссылок. |

*Приватные (`_…`, не часть публичного контракта): 4 — `_tick`, `_simulate`, `_frame`, `_profRun`*

**События** (`EventDispatcher`): `start`, `stop`, `pause`, `resume`, `update`, `postrender`, `dispose`

### InstancedBatcher

*строка 306*

InstancedBatcher — пул инстансов поверх THREE.InstancedMesh со «страницами». - add(matrix, color) -> handle; remove(handle) — swap-remove (O(1), плотный массив инстансов, без «дыр»). - Частичная загрузка на GPU: батчер помечает только изменённый диапазон слотов (dirtyMin..dirtyMax) и загружает его через updateRanges — вместо полного bufferSubData на весь pageSize каждый кадр. - frustum culling: собственная растущая boundingSphere на страницу (обновляется из AABB всех инстансов; периодический computeBounds() сжимает её обратно). ИСПРАВЛЕНО (критические баги оригинала в remove()/add()): 1)…

**`new InstancedBatcher(options)`**

| Опция | По умолчанию | Описание |
|---|---|---|
| `pageSize` | `16384` | — |
| `parent` | `null` | — |
| `bounds` | `'grow'` | — |
| `useColor` | `false` | — |
| `castShadow` | `false` | 'grow' \| 'none' |
| `receiveShadow` | `false` | — |
| `frustumCulled` | `true` | — |
| `geometry` | — | — |
| `material` | — | — |

**Методы:**

| Сигнатура | Описание |
|---|---|
| `add(matrix, color = null)` |  |
| `setMatrix(handle, matrix, growBounds = true)` |  |
| `setTransform(handle, position, quaternion = null, scale = null)` |  |
| `setColor(handle, color)` |  |
| `getMatrix(handle, out)` |  |
| `remove(handle)` | Занятые слоты остаются плотными [0, used) — free-list не нужен. |
| `flush()` | Загружает на GPU только изменённые диапазоны матриц/цвета. |
| `computeBounds()` | Вызывать периодически, если инстансы двигаются (grow-only границы только растут). |
| `clear()` | Мгновенно удалить все инстансы (страницы и GPU-буферы сохраняются). |
| `get capacity()` |  |
| `get pageCount()` |  |
| `forEachInstance(callback)` |  |
| `dispose()` |  |

*Приватные (`_…`, не часть публичного контракта): 5 — `_allocatePage`, `_validHandle`, `_markDirty`, `_markColorDirty`, `_growBounds`*

### CullGroup

*extends `Group`; строка 5802*

P5: скретч вместо matrixWorld.clone()

**Конструктор:** `new CullGroup()`

**Методы:**

| Сигнатура | Описание |
|---|---|
| `computeBoundingSphere()` |  |
| `setBoundingSphereFromWorldBox(box)` |  |
| `intersectsFrustum(frustum)` |  |
| `copy(source, recursive)` |  |

---

## Часть 1.5: свет и тени

> ThreeForge Engine — часть 1.5: свет и тени (SunLight + CSM, SunCycle) three.js r186 содержит ПОЛНУЮ поддержку каскадных теней SunLight на уровне рендерера (WebGLShadowMap: атлас вьюпортов и getCamera(i)/getFrustum(i); WebGLLights: sunShadowMatrix/sunShadowCascade; шейдеры: getSunShadow с выбором каскада по view-глубине и fade-блендингом), но сами классы источника в бандл не вошли. Ниже — порт эталонных SunLight/SunLightShadow из three@0.186.0 (examples/jsm/lights) на минифицированные алиасы бандла + минимальный PointLight + SunCycle (директор времени суток). Контракты рендерера (проверены по коду бандла): - WebGLShadowMap.render(shadows, scene, camera): shadow.getFrameExtents() -> Vector2…

### SunLight

*extends `Light`; строка 716*

SunLight — солнце: параллельные лучи, направление = normalize(position) (светит из position в начало координат; target не нужен). Тени — каскады SunLightShadow (v2.7: 1–4, настраиваются глобально setSunCascadeCount или per-shadow через shadowOptions.cascades), подгоняются под камеру сцены автоматически. ИСПРАВЛЕНО (L3): dispose() теперь вызывает super.dispose() — Light наследует его от Object3D (dispatchEvent 'dispose'), как и в эталонном examples/jsm/lights/SunLight.js. Прежний комментарий («у Light в этом бандле его нет») относился к минифицированной сборке и устарел.

**Конструктор:** `new SunLight(color, intensity, shadowOptions)` — `shadowOptions` передаётся в `SunLightShadow` (`cascades`, `splitLambda`, `cascadeFade`, `cascadeTiles`).

**Методы:**

| Сигнатура | Описание |
|---|---|
| `dispose()` |  |
| `copy(source, recursive)` |  |
| `toJSON(meta)` |  |

### SunLightShadow

*extends `LightShadow`*

Каскадные тени солнца (CSM) поверх атласа: N фрустумов-срезов view-камеры упакованы в одну карту (`mapSize` = размер ОДНОГО каскада; атлас = mapSize × сумма тайлов). v2.7: число каскадов, схема сплитов, фейд и веса тайлов настраиваются; дефолты покадрово эквивалентны эталону three (examples/jsm/lights/SunLightShadow).

**Конструктор:** `new SunLightShadow(options)`

| Опция | По умолчанию | Описание |
|---|---|---|
| `cascades` | `getSunCascadeCount()` | Число каскадов 1..4. |
| `splitLambda` | `0.5` | Схема сплитов: 0 = логарифмическая, 1 = равномерная, 0.5 = среднее (эталон). |
| `cascadeFade` | `0.1` | Доля глубины каскада, растворяющаяся в следующем (0.02..0.9). |
| `cascadeTiles` | `null` | Веса каскадов в атласе: `[2,1,1,1]` — ближний вдвое детальнее; null = по 1. |

**Методы:**

| Сигнатура | Описание |
|---|---|
| `setCascadeCount(n)` | Число каскадов 1..4 (пересоздаёт камеры/атлас; карта будет пересобрана). |
| `getCascadeCount()` |  |
| `setSplitLambda(x)` | Схема сплитов: 0 = логарифмическая, 1 = равномерная (дефолт 0.5). |
| `setCascadeFade(f)` | Доля глубины каскада, растворяющаяся в следующем (0.02..0.9). |
| `setCascadeTiles(tiles)` | Веса каскадов в атласе ([2,1,1,1] — ближний вдвое детальнее); null = по 1. |
| `getCamera(cascadeIndex = 0)` |  |
| `getMatrix(cascadeIndex = 0)` |  |
| `getFrustum(cascadeIndex = 0)` |  |
| `updateMatrices(light, viewCamera)` | viewCamera — камера, которой рендерится сцена (срезы её frustum'а). |
| `copy(source, recursive)` | Переносит в т.ч. splitLambda/cascadeFade/cascadeTiles/число каскадов. |
| `toJSON()` | + cascades, splitLambda, cascadeFade, cascadeTiles. |
| `dispose()` | Снимает тень с глобального реестра (setSunCascadeCount её больше не трогает). |

### PointLight

*extends `Light`; строка 1172*

PointLight — точечный источник. ИСПРАВЛЕНО/ДОРАБОТАНО (L2): прежняя версия была заглушкой без shadow, без power и без copy/toJSON/dispose, а комментарий запрещал castShadow («PointLightShadow в бандл не вошёл»). В реальном three r186 (import из 'three') PointLightShadow ЕСТЬ, а WebGLShadowMap.render() для light.isPointLight рендерит куб-карту (6 граней, WebGLCubeRenderTarget) и сам выставляет camera.far = light.distance || camera.far. Поэтому тени точечных источников доступны «из коробки»; по-прежнему opt-in (castShadow = false по умолчанию — куб-тени дороги). Контракт WebGLLights для…

**`new PointLight(options)`**

| Опция | По умолчанию | Описание |
|---|---|---|
| `shadowMapSize` | `512` | — |
| `shadowBias` | `0.005` | — |
| `shadowNormalBias` | `0.02` | — |
| `shadowRadius` | `2` | — |
| `priority` | `1` | Поле для LightManager (не влияет на рендерер напрямую): |
| `castShadow` | `false` | Куб-тени: 6 граней |
| `shadowNear` | — | — |
| `shadowFar` | — | — |

**Методы:**

| Сигнатура | Описание |
|---|---|
| `get power()` | Световой поток в люменах (изотропный источник: |
| `power(p)` |  |
| `enableShadow(mapSize = 512, o = {})` | Включить куб-тени и настроить качество. |
| `disableShadow()` |  |
| `dispose()` |  |
| `copy(source, recursive)` |  |
| `toJSON(meta)` |  |

### SunCycle

*extends `EventDispatcher`; строка 939*

SunCycle — директор времени суток. Считает положение/палитру солнца, луны и неба для часа time ∈ [0..24) и записывает результат в связанные цели (всё опционально, null = не трогать): sun (SunLight), hemi (HemisphereLight), moon (DirectionalLight; v2.7 — опционально с тенями), fogColor (общий Color тумана/фона/горизонта), skyUniforms, waterUniforms. v2.7: вместо булева порога — ПЛАВНЫЕ shadow.intensity солнца и луны по высоте светила (поля shadowFactor/moonShadowFactor): ночью застывшая карта заката больше не сэмплируется (интенсивность 0), рассвет/закат без щелчка; shadow-проход по-прежнему выключается (экономия без рекомпиляции программ). sunDirection/moonDirection/sunColor — ЖИВЫЕ объекты: можно отдавать их напрямую в value униформ (uSunDir.value =…

**`new SunCycle(options)`**

| Опция | По умолчанию | Описание |
|---|---|---|
| `time` | `10.0` | — |
| `hoursPerSecond` | `0.1` | часы [0..24) |
| `autoAdvance` | `true` | сутки = 240 с |
| `maxElevationDeg` | `62` | — |
| `sunDistance` | `1000` | — |
| `sunIntensityMax` | `3.3` | — |
| `moonIntensityMax` | `0.25` | — |
| `sun` | `null` | — |
| `hemi` | `null` | — |
| `moon` | `null` | — |
| `fogColor` | `null` | — |
| `skyUniforms` | `null` | — |
| `waterUniforms` | `null` | — |
| `lights` | — | часть 1.6: LightManager (или любой объект с setDayFactor) |

**Поля состояния (читаются после update):** `dayFactor`, `nightFactor`, `sunsetFactor`, `sunIntensity`, `hemiIntensity`, `moonIntensity`, `elevation`, **v2.7:** `shadowFactor` (0 ночь → 1 день; пишется в `sun.shadow.intensity`), `moonShadowFactor` (наоборот).

**Методы:**

| Сигнатура | Описание |
|---|---|
| `setTime(hours)` |  |
| `get timeString()` |  |
| `update(dt)` |  |
| `bindLightManager(lights)` | Привязать LightManager (часть 1.6): |

*Приватные (`_…`, не часть публичного контракта): 2 — `_compute`, `_apply`*

**События** (`EventDispatcher`): `update`

### installSunShadowPatch(material)

Патчит материал для теней (v2.7 — генерируемый GLSL под текущие настройки качества): CSM-выбор каскада `SunLight` (цикл на ЛЮБОЕ число каскадов), N-таповый Vogel-PCF с footprint-клампом и temporal-ротацией (`tfShadowRot`), soft-режим (второе широкое кольцо, `tfShadowSoft`), фейд теней по туману (`tfShadowFade`) — для солнца И (опция `fadeAllLights`, вкл. по умолчанию) для directional/spot/point через обёртку `tfFadeShadow(<call>, -geometryPosition.z)`. Компонуется с туманом/дизером/emissive; ключ кэша программ — динамический (число каскадов + тапы + soft + fadeAll), поэтому смена `setShadowQuality`/`setSunCascadeCount` не переиспользует молча старую программу. Патч корректен при ЛЮБОМ `renderer.shadowMap.type` (PCF/PCFSoft → Vogel; Basic/VSM → встроенный getShadow того же типа сэмплера).

### getSunCascadeCount() / setSunCascadeCount(n)

Число каскадов CSM — ГЛОБАЛЬНОЕ свойство шейдера (define `SUN_LIGHT_CASCADES` в чанке three задаёт размеры униформ-массивов), одно на рендерер; диапазон 1..4 (дефолт 2). `setSunCascadeCount(n)`:
1. переопределяет define в `ShaderChunk.shadowmap_pars_fragment` — ВСЕ программы, скомпилированные после вызова, согласованы (включая нативный `getSunShadow` и shadowmask);
2. переконфигурирует все живые `SunLightShadow` (реестр);
3. помечает материалы с TF-патчем на рекомпиляцию (реестр WeakRef).

Программы, скомпилированные ДО вызова, пересобираются через `material.needsUpdate = true` — меняйте каскады на старте/загрузке, не в бою.

### getShadowQuality() / setShadowQuality(q)

Глобальные настройки фильтрации теней (для всех материалов с патчем):

| Поле | По умолчанию | Описание |
|---|---|---|
| `taps` | `12` | Vogel-тапов PCF на кольцо (1..64; 12 = прежнее поведение v2.6). |
| `soft` | `false` | Второе «широкое» кольцо (×2 стоимость сэмплинга, только SHADOWMAP_TYPE_PCF). |
| `softMix` | `0.55` | Базовая доля широкого кольца (униформа, без рекомпиляции). |
| `softDepthGrowth` | `0.45` | Прирост доли на view-глубину (÷ tfShadowFade.y) — дальние тени мягче (contact hardening-аппроксимация). |
| `softRadius` | `3.0` | Радиус широкого кольца в радиусах узкого (1..12). |
| `fadeAllLights` | `true` | Растворять в дымке тени directional/spot/point (v2.6: только солнце). |

Смена `taps`/`soft`/`fadeAllLights` перегенерирует GLSL и помечает пропатченные материалы на рекомпиляцию (one-time фриз); `softMix`/`softDepthGrowth`/`softRadius` — униформы (мгновенно). `soft` принимает также объект: `{ enabled, mix, depthGrowth, radius }`.

### applyShadowQuality(preset, targets)

Применить пресет ко всем целям одним вызовом: каскады + тапы + soft + размеры карт солнца/луны/directional + слоты `LightManager` (mapSize/budget/rate). Возвращает копию пресета или null.

**`targets`:** `{ rig, sun, lights, directional }` (всё опционально; rig возьмёт sun/moon сам).

| Пресет | cascades | taps | soft | sun map | atlas | budget/rate |
|---|---|---|---|---|---|---|
| `low` | 2 | 4 | — | 1024 | 2048×1024 (~8 МБ) | 1 / 12 Гц |
| `medium` | 2 | 8 | — | 1024 | 2048×1024 (~8 МБ) | 2 / 24 Гц |
| `high` | 2 | 12 | — | 1024 | 2048×1024 (~8 МБ) | без лимита (= v2.6) |
| `ultra` | 4 | 16 | mix 0.55 | 1536, tiles [2,1,1,1] | 7680×1536 (~47 МБ) | без лимита |

### SunShadowHelper(sun, options)

*extends `Group`*

Отладочная визуализация CSM: wireframe-боксы орто-фрустумов каскадов (свой цвет на каскад) + линия направления света. `update(camera)` пересчитывает матрицы каскадов сам — работает и когда теневой проход выключен (ночь/autoUpdate=false). Добавляйте в сцену, зовите `update(camera)` каждый кадр (или системой Engine), `dispose()` по окончании.

**Опции:** `colors` (массив hex по каскадам, дефолт зелёный→жёлтый→оранжевый→красный), `showDirection` (true), `depthTest` (false — рисовать поверх геометрии).

**Методы:** `update(camera)`, `dispose()`.

#### Константы и пресеты

| Имя | Значение / состав | Описание |
|---|---|---|
| `SUN_CASCADE_COUNT` | `2` | Дефолтное число каскадов (экспорт для совместимости; фактическое — getSunCascadeCount()). |
| `SUN_CASCADE_FADE` | `0.1` | Дефолтная доля фейда каскада. |
| `SHADOW_QUALITY_PRESETS` | ключи: `low`, `medium`, `high`, `ultra` | Данные пресетов (см. applyShadowQuality). |
| `SHADOW_QUALITY_ORDER` | `['low','medium','high','ultra']` | Порядок пресетов (для UI «качество теней»). |
| `TF_SHADOW_UNIFORMS` | ключи: `tfShadowRot`, `tfShadowFade`, `tfShadowSoft` | Общие униформы: rot/fade пишет PostPipeline, soft — setShadowQuality; без пайплайна дефолты = статичные тени без фейда. |

#### GLSL-чанки (шейдерный код)

| Имя | Значение / состав | Описание |
|---|---|---|
| `TF_SUN_SHADOW_FN` | GLSL, генерируется | Текущая сгенерированная функция теней (live-binding: обновляется setShadowQuality). |

---

## Часть 1.55: гигиена шейдерных патчей

> ThreeForge Engine — часть 1.55: гигиена шейдерных патчей (onBeforeCompile) Все патчи движка (тени, туман, дизер LOD, emissive) вшиваются через material.onBeforeCompile и КОМПОНИРУЮТСЯ в цепочку. Проблема: three.js берёт ключ кэша программ из `material.customProgramCacheKey()`, а по умолчанию это `onBeforeCompile.toString()` — текст ВНЕШНЕЙ функции цепочки. Он одинаков для всех материалов с одним и тем же последним патчем, независимо от того, что внутри цепочки: материал A: fog → dither key = text(ditherWrapper) материал B: sunShadow → dither key = text(ditherWrapper) ← ТОТ ЖЕ КЛЮЧ three переиспользует программу A для материала B — у B молча пропадают каскадные тени (или у A — туман). Ошибка…

### tfAddProgramCacheKey(material, key)

*строка 744*

Стабильный ключ кэша программ: base(three) + метки патчей ThreeForge.

### tfRecordPatch(material, entry)

*строка 763*

Журнал патчей — для корректного clone() (см. cloneMaterialPatched).

### tfChainOnBeforeCompile(material, apply)

*строка 770*

Композиция onBeforeCompile: предыдущий патч вызывается ПЕРЕД новым.

### cloneMaterialPatched(material)

*строка 789*

```
Клонировать материал, СОХРАНИВ патчи ThreeForge (туман/тени/дизер/emissive).
`material.clone()` в three r186 не переносит onBeforeCompile — копия
возвращается «голой». Этот метод клонирует материал и повторяет на копии
все зарегистрированные патчи в исходном порядке.
@param {THREE.Material} material
@returns {THREE.Material} Клон с теми же патчами.
```

---

## Часть 1.58: Gameplay Kit (v2.8)

Набор для игр «от первого лица» в стилизованной графике (референс — ночное поле мечей).
Все системы независимы и ничего не меняют по умолчанию.

### FirstPersonController

Walker от первого лица: pointer-lock обзор, WASD, спринт, прыжок, гравитация, опора на
`groundFn`/`terrain.heightAt`, head-bob. Без `document`/`input` — чистая кинематика (тестируется headless).

```js
const input = new InputManager(renderer.domElement);
const ctl = new FirstPersonController({
  camera, input,
  groundFn: (x, z) => world.groundHeight(x, z), // или terrain: <Terrain>
  speed: 4.4, sprintSpeed: 8.2, eyeHeight: 1.65,
  gravity: 14, jumpSpeed: 4.6, accel: 12,
  mouseSensitivity: 0.0022, maxPitch: 1.52,
  headBobAmp: 0.045, headBobFreq: 1.9,
  keys: { forward: 'KeyW', /* back/left/right/sprint/jump */ }
});
ctl.attach(engine);              // система с priority -10
canvas.onclick = () => ctl.lock();
```

Поля состояния: `feet`, `velocity`, `onGround`, `yaw/pitch`, `speedRatio`, `moveAxis`,
`bobPhase`, `bobOffset` (их читает вьюмодель). Методы: `teleport(x, y?, z)`, `lock()/unlock()`,
`groundHeightAt(x, z)`, `attach(engine)/detach()`, `update(dt)`.

### ViewModel

Оружие/руки от первого лица: отдельная сцена, рисуется ПОСЛЕ основной **в тот же render
target без clearDepth** — корректная окклюзия миром, нулевой клиппинг дальних объектов.
С `PostPipeline` автоматически встаёт в хук `scenePassHook` (внутрь `sceneRT`, т.е. под
bloom/AO/TAA), без него — обёрткой `engine.renderOverride`.

```js
const vm = new ViewModel({ camera, swayAmp: 0.02, bobAmp: 0.014 });
const fist = new THREE.Mesh(createFistGeometry(), skinMat);
fist.add(new THREE.Mesh(createSwordGeometry({ bladeLength: 0.92 }), bladeMat));
vm.add(fist, { offset: { x: 0.3, y: -0.33, z: -0.62 }, rotation: { x: 0.22, y: -0.42, z: 0.12 } });
vm.attach(engine);                              // после post.attach(engine)
engine.addSystem({ update: dt => vm.update(dt, ctl) }, 50); // sway/bob от контроллера
```

Методы: `add(object, {offset, rotation, sway, bob}) → holder`, `remove(obj)`, `clear()`,
`attach/detach`, `update(dt, source?)`, `renderPass(renderer, camera)` (вручную не нужен).

### scatterProps(options)

Детерминированный (по `seed`) инстанс-разброс пропсов с чанками для frustum culling:

```js
const swords = scatterProps({
  geometry: createSwordGeometry(), material: giantMat,
  count: 52, seed: 5, radius: 150, chunkSize: 64,   // или bounds: {minX..maxZ}, center
  heightFn: (x, z, scale) => ground(x, z) + scale * 0.62, // 3-й аргумент — масштаб инстанса (F3)
  // или terrain: <Terrain>
  scale: [7, 15], tiltMax: 0.24, sink: 1.4,
  baseRotation: [Math.PI, 0, 0],                     // «остриём в землю»
  densityFn: (x, z) => nearSpawn(x, z) ? 0 : 1,      // маска плотности 0..1
  castShadow: true, receiveShadow: true
});
scene.add(swords.group);
// → { group, meshes: InstancedMesh[], count, dispose() }
```

### FloatingProps

Парящие острова/камни: `add(object, {amp, freq, phase, rotSpeed, tilt})`, `remove`, `clear`,
`update(dt)`; `attach(engine)` (priority -5). Bob по sin, медленное вращение и наклон.

### Stylized-материалы

- `createGradientMap(stepsOrLevels, {floor})` — ступени toon-освещения (NearestFilter).
- `installStylizedPatch(material, {rim, rimPower, rimColor})` — rim-френель для любого
  материала с `<opaque_fragment>` (toon/standard/physical); совместим с fog/shadow/sway
  и `cloneMaterialPatched` (uniforms разделяются оригиналом и клоном).
- `createStylizedMaterial({color, steps: 3, rim, rimColor, rimPower, flatShading, side,
  emissive, gradientMap})` — MeshToonMaterial + gradientMap + rim. «rim: false» — без патча.

### Процедурные геометрии (низполи)

| Функция | Что делает | Начало координат |
|---|---|---|
| `createSwordGeometry({bladeLength: 1.05, bladeWidth, bladeThickness, guardWidth, gripLength, pommelRadius, *Color})` | меч: 4-гранный клинок с остриём, перекрестье, рукоять, навершие | перекрестье; клинок +Y |
| `createFistGeometry({scale, color, cuffColor})` | кулак-перчатка для вьюмодели | центр ладони |
| `createFlowerGeometry({petals: 5, headRadius, stemHeight, seed, *Color})` | цветок: стебель-крест, лепестки, сердцевина | основание стебля |

### Тип детали `flower`

`TF_DETAIL_TYPES` теперь `['tree', 'rock', 'bush', 'grass', 'flower']`. В
`TerrainDetailManager`/`createTerrainSystem` цветы настраиваются как прочие типы:
`details: { types: { flower: { density: 1.6, budget: 26000, emissive: 0x39325a } } }`
(sway maskHeight 0.35, emissive — F5). Чтобы цветы вообще сеялись, задайте веса типов
террейна (F4): `terrain: { scatterWeights: { tree: 0.02, rock: 0.06, bush: 0.06, grass: 0.44, flower: 0.42 } }`
— дефолт без `scatterWeights` = палитра v2.7 (tree/rock/bush/grass).

### Hud (DOM)

```js
const hud = new Hud({ title: 'ИГРА', hints: ['Tab — вернуться в конструктор', 'Esc — меню игры'], crosshair: false });
hud.setPrompt('Клик — захват мыши'); // центральная плашка
hud.setCrosshair(true); hud.dispose();
```

В headless-среде (`document === undefined`) `hud.available === false`, все методы безопасны.

### PostPipeline grade (GK9)

Финальный пасс: `grade: { vignette: 0..1, saturation, tint }` (конструктор или
`post.setGrade({...})`); по умолчанию нейтрален (0/1/белый). Плюс хук
`post.scenePassHook(renderer, scene, camera)` — вызывается после рендера сцены в текущий
RT (его занимает `ViewModel`; при ручной установке зовите свой коллбэк сами).

---

## Часть 1.6: источники света, LightManager, emissive

> ThreeForge Engine — часть 1.6: источники света, LightManager, emissive Что добавлено к части 1.5 (SunLight + CSM, SunCycle): PointLight — точечный источник С поддержкой куб-теней (three r186 рендерит 6 граней для isPointLight; PointLightShadow есть в ядре библиотеки — прежнее ограничение «castShadow всегда false» снято); DirectionalLight— направленный свет с target, автоподгонкой теневого орто-фрустума и снапом на тексельную сетку; SpotLight — конус + penumbra + подгонка near/far теневой камеры; createLightRig — готовый риг «солнце + небо + луна» с SunCycle; LightManager — пул источников фиксированного размера (КУЛЛИНГ по расстоянию/фраструму, бюджет источников, кроссфейд, мерцание, теневой…

### DirectionalLight

*extends `ThreeDirectionalLight`; строка 1259*

DirectionalLight — направленный свет (солнце вне CSM, луна, прожекторы «из бесконечности», вспышки молний). Направление = position → target. Надстройка над THREE.DirectionalLight: - разумные дефолты теней (bias/normalBias/radius/mapSize); - fitShadowCamera(target) — подгонка орто-фрустума под объект/Box3 (+ снап на тексельную сетку: тени не «кипят» при движении света); - followCamera(camera) — свет «едет» вместе с камерой (бесконечные миры: теневая карта покрывает только окрестность игрока). ВАЖНО: three читает light.target.matrixWorld (WebGLLights.setupView и LightShadow.updateMatrices).…

**`new DirectionalLight(options)`**

| Опция | По умолчанию | Описание |
|---|---|---|
| `shadowMapSize` | `1024` | — |
| `shadowBias` | `-0.0005` | — |
| `shadowNormalBias` | `0.02` | — |
| `shadowRadius` | `1.5` | — |
| `castShadow` | `false` | — |
| `range` | — | — |

**Методы:**

| Сигнатура | Описание |
|---|---|
| `setShadowRange(near, far)` | near/far теневой орто-камеры (диапазон кастеров вдоль направления). |
| `fitShadowCamera(target, o = {})` | Подогнать теневой орто-фрустум под объект (или Box3) и обновить матрицы. |
| `followCamera(camera, o = {})` | Держать свет и его цель привязанными к камере (бесконечный мир) и накрывать тенями сферу радиуса range вокруг точки интереса. |
| `aimAt(target)` | Направить свет на объект/точку (position остаётся, крутится target). |
| `copy(source, recursive)` |  |

### SpotLight

*extends `ThreeSpotLight`; строка 1424*

SpotLight — конус. Надстройка над THREE.SpotLight: дефолты теней, setCone()/aimAt(), подгонка near/far теневой камеры под конус.

**`new SpotLight(options)`**

| Опция | По умолчанию | Описание |
|---|---|---|
| `shadowMapSize` | `1024` | — |
| `shadowBias` | `-0.0005` | — |
| `shadowNormalBias` | `0.02` | — |
| `shadowRadius` | `1.5` | — |
| `shadowFocus` | `1` | — |
| `priority` | `1` | — |
| `castShadow` | `false` | — |
| `target` | — | — |

**Методы:**

| Сигнатура | Описание |
|---|---|
| `get power()` |  |
| `power(p)` |  |
| `setCone(angleDeg, penumbra)` | Угол конуса в ГРАДУСАХ + penumbra [0..1] (мягкость кромки). |
| `aimAt(target)` |  |
| `fitShadowCamera(near = 0.5, far)` | Настроить near/far теневой камеры под текущий конус. |
| `copy(source, recursive)` |  |

### LightManager

*extends `EventDispatcher`; строка 1558*

LightManager — бюджет источников света. ЗАЧЕМ. three компилирует шейдерную программу под КОНКРЕТНОЕ число источников (NUM_POINT_LIGHTS, NUM_SPOT_LIGHTS, NUM_*_SHADOWS — дефайны). Любой источник, который появился/исчез из traverseVisible (visible = false, слои, добавление в сцену), меняет эти числа → рекомпиляция программ → фриз. Поэтому «включать и выключать» свет через visible — антипаттерн. LightManager держит в сцене ПОСТОЯННЫЙ пул «слотов» (реальных источников с intensity = 0) и каждый кадр распределяет по ним логические источники: 1. куллинг — сфера (позиция, range) против фрустума…

**`new LightManager(options)`**

| Опция | По умолчанию | Описание |
|---|---|---|
| `maxPointLights` | `6` | — |
| `maxSpotLights` | `3` | — |
| `pointShadowSlots` | `1` | — |
| `spotShadowSlots` | `1` | — |
| `fadeReserve` | `2` | резерв слотов под угасающие источники (кроссфейд не вытесняет активные) |
| `fadeTime` | `0.25` | — |
| `hysteresis` | `0.2` | — |
| `defaultRange` | `24` | — |
| `globalIntensity` | `1` | — |
| `shadowBudget` | `0` | v2.7: макс. рендеров теневых карт на кадр (0 = без лимита); round-robin по времени ожидания, первый рендер карты — вне бюджета. |
| `shadowRate` | `0` | v2.7: частота обновления теней по умолчанию, Гц (0 = каждый кадр); для статичных факелов достаточно 5–15. |
| `profile` | `false` | — |
| `enabled` | `true` | — |
| `scene` | — | — |
| `camera` | — | — |

**Методы:**

| Сигнатура | Описание |
|---|---|
| `setBudget(maxPoint, maxSpot, o = {})` | Изменить бюджет источников «на лету» (смена уровня графики, настройка). v2.7: `o.shadowBudget`, `o.shadowRate` — без пересоздания слотов. |
| `setScene(scene)` | Привязать сцену (пул слотов создаётся один раз). |
| `add(light, options = {})` | Зарегистрировать источник. |
| `remove(light)` | Снять источник с регистрации (слот освобождается на следующем кадре). |
| `find(light)` |  |
| `setEnabled(light, on)` |  |
| `setIntensity(light, v)` |  |
| `setRange(light, range)` |  |
| `setPriority(light, p)` |  |
| `setShadowRate(light, hz)` | v2.7: частота обновления теневой карты источника (Гц; 0 = каждый кадр). Опция `shadowRate` есть и у `add(light, options)`. |
| `setFlicker(light, preset)` | Мерцание: |
| `setGroupEnabled(group, on)` | Массовое включение/выключение группы (например, 'torches'). |
| `setDayFactor(f)` | 0 = ночь, 1 = день. |
| `update(dt, camera)` | Кадровое обновление: |
| `getStats()` |  |
| `getActive(out = [])` | Список активных источников (для отладки/HUD). |
| `restoreAll()` | Сбросить все слоты и бленды (смена сцены/уровня, телепорт камеры). |
| `dispose()` |  |

*Приватные (`_…`, не часть публичного контракта): 10 — `_buildSlots`, `_resolveFlicker`, `_entry`, `_assignSlots`, `_syncShadow`, `_grantShadowUpdates`, `_countShadowUpdates`, `_countShadowIn`, `_clearSlots`, `_disposeSlots`*

### EmissiveManager

*extends `EventDispatcher`; строка 2369*

EmissiveManager — время и транзиенты свечения. Держит общее время (TF_EMISSIVE_TIME) и список материалов; умеет вспышки (flash) и плавную смену силы (setIntensity с tween). Регистрируется как система Engine (update(dt)).

**`new EmissiveManager(options)`**

| Опция | По умолчанию | Описание |
|---|---|---|
| `time` | `0` | — |
| `autoTime` | `true` | — |

**Методы:**

| Сигнатура | Описание |
|---|---|
| `register(material)` |  |
| `unregister(material)` |  |
| `setIntensity(material, v)` | Мгновенная сила свечения (без анимации). |
| `fadeIntensity(material, to, time = 0.4, easing = 'smooth')` | Плавная смена силы свечения. |
| `flash(material, power = 4, duration = 0.3)` | Вспышка (взрыв, выстрел, удар): |
| `setTime(t)` |  |
| `update(dt)` |  |
| `getStats()` |  |
| `dispose()` |  |

### tfFlickerValue(f, t, phase = 0)

*строка 1135*

Значение мерцания (множитель интенсивности) для конфига f в момент t.

### createLightRig(options = {})

*строка 1484*

```
createLightRig — готовый риг дневного цикла.
Собирает SunLight (CSM-тени) + HemisphereLight (небо/земля) + DirectionalLight
(луна; v2.7 — опционально С тенями) и SunCycle, который ими управляет. Всё
кладётся в Group, чтобы игра добавляла в сцену один объект. Group ДОЛЖНА
стоять в начале координат: SunLight вычисляет направление из МИРОВОЙ позиции.
@param {THREE.Scene} [options.scene] Куда добавить group (иначе — вручную).
@param {THREE.Camera} [options.camera] Камера для лунных теней (или rig.bindShadowCamera позже).
@param {boolean|object} [options.moonShadow] v2.7: лунные тени — true или
  { mapSize=1024, range=60, distance, bias, normalBias, radius }.
  castShadow включается СРАЗУ (NUM_DIR_LIGHT_SHADOWS стабилен → без
  рекомпиляций в рантайме); ночью SunCycle включает autoUpdate и
  followCamera(range) вокруг камеры, днём проход теней не рендерится.
  v2.9 (D2): при включённом moonShadow риг ставит `moon.shadow.needsUpdate =
  true` — карта луны рендерится один раз на первом кадре при любом времени
  суток; без неё днём `shadow.map === null`, и sampler2DShadow в PCF/PCFSoft
  получал плейсхолдер без COMPARE_MODE (GL INVALID_OPERATION 1282 → все draw
  освещаемых материалов отбрасывались, кадр = одно небо).
@returns {{group, sun, hemi, moon, cycle, setTime, update, bindShadowCamera, dispose}}
```

### installEmissivePatch(material, options = {})

*строка 2272*

```
Включить на материале «живое» свечение (светящуюся текстуру).
Патч компонуется с туманом/тенями/дизером и добавляет стабильный ключ кэша
программ (tfAddProgramCacheKey), поэтому материалы с разными опциями
свечения НЕ сливаются в одну шейдерную программу.
@param {THREE.Material} material MeshStandard/Physical/Lambert/Phong/Toon.
@param {object} [options]
@param {THREE.Texture} [options.map] Текстура свечения (свой сэмплер,
НЕ material.emissiveMap — штатная карта three продолжает работать).
@param {THREE.ColorRepresentation} [options.color=0xffffff] Цвет свечения.
@param {number} [options.intensity=1] HDR-сила; > 1 → попадает в bloom.
@param {[number,number]} [options.uvScale] / [options.uvOffset] Тайлинг.
@param {[number,number]} [options.scroll] Скорость UV-скролла (uv/с).
@param {number} [options.pulseSpeed] Гц пульсации (0 = нет).
@param {number} [options.pulseAmount] Глубина пульсации (0..1+).
@param {number} [options.flicker] Глубина мерцания (0..1).
@param {number} [options.phase] Фаза (для рассинхронизации экземпляров).
@param {'none'|'alpha'|'luma'} [options.mask] Канал маски свечения.
@param {object|false} [options.fresnel] { power, amount, color } — ободок.
@param {boolean} [options.instancePhase] Разная фаза на экземпляр InstancedMesh.
@returns {THREE.Material} Тот же материал (патчится на месте).
```

### applyEmissiveOptions(material, options = {})

*строка 2338*

Обновить параметры уже пропатченного материала (без рекомпиляции, если не меняются define'ы: map/fresnel/instancePhase задаются один раз).

### createEmissiveTexture(kind = 'glow', size = 256, options = {})

*строка 2488*

```
@param {string} [kind='glow'] Один из EMISSIVE_TEXTURE_KINDS.
@param {number} [size=256]
@param {{color?:THREE.ColorRepresentation, seed?:number, scale?:number,
alphaMask?:boolean}} [options]
@returns {THREE.DataTexture}
```

### createEmissiveMaterial(options = {})

*строка 2600*

```
Удобный конструктор «светящегося» материала: MeshStandardMaterial с
установленным emissive-патчем.
@param {object} [options] См. installEmissivePatch + { roughness, metalness,
color, emissive, emissiveIntensity, side, transparent }.
@returns {THREE.MeshStandardMaterial}
```

#### Константы и пресеты

| Имя | Значение / состав | Описание |
|---|---|---|
| `LIGHT_FLICKER` | ключи: `none`, `pulse`, `breath`, `candle`, `torch`, `fire`, `tv`, `fluorescent`, `broken`, `strobe`, `beacon` | ------------------------------- мерцание ---------------------------------- Пресеты для LightManager.setFlicker(). Все функции детерминированы по (время, фаза)… |
| `TF_EMISSIVE_TIME` | ключи: `value` | Общее время для всех emissive-материалов (живой uniform-объект). |
| `EMISSIVE_TEXTURE_KINDS` | `['glow', 'stripes', 'cells', 'grid', 'runes', 'noise', 'windows', 'scanline']` | — |

#### GLSL-чанки (шейдерный код)

| Имя | Значение / состав | Описание |
|---|---|---|
| `TF_EMISSIVE_GLSL` | GLSL, ~1 КБ | — |

---

## Часть 1.75: туман

> ThreeForge Engine — часть 1.75: туман (единая модель, FogManager, оптимизации) Единая система тумана движкового уровня: 1. TF_FOG_GLSL — один шейдерный чанк-источник правды для ВСЕХ материалов: - линейный туман smoothstep(near, far, viewDepth) — формула 1:1 со встроенным fog_fragment three.js r186 (стык «террейн/кастомный шейдер» бесшовный); - экспоненциальный exp2 туман 1-exp(-ρ²d²) — физичнее для воды/дымки; - режимы смешиваются униформой modeBlend → переключение linear↔exp2 БЕЗ рекомпиляции шейдерных программ (define FOG_EXP2 больше не решает); - аналитический HEIGHT-FOG: плотность ρ(y)=h·exp(-k(y-y0)), точный интеграл вдоль луча камера→фрагмент (2 exp, без реймарша) — туман скапливается…

### FogManager

*extends `EventDispatcher`; строка 2768*

FogManager — система Engine (update(dt)). Связи (всё опционально, null = не трогать): scene.fog — near/far/color (совместимость + fallback непропатченных) camera — адаптивный far (adaptiveFar) sunCycle — автопогода (время/закат) + живой sunDirection baseColor — «горизонт» от SunCycle (база финального цвета) sky / skyRadius — follow+scale купола под camera.far skyUniforms — uSkyFogAmt (скай-туман; цвет — общий tfFogColor) waterLevel — подводный оверлей (камера ниже → exp2 муть) Поток кадра: погода-цель (пресет ИЛИ auto по SunCycle) → экспоненциальное сглаживание → подводный бленд → commit…

**`new FogManager(options)`**

| Опция | По умолчанию | Описание |
|---|---|---|
| `skyRadius` | `2400` | — |
| `waterLevel` | `0` | — |
| `heightBase` | `0` | — |
| `baseFar` | `3000` | y0 height-слоя |
| `responseTime` | `0.9` | предел camera.far |
| `adaptiveFar` | `true` | — |
| `inscatterBoost` | `1` | художественный множитель инсаттеринга солнца в тумане (золотая дымка против солнца «как в жизни» на закате/рассвете, но сильнее) |
| `scene` | `null` | — |
| `camera` | `null` | — |
| `sunCycle` | `null` | — |
| `baseColor` | `null` | — |
| `sky` | `null` | живой Color горизонта (SunCycle) |
| `skyUniforms` | `null` | — |
| `preset` | `'auto', true` | камера стартует с far=3000 |
| `shaderColorSpace` | — | пространство цвета шейдерных униформ тумана |

**Методы:**

| Сигнатура | Описание |
|---|---|
| `get presetLabel()` |  |
| `get isUnderwater()` |  |
| `setShaderColorSpace(mode)` | (униформы перезаписываются каждый _commit). |
| `setPreset(name, immediate = false)` |  |
| `cyclePreset()` |  |
| `update(dt)` |  |
| `getState()` |  |

*Приватные (`_…`, не часть публичного контракта): 4 — `_computeTarget`, `_applyWeatherInfluence`, `_readBaseColor`, `_commit`*

**События** (`EventDispatcher`): `preset`, `farchange`

### installFogPatch(material, fog)

*строка 2684*

installFogPatch — единый туман в стандартных материалах three.js. Ставится ПОСЛЕ installSunShadowPatch (или до — порядок не важен: патчи компонируются, участки шейдера не пересекаются). material.fog должен быть true (define USE_FOG ставит рендерер при scene.fog !== null && material.fog). Кэш программ: базовый customProgramCacheKey() = onBeforeCompile.toString(), поэтому пропатченные и…

#### Константы и пресеты

| Имя | Значение / состав | Описание |
|---|---|---|
| `FOG_PRESETS` | ключи: `clear`, `haze`, `fog`, `dense` | Пресеты погоды. Значения — цели сглаживания FogManager (responseTime), height.falloff — скорость оседания слоя (0.05 ≈ e-сложение на 20 м). near/far пресетов… |
| `FOG_PRESET_ORDER` | `['auto', 'clear', 'haze', 'fog', 'dense']` | — |

#### GLSL-чанки (шейдерный код)

| Имя | Значение / состав | Описание |
|---|---|---|
| `TF_FOG_GLSL` | GLSL, ~2 КБ | TF_FOG_GLSL — общие униформы и функции тумана. Униформы (объекты {value} ОДНИ на сцену — FogManager пишет раз в кадр, все материалы видят обновление без… |

---

## Часть 1.9: частицы и погода

> ThreeForge Engine — часть 1.9: частицы (GPU-поля, CPU-пул, менеджер, погода) Подсистема частиц для ОГРОМНЫХ количеств — два дополняющих друг друга пути: 1. ParticleField — GPU-поле (погода: дождь/снег). Вся анимация считается в вершинном шейдере из статических seed-атрибутов и uTime: позиция частицы — «виртуальная» точка в мире, завёрнутая (mod) в бокс вокруг камеры. Стоимость на CPU — НОЛЬ байт аплоадов и ~6 униформ на кадр; десятки тысяч частиц (30k+) в одном draw call. Время заворачивается по осям отдельно (период = box/|v|), поэтому float32-точность не деградирует часами. Интенсивность/бокс/ветер — униформы: переключение погоды и кроссфейды БЕЗ рекомпиляции шейдеров и без рывков. 2.…

### ParticleManager

*extends `EventDispatcher`; строка 3811*

ParticleManager — система Engine (fixedUpdate: симуляция CPU-пулов; update: время/центр/качество/упаковка). Владеет атласом, общими униформами (uTime/uCenter/uWind — одни объекты на все поля), гравитацией и ветром (ветер пишет WeatherManager — влияет и на GPU-поля, и на CPU-частицы). Адаптивное качество: FPS-EMA от engine.stats; тиры low/medium/high переключаются с гистерезисом (< 34 вниз, > 56 вверх) и кулдауном 3 с — бюджеты GPU-полей масштабируются множителем, буферы НЕ пересоздаются. Режим 'auto' или фиксированный (клавиша B в игре).

**`new ParticleManager(options)`**

| Опция | По умолчанию | Описание |
|---|---|---|
| `atlasSize` | `256` | — |
| `scene` | `null` | — |
| `camera` | `null` | — |
| `quality` | `'auto'` | — |
| `gravity` | — | — |
| `fog` | — | — |

**Методы:**

| Сигнатура | Описание |
|---|---|
| `createField(options)` |  |
| `createSystem(options)` |  |
| `destroyField(field)` | Уничтожить поле и снять его с регистрации в менеджере. |
| `destroySystem(system)` | Уничтожить CPU-систему и снять её с регистрации. |
| `setQuality(mode)` |  |
| `cycleQuality()` |  |
| `fixedUpdate(h)` |  |
| `update(dt, alpha, engine)` |  |
| `getStats()` |  |
| `dispose()` |  |

*Приватные (`_…`, не часть публичного контракта): 2 — `_applyQualityMode`, `_autoQuality`*

**События** (`EventDispatcher`): `quality`

### ParticleField

*строка 3399*

ParticleField — GPU-поле (погода и любые «фоновые» частицы). Статические seed-атрибуты заполняются один раз (детерминированный PRNG — миры воспроизводимы); каждый кадр менеджер пишет только uTime/uCenter/uWind. setIntensity/setBudget/setBox — униформы и instanceCount, без реаллокаций. Прогрев: первые 2 тика mesh виден даже при нулевой интенсивности — программа компилируется на старте (instanceCount может быть 0 — draw call остаётся «пустым», но шейдеры собираются).

**`new ParticleField(options)`**

| Опция | По умолчанию | Описание |
|---|---|---|
| `budget` | `this.capacity` | — |
| `seed` | `9176` | — |
| `renderOrder` | `5` | бокс всегда вокруг камеры |
| `additive` | `false` | — |
| `manager` | — | — |
| `capacity` | — | — |
| `mode` | — | — |
| `atlas` | — | — |
| `shared` | — | — |
| `fogUniforms` | — | — |
| `tile` | — | — |
| `color` | — | — |
| `opacity` | — | — |
| `size` | — | — |
| `fall` | — | — |
| `sway` | — | — |
| `edgeFade` | — | — |
| `box` | — | — |
| `parent` | — | — |

**Методы:**

| Сигнатура | Описание |
|---|---|
| `setIntensity(v)` |  |
| `setBudget(n)` | Бюджет (до множителя качества) — погода масштабирует его по видимости. |
| `setBox(x, y, z)` |  |
| `update(dt, camera = null)` | ручное обновление standalone-поля (без ParticleManager): |
| `dispose()` |  |

*Приватные (`_…`, не часть публичного контракта): 1 — `_refresh`*

### ParticleSystem

*extends `EventDispatcher`; строка 3526*

ParticleSystem — CPU-пул частиц (один draw call на систему). Память: один Float32Array со stride TF_PSTRIDE (27 float на частицу) — SoA- доступ в симуляции, swap-remove при смерти (copyWithin 108 байт), живой префикс [0, live) всегда плотный. Атрибуты упакованы в три vec4 на инстанс (позиция+размер / цвет+альфа / поворот+тайл+растяжение) и загружаются updateRanges ТОЛЬКО на длину живого префикса. Эмиттеры: непрерывные (rate + аккумулятор в fixedUpdate, с защитой от «пулемёта» после лагов) и разовые burst(cfg, count). Конфиг спавна — обычный объект (создаётся один раз на эмиттер/пресет, НЕ в…

**`new ParticleSystem(options)`**

| Опция | По умолчанию | Описание |
|---|---|---|
| `renderOrder` | `5` | позиции частиц |
| `additive` | `false` | — |
| `manager` | — | — |
| `capacity` | — | — |
| `random` | — | источник случайности |
| `atlas` | — | — |
| `shared` | — | — |
| `fogUniforms` | — | — |
| `parent` | — | — |

**Методы:**

| Сигнатура | Описание |
|---|---|
| `addEmitter(config)` | ------------------------------- эмиттеры -------------------------------- |
| `removeEmitter(emitter)` |  |
| `burst(config, count)` | age*NaN >= 1 всегда false — пул необратимо забивался). |
| `clear()` |  |
| `fixedUpdate(h)` | ------------------------------ симуляция -------------------------------- |
| `update()` | ------------------------- упаковка и аплоад ------------------------------ |
| `dispose()` |  |

*Приватные (`_…`, не часть публичного контракта): 2 — `_spawnOne`, `_kill`*

### WeatherManager

*extends `EventDispatcher`; строка 3992*

WeatherManager — погода как игровая система (часть 1.9). Режимы: clear/rain/snow/storm (цикл — клавиша R в игре). Интенсивности сглаживаются экспоненциально (~1.1 с) и уходят в униформу uIntensity — кроссфейд дождь↔снег↔ясно без рекомпиляций и попов. Ветер: медленно дрейфующее направление + порывы (две синусоиды) — пишет в общий uWind ParticleManager (наклон капель, занос снега, снос дыма/искр синхронны). Экономия: размеры wrap-боксов следуют за видимостью тумана (FogManager. visibility) — частицы НЕ спавнятся дальше стены тумана; бюджет полей масштабируется той же видимостью. Под водой…

**`new WeatherManager(options)`**

| Опция | По умолчанию | Описание |
|---|---|---|
| `waterLevel` | `0` | — |
| `camera` | `null` | — |
| `particles` | `null` | — |
| `fog` | `null` | — |
| `audio` | `null` | — |
| `terrain` | `null` | — |
| `skyUniforms` | `null` | — |
| `lightning` | `null` | — |
| `splashSystem` | `null` | DirectionalLight (intensity=0 на старте) |
| `mode` | `'clear', true` | — |

**Методы:**

| Сигнатура | Описание |
|---|---|
| `get modeLabel()` |  |
| `setMode(name, immediate = false)` |  |
| `cycleMode()` |  |
| `update(dt)` |  |
| `getState()` |  |
| `dispose()` | Полная остановка погоды: |

*Приватные (`_…`, не часть публичного контракта): 3 — `_strike`, `_updateLightning`, `_updateAudio`*

**События** (`EventDispatcher`): `mode`, `lightning`

### TFInstancedBufferGeometry

*extends `BufferGeometry`; строка 3068*

InstancedBufferGeometry — в бандл класс не вошёл, но WebGLRenderer и WebGLBindingStates работают с ним по контракту: - geometry.isInstancedBufferGeometry → renderInstances(start, count, min(instanceCount, _maxInstanceCount)); - _maxInstanceCount рендерер сам выставляет из первого инстанс-атрибута (meshPerAttribute * count) и удаляет при dispose геометрии.

**Конструктор:** `new TFInstancedBufferGeometry()`

**Методы:**

| Сигнатура | Описание |
|---|---|
| `copy(source)` |  |

### createParticleAtlas(size = 256)

*строка 3087*

Генерирует процедурный атлас спрайтов частиц 2×2 (`DataTexture`, RGBA): мягкие круги, вспышки/кольца, звезда с гало, снежинка — для `createParticleMaterial` и `ParticleSystem`.

### createParticleMaterial(options)

*строка 3331*

createParticleMaterial — фабрика материалов частиц. mode: 'gpu-sprite' | 'gpu-streak' | 'cpu'; additive — аддитивный блендинг. fogUniforms — ССЫЛКИ на uniform-объекты FogManager (live, без копий). shared — общие униформы ParticleManager (uTime/uCenter/uWind): одна запись на кадр видна всем полям сразу.

#### Константы и пресеты

| Имя | Значение / состав | Описание |
|---|---|---|
| `TF_TILE_PAD` | `0.02` | Атлас спрайтов: 2×2 тайла по 128 px (всего 256×256, RGBA8, sRGB, mipmaps). Тайл 0 — мягкая точка (снег, брызги), 1 — glow (искры, аддитив), 2 — полоса дождя… |
| `TF_TILE_SCALE` | `0.46` | — |
| `TF_TILE_PAD_UV` | `TF_TILE_PAD * 2` | генератором атласа, чтобы альфа гарантированно уходила в 0 на кромке тайла (N10). |
| `TF_PARTICLES_SPRITE_VERT` | `TF_PARTICLES_GLSL_COMMON_VERT + ` void main() { 	vec3 vel = …` | — |
| `TF_PARTICLES_STREAK_VERT` | `TF_PARTICLES_GLSL_COMMON_VERT + ` void main() { 	vec3 vel = …` | — |
| `TF_PSTRIDE` | `27` | ParticleSystem — CPU-пул частиц (один draw call на систему). Память: один Float32Array со stride TF_PSTRIDE (27 float на частицу) — SoA- доступ в симуляции… |
| `TF_P_POS` | `0` | — |
| `TF_P_VEL` | `3` | — |
| `TF_P_AGE` | `6` | — |
| `TF_P_INVLIFE` | `7` | — |
| `TF_P_SIZE0` | `8` | — |
| `TF_P_SIZE1` | `9` | — |
| `TF_P_ROT0` | `10` | — |
| `TF_P_ROTV` | `11` | — |
| `TF_P_C0` | `12` | — |
| `TF_P_C1` | `15` | — |
| `TF_P_ALPHA` | `18` | — |
| `TF_P_FADEIN` | `19` | — |
| `TF_P_DRAG` | `20` | — |
| `TF_P_GSCALE` | `21` | — |
| `TF_P_TILE` | `22` | — |
| `TF_P_STRETCH` | `23` | — |
| `TF_P_WINDF` | `24` | — |
| `TF_P_TURBA` | `25` | — |
| `TF_P_TURBF` | `26` | — |
| `TF_QUALITY_MUL` | ключи: `low`, `medium`, `high` | ParticleManager — система Engine (fixedUpdate: симуляция CPU-пулов; update: время/центр/качество/упаковка). Владеет атласом, общими униформами… |
| `TF_QUALITY_ORDER` | `['auto', 'low', 'medium', 'high']` | — |
| `TF_QUALITY_TIERS` | `['low', 'medium', 'high']` | — |
| `WEATHER_MODES` | ключи: `clear`, `rain`, `snow`, `storm` | WeatherManager — погода как игровая система (часть 1.9). Режимы: clear/rain/snow/storm (цикл — клавиша R в игре). Интенсивности сглаживаются экспоненциально… |
| `WEATHER_ORDER` | `['clear', 'rain', 'snow', 'storm']` | — |
| `defaultFogUniforms` | `_tfDefaultFogUniforms` | FogManager не нужен (прежнее приватное имя _tfDefaultFogUniforms). |

#### GLSL-чанки (шейдерный код)

| Имя | Значение / состав | Описание |
|---|---|---|
| `TF_PARTICLES_GLSL_COMMON_VERT` | GLSL, ~2 КБ | Шейдеры частиц (GLSL1-синтаксис, как у неба/воды: бандл r186 сам конвертирует attribute/varying/gl_FragColor/texture2D для WebGL2). Вершинный GPU-режим (поля)… |
| `TF_PARTICLES_CPU_VERT` | GLSL, ~1 КБ | — |
| `TF_PARTICLES_FRAG` | GLSL, ~1 КБ | — |

---

## Часть 2: шум, террейн, физика, ввод, звук

> ThreeForge Engine — часть 2: шум, террейн, физика, ввод, звук (читаемая версия + исправления; математика генерации сохранена 1:1, чтобы мир с тем же seed выглядел идентично)

### SimplexNoise

*строка 4335*

SimplexNoise — 2D симплекс-шум (таблица перестановок из seed).

**Конструктор:** `new SimplexNoise(seed = 0)`

**Методы:**

| Сигнатура | Описание |
|---|---|
| `noise2D(x, y)` |  |

### Terrain

*строка 4409*

Terrain — процедурный высотный ландшафт: height(x,z), normal(), buildChunkGeometry(), scatter() (деревья/камни/трава). ИСПРАВЛЕНО/УЛУЧШЕНО: - height() больше НЕ создаёт замыкания и объекты-опции на каждый вызов (это горячий путь: физика дёргает его 5 раз на тело на шаг) — меньше GC; - buildChunkGeometry() теперь пишет АНАЛИТИЧЕСКИЕ нормали в атрибут normal (раньше они считались и выбрасывались, а затем computeVertexNormals() пересчитывал худшие — были швы на стыках чанков и двойная работа); - индекс чанка Uint16, когда вершин < 65536 (экономия памяти/пропускной способности), Uint32 — только…

**`new Terrain(options)`**

| Опция | По умолчанию | Описание |
|---|---|---|
| `scale` | `0.004` | ВНИМАНИЕ: scale |
| `amplitude` | `40` | — |
| `octaves` | `5` | — |
| `ridgeMix` | `0.35` | — |
| `waterLevel` | `-6` | — |
| `seed` | `0` | — |
| `palette` | — | переопределение палитры числами [r,g,b] (линейные): { sand, snow, rock, grassA, grassB } |

**Методы:**

| Сигнатура | Описание |
|---|---|
| `height(x, z)` | Базовый fbm + примесь «хребтов» (ridge noise). |
| `normal(x, z, out, eps = 0.5)` | Нормаль поверхности центральными разностями (eps — шаг выборки). |
| `buildChunkArrays(chunkX, chunkZ, size, segments = 24, options = null)` | buildChunkGeometry (тот же порядок float-операций). |
| `buildChunkGeometry(chunkX, chunkZ, size, segments = 24, options = null)` | options.skirt добавляет юбку для LOD-стыков). |
| `scatter(chunkX, chunkZ, size, count = 512)` | Возвращает массив {type: |

*Приватные (`_…`, не часть публичного контракта): 2 — `_terrainColorRGB`, `_terrainColor`*

### RigidBody

*строка 4701*

Тело для `PhysicsWorld`: форма `sphere` | `box` (AABB), масса, линейная/угловая скорость, restitution/friction, режим сна. Обычно создаётся через `physics.addBody(options)`.

**`new RigidBody(options)`**

| Опция | По умолчанию | Описание |
|---|---|---|
| `radius` | `0.5` | — |
| `mass` | `1` | — |
| `restitution` | `0.35` | — |
| `friction` | `0.2` | — |
| `linearDamping` | `0.02` | — |
| `userData` | `null` | — |
| `sleepThreshold` | `0.04` | — |
| `shape` | `'sphere'` | — |
| `type` | `(this.mass > 0 ? 'dynamic' : 'static'` | — |
| `position` | — | 'sphere' \| 'box' (AABB) |
| `velocity` | — | для интерполяции рендера |
| `halfExtents` | — | — |

**Методы:**

| Сигнатура | Описание |
|---|---|
| `getBounds(out)` |  |
| `applyImpulse(impulse)` |  |

### SpatialHashGrid

*строка 4745*

Пространственный хеш (равномерная сетка) для broadphase.

**Конструктор:** `new SpatialHashGrid(cellSize = 8)`

**Методы:**

| Сигнатура | Описание |
|---|---|
| `clear()` | Очистка перед новым шагом broadphase. |
| `insert(body)` |  |
| `queryBox(box, out)` | Добавляет уникальные тела, попавшие в бокс, в out[]. |

*Приватные (`_…`, не часть публичного контракта): 1 — `_key`*

### PhysicsWorld

*строка 4838*

Лёгкий физический мир без внешних зависимостей: интеграция, коллизии sphere/box, broadphase (перебор → пространственный хеш при hashThreshold), итеративный импульсный решатель, сны тел, heightfield-рельеф, raycast. Шаг — `step(dt)` (подключайте к `Engine` как систему: `engine.addSystem({ fixedUpdate: h => physics.step(h) })`).

**`new PhysicsWorld(options)`**

| Опция | По умолчанию | Описание |
|---|---|---|
| `maxSpeed` | `200` | потолок скорости тел, м/с |
| `maxStep` | `0.1` | потолок dt одного step(), с (защита от «прострела» геометрии после фриза) |
| `iterations` | `12` | итерации импульсного решателя; стопки тел сходятся до ~12 контактных уровней |
| `hashThreshold` | `512` | число тел, с которого допускается хеш-broadphase |
| `hashAwakeMin` | `24` | минимум бодрствующих тел для включения хеш-broadphase |
| `sleepDelay` | `0.25` | время покоя тела до перехода в сон, с |
| `cellSize` | `8` | размер ячейки SpatialHashGrid (broadphase) |
| `recordContacts` | `false` | собирать контакты в `world.contacts` на каждом шаге |
| `nanGuard` | `true` | карантин тел с NaN (отравленное тело не заражает мир) |
| `gravity` | — | Vector3 гравитации (клонируется); дефолт (0, −25, 0) |

**Методы:**

| Сигнатура | Описание |
|---|---|
| `addBody(options)` |  |
| `removeBody(body)` |  |
| `setHeightfield(fn)` |  |
| `step(dt)` |  |
| `raycast(origin, direction, maxDistance = Infinity, out = null)` | Ближайшее попадание луча по телам (сферы — точно, боксы — по AABB). |
| `explode(position, radius, strength)` | Радиальный импульс: |
| `clear()` |  |

*Приватные (`_…`, не часть публичного контракта): 7 — `_reach`, `_collidePair`, `_sphereSphere`, `_sphereBox`, `_boxBox`, `_resolve`, `_collideHeightfield`*

### InputManager

*extends `EventDispatcher`; строка 5255*

скретч consumeMouseDelta()

**Конструктор:** `new InputManager(domElement = null)`

**Методы:**

| Сигнатура | Описание |
|---|---|
| `connect()` |  |
| `disconnect()` |  |
| `bind(action, ...codes)` |  |
| `bindAxis(axis, negativeCode, positiveCode, gamepadAxis = null)` |  |
| `isDown(action)` |  |
| `isPressed(action)` |  |
| `isReleased(action)` |  |
| `axis(name)` | Ось: |
| `isKeyDown(code)` |  |
| `setEnabled(value)` | Включить/выключить обработку ввода. |
| `consumeMouseDelta(out = _inputMouseDelta)` | Накопленное движение мыши за кадр (dx, dy) с обнулением. |
| `gamepad()` |  |
| `lockPointer()` |  |
| `unlockPointer()` |  |
| `endFrame()` | Вызывается игрой в конце кадра: |
| `dispose()` |  |

*Приватные (`_…`, не часть публичного контракта): 9 — `_onKeyDown`, `_onKeyUp`, `_onMouseMove`, `_onMouseDown`, `_onMouseUp`, `_onWheel`, `_onLockChange`, `_resetState`, `_onBlur`*

**События** (`EventDispatcher`): `keydown`, `keyup`, `click`, `pointerlockchange`, `blur`

### AudioManager

*строка 5520*

AudioManager — WebAudio: процедурные тоны (playTone) и сэмплы (play). ИСПРАВЛЕНО/УЛУЧШЕНО: - supported-флаг вместо мёртвого выражения в конструкторе; - loadBuffer/play больше не падают, если AudioContext недоступен; - узлы (osc/gain/panner) отключаются по onended — не копятся в графе.

**`new AudioManager(options)`**

| Опция | По умолчанию | Описание |
|---|---|---|
| `masterVolume` | `0.7` | — |
| `maxVoices` | `24` | — |

**Методы:**

| Сигнатура | Описание |
|---|---|
| `unlock()` | Вызывать из пользовательского жеста (клик) — иначе браузер не даст звук. |
| `setVolume(v)` |  |
| `setListener(object3d)` |  |
| `playTone(options = {})` | Процедурный тон: |
| `registerBuffer(name, buffer)` |  |
| `loadBuffer(name, url)` |  |
| `play(name, options = {})` | Проигрывание зарегистрированного сэмпла: |
| `makeNoiseBuffer(options = {})` | «естественный» спектр дождя и низкочастотный рокот грома. |
| `playAmbient(name, options = {})` | gain-узел живёт отдельно от source, поэтому узел не пересоздаётся. |
| `dispose()` |  |

*Приватные (`_…`, не часть публичного контракта): 1 — `_updateListener`*

### createPRNG(seed)

*строка 4316*

createPRNG — детерминированный 32-битный генератор (mulberry32-подобный). Тот же алгоритм, что был в оригинале — seed-миры воспроизводимы.

### fbm(noiseFn, x, y, options = {})

*строка 4389*

fbm — фрактальный шум (сумма октав с нормировкой).

#### Константы и пресеты

| Имя | Значение / состав | Описание |
|---|---|---|
| `SIMPLEX_GRAD3` | `new Float32Array([ 	1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0, …` | SimplexNoise — 2D симплекс-шум (таблица перестановок из seed). |
| `SIMPLEX_F2` | `0.5 * (Math.sqrt(3) - 1)` | — |
| `SIMPLEX_G2` | `(3 - Math.sqrt(3)) / 6` | — |
| `TERRAIN_SAND` | `new Color(0.76, 0.70, 0.50)` | TERRAIN_SNOW/ROCK/GRASS_*, и сериализуется в воркер наравне с ними. |
| `TERRAIN_SNOW` | `new Color(0.95, 0.96, 0.98)` | — |
| `TERRAIN_ROCK` | `new Color(0.42, 0.40, 0.38)` | — |
| `TERRAIN_GRASS_A` | `new Color(0.24, 0.45, 0.18)` | — |
| `TERRAIN_GRASS_B` | `new Color(0.36, 0.42, 0.22)` | — |

---

## Часть 3: продвинутый рендеринг

> ThreeForge Engine — часть 3: продвинутый рендеринг и оптимизация сложных сцен (объединено из threeforge-advanced.js; все системы ОПЦИОНАЛЬНЫ — без них движок работает как раньше; интеграция PostPipeline — Engine.renderOverride) 3.1 PostPipeline + SSAO — конвейер постобработки: HDR-таргет + DepthTexture → SSAO (16 cosine-семплов, IGN, range-check) → билатеральный блюр → композит (AO × HDR → тонмаппинг → sRGB) + опциональный FXAA; quality='high' — normal-prepass (override-материал, instancing). 3.1b TAA + motion vectors — Halton(2,3)-джиттер, velocity-проход, репроекция истории, анти-гостинг 3×3-AABB-кламп. TAA заменяет FXAA. 3.1c God-rays — radial blur от солнца. 3.1d Bloom — HDR bright-pass…

*3.1 постобработка / SSAO*

### PostPipeline

*extends `THREE.EventDispatcher`; строка 6395*

Постпроцессинг поверх `renderer`: SSAO, TAA + motion vectors, god-rays, bloom, FXAA, финальный composite. Подключение — `post.attach(engine)` (устанавливает `engine.renderOverride`, fog → linear, `info.autoReset=false`).

**`new PostPipeline(options)`**

| Опция | По умолчанию | Описание |
|---|---|---|
| `fog` | `null` | — |
| `samples` | `0` | MSAA scene-таргета (WebGL2) |
| `fxaa` | `'auto'` | FXAA: 'auto' = когда samples === 0; true/false |
| `sunDirection` | `null` | God rays (v2.3, opt-in): экранное объёмное свечение сквозь просветы. |
| `taa` | `{}` | motion vectors для trackObject() |
| `godRays` | `{}` | — |
| `bloom` | `{}` | 1\|2 прохода блюра (2 |
| `ao` | `{}` | SSAO: `{enabled, samples, resolutionScale, radius, bias, rangeCheck, intensity, power, fadeEnd, strength, blurSharpness, ambientShare, lights}`. v2.9: дефолты контактные (`radius 0.5, bias 0.03, rangeCheck 1.0, intensity 1.15, power 1.6`); `lights = {hemi, sun, moon}` — живые источники для доли ambient (см. ниже); `ambientShare` (0.6) — доля без привязки. |
| `debug` | `'none'` | 'none' \| 'ao' \| 'depth' \| 'normals' |
| `profile` | `false` | — |
| `hdr` | `false` | — |
| `enabled` | `true` | FogManager (для linear-режима) |
| `renderer` | — | — |
| `scene` | — | options.scene/camera без значения давали undefined, а все guards ниже проверяют `!== null`/`=== null` |
| `camera` | — | — |
| `quality` | — | качество AO: 'fast' (нормали из глубины, dFdx/dFdy |
| `prepassExclude` | — | объекты, исключаемые из normal-prepass (купол неба и т.п.) |
| `width` | — | — |
| `height` | — | — |

**Методы:**

| Сигнатура | Описание |
|---|---|
| `attach(engine)` | (статистика draw calls аккумулируется за все проходы кадра). |
| `detach()` |  |
| `setSize(width, height)` | ------------------------------- ресурсы ------------------------------- |
| `setAO(params)` | через setAOSamples()/setSize (рекомпиляция/ресайз). |
| `setBloomEnabled(on)` | 3.1d: |
| `setQuality(quality)` | Переключение режима AO на лету: |
| `setGodRays(on)` | Включение/выключение god-rays (v2.3). |
| `setGodRaysParams(params)` | Живые параметры god-rays: |
| `setAOSamples(n)` |  |
| `setDebug(mode)` |  |
| `setTAA(params)` | velocityPass}. |
| `trackObject(object)` | автоматически в конце каждого кадра пайплайна. |
| `untrackObject(object)` |  |
| `resetHistory()` | один кадр без накопления, без гостинга. |
| `render()` | -------------------------------- рендер -------------------------------- |
| `dispose()` |  |

*Приватные (`_…`, не часть публичного контракта): 7 — `_ensureLdr`, `_fxaaActive`, `_finalBlit`, `_ensurePost`, `_updateCameraUniforms`, `_hideForPrepass`, `_restoreAfterPrepass`*

**AO v2.9 (S1–S3).** SSAO — подсветка контактных стыков, а не замена теней:
вклад сэмпла гаснет квадратично по дистанции до окклюдера (метровые ореолы вокруг
силуэтов устранены), а в композите AO умножается только на ambient-составляющую
освещения (`uAOAmbient`): при `ao.lights = {hemi, sun, moon}` доля считается каждый
кадр как `hemi/(hemi+sun+moon)` (кламп 0.15..0.85) — прямой свет светила и его
теневая карта не гасятся AO. Без привязки источников действует константа
`aoOptions.ambientShare` (0.6). `setAO({…, ambientShare, lights})`; `lights: false`
снимает привязку.

**События** (`EventDispatcher`): `quality`, `godrays`

#### GLSL-чанки (шейдерный код)

| Имя | Значение / состав | Описание |
|---|---|---|
| `TF_FS_VERT` | GLSL, ~1 КБ | --------------------------- fullscreen-шейдеры --------------------------- |
| `TF_AO_FRAG` | GLSL, ~3 КБ | world-space радиус. Выход: R = видимость (1 = не затенён). |
| `TF_AO_BLUR_FRAG` | GLSL, ~1 КБ | Билатеральный блюр AO 4×4: вес = 1 - \|ΔviewZ\|·sharpness (грани не размываются). |
| `TF_COMPOSITE_FRAG` | GLSL, ~1 КБ | ldrRT (FXAA-цепочка) — идентичность (аппаратная sRGB-запись в SRGB8-текстуру). |
| `TF_DEBUG_FRAG` | GLSL, ~1 КБ | Отладочные визуализации: 1 = AO, 2 = линейная глубина, 3 = view-нормали. |
| `TF_FXAA_FRAG` | GLSL, ~1 КБ | FXAA (console-вариант): работает ПОСЛЕ тонмаппинга/sRGB на LDR-изображении. |
| `TF_NORMAL_VERT` | GLSL, ~1 КБ | gl_FrontFacing — листва/трава дают корректные нормали с обеих сторон. |
| `TF_NORMAL_FRAG` | GLSL, ~1 КБ | — |

*3.1b TAA + motion vectors*

### tfHalton(index, base)

*строка 6347*

Halton(i, base) — низко-дискрепансная последовательность для джиттера.

#### Константы и пресеты

| Имя | Значение / состав | Описание |
|---|---|---|
| `TF_VELOCITY_LAYER` | `1` | camera.layers ТОЛЬКО на слой 1). |

#### GLSL-чанки (шейдерный код)

| Имя | Значение / состав | Описание |
|---|---|---|
| `TF_VELOCITY_VERT` | GLSL, ~1 КБ | --------------------------- TAA + motion vectors -------------------------- Temporal Antialiasing (Unreal-подобная схема): 1) субпиксельный джиттер проекции… |
| `TF_VELOCITY_FRAG` | GLSL, ~1 КБ | — |
| `TF_TAA_RESOLVE_FRAG` | GLSL, ~2 КБ | — |
| `TF_TAA_BLIT_FRAG` | GLSL, ~1 КБ | попадает НЕрезкий результат — обратная связь не усиливает ringing). |

*3.1c god-rays*

#### GLSL-чанки (шейдерный код)

| Имя | Значение / состав | Описание |
|---|---|---|
| `TF_RAYS_BRIGHT_FRAG` | GLSL, ~1 КБ | --------------------------- God rays (v2.3) ------------------------------ Экранная имитация объёмного света сквозь просветы крон (референс-арт: «светящийся»… |
| `TF_RAYS_BLUR_FRAG` | GLSL, ~1 КБ | — |
| `TF_FINAL_FRAG` | GLSL, ~1 КБ | Финальный проход: цвет (+unsharp) + god-rays + dither + кодирование sRGB. |

*3.1d bloom*

#### GLSL-чанки (шейдерный код)

| Имя | Значение / состав | Описание |
|---|---|---|
| `TF_BLOOM_BRIGHT_FRAG` | GLSL, ~1 КБ | 3.1d Bloom — HDR bright-pass с мягким коленом + separable Gauss в ¼ рез. Аддитивно подмешивается В КОМПОЗИТЕ ДО тонмаппинга (поэтому корректно «распускает»… |
| `TF_BLOOM_BLUR_FRAG` | GLSL, ~1 КБ | Линейный Gauss: 5 выборок с билинейными офсетами = 9-тап ядро (1,4,6,4,1)/16. |

*3.2 LOD*

### LODGroup

*extends `THREE.Group`; строка 7510*

`Group` с LOD-уровнями и dither-переключением: уровни добавляются с диапазонами дистанций, cross-fade между ними через `installDitherLODPatch`.

**`new LODGroup(options)`**

| Опция | По умолчанию | Описание |
|---|---|---|
| `hysteresis` | `0.08` | — |
| `ditherTime` | `0.35` | — |
| `radius` | `1` | — |
| `camera` | `null` | — |
| `dither` | `true` | — |
| `autoPatch` | `true` | { from, to, t } |
| `metric` | — | — |

**Методы:**

| Сигнатура | Описание |
|---|---|
| `addLevel(object, threshold = 0)` | и означает границу между i-1 и i (для i=0 игнорируется). |
| `update(dt = 1 / 60)` |  |
| `forceLevel(i)` |  |
| `dispose()` | (уровни часто шарят ресурсы). |
| `computeRadius()` | Радиус для screen-метрики: |

*Приватные (`_…`, не часть публичного контракта): 2 — `_patchLevel`, `_boundary`*

### installDitherLODPatch(material, uniform)

*строка 7481*

Патчит материал dither-LOD: униформа `uDitherFade` + IGN-шум по `gl_FragCoord` — пиксели отбрасываются при fade < 1 (плавное растворение между уровнями `LODGroup` без щелчков геометрии).

#### GLSL-чанки (шейдерный код)

| Имя | Значение / состав | Описание |
|---|---|---|
| `TF_DITHER_PARS_GLSL` | GLSL, ~1 КБ | 3.2 LODGroup + dithered cross-fade Unity-подобный LOD: уровни переключаются по дистанции ИЛИ экранному размеру (bounding-сфера группы / проекция), гистерезис… |
| `TF_DITHER_MAIN_GLSL` | GLSL, ~1 КБ | — |

*3.3 frustum-куллинг*

### CullBVH

*строка 7748*

BVH по сферам: медианные сплиты по длинной оси центроидов, плоские массивы.

**Конструктор:** `new CullBVH()`

**Методы:**

| Сигнатура | Описание |
|---|---|
| `build(items)` |  |
| `query(frustum, out)` | frustum-запрос: |
| `clear()` | оставался жив после dispose (утечка ~2 КБ/объект). |

*Приватные (`_…`, не часть публичного контракта): 2 — `_buildNode`, `_growStack`*

### SceneCuller

*extends `THREE.EventDispatcher`; строка 7869*

Frustum-куллинг объектов сцены через `CullBVH`: у добавленных объектов считаются мировые bounding-сферы, невидимые отключаются до рендера. Работает батчами за кадр.

**`new SceneCuller(options)`**

| Опция | По умолчанию | Описание |
|---|---|---|
| `camera` | `null` | — |
| `enabled` | `true` | — |

**Методы:**

| Сигнатура | Описание |
|---|---|
| `add(object, options = {})` |  |
| `remove(object)` |  |
| `refresh(object = null)` | Пересчитать сферы (после перемещения статичных объектов/перестройки чанков). |
| `restoreAll()` | Вернуть видимость всем отсечённым объектам (то, что было скрыто самим куллером; пользовательские `visible = false` не трогаем — для каждого… |
| `update()` |  |
| `dispose()` |  |

### computeWorldSphere(object, out, depth = 0)

*строка 7719*

```
Мировая bounding-сфера объекта.
Приоритет источника: `object.boundingSphere` у InstancedMesh/CullGroup
(«живая» сфера батчера) → `geometry.boundingSphere` → union сфер детей
(рекурсивно, для Group без геометрии) → `Box3.setFromObject()`.
@param {THREE.Object3D} object - Объект (мировые матрицы должны быть свежими).
@param {THREE.Sphere} out - Куда писать результат.
@param {number} [depth=0] - Внутреннее: уровень рекурсии (индекс скретча).
@returns {THREE.Sphere|null} `out`, либо `null`, если границ нет вовсе.
```

*3.4 окклюзионный куллинг*

### OcclusionCuller

*extends `THREE.EventDispatcher`; строка 8012*

Софтверный Hi-Z окклюзионный куллинг (CPU, без GPU-запросов, классика GPU Gems ch.29): сетка глубин ~128×72; окклюдеры (крупные непрозрачные AABB) консервативно растеризуются в сетку, окклюды (bounding-сферы) отбрасываются, если полностью перекрыты.

**`new OcclusionCuller(options)`**

| Опция | По умолчанию | Описание |
|---|---|---|
| `gridWidth` | `128` | — |
| `gridHeight` | `72` | — |
| `hysteresis` | `3` | — |
| `bias` | `0.1` | — |
| `camera` | `null` | — |
| `enabled` | `true` | — |

**Методы:**

| Сигнатура | Описание |
|---|---|
| `addOccluder(source, options = {})` |  |
| `removeOccluder(entry)` |  |
| `addOccludee(object, options = {})` |  |
| `removeOccludee(object)` |  |
| `restoreAll()` | Вернуть видимость всем скрытым окклюдии (см. |
| `update()` |  |
| `setGridSize(w, h)` | Сменить разрешение сетки глубин (по умолчанию 128×72). |
| `getDepthGrid(out = null)` | Копия сетки глубин для отладочной визуализации (демо рисует её в 2D canvas). |
| `dispose()` |  |

*Приватные (`_…`, не часть публичного контракта): 2 — `_refreshOccluder`, `_showOccludee`*

*3.5 BVH-рейкасты*

### MeshBVH

*строка 8268*

и без GC-давления), Vector3-скретчи остались только для resolveHit (E1/E2).

**`new MeshBVH(options)`**

| Опция | По умолчанию | Описание |
|---|---|---|
| `leafSize` | — | — |

**Методы:**

| Сигнатура | Описание |
|---|---|
| `raycast(origin, direction, maxDistance = Infinity)` | Возвращает null или {distance(t), faceIndex(исходный номер), u, v}. |
| `resolveHit(hit, wantNormal = true)` | Точка/нормаль хита в локальных координатах (заполняет hit.point/normal). |

*Приватные (`_…`, не часть публичного контракта): 4 — `_growStack`, `_triBox`, `_build`, `_rayBox`*

### raycastMesh(mesh, bvh, origin, direction, maxDistance = Infinity)

*строка 8538*

Возвращает hit {distance, point(мир), normal(мир), faceIndex, u, v} или null.

*3.6 static batching*

#### Константы и пресеты

| Имя | Значение / состав | Описание |
|---|---|---|
| `StaticBatcher` | ключи: `mergeGeometries`, `batchByMaterial` | — |

*3.7 потоковый террейн*

### TerrainStreamer

*extends `THREE.EventDispatcher`; строка 8806*

Потоковая подгрузка чанков террейна вокруг камеры (focus): пул Web Worker’ов собирает геометрию (`buildTerrainWorkerSource`), LOD-кольца, бюджет времени на кадр, таймаут зависшего воркера с деградацией в синхронный режим.

**`new TerrainStreamer(options)`**

| Опция | По умолчанию | Описание |
|---|---|---|
| `parent` | `null` | — |
| `chunkSize` | `64` | Material \| (chunk)=>Material |
| `viewDistance` | `5` | — |
| `lodRings` | `[` | в чанках (Chebyshev) LOD-кольца: [{maxDist, segments}] по возрастанию maxDist; последнее |
| `skirtCells` | `2.5` | — |
| `budgetMs` | `4` | глубина юбки = step × skirtCells |
| `workers` | `0` | — |
| `maxInFlight` | `Math.max(2, this.workers * 2` | — |
| `workerTimeoutMs` | `30000` | — |
| `yOffset` | `0` | — |
| `focus` | `null` | — |
| `onChunkBuilt` | `null` | — |
| `onChunkRemoved` | `null` | callback(chunk) |
| `terrain` | — | — |
| `material` | — | — |

**Методы:**

| Сигнатура | Описание |
|---|---|
| `update()` |  |
| `height(x, z)` | для физики/спавна. |
| `getChunkAt(x, z)` | Гото́вый чанк, накрывающий мировую точку (x, z), либо undefined. |
| `chunkIndexAt(x, z)` | Индексы чанка, накрывающего мировую точку. |
| `forceRebuildAll()` |  |
| `dispose()` |  |

*Приватные (`_…`, не часть публичного контракта): 17 — `_segmentsForRing`, `_initWorkers`, `_checkWorkerHealth`, `_freeWorker`, `_dispatchWorker`, `_expireStaleRequests`, `_onWorkerMessage`, `_updateFocus`, `_countBuildsInFlight`, `_enqueue`, `_dequeue`, `_jobInFlight`, `_jobStillNeeded`, `_prepareJob`, `_buildSync`, `_assemble`, `_removeChunk`*

**События** (`EventDispatcher`): `chunkbuilt`, `chunkremoved`

### buildTerrainWorkerSource(palette = null)

*строка 8734*

без аргумента — модульные константы TERRAIN_* (прежнее поведение).

---

## Часть 4: игровой террейн

> ThreeForge Engine — часть 4: игровой террейн Ядро террейна (часть 2: Terrain; часть 3.7: TerrainStreamer) даёт геометрию и vertexColors. Часть 4 достраивает его до «игрового» ландшафта: 4.1 Процедурные текстуры — createTerrainTexture / createTerrainTextureSet / createTerrainNormalMap: БЕСКОНЕЧНО тайлящиеся карты (трава/камень/ снег/песок/земля/гравий) на периодическом value-noise. Два режима: 'detail' (яркость вокруг 1.0 — умножается на vertexColors) и 'albedo' (полноцветная карта). Парная normalMap генерируется из того же поля высот — рельеф и микрорельеф согласованы. 4.2 Материал террейна — createTerrainMaterial + installTerrainDetailPatch: патч MeshStandardMaterial с 4-слойным блендом…

*4.1 процедурные текстуры*

### createTerrainTexture(kind = 'grass', size = 256, options = {})

*строка 9431*

```
Процедурная цветовая карта terрейна (тайлящаяся).
@param {string} [kind='grass'] Один из TERRAIN_TEXTURE_KINDS.
@param {number} [size=256]
@param {{seed?:number, mode?:'detail'|'albedo', contrast?:number, anisotropy?:number}} [options]
mode 'detail' (по умолчанию) — яркость вокруг 1.0: карта УМНОЖАЕТСЯ на
vertexColors террейна (палитра Terrain остаётся ведущей);
mode 'albedo' — полноцветная текстура (для материалов без vertexColors).
@returns {THREE.DataTexture}
```

### createTerrainNormalMap(kind = 'grass', size = 256, options = {})

*строка 9473*

Процедурная normal-карта террейна (из того же поля высот, что и цвет — микрорельеф согласован с яркостью). @returns {THREE.DataTexture}

### createTerrainTextureSet(kind = 'grass', size = 256, options = {})

*строка 9488*

Комплект «цвет + нормаль» из ОДНОГО прохода генерации (дешевле пары отдельных вызовов: поля высот/зерна считаются один раз). @returns {{map:THREE.DataTexture, normalMap:THREE.DataTexture, height:Float32Array}}

### tfNormalMapFromHeight(height, size, strength = 2.2)

*строка 9380*

height: Float32Array size*size в [0,1]; strength — глубина микрорельефа.

#### Константы и пресеты

| Имя | Значение / состав | Описание |
|---|---|---|
| `TERRAIN_TEXTURE_KINDS` | `['grass', 'rock', 'snow', 'sand', 'dirt', 'gravel']` | — |
| `TF_TERRAIN_TEX_STYLE` | ключи: `grass`, `rock`, `snow`, `sand`, `dirt`, `gravel` | albedoA/albedoB — градиент полноцветного режима (sRGB, как у palette Terrain). |

*4.2 материал террейна с детализацией*

### createTerrainDetailUniforms(options = {})

*строка 9640*

Живые униформы detail-патча. options.textures = {grass:{map,normalMap}, ...}; пропущенные слоты — нейтральные заглушки (белая карта / плоская нормаль). Параметры бленда: из options.terrain (waterLevel/amplitude) ИЛИ options.blend ({sandEdge, slopeRock, snowStart, snowEnd}) + options.yOffset (сдвиг мира).

### installTerrainDetailPatch(material, options = {})

*строка 9686*

```
Патч детализации для MeshStandard/PhysicalMaterial (и других материалов с
чанками map/roughness/normal — проверяется наличие тегов, иначе warning).
@param {THREE.Material} material
@param {object} [options] те же поля, что у createTerrainDetailUniforms.
@returns {THREE.Material} тот же материал (патчуется на месте).
```

### createTerrainMaterial(options = {})

*строка 9751*

```
Готовый материал террейна: MeshStandardMaterial (vertexColors) + патч
детализации + (опционально) туман и CSM-тени.
@param {object} [options]
@param {Terrain} [options.terrain] источник параметров бленда (waterLevel, amplitude).
@param {number} [options.yOffset=0] вертикальный сдвиг чанков (мировой Y).
@param {object|false} [options.textures] {grass,rock,snow,sand} → {map, normalMap};
undefined/true — сгенерировать процедурно; false — материал БЕЗ detail-патча.
@param {number|false} [options.detail=0.75] сила детали (0..1); false — без патча.
@param {number} [options.normalStrength=1] сила микрорельефа нормали.
@param {number} [options.texWorldSize=6] мировых единиц на тайл текстуры.
@param {number} [options.roughMix=0.85] доля per-layer roughness.
@param {number[]} [options.rough] [grass, rock, snow, sand].
@param {number} [options.textureSize=256] размер генерируемых текстур.
@param {number} [options.textureSeed=1337] seed генератора текстур.
@param {'detail'|'albedo'} [options.textureMode='detail']
@param {number} [options.textureNormalStrength=2.2] normalStrength генерируемых текстур (R3).
@param {number} [options.textureContrast] контраст генерируемых текстур (R3).
@param {number} [options.textureAnisotropy] анизотропия генерируемых текстур (R3).
@param {FogManager|null} [options.fog] установить installFogPatch.
@param {boolean} [options.sunShadow=true] установить installSunShadowPatch (CSM).
@param {object} [options.blend] {sandEdge, slopeRock, snowStart, snowEnd} —
ручные пороги бленда (иначе из terrain).
Плюс стандартные поля MeshStandardMaterial: color, roughness, metalness,
side, flatShading, dithering, vertexColors.
@returns {THREE.MeshStandardMaterial} material.tfTerrain — API рантайм-правок.
```

#### GLSL-чанки (шейдерный код)

| Имя | Значение / состав | Описание |
|---|---|---|
| `TF_TERRAIN_DETAIL_GLSL` | GLSL, ~2 КБ | 4.2 — Материал террейна с детализацией. installTerrainDetailPatch патчует MeshStandard/PhysicalMaterial: - вершинный шейдер отдаёт мировую позицию и мировую… |
| `TF_TERRAIN_DETAIL_VERT` | GLSL, ~1 КБ | террейна — только трансляция). |
| `TF_TERRAIN_DETAIL_COLOR` | GLSL, ~1 КБ | последующие точки вставки (roughness, normal). |
| `TF_TERRAIN_DETAIL_ROUGH` | GLSL, ~1 КБ | Точка 2 (после <roughnessmap_fragment>). |
| `TF_TERRAIN_DETAIL_NORMAL` | GLSL, ~1 КБ | нужен); вырождение базы исключено выбором опорной оси по большей компоненте. |

*4.3 растительность и камни*

### TerrainDetailManager

*extends `EventDispatcher`; строка 10102*

Растительность и камни террейна: instanced-размещение detail-типов (деревья/кусты/трава/камни — `TF_DETAIL_TYPES`) по чанкам с шумовой плотностью, culling по дистанции/фрустуму, ветер через sway-шейдер.

**`new TerrainDetailManager(options)`**

| Опция | По умолчанию | Описание |
|---|---|---|
| `chunkSize` | `(this.streamer !== null ? this.streamer.chunkSize : 64` | — |
| `yOffset` | `(this.streamer !== null ? this.streamer.yOffset : 0` | — |
| `scatterCount` | `420` | — |
| `seed` | `(this.terrain.seed !== undefined ? this.terrain.seed : 0` | — |
| `budgetMs` | `3` | — |
| `focus` | `null` | — |
| `fog` | `null }` | — |
| `streamer` | — | — |
| `terrain` | — | — |
| `parent` | — | — |
| `scatter` | — | — |
| `types` | — | геометрии/материалы, созданные менеджером (dispose) |
| `sway` | — | геометрии/материалы, созданные менеджером (dispose) |
| `geometries` | — | — |
| `materials` | — | — |

**Методы:**

| Сигнатура | Описание |
|---|---|
| `ringOf(cx, cz)` | Кольцо LOD (Чебышёв) чанка от текущего фокуса. |
| `populateChunk(cx, cz)` | Немедленно заселить чанк (вне очереди). |
| `removeChunk(cx, cz)` | Снять всю растительность чанка. |
| `refresh()` | Перезаселить чанки (после смены density/maxRing/после clear()): |
| `clear()` | Мгновенно снять всё. |
| `update(dt)` | Кадровый тик: |
| `dispose()` |  |

*Приватные (`_…`, не часть публичного контракта): 10 — `_onChunkBuilt`, `_enqueueSync`, `_eligChanged`, `_onChunkRemoved`, `_focusPosition`, `_itemRand`, `_populateNow`, `_addTypes`, `_syncChunk`, `_flush`*

**События** (`EventDispatcher`): `chunkpopulated`, `chunksynced`, `chunkcleared`

### installSwayPatch(material, options = {})

*строка 9857*

Патч «ветра» для любого материала с #include <begin_vertex> (Lambert/Standard/Physical). timeUniform — общий {value} clock.

### createTreeGeometry(options = {})

*строка 9935*

Ёлка: ствол-цилиндр + ярусы конусов (вершинные цвета, ~60 треуг.).

### createRockGeometry(options = {})

*строка 9962*

Валун: икосаэдр с гранёным шумовым displacement'ом (плоские фасеты).

### createBushGeometry(options = {})

*строка 9993*

Куст: несколько смятых икосаэдров-«комков» с вариацией зелени.

### createGrassGeometry(options = {})

*строка 10022*

Пучок травы: изогнутые «лезвия» с градиентом корень→кончик (DoubleSide).

### createDetailMaterial(type, options = {})

*строка 10076*

Материал растительности по умолчанию: Lambert + vertexColors (+ DoubleSide для травы).

#### Константы и пресеты

| Имя | Значение / состав | Описание |
|---|---|---|
| `TF_SWAY_TIME` | ключи: `value` | Общий clock ветра для standalone-материалов (менеджеры ведут свой). |
| `TF_DETAIL_DEFAULTS` | ключи: `tree`, `rock`, `bush`, `grass` | budget — потолок инстансов, sway — параметры ветра (null — без ветра). |
| `TF_DETAIL_TYPES` | `['tree', 'rock', 'bush', 'grass']` | — |

#### GLSL-чанки (шейдерный код)

| Имя | Значение / состав | Описание |
|---|---|---|
| `TF_SWAY_GLSL` | GLSL, ~1 КБ | — |
| `TF_SWAY_VERT` | GLSL, ~1 КБ | одного типа качаются не в ногу), маска от ЛОКАЛЬНОЙ Y (низ закреплён). |

*4.4 вода*

### WaterSurface

*extends `Mesh`; строка 10681*

Поверхность воды (`Mesh`): процедурные FBM-волны в вершинном шейдере, береговая пена по shore-height текстуре (`createShoreHeightTexture`), привязка к SunCycle/FogManager; follow за камерой.

**`new WaterSurface(options)`**

| Опция | По умолчанию | Описание |
|---|---|---|
| `size` | `1400` | — |
| `segments` | `96` | — |
| `colorDeep` | `0x0d3244` | — |
| `colorShallow` | `0x2f7f92` | — |
| `colorFoam` | `0xe8f2f4` | — |
| `zenith` | `0x3f6fb5` | — |
| `horizon` | `0x9fc0dd` | — |
| `sunIntensity` | `3.0 }` | — |
| `normalStrength` | `1.0` | — |
| `foamScale` | `0.8` | — |
| `opacity` | `0.42` | — |
| `specStrength` | `0.55` | — |
| `gloss` | `380` | — |
| `skyGlow` | `0.35` | — |
| `foamThreshold` | `0.62` | — |
| `shoreRange` | `10` | — |
| `depthWrite` | `true` | — |
| `renderOrder` | `-1` | renderOrder < 0: вода рисуется РАНЬШЕ прочих прозрачных (частицы/дождь поверх воды), depthWrite=true отсекает то, что под водой. |
| `level` | `0` | — |
| `timeScale` | `1` | — |
| `follow` | `null` | — |
| `vertexWaveAmp` | `1` | — |
| `vertexWaves` | `true` | — |
| `fog` | — | — |
| `sunDir` | — | — |
| `waves` | — | — |
| `sunCycle` | — | — |

**Методы:**

| Сигнатура | Описание |
|---|---|
| `setWaves(list)` | Волны: |
| `setLevel(y)` |  |
| `bindSunCycle(cycle)` | Подключить SunCycle: |
| `unbindSunCycle()` |  |
| `setShoreHeightTexture(texture, rect)` | Береговая пена: |
| `heightAt(x, z, t)` | Высота волн в мировой точке — JS-зеркало tfWaterH (тот же порядок ops). |
| `isUnderwater(cameraOrY)` |  |
| `update(dt)` | Кадровый тик (система Engine): |
| `dispose()` |  |

### createShoreHeightTexture(terrain, options = {})

*строка 10646*

```
Shore-карта высот для береговой пены: R = (height - level)/range*0.5 + 0.5.
Печётся из Terrain один раз (или периодически) вокруг центра мира/игрока.
@param {Terrain} terrain
@param {{centerX?:number, centerZ?:number, worldSize?:number, size?:number, range?:number, level?:number, yOffset?:number}} [options]
@returns {THREE.DataTexture}
```

#### Константы и пресеты

| Имя | Значение / состав | Описание |
|---|---|---|
| `TF_WATER_DEFAULT_WAVES` | `[{ direction: 0.35, lengt…, { direction: 1.31, lengt…, { direction: 2.53, lengt…, { direction: 4.02, lengt…]` | — |

#### GLSL-чанки (шейдерный код)

| Имя | Значение / состав | Описание |
|---|---|---|
| `TF_WATER_WAVES_GLSL` | GLSL, ~1 КБ | Общая часть вершинного и фрагментного шейдеров: волны + аналитическая нормаль. |
| `TF_WATER_VERT` | GLSL, ~1 КБ | — |
| `TF_WATER_FRAG` | GLSL, ~3 КБ | — |

*4.5 фасад*

### createTerrainSystem(options = {})

*строка 10919*

```
@param {object} [options]
Сцена/ядро: scene, camera, engine, physics (PhysicsWorld), fog (FogManager),
sunCycle (или lights — риг createLightRig: возьмётся lights.cycle),
group (своя группа; иначе создаётся и добавляется в scene), yOffset.
Рельеф: terrain — Terrain-инстанс ИЛИ объект параметров Terrain
(seed/scale/amplitude/octaves/ridgeMix/waterLevel/palette — читаются и из
плоских options).
Стример: streamer — объект опций TerrainStreamer (chunkSize/viewDistance/
lodRings/workers/budgetMs/skirtCells/maxInFlight/workerTimeoutMs) ИЛИ
плоские поля того же имени; focus по умолчанию — camera.
Материал: material — Material-инстанс | false (чистый vertexColors) |
объект опций createTerrainMaterial; textures — false | объект опций
генерации {size, seed, mode, contrast} | готовые наборы {grass, rock, ...}.
Детали: details — false | объект опций TerrainDetailManager.
Вода: water — false | объект опций WaterSurface (follow по умолчанию camera).
autoPhysics — false отключает автопривязку heightfield (default true).
Приоритеты систем Engine: priorityStreamer/priorityDetails/priorityWater.
@returns {object} system — фасад (поля + методы, см. реализацию).
```

---

## Часть 5: небо

> ThreeForge Engine — часть 5: небо (SkyDome + CloudLayer + createSkySystem) До этой части вся математика неба в движке была, а самого неба не было: SunCycle (1.5) считал uZenith/uHorizon/uSunColor/uSunIntensity/ uNightFactor и писал их в skyUniforms — но skyUniforms по умолчанию null: писать было некуда; FogManager (1.75) двигал sky за камерой (follow + scale 0.98·far) и писал uSkyFogAmt — но sky = null; WeatherManager (1.9) писал uFlash (молнии) в skyUniforms — null; WaterSurface (4.4) отражала процедурное небо (uZenith/uHorizon) — отражать было нечего; PostPipeline (3.1c) god-rays используют пиксели неба (depth ≥ 0.9995) как источник лучей — неба не было → лучам не откуда бить. Состав…

*5.1 купол неба*

### SkyDome

*extends `Mesh`; строка 11297*

SkyDome — купол неба (система Engine: update(dt); меш для сцены). Связи (всё опционально, как у WaterSurface): bindSunCycle(cycle) — контракт skyUniforms: SunCycle._apply() пишет uZenith/uHorizon/uSunColor/uSunIntensity/uNightFactor; uSunDir/uMoonDir/uZenith/uHorizon/uSunColor получают ЖИВЫЕ объекты цикла (без копий — что насчитал _compute, сразу видно); cycle.skyUniforms = uniforms; bindFog(fog) — fog.sky = купол (follow + scale 0.98·far), fog.skyRadius = radius, fog.skyUniforms = uniforms (uSkyFogAmt), tfFogColor.value → живой Color тумана; bindWeather(weather) — weather.skyUniforms =…

**`new SkyDome(options)`**

| Опция | По умолчанию | Описание |
|---|---|---|
| `radius` | `2400` | — |
| `segments` | `32` | — |
| `flashColor` | `0xdfe9ff` | — |
| `sunSizeDeg` | `0.9` | — |
| `sunHaloPower` | `18` | — |
| `sunHalo` | `0.42` | — |
| `sunHDR` | `2.6` | — |
| `moonSizeDeg` | `1.15` | — |
| `moonHalo` | `0.09` | — |
| `moonBrightness` | `1.35` | — |
| `moonMare` | `0.22` | — |
| `starDensity` | `0.7` | — |
| `starBrightness` | `1.35` | — |
| `starTwinkleSpeed` | `2.2` | — |
| `starTwinkle` | `0.35` | — |
| `starScaleA` | `90` | — |
| `starScaleB` | `175` | — |
| `starBrightB` | `0.38` | — |
| `starColorMix` | `0.55` | — |
| `gradientStart` | `-0.05` | — |
| `gradientEnd` | `0.55` | — |
| `sunsetGlow` | `0.9` | — |
| `belowDarken` | `0.32` | — |
| `horizonVeil` | `1` | v2.9 (H1): сила горизонтальной вуали — сведения неба к цвету тумана у горизонта (непрерывность тумана на силуэте); применяется при `bindFog()`, `0` — вуаль выключена. |
| `veilHeight` | `0.3` | v2.9 (H1): высота полосы вуали по `dir.y` (0.3 ≈ 17° над горизонтом). |
| `renderOrder` | `10` | — |
| `timeScale` | `1` | — |
| `follow` | `null` | — |
| `autoScale` | `true` | — |
| `sunCycle` | — | — |
| `fog` | — | — |
| `weather` | — | — |

**Методы:**

| Сигнатура | Описание |
|---|---|
| `bindSunCycle(cycle)` | Привязать SunCycle: |
| `unbindSunCycle()` |  |
| `bindFog(fog)` | Привязать FogManager: |
| `unbindFog()` |  |
| `bindWeather(weather)` | Привязать WeatherManager: |
| `unbindWeather()` |  |
| `update(dt)` | Кадровый тик (система Engine): |
| `getState()` |  |
| `dispose()` | Освобождение: |

#### GLSL-чанки (шейдерный код)

| Имя | Значение / состав | Описание |
|---|---|---|
| `TF_SKY_VERT` | GLSL, ~1 КБ | 5.1 — SkyDome: шейдеры купола. Вершина отдаёт направление «камера → точка купола» (купол центрирован на камере — направление и есть нормализованная локальная… |
| `TF_SKY_FRAG` | GLSL, ~6 КБ | — |

*5.2 процедурные облака*

### CloudLayer

*extends `Mesh`; строка 11705*

CloudLayer — слой процедурных облаков (система Engine: update(dt)). Два режима: автономный — options.follow (камера): сам следует за камерой и масштабируется под 0.98·far; bindSunCycle/bindFog/bindWeather работают как у SkyDome (тот же контракт униформ); в составе — attachTo(skyDome) (делает createSkySystem): облака — ребёнок купола, follow/scale наследуются, униформы SunCycle/Fog/ Weather — ОБЩИЕ {value}-объекты с куполом (одна запись — оба материала видят; uTime тикает купол). Погода: bindWeather(weather) — coverage/darken/ветер следуют rain/snow/ storm и windSpeed/windAngle WeatherManager…

**`new CloudLayer(options)`**

| Опция | По умолчанию | Описание |
|---|---|---|
| `radius` | `2364` | — |
| `segments` | `32` | — |
| `coverage` | `0.42` | — |
| `softness` | `0.24` | — |
| `opacity` | `0.92` | — |
| `scale` | `0.9` | — |
| `height` | `1` | — |
| `warp` | `0.65` | — |
| `lightStep` | `0.4` | — |
| `silver` | `0.55` | — |
| `fadeStart` | `7` | — |
| `fadeEnd` | `18` | — |
| `horizonSoft` | `0.05` | — |
| `flashBoost` | `1.7` | — |
| `colorBright` | `0xf4f7fb` | — |
| `brightness` | `1.3` | — |
| `colorDark` | `0x8b98ac` | — |
| `flashColor` | `0xdfe9ff` | — |
| `renderOrder` | `-5` | — |
| `windSpeed` | `2.4` | — |
| `windAngle` | `0.6` | — |
| `windFactor` | `0.02` | — |
| `coverageResponse` | `4.5` | — |
| `timeScale` | `1` | — |
| `follow` | `null` | — |
| `autoScale` | `true` | — |
| `octaves` | — | — |
| `sunCycle` | — | — |
| `fog` | — | — |
| `weather` | — | — |

**Методы:**

| Сигнатура | Описание |
|---|---|
| `shareSkyUniforms(sky)` | Разделить униформы с куполом: |
| `attachTo(skyDome)` | Присоединить к куполу (делает createSkySystem): |
| `bindSunCycle(cycle)` | Автономная привязка SunCycle (когда купола нет): |
| `unbindSunCycle()` |  |
| `bindFog(fog)` | Автономная привязка FogManager (когда купола нет): |
| `unbindFog()` |  |
| `bindWeatherUniforms(weather)` | Автономный контракт uFlash (когда купола нет): |
| `unbindWeatherUniforms()` |  |
| `bindWeather(weather)` | Привязать WeatherManager: |
| `unbindWeather()` |  |
| `setCoverage(v)` | Ручное покрытие 0..1 (без погоды/поверх базового — погода всё равно добавит). |
| `update(dt)` | Кадровый тик (система Engine): |
| `getState()` |  |
| `dispose()` |  |

#### Константы и пресеты

| Имя | Значение / состав | Описание |
|---|---|---|
| `TF_CLOUD_WRAP` | `128` | Период решётки шума = модуль дрейфа ветра (shader/CPU — одно число!) |

#### GLSL-чанки (шейдерный код)

| Имя | Значение / состав | Описание |
|---|---|---|
| `TF_CLOUD_VERT` | GLSL, ~1 КБ | — |
| `TF_CLOUD_FRAG` | GLSL, ~6 КБ | — |

*5.3 фасад*

### createSkySystem(options = {})

*строка 12074*

```
@param {object} [options]
Ядро: scene, camera, engine, fog (FogManager), sunCycle (или lights — риг
createLightRig: возьмётся lights.cycle), weather (WeatherManager),
post (PostPipeline), water (WaterSurface — привязать к sunCycle, если ещё
не привязана), group (своя группа; иначе создаётся и добавляется в scene;
группа ДОЛЖНА оставаться в начале координат — купол позиционируется
мировой позицией камеры).
Небо: sky — false (без купола) | объект опций SkyDome (radius/segments/
sunSizeDeg/starDensity/... — см. JSDoc SkyDome; follow по умолчанию camera).
Облака: clouds — false (без облаков) | объект опций CloudLayer (coverage/
softness/warp/octaves/... — см. JSDoc CloudLayer; radius по умолчанию
0.985·radius купола).
priority — приоритет системы Engine (по умолчанию 5).
autoBind — false отключает автопривязку SunCycle/Fog/Weather/Post/Water
(default true; объекты, явно переданные в sky/clouds-опциях, привязываются
их конструкторами как обычно).
@returns {object} фасад {group, sky, clouds, uniforms, update, setTime,
setCloudCoverage, getState, dispose}.
```

---

*Документ сгенерирован из AST исходного файла (acorn) + JSDoc/баннеры оригинала;
описания опций конструкторов извлечены из комментариев к ко v2.6.0.*
