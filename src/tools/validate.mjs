import * as acorn from 'acorn';
import fs from 'fs';

const [a, b] = [process.argv[2], process.argv[3]];
const srcA = fs.readFileSync(a, 'utf8');
const srcB = fs.readFileSync(b, 'utf8');

// 1. parse both
const astA = acorn.parse(srcA, { ecmaVersion: 2022, sourceType: 'module' });
const astB = acorn.parse(srcB, { ecmaVersion: 2022, sourceType: 'module' });
console.log('parse: OK both');

// 2. token stream compare (comments excluded by tokenizer)
function tokens(src) {
  const out = [];
  for (const t of acorn.tokenizer(src, { ecmaVersion: 2022, sourceType: 'module' })) {
    out.push(t.type.label + ':' + (typeof t.value === 'string' ? JSON.stringify(t.value) : String(t.value)));
  }
  return out;
}
const tA = tokens(srcA), tB = tokens(srcB);
console.log('tokens:', tA.length, 'vs', tB.length);
let diff = -1;
for (let i = 0; i < Math.max(tA.length, tB.length); i++) {
  if (tA[i] !== tB[i]) { diff = i; break; }
}
if (diff >= 0) {
  console.log('TOKEN DIFF at', diff);
  console.log('  A:', tA.slice(Math.max(0, diff - 3), diff + 3));
  console.log('  B:', tB.slice(Math.max(0, diff - 3), diff + 3));
  process.exit(1);
}
console.log('token streams: IDENTICAL ✓');

// 3. export lists compare
function exportNames(ast) {
  const names = [];
  for (const n of ast.body) if (n.type === 'ExportNamedDeclaration') for (const s of n.specifiers) names.push(s.local.name + '->' + s.exported.name);
  return names;
}
const eA = exportNames(astA), eB = exportNames(astB);
console.log('exports:', eA.length, 'vs', eB.length, eA.join() === eB.join() ? 'IDENTICAL ✓' : 'DIFFER ✗');
if (eA.join() !== eB.join()) process.exit(1);

// 4. GLSL integrity: compare all template literal raw sources via token values (covered by #2)
console.log('bytes:', srcA.length, '->', srcB.length, `(-${(100 - srcB.length / srcA.length * 100).toFixed(1)}%)`);
console.log('lines:', srcA.split('\n').length, '->', srcB.split('\n').length);
