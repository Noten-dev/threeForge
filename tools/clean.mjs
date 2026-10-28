import * as acorn from 'acorn';
import fs from 'fs';

const inFile = process.argv[2];
const outFile = process.argv[3];
if (!inFile || !outFile) { console.error('usage: node clean.mjs <in.js> <out.js>'); process.exit(1); }

const src = fs.readFileSync(inFile, 'utf8');
const comments = [];
acorn.parse(src, {
  ecmaVersion: 2022, sourceType: 'module',
  onComment: (block, text, start, end) => comments.push({ block, text, start, end })
});

const isJsdoc = c => c.block && c.text.startsWith('*');

// диапазоны на удаление
const ranges = [];
let removedWhole = 0, removedTrail = 0;
for (const c of comments) {
  if (isJsdoc(c)) continue;
  const lineStart = src.lastIndexOf('\n', c.start - 1) + 1;
  const prefixWs = /^\s*$/.test(src.slice(lineStart, c.start));
  let nl = src.indexOf('\n', c.end);
  const tail = nl === -1 ? src.slice(c.end) : src.slice(c.end, nl);
  const suffixWs = /^\s*$/.test(tail);
  let s = c.start, e = c.end;
  if (prefixWs && suffixWs) {
    // комментарий занимает целые строки — удаляем строки целиком
    s = lineStart;
    e = nl === -1 ? src.length : nl + 1;
    removedWhole++;
  } else if (!prefixWs) {
    // хвостовой комментарий — съедаем пробелы перед ним
    while (s > lineStart && (src[s - 1] === ' ' || src[s - 1] === '\t')) s--;
    removedTrail++;
  } else {
    // /* блок */ в начале строки, дальше код — съедаем пробелы после
    while (e < src.length && (src[e] === ' ' || src[e] === '\t')) e++;
    removedTrail++;
  }
  ranges.push([s, e]);
}
ranges.sort((a, b) => a[0] - b[0]);
// проверка на пересечения
for (let i = 1; i < ranges.length; i++) {
  if (ranges[i][0] < ranges[i - 1][1]) { console.error('OVERLAP', ranges[i - 1], ranges[i]); process.exit(2); }
}

let out = '';
let pos = 0;
for (const [s, e] of ranges) {
  out += src.slice(pos, s);
  pos = e;
}
out += src.slice(pos);

// схлопываем 3+ пустых строк до одной
out = out.replace(/\n{3,}/g, '\n\n');
// убираем пробелы на пустых строках
out = out.replace(/^[ \t]+$/gm, '');

const header = `/**
 * ThreeForge Engine v2.6.0 — единый ESM-модуль для three.js r186 (без внешних зависимостей).
 *
 * Документация:
 *   API.md       — справочник (167 экспортов: 35 классов, 37 функций, GLSL-чанки, пресеты);
 *   QUICKSTART.md — подключение и рабочие примеры интеграции;
 *   CHANGELOG.md — история исправлений (метки T/F/R/S/L/N/M).
 *
 * Все системы опциональны. Игровой цикл — Engine (fixed timestep); системы
 * подключаются через engine.addSystem({ fixedUpdate?(h), update?(dt, alpha) }, priority).
 * Крупные сборки «одним вызовом»: createTerrainSystem, createSkySystem, createLightRig.
 * Постобработка: PostPipeline.attach(engine) (устанавливает engine.renderOverride).
 */
`;
out = header + out.replace(/^\s*\n/, '');
if (!out.endsWith('\n')) out += '\n';

fs.writeFileSync(outFile, out);
console.log(`removed comments: ${removedWhole} whole-line, ${removedTrail} trailing; kept JSDoc: ${comments.filter(isJsdoc).length}`);
console.log(`in:  ${src.length} bytes, ${src.split('\n').length} lines`);
console.log(`out: ${out.length} bytes, ${out.split('\n').length} lines`);
