#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Генератор API.md для ThreeForge Engine из structure.json (AST-экстракция)."""
import json, re, sys

STRUCT = sys.argv[1] if len(sys.argv) > 1 else 'structure.json'
OUT = sys.argv[2] if len(sys.argv) > 2 else 'threeforge/API.md'
LINES_FROM = sys.argv[3] if len(sys.argv) > 3 else None  # structure-clean.json — для номеров строк

d = json.load(open(STRUCT))
sections = {s['part']: s for s in d['sections']}
exports = d['exports']

if LINES_FROM:
    clean = {e['name']: e for e in json.load(open(LINES_FROM))['exports']}
    for e in exports:
        if e['name'] in clean and clean[e['name']].get('line'):
            e['line'] = clean[e['name']]['line']

# ---------------------------------------------------------------- описания
MANUAL = {
    'RigidBody': 'Тело для `PhysicsWorld`: форма `sphere` | `box` (AABB), масса, линейная/угловая скорость, restitution/friction, режим сна. Обычно создаётся через `physics.addBody(options)`.',
    'PhysicsWorld': 'Лёгкий физический мир без внешних зависимостей: интеграция, коллизии sphere/box, broadphase (перебор → пространственный хеш при hashThreshold), итеративный импульсный решатель, сны тел, heightfield-рельеф, raycast. Шаг — `step(dt)` (подключайте к `Engine` как систему: `engine.addSystem({ fixedUpdate: h => physics.step(h) })`).',
    'SceneCuller': 'Frustum-куллинг объектов сцены через `CullBVH`: у добавленных объектов считаются мировые bounding-сферы, невидимые отключаются до рендера. Работает батчами за кадр.',
    'OcclusionCuller': 'Софтверный Hi-Z окклюзионный куллинг (CPU, без GPU-запросов, классика GPU Gems ch.29): сетка глубин ~128×72; окклюдеры (крупные непрозрачные AABB) консервативно растеризуются в сетку, окклюды (bounding-сферы) отбрасываются, если полностью перекрыты.',
    'TerrainStreamer': 'Потоковая подгрузка чанков террейна вокруг камеры (focus): пул Web Worker’ов собирает геометрию (`buildTerrainWorkerSource`), LOD-кольца, бюджет времени на кадр, таймаут зависшего воркера с деградацией в синхронный режим.',
    'TerrainDetailManager': 'Растительность и камни террейна: instanced-размещение detail-типов (деревья/кусты/трава/камни — `TF_DETAIL_TYPES`) по чанкам с шумовой плотностью, culling по дистанции/фрустуму, ветер через sway-шейдер.',
    'WaterSurface': 'Поверхность воды (`Mesh`): процедурные FBM-волны в вершинном шейдере, береговая пена по shore-height текстуре (`createShoreHeightTexture`), привязка к SunCycle/FogManager; follow за камерой.',
    'installSunShadowPatch': 'Патчит материал для CSM-теней `SunLight`: выбор каскада, temporal PCF-ротация (`tfShadowRot`) и фейд теней по туману (`tfShadowFade`) через общие униформы `TF_SHADOW_UNIFORMS`.',
    'createParticleAtlas': 'Генерирует процедурный атлас спрайтов частиц 2×2 (`DataTexture`, RGBA): мягкие круги, вспышки/кольца, звезда с гало, снежинка — для `createParticleMaterial` и `ParticleSystem`.',
    'installDitherLODPatch': 'Патчит материал dither-LOD: униформа `uDitherFade` + IGN-шум по `gl_FragCoord` — пиксели отбрасываются при fade < 1 (плавное растворение между уровнями `LODGroup` без щелчков геометрии).',
    'LODGroup': '`Group` с LOD-уровнями и dither-переключением: уровни добавляются с диапазонами дистанций, cross-fade между ними через `installDitherLODPatch`.',
    'PostPipeline': 'Постпроцессинг поверх `renderer`: SSAO, TAA + motion vectors, god-rays, bloom, FXAA, финальный composite. Подключение — `post.attach(engine)` (устанавливает `engine.renderOverride`, fog → linear, `info.autoReset=false`).',
    'Engine': 'Игровой цикл с фиксированным шагом физики: `fixedUpdate(h)` систем вызывается строго `fixedTimeStep` раз в секунду (аккумулятор, защита от «спирали смерти» — `maxSubSteps`, `maxFrameDelta`), `update(dt, alpha)` — каждый кадр; `alpha` — доля аккумулятора для интерполяции рендера. Работает через `renderer.setAnimationLoop` (если renderer задан) или rAF.',
}

def clean_desc(t, limit=320):
    if not t:
        return None
    lines = [l for l in t.split('\n') if l.strip('-= \t*/')]
    t = ' '.join(l.strip() for l in lines)
    t = re.sub(r'^(ИСПРАВЛЕНО|ДОБАВЛЕНО|ПЕРЕДЕЛАНО|ВАЖНО)\s*(\([^)]*\))?\s*:?\s*', '', t)
    t = re.sub(r'^v\d+(\.\d+)?\s*(\([^)]*\))?\s*:?\s*', '', t)
    t = re.sub(r'\s+', ' ', t).strip()
    if limit and len(t) > limit:
        cut = t[:limit]
        sp = cut.rfind(' ')
        t = cut[:sp if sp > limit * 0.6 else limit].rstrip(',;:') + '…'
    return t or None

OPT_MANUAL = {
    ('Engine', 'renderer'): 'WebGLRenderer: цикл через renderer.setAnimationLoop + авто-рендер scene/camera (иначе rAF без рендера)',
    ('Engine', 'scene'): 'THREE.Scene для авто-рендера',
    ('Engine', 'camera'): 'камера для авто-рендера',
    ('Engine', 'fixedTimeStep'): 'фиксированный шаг симуляции, с',
    ('Engine', 'maxSubSteps'): 'потолок fixed-шагов за один кадр (защита от «спирали смерти»)',
    ('Engine', 'interpolation'): 'считать alpha — долю накопленного шага для интерполяции рендера',
    ('PhysicsWorld', 'gravity'): 'Vector3 гравитации (клонируется); дефолт (0, −25, 0)',
    ('PhysicsWorld', 'maxSpeed'): 'потолок скорости тел, м/с',
    ('PhysicsWorld', 'maxStep'): 'потолок dt одного step(), с (защита от «прострела» геометрии после фриза)',
    ('PhysicsWorld', 'iterations'): 'итерации импульсного решателя; стопки тел сходятся до ~12 контактных уровней',
    ('PhysicsWorld', 'sleepDelay'): 'время покоя тела до перехода в сон, с',
    ('PhysicsWorld', 'cellSize'): 'размер ячейки SpatialHashGrid (broadphase)',
    ('PhysicsWorld', 'recordContacts'): 'собирать контакты в `world.contacts` на каждом шаге',
    ('PhysicsWorld', 'hashThreshold'): 'число тел, с которого допускается хеш-broadphase',
    ('PhysicsWorld', 'hashAwakeMin'): 'минимум бодрствующих тел для включения хеш-broadphase',
    ('PhysicsWorld', 'nanGuard'): 'карантин тел с NaN (отравленное тело не заражает мир)',
}
CHANGELOGGY = re.compile(r'раньше|прежн|молча|не работало|было слишком|теперь |вместо |→|ИСПРАВЛЕНО|стало |дефолт \d')

def opt_desc(cls_name, opt):
    key = (cls_name, opt['name'])
    if key in OPT_MANUAL:
        return OPT_MANUAL[key]
    t = clean_desc(opt.get('desc'), None)
    if not t:
        return None
    # strip "optName — ..." prefix
    t = re.sub(r'^' + re.escape(opt['name']) + r'\s*(—|-|–)\s*', '', t)
    # keep first sentence/clause
    m = re.split(r'(?<=[^с])\.\s|\s—\s', t, maxsplit=1)
    t = m[0].strip()
    if len(t) < 12 or CHANGELOGGY.search(t):
        return None
    if len(t) > 150:
        t = t[:150].rsplit(' ', 1)[0] + '…'
    return t

def md_escape(t):
    return (t or '').replace('|', '\\|')

def first_sentence(t, limit=140):
    t = clean_desc(t, None)
    if not t:
        return ''
    m = re.split(r'(?<=[.:])\s', t)
    s = m[0] if m else t
    if len(s) > limit:
        s = clean_desc(t, limit)
    return s

def sig_params(m):
    return ', '.join(m.get('params') or [])

def anchor(name):
    a = name.lower()
    a = re.sub(r'[.:,()«»!?\'"/]', '', a)
    return re.sub(r'\s+', '-', a.strip())

def cap(g):
    return g[0].upper() + g[1:] if g else g

# ---------------------------------------------------------------- группировка
GROUP_ORDER = []
for e in exports:
    if e['group'] not in GROUP_ORDER:
        GROUP_ORDER.append(e['group'])

def part_of(group):
    m = re.match(r'часть\s+([\d.]+)', group)
    return m.group(1) if m else group

by_group = {g: [] for g in GROUP_ORDER}
for e in exports:
    by_group[e['group']].append(e)

kind_ru = {'class': 'класс', 'function': 'функция', 'glsl': 'GLSL', 'literal': 'константа',
           'object': 'объект', 'array': 'массив', 'expr': 'значение'}

# ---------------------------------------------------------------- рендер
out = []
w = out.append

w('# ThreeForge Engine v2.6.0 — справочник API')
w('')
w('Единый **ESM-модуль** для **three.js r186** (единственный импорт — `three`, других зависимостей нет).')
w('Файл: `threeforge-v2_6_0.js`. Все системы **опциональны**: подключайте только то, что нужно.')
w('')
n_class = sum(1 for e in exports if e['kind'] == 'class')
n_fn = sum(1 for e in exports if e['kind'] == 'function')
n_glsl = sum(1 for e in exports if e['kind'] == 'glsl')
n_rest = len(exports) - n_class - n_fn - n_glsl
w(f'**Экспортов: {len(exports)}** — {n_class} классов, {n_fn} функций, {n_glsl} GLSL-чанков, {n_rest} констант/пресетов.')
w('')
w('> Сопутствующие документы: [QUICKSTART.md](QUICKSTART.md) — рабочие примеры интеграции;')
w('> [CHANGELOG.md](CHANGELOG.md) — история исправлений (метки T/L/R/S/N/M в комментариях кода).')
w('')
w('## Оглавление')
w('')
w('- [Интеграция](#интеграция)')
w('- [Обзор экспортов](#обзор-экспортов)')
for g in GROUP_ORDER:
    w(f'- [{cap(g)}](#{anchor(g)})')
w('')

# ---- интеграция
w('## Интеграция')
w('')
w('### Подключение')
w('')
w('Модуль импортирует `three` как bare-specifier — в браузере нужна import map (или сборщик: Vite/webpack/Rollup — достаточно положить файл в проект и импортировать):')
w('')
w('```html')
w('<script type="importmap">')
w('{')
w('  "imports": {')
w('    "three": "https://unpkg.com/three@0.186.0/build/three.module.js",')
w('    "threeforge": "./threeforge-v2_6_0.js"')
w('  }')
w('}')
w('</script>')
w('<script type="module">')
w("import * as THREE from 'three';")
w("import { Engine, createLightRig, PhysicsWorld } from 'threeforge';")
w('</script>')
w('```')
w('')
w('### Контракт систем Engine')
w('')
w('`engine.addSystem(system, priority)` принимает любой объект с опциональными методами:')
w('')
w('```js')
w('{')
w('  fixedUpdate(h, engine) {},      // строгий фиксированный шаг (физика)')
w('  update(dt, alpha, engine) {}    // каждый кадр; alpha ∈ [0,1) — интерполяция')
w('}')
w('```')
w('')
w('Системы вызываются в порядке `priority` (меньше — раньше). Большинство менеджеров движка')
w('(`FogManager`, `WeatherManager`, `ParticleManager`, `SunCycle`, фасады `createTerrainSystem`/`createSkySystem`)')
w('уже соответствуют контракту или имеют совместимый `update(dt)` — подключайте их через `addSystem`.')
w('`PhysicsWorld` — исключение: у него `step(dt)`, оборачивайте: `engine.addSystem({ fixedUpdate: h => physics.step(h) })`.')
w('')
w('### Типовая иерархия систем (приоритеты)')
w('')
w('| Система | Роль | Куда |')
w('|---|---|---|')
w('| `SunCycle` / риг `createLightRig` | время суток, свет | `update(dt)` |')
w('| `PhysicsWorld` | симуляция тел | `fixedUpdate(h)` |')
w('| `TerrainStreamer` | чанки террейна | `update(dt)` (внутренний бюджет) |')
w('| `FogManager` | туман (пресеты, авто, погода) | `update(dt)` |')
w('| `WeatherManager` | погода: осадки, ветер, молнии | `update(dt)` |')
w('| `ParticleManager` | частицы (GPU/CPU) | `update(dt, camera)` |')
w('| `SceneCuller` / `OcclusionCuller` | отсечение невидимого | `update(dt)` |')
w('| `PostPipeline` | постобработка | `attach(engine)` — сама ставит `renderOverride` |')
w('')
w('Фасады `createTerrainSystem` и `createSkySystem` связывают всё автоматически (см. их описания и QUICKSTART).')
w('')

# ---- обзор
w('## Обзор экспортов')
w('')
for g in GROUP_ORDER:
    names = [f'`{e["name"]}`' for e in by_group[g]]
    w(f'- **{g}** ({len(names)}): ' + ', '.join(names))
w('')

# ---- разделы
def render_class(e):
    name = e['name']
    w(f'### {name}')
    w('')
    meta = []
    if e.get('superClass'):
        meta.append(f'extends `{e["superClass"]}`')
    if e.get('line'):
        meta.append(f'строка {e["line"]}')
    if meta:
        w('*' + '; '.join(meta) + '*')
        w('')
    desc = MANUAL.get(name) or clean_desc(e.get('jsdoc'), 600)
    if desc:
        w(desc)
        w('')
    ctor = e.get('ctor')
    if ctor and ctor.get('options'):
        w(f'**`new {name}(options)`**')
        w('')
        w('| Опция | По умолчанию | Описание |')
        w('|---|---|---|')
        for o in ctor['options']:
            dflt = f'`{o["default"]}`' if o.get('default') is not None else '—'
            w(f'| `{o["name"]}` | {dflt} | {md_escape(opt_desc(name, o)) or "—"} |')
        w('')
    elif ctor:
        ps = sig_params(ctor)
        w(f'**Конструктор:** `new {name}({ps})`' if ps else f'**Конструктор:** `new {name}()`')
        w('')
    pub = [m for m in e.get('methods', []) if not m['name'].startswith('_')]
    priv = [m for m in e.get('methods', []) if m['name'].startswith('_')]
    if pub:
        w('**Методы:**')
        w('')
        w('| Сигнатура | Описание |')
        w('|---|---|')
        for m in pub:
            prefix = '`static ' if m.get('static') else ('`get ' if m.get('kind') == 'get' else '`')
            s = prefix + m['name'] + '(' + sig_params(m) + ')`'
            w(f'| {s} | {md_escape(first_sentence(m.get("jsdoc")))} |')
        w('')
    if priv:
        w(f'*Приватные (`_…`, не часть публичного контракта): {len(priv)} — ' +
          ', '.join(f'`{m["name"]}`' for m in priv) + '*')
        w('')
    if e.get('events'):
        w('**События** (`EventDispatcher`): ' + ', '.join(f'`{ev}`' for ev in e['events']))
        w('')
    if e.get('fields'):
        fs = [f['name'] for f in e['fields'] if not f['name'].startswith('_')]
        if fs:
            w('*Публичные поля классов (class fields):* ' + ', '.join(f'`{f}`' for f in fs))
            w('')

def render_function(e):
    name = e['name']
    ps = sig_params(e)
    w(f'### {name}({ps})')
    w('')
    if e.get('line'):
        w(f'*строка {e["line"]}*')
        w('')
    jd = e.get('jsdoc')
    if jd and '@param' in jd:
        w('```')
        for l in jd.split('\n'):
            l = l.rstrip()
            if l.strip('-= \t*'):
                w(l)
        w('```')
        w('')
    else:
        desc = MANUAL.get(name) or clean_desc(jd, 400)
        if desc:
            w(desc)
            w('')

def render_value_group(items, title):
    w(f'#### {title}')
    w('')
    w('| Имя | Значение / состав | Описание |')
    w('|---|---|---|')
    for e in items:
        name = f'`{e["name"]}`'
        if e['kind'] == 'literal':
            val = f'`{json.dumps(e.get("value"), ensure_ascii=False)}`'
        elif e['kind'] == 'object':
            keys = e.get('keys') or []
            val = ('ключи: ' + ', '.join(f'`{k}`' for k in keys[:14]) + ('…' if len(keys) > 14 else '')) if keys else 'объект'
        elif e['kind'] == 'array':
            items_s = ', '.join((i[:24] + '…') if len(i) > 25 else i for i in (e.get('items') or [])[:10])
            val = f'`[{items_s}]`'
        elif e['kind'] == 'glsl':
            val = f'GLSL, ~{e.get("bytes", 0)//1024 or 1} КБ'
        else:
            ex = (e.get('expr') or '').replace('\n', ' ')
            val = f'`{ex[:60]}{"…" if len(ex) > 60 else ""}`'
        desc = md_escape(clean_desc(e.get('jsdoc'), 160)) or '—'
        w(f'| {name} | {md_escape(val)} | {desc} |')
    w('')

for g in GROUP_ORDER:
    w(f'## {cap(g)}')
    w('')
    sec = sections.get(part_of(g))
    if sec and sec.get('text'):
        intro = clean_desc(sec['text'], 700)
        if intro:
            w(f'> {intro}')
            w('')
    es = by_group[g]
    # подгруппы
    subs = []
    for e in es:
        sg = e.get('subgroup') or ''
        if not subs or subs[-1][0] != sg:
            subs.append((sg, []))
        subs[-1][1].append(e)
    for sg, items in subs:
        if sg:
            w(f'*{sg}*')
            w('')
        classes = [i for i in items if i['kind'] == 'class']
        funcs = [i for i in items if i['kind'] == 'function']
        others = [i for i in items if i['kind'] not in ('class', 'function')]
        for c in classes:
            render_class(c)
        for f in funcs:
            render_function(f)
        if others:
            glsl = [i for i in others if i['kind'] == 'glsl']
            vals = [i for i in others if i['kind'] != 'glsl']
            if vals:
                render_value_group(vals, 'Константы и пресеты')
            if glsl:
                render_value_group(glsl, 'GLSL-чанки (шейдерный код)')
    w('---')
    w('')

w('*Документ сгенерирован из AST исходного файла (acorn) + JSDoc/баннеры оригинала;')
w('описания опций конструкторов извлечены из комментариев к ко v2.6.0.*')

open(OUT, 'w', encoding='utf-8').write('\n'.join(out) + '\n')
print(f'written {OUT}: {len(out)} blocks, {sum(len(x) for x in out)//1024} KB')
