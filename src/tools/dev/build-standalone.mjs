/**
 * Сборка ОДНОГО самодостаточного HTML: three r186 (core+module) + движок + демо
 * инлайнятся классическим <script> (без модулей/import map) — файл открывается
 * двойным кликом с диска (file://) или с любого статик-сервера.
 *
 * Запуск: npm run standalone   (node tools/dev/build-standalone.mjs)
 * Результат: examples/sword-field-standalone.html
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf-8');

// --------------------------------------------------------------- парсер export-блоков
function parseEntries(listSrc) {
	return listSrc.split(',').map(s => s.trim()).filter(Boolean).map(entry => {
		const m = entry.split(/\s+as\s+/);
		return m.length === 2 ? { local: m[0].trim(), exported: m[1].trim() } : { local: entry, exported: entry };
	});
}
function objLiteral(entries) {
	return entries.map(e => (e.local === e.exported ? e.local : `${e.exported}: ${e.local}`)).join(', ');
}
function stripTrailingExport(src, label) {
	const m = src.match(/export \{([\s\S]*?)\};\s*$/);
	if (m === null) throw new Error('standalone: не найден финальный export {' + label + '};');
	return { body: src.slice(0, m.index), entries: parseEntries(m[1]) };
}

// --------------------------------------------------------------- three: core + module
const coreSrc = read('node_modules/three/build/three.core.js');
if ((coreSrc.match(/^export /gm) || []).length !== 1) throw new Error('standalone: three.core.js — ожидался один export-блок');
const core = stripTrailingExport(coreSrc, ' core');

let modSrc = read('node_modules/three/build/three.module.js');
const impM = modSrc.match(/^import \{([\s\S]*?)\} from '\.\/three\.core\.js';$/m);
const rexM = modSrc.match(/^export \{([\s\S]*?)\} from '\.\/three\.core\.js';$/m);
if (impM === null || rexM === null) throw new Error('standalone: three.module.js — нет import/re-export из three.core.js');
modSrc = modSrc.replace(impM[0], '');
modSrc = modSrc.replace(rexM[0], '');
const reExports = parseEntries(rexM[1]);
const mod = stripTrailingExport(modSrc, ' module');
const importNames = parseEntries(impM[1]).map(e => (e.local === e.exported ? e.local : `${e.local}: ${e.exported}`)).join(', ');

// --------------------------------------------------------------- движок
let engSrc = read('src/threeforge-v2_6_0.js');
if ((engSrc.match(/^import /gm) || []).length !== 1 || (engSrc.match(/^export /gm) || []).length !== 1) {
	throw new Error('standalone: движок — ожидалось по одному import/export-блоку');
}
engSrc = engSrc.replace(/^import \* as THREE from 'three';$/m, '');
const eng = stripTrailingExport(engSrc, ' engine');

// --------------------------------------------------------------- демо (без import-строк)
const demoHtml = read('examples/sword-field.html');
const demoM = demoHtml.match(/<script type="module">([\s\S]*?)<\/script>/);
if (demoM === null) throw new Error('standalone: не найден module-скрипт демо');
const demoBody = demoM[1].split('\n').filter(l => !/^import /.test(l)).join('\n');
const styleM = demoHtml.match(/<style>([\s\S]*?)<\/style>/);
const noteM = demoHtml.match(/<div id="note">([\s\S]*?)<\/div>/);

// --------------------------------------------------------------- сборка
const reExportAssign = reExports.map(e => `${e.exported}: __core.${e.local}`).join(', ');
const bundle = `"use strict";
/* ThreeForge standalone bundle: three r186 (core+module) + threeForge v2.8 + демо.
 * Собрано tools/dev/build-standalone.mjs — не редактировать вручную. */
const THREE = (function () {
	const __core = (function () {
${core.body}
		return { ${objLiteral(core.entries)} };
	})();
	return (function (__core) {
		const { ${importNames} } = __core;
${mod.body}
		return Object.assign({ ${reExportAssign} }, { ${objLiteral(mod.entries)} });
	})(__core);
})();
const TF = (function (THREE) {
${eng.body}
	return { ${objLiteral(eng.entries)} };
})(THREE);
(function (THREE, TF) {
${demoBody}
})(THREE, TF);
`;

for (const bad of ['</script', '<!--']) {
	if (bundle.indexOf(bad) !== -1) throw new Error('standalone: в бандле найдена последовательность ' + bad);
}
parse(bundle, { ecmaVersion: 2022, sourceType: 'script' });

// headless-прогон библиотечной части (без демо): ловит ошибки трансформации
import('node:vm').then(({ runInNewContext }) => {
	const libOnly = bundle.slice(0, bundle.indexOf('(function (THREE, TF) {')) +
		'\nglobalThis.__TF = TF; globalThis.__THREE = THREE;\n';
	const sandbox = { console, performance, setTimeout, clearTimeout, URL, Blob, Worker: undefined };
	runInNewContext(libOnly, sandbox, { timeout: 60000 });
	const TF = sandbox.__TF, THREE = sandbox.__THREE;
	if (typeof TF.Engine !== 'function' || typeof TF.createSwordGeometry !== 'function') throw new Error('standalone: TF не собрался');
	if (typeof THREE.WebGLRenderer !== 'function' || THREE.REVISION === undefined) throw new Error('standalone: THREE не собрался');
	console.log('standalone: headless-прогон OK (THREE r' + THREE.REVISION + ', экспортов TF: ' + Object.keys(TF).length + ')');

	const html = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>threeForge v2.8 — «Поле мечей» (standalone, один файл)</title>
<style>${styleM !== null ? styleM[1] : ''}</style>
</head>
<body>
<div id="note">${noteM !== null ? noteM[1] : ''} · single-file сборка</div>
<script>
${bundle}
</script>
</body>
</html>
`;
	const out = path.join(root, 'examples/sword-field-standalone.html');
	fs.writeFileSync(out, html);
	console.log('standalone: записан ' + path.relative(root, out) + ' (' + (html.length / 1048576).toFixed(2) + ' МБ)');
}).catch(e => { console.error(e); process.exit(1); });
