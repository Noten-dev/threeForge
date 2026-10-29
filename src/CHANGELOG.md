# ThreeForge Engine — CHANGELOG

> История изменений, извлечённая из шапки исходного модуля v2.6.0.
> Метки (**T**/**F**/**R**/**S**/**L**/**N**/**M**) встречаются в комментариях кода — по ним можно найти место фикса.
> Состав модуля по разделам — в [API.md](API.md).

**ThreeForge Engine** — единый ESM-модуль (three.js r186, без внешних зависимостей); объединение
`threeforge-engine.js` (части 1–2: ядро и игровой мир) и `threeforge-advanced.js` (часть 3: продвинутый
рендеринг и оптимизация). Все системы опциональны; имена экспортов не менялись между версиями.

## v2.9 — Horizon & Contact-AO & Day fix (H1, S1–S4, D1–D3):

- **H1** `TF_SKY_FRAG` / `SkyDome`: **горизонтальная вуаль** — полоса неба вокруг
  горизонта сходится к цвету тумана `tfFogColor` НЕЗАВИСИМО от `uSkyFogAmt`
  (маска `max(fogMask, veil)`, veil = 1 ниже горизонта, квадратично гаснет к
  `uVeilHeight`). Устраняет жёсткий «обрез» тумана силуэтом горизонта: террейн вдали
  всегда полностью затуманен, а небо ночью (`skyFog ≈ 0`) раньше оставалось своим —
  разрыв цветов на линии силуэта. Новые униформы `uHorizonVeil`/`uVeilHeight`;
  опции `SkyDome({ horizonVeil = 1, veilHeight = 0.3 })`; вуаль включает
  `bindFog()`, выключает `unbindFog()`. Звёзды/закат в полосе вуали приглушаются
  (атмосферная экстинкция).
- **S1** `TF_AO_FRAG`: **контактная локализация SSAO** — вклад сэмпла гаснет
  квадратично по дистанции до окклюдера (`contact = 1 - smoothstep(0.25·R, R, od)`);
  метровые ореолы-«объятия» вокруг силуэтов и градиенты на вертикалях у земли
  исчезают, остаётся подсветка стыков.
- **S2** дефолты AO: `radius 0.8→0.5`, `bias 0.025→0.03`, `rangeCheck 2.0→1.0`,
  `intensity 1.7→1.15`, `power 1.35→1.6`.
- **S3** `TF_COMPOSITE_FRAG` / `PostPipeline`: AO применяется только к **ambient**-
  составляющей освещения (новый uniform `uAOAmbient`): доля берётся из живых
  интенсивностей `ao.lights = {hemi, sun, moon}` (`share = hemi/(hemi+sun+moon)`,
  кламп 0.15..0.85, пересчёт каждый кадр в `_updateAOAmbient()`), без привязки —
  `aoOptions.ambientShare` (дефолт 0.6). Прямой свет светила больше не гасится AO:
  «тень» перестаёт обволакивать предмет, брошенные тени даёт теневая карта.
  `setAO({ambientShare, lights})`.
- **D1** dev-стенд: `serve.mjs` отдаёт корень репозитория (раскладка `src/`),
  починены относительные импорты `smoke.mjs`/`smoke-game.mjs`/`smoke-shadow.mjs`/
  `validate-shaders.mjs`; восстановлено демо `examples/sword-field.html` +
  headless-скриншоты `npm run shot` (playwright + SwiftShader).
- **D2** `createLightRig({moonShadow})`: **дневной режим восстановлен**. Корень бага:
  `castShadow=true` у луны держит `NUM_DIR_LIGHT_SHADOWS > 0` (`sampler2DShadow` в
  PCF/PCFSoft), а днём shadow-pass луны выключен и `shadow.map === null` → three
  биндит плейсхолдер без `COMPARE_MODE` → GL `INVALID_OPERATION` (1282) на каждом
  draw → все освещаемые материалы отбрасывались (кадр = одно небо; `BasicShadowMap`
  не требовал compare — потому работал). Фикс: `moon.shadow.needsUpdate = true` при
  создании рига — карта рендерится один раз на первом кадре при любом времени суток
  (вклад днём = 0 через `shadow.intensity`), сэмплер валиден, рекомпиляций нет.
  Regression-тест в `smoke-shadow.mjs` (D2, 7 проверок).
- **D3** dev-стенд: `build-standalone.mjs` — корень репозитория (раскладка `src/`),
  `npm run standalone` собран и проверен headless- прогоном; артефакт
  `examples/sword-field-standalone.html` в git не кладётся (`.gitignore`).

## v2.8 — Gameplay Kit (игровой набор; аддитивно, дефолты = v2.7):

- **GK1** `createSwordGeometry` — процедурный низполи-меч (4-гранный клинок с остриём и
  долом, перекрестье, рукоять, навершие; вершинные цвета; начало координат — перекрестье).
- **GK2** `createFistGeometry` — стилизованный кулак-перчатка для вьюмодели.
- **GK3** `createFlowerGeometry` + новый тип детали `flower` (палитра, sway, бюджет) —
  плотные «поля цветов» через TerrainDetailManager/createTerrainSystem.
- **GK4** `scatterProps` — детерминированное инстанс-рассеивание пропсов (seed, радиус/
  bounds, маска плотности, масштаб/наклон/yaw, sink, baseRotation, чанки InstancedMesh
  с корректными boundingSphere для frustum culling, dispose).
- **GK5** `FloatingProps` — парящие острова/камни: bob, медленное вращение, наклон;
  attach в Engine.
- **GK6** `FirstPersonController` — walker от первого лица: pointer-lock обзор (через
  InputManager), WASD+спринт+прыжок, гравитация и опора на terrain.heightAt/groundFn,
  head-bob, edge-детект прыжка, clamp pitch, teleport; headless-безопасен (input=null →
  чистая кинематика, покрыт тестами).
- **GK7** `ViewModel` — оружие/руки от первого лица: отдельная сцена, рендер ПОСЛЕ
  основной в тот же RT без clearDepth (корректная окклюзия, нет клиппинга); с
  PostPipeline — через новый хук `scenePassHook` (внутри sceneRT, под bloom/AO/TAA),
  без него — обёртка `engine.renderOverride`; sway/bob от FirstPersonController;
  `attach/detach` восстанавливают предыдущее состояние (включая чужой хук).
  `PostPipeline.attach` теперь ставит `engine.postPipeline` (detach — снимает).
- **GK8** `createGradientMap`, `installStylizedPatch` (rim-френель для любого материала
  с `<opaque_fragment>`; совместим с fog/shadow/sway-патчами и cloneMaterialPatched),
  `createStylizedMaterial` (MeshToonMaterial + gradientMap + rim).
- **GK9** PostPipeline: кино-грейд финального пасса `grade: {vignette, saturation, tint}`
  + `setGrade()`; по умолчанию нейтрален (поведение v2.7). Синхронизация каждый кадр
  (`gradeOptions` можно менять напрямую).
- **GK10** `Hud` — DOM-плашка подсказок («ИГРА · Tab — … · Esc — …»), промпт, прицел;
  без `document` — безопасные заглушки.
- Тесты: `tools/dev/smoke-game.mjs` (99 проверок, входит в `npm run smoke` и отдельным
  `npm run game`); GLSL-матрица расширена до 49 комбинаций (toon+rim+fog+CSM, standard+rim,
  final+grade). Демо: `examples/sword-field.html` + `tools/dev/serve.mjs` (статик-сервер).
- `tools/dev/build-standalone.mjs` (+ `npm run standalone`): single-file сборка демо —
  `examples/sword-field-standalone.html` (three core+module + движок + демо одним
  классическим `<script>`; работает с file://; встроенные проверки: acorn + headless-прогон).
- Фиксы запуска/визуала демо (F1–F5), найдены headless-браузером (puppeteer):
  - **F1** `PostPipeline`: `grade.tint` числом/строкой в конструкторе падал с
    «tint.clone is not a function» и ронял весь скрипт — нормализуется в `Color`.
  - **F2** `TerrainStreamer`: `new Worker(blob:)` в Chrome на `file://` бросает
    синхронный SecurityError — обёрнуто в try/catch с переходом на sync-сборку
    (single-file демо теперь реально открывается с диска).
  - **F3** `scatterProps`: `heightFn(x, z, scale)` — третий аргумент позволяет
    «воткнуть» меч остриём в землю на нужную высоту (гарда над землёй).
  - **F4** `Terrain`: `options.scatterWeights {type: weight}` — настраиваемая
    палитра типов scatter (дефолт = v2.7); пробрасывается через createTerrainSystem;
    без неё тип `flower` не сеялся вовсе.
  - **F5** `createDetailMaterial`: `emissive` (и `types.*.emissive` у менеджера) —
    ночной «светящийся» ковёр цветов; плюс type-agnostic stats/records менеджера
    деталей (ранее rec/stats создавались только для 4 старых типов → крах на flower).
  - Демо: палитра ночи (zenith/horizon/hemi), fill-hemi, PCFShadowMap (PCFSoft удалён
    в r186), парящие острова в секторе взгляда, `window.__tf` для отладки.
- Экспорты: 175 → 186 (+11). Имя файла и прежние API не менялись.

## v2.7 — Shadow Overhaul (глубокая переработка теней; аддитивно, дефолты = v2.6):

- **SH1** SunLightShadow: конфигурируемые каскады — `setSunCascadeCount(1..4)` (глобально: override
  define `SUN_LIGHT_CASCADES` в чанке three + реестр живых теней + авто-рекомпиляция пропатченных
  материалов), `splitLambda` (0 = логарифмические сплиты, 1 = равномерные, 0.5 = прежнее поведение),
  `cascadeFade`, `cascadeTiles` (веса каскадов в атласе: `[2,1,1,1]` — ближний каскад вдвое детальнее);
  эквивалентность дефолтов эталону three проверена покадрово (матрицы/вьюпорты/cascadeData);
- **SH2** Качество фильтрации: GLSL теперь ГЕНЕРИРУЕТСЯ под настройки — `setShadowQuality({taps, soft,
  fadeAllLights})`: тиры Vogel-тапов 1..64 (дефолт 12 = v2.6), soft-режим (второе широкое PCF-кольцо
  с усилением по дальности — аппроксимация contact hardening, униформа `tfShadowSoft`); динамический
  ключ кэша программ (`tfShadowCacheKey.toString()`) — смена настроек даёт новую программу, а не
  молчаливое переиспользование старой;
- **SH3** Единый туманный фейд: `tfFadeShadow` оборачивает тени directional/spot/point (раньше
  растворялись только тени солнца) — дальние тени всех источников уходят в дымку вместе с `tfShadowFade`;
- **SH4** SunCycle: фикс «застывшей ночи» — вместо булева порога `sunIntensity > 0.05` плавный
  `shadow.intensity` по высоте солнца (`shadowFactor`): ночью застывшая карта заката больше не
  сэмплируется (интенсивность 0), рассвет/закат без щелчка; `water.uShadowFade` — из той же кривой;
- **SH5** Лунные тени: `createLightRig({moonShadow: true|{mapSize, range, ...}})` + `bindShadowCamera(camera)` —
  `castShadow` включён сразу (NUM_DIR_LIGHT_SHADOWS стабилен → без рекомпиляций в рантайме), ночью
  SunCycle включает autoUpdate, орто-фрустум следует за камерой (`followCamera` + тексельный снап);
- **SH6** LightManager: бюджет обновлений теневых карт — `shadowBudget` (грантов/кадр, round-robin по
  времени ожидания; первый рендер карты — вне бюджета) и `shadowRate` (Гц на источник, default +
  per-entry + `setShadowRate()`); статичные факелы больше не рендерят куб-карту каждый кадр;
- **SH7** Пресеты: `SHADOW_QUALITY_PRESETS` (low/medium/high/ultra) + `applyShadowQuality(name,
  {rig, sun, lights, directional})` — один вызов настраивает каскады, тапы, soft, размеры карт
  и бюджет LightManager; 'high' = прежнее поведение v2.6;
- **SH8** Отладка: `SunShadowHelper(sun)` — wireframe фрустумов каскадов (цвет на каскад) + линия
  направления света; работает и при выключенном теневом проходе (сам зовёт updateMatrices);
- **SH9** Инструменты: `tools/dev/` — GLSL-валидатор (glslang 16.6.0, 46 комбинаций: тип карты ×
  каскады × тиры × soft × состав источников) и smoke-тесты логики (67 проверок, без WebGL):
  `npm run shaders`, `npm run smoke`.

## v2.4 — исправления по итогам стресс-тестирования (метки T1..T16 в коде):

- **T1** PhysicsWorld: options.recordContacts теперь читается конструктором;
- **T2** PhysicsWorld.step(Infinity) больше не выполняет шаг (Number.isFinite-guard);
- **T3** PhysicsWorld.raycast: промах с out-параметром возвращает null, а не устаревший объект прошлого хита;
- **T4** DirectionalLight.fitShadowCamera: near/far накрывают расстояние «свет → цель» (раньше при далёком свете тени пропадали целиком);
- **T5** PostPipeline: god-rays RT создаются независимо от TAA; setGodRays(false) освобождает VRAM;
- **T6** PhysicsWorld: brute-force narrowphase — O(awake × n) вместо O(n²) (~10× на мирах со спящими телами);
- **T7** LightManager: копия options (setBudget не мутирует объект игры); setScene() снимает и утилизирует слоты старой сцены;
- **T8** InstancedBatcher: boundingSphere страницы растёт через Sphere.union (в ~1.7× плотнее прежней AABB-схемы — точнее frustum-куллинг);
- **T9** PostPipeline.dispose: guard на depthTexture === null;
- **T10** ParticleField/createParticleMaterial: standalone-режим без менеджера не падает (фолбэк shared-униформ) + ParticleField.update(dt, camera);
- **T11** TerrainStreamer: таймаут зависшего воркера (workerTimeoutMs) — запрос снимается, задание возвращается в очередь, пул деградирует в sync;
- **T12** ParticleSystem: burst/addEmitter/_spawnOne санитизируют мусорные конфиги (NaN-частица «бессмертна» и необратимо съедала capacity);
- **T13** TerrainStreamer: _freeWorker пропускает failed-воркеры; onerror возвращает build-задания в очередь (раньше задания терялись → дыры);
- **T14** SceneCuller.add / OcclusionCuller.addOccluder/addOccludee: валидация типа аргумента (warning + null вместо TypeError);
- **T15** _tfRange: null/строки → def (вместо «reading 'min' of null»);
- **T16** PhysicsWorld: хеш-broadphase включается при awake ≥ hashAwakeMin(24) вместо 15% тел (~4× на сценариях «взрыв будит часть мира»).

## v2.5 — часть 4 «игровой террейн» (аддитивно, существующий API не изменён):

- **4.1** createTerrainTexture / createTerrainTextureSet / createTerrainNormalMap — бесшовные процедурные текстуры (трава/камень/снег/песок/земля/гравий), режимы 'detail' (умножение на vertexColors) и 'albedo';
- **4.2** createTerrainMaterial + installTerrainDetailPatch — материал террейна: 4-слойный бленд деталей по высоте/наклону (веса зеркалят Terrain._terrainColorRGB), normal-микрорельеф, roughness по слоям; компонуется с fog/sunShadow-патчами (цепочка onBeforeCompile);
- **4.3** TerrainDetailManager — деревья/камни/кусты/трава через InstancedBatcher: подписка на чанки TerrainStreamer, LOD-кольца на тип с синхронизацией при пересборке чанка (приближение дозаселяет траву/кусты, отъезд снимает; стоящие инстансы не пересоздаются — PRNG отдельного элемента), детерминированная плотность, бюджет инстансов, ветер (installSwayPatch), заселение в рамках budgetMs;
- **4.4** WaterSurface — вода: 4 волновые системы (аналитические нормали), френель, процедурное небо в отражении, солнечный блик, пена гребней и берега (shore-карта высот), туман движка, SunCycle-контракт waterUniforms (bindSunCycle), вид из-под воды;
- **4.5** createTerrainSystem — фасад «всё одним вызовом»: Terrain + Streamer + материал с текстурами + растительность + вода; автопривязка PhysicsWorld.setHeightfield, FogManager.waterLevel/scene.fog, SunCycle.waterUniforms, регистрация систем в Engine, dispose().

## v2.5.1 — ревизия (метки F1..F13 в коде; F8 в ходе ревизии снят — метки нет):

- **F1** PostPipeline: JSDoc setQuality стоял над setBloomEnabled — восстановлен;
- **F2** InputManager.connect() возвращает this (раньше undefined);
- **F3** SpatialHashGrid: бесконечные/огромные тела (пол halfExtents=Infinity) вешали вкладку и стоили тысячи вставок за шаг — теперь список «крупных» тел + обход бакетов для широких запросов; NaN-границы не вставляются;
- **F4** PhysicsWorld.removeBody будит цепочку спящих тел вокруг удалённого;
- **F5** Engine: add/removeSystem — copy-on-write (безопасно из update());
- **F6** InputManager.gamepad(): проверка слота на truthy;
- **F7** удалены неиспользуемые _lmPos/_lmTarget;
- **F9** InstancedBatcher._growBounds: масштаб оси Y брал e[3..5] вместо e[4..6] (column-major) — границы страницы занижались, инстансы пропадали у края;
- **F10** InstancedBatcher: хендл чужого батчера отвергается;
- **F11** InputManager.disconnect() сбрасывает залипшие клавиши;
- **F12** AudioManager: слушатель — по МИРОВОЙ позиции + фолбэк для Safari;
- **F13** createTerrainSystem.unbindPhysics не стирает чужой heightfield.
- *Тесты: tests/ (215 проверок, node --expose-gc tests/run.js).*

## v2.5.2 — исправления по итогам независимого код-ревью (метки R1..R3):

- **R1** PhysicsWorld — солвер контактов:
- **R1a** пары-кандидаты собираются ОДИН раз за шаг (кэш this._pairs); итерации перечитывают список вместо повторного broadphase-скана (раньше iterations=N умножал O(awake×n)/хеш-запросы на N);
- **R1b** iterations по умолчанию 1 → 12: с одной итерацией импульс опоры не распространяется вверх по стопке — стопки из 3+ тел не засыпали НИКОГДА, проникали друг в друга на 20–60% и держали остаточную скорость ~1.4–2 м/с (сходимость: 6 тел — 6 итераций, 10 тел — 12);
- **R1c** спящее тело участвует в контакте как СТАТИК, пока удар не разбудит его (|jn| > wakeImpulse): раньше спящие тела получали импульсы и Baumgarte-коррекцию, не просыпаясь — во сне копилась «мусорная» скорость (спящее тело с |v|≈0.5 м/с «вздрагивало» при пробуждении), а спящие стопки медленно проседали. Разбуженному телу сбрасывается _still (иначе счётчик сна укладывал его обратно в тот же шаг).
- **R2** DirectionalLight.copy(source, recursive): THREE.DirectionalLight.copy принимает один аргумент и recursive молча терялся (дефолт Object3D — всегда копировать детей). Теперь копия честная, target/shadow — клоны.
- **R3** Документация: JSDoc createTerrainMaterial (textureNormalStrength/ textureContrast/textureAnisotropy), WaterSurface (vertexWaveAmp), TerrainDetailManager (chunkSize/seed/focus/fog) — опции читались кодом, но не были объявлены; примечание о снятой метке F8 в шапке.

## v2.6 — часть 5 «небо» (аддитивно, существующий API не изменён):

- **5.1** SkyDome — купол неба: градиент зенит→горизонт (окно smoothstep 1:1 с отражением WaterSurface), солнечный диск и ореол (HDR — источник для bloom 3.1d и god-rays 3.1c: небо не пишет глубину, depth=1), луна с процедурными «морями», два слоя звёзд из хеш-ячеек с мерцанием, закатное свечение (sunsetFactor — формула 1:1 с SunCycle._compute), скай-туман, молнии. Контракт skyUniforms совместим с SunCycle._apply(), FogManager._commit(), WeatherManager._updateLightning(); bindSunCycle отдаёт в .value ЖИВЫЕ sunDirection/moonDirection/zenithColor/horizonColor/sunColor;
- **5.2** CloudLayer — процедурные облака: 5-октавный FBM (define TF_CLOUD_OCTAVES) с доменным искажением, покрытие/плотность (bindWeather: rain/storm/snow → coverage/darken, ветер — windSpeed/windAngle WeatherManager), бесшовный дрейф (периодный хеш, wrap TF_CLOUD_WRAP=128 — float-точность не деградирует часами), освещение солнцем («серебряная кайма» — тонкие края против солнца), день/ночь от живой палитры SunCycle, прозрачность; attachTo(skyDome) — общие {value}-объекты униформ с куполом (одна запись SunCycle/Fog/Weather видна обоим материалам);
- **5.3** createSkySystem — фасад «небо одним вызовом»: SkyDome + CloudLayer (облака — ребёнок купола), автопривязка SunCycle (skyUniforms), FogManager (sky/skyRadius/skyUniforms + общий tfFogColor), WeatherManager (uFlash + погода облаков), Engine (система-тик), PostPipeline (prepassExclude + sunDirection god-rays), WaterSurface (bindSunCycle — палитра отражений совпадает с небом), dispose() с точной отвязкой контрактов;
- **S1** Небо↔туман (исправление совместной работы): uSkyFogAmt применяется нелинейно — горизонт затягивает цветом тумана первым (×1.25), но член pow(amt,4) догоняет зенит: в плотном тумане (dense, 0.85) и под водой (0.92) небо — сплошная стена tfFogColor, горизонт/солнце/луна/ звёзды/облака НЕ прорисовываются (светила гасятся celFade=(1-amt)^1.6, облака растворяются тем же цветом). Цвет общий с туманом террейна — стык «земля ↔ небо» бесшовный; god-rays в густом тумане гаснут сами (яркость неба ниже порога).
