# ThreeForge Engine — CHANGELOG

> История изменений, извлечённая из шапки исходного модуля v2.6.0.
> Метки (**T**/**F**/**R**/**S**/**L**/**N**/**M**) встречаются в комментариях кода — по ним можно найти место фикса.
> Состав модуля по разделам — в [API.md](API.md).

**ThreeForge Engine** — единый ESM-модуль (three.js r186, без внешних зависимостей); объединение
`threeforge-engine.js` (части 1–2: ядро и игровой мир) и `threeforge-advanced.js` (часть 3: продвинутый
рендеринг и оптимизация). Все системы опциональны; имена экспортов не менялись между версиями.

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
