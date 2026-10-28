import * as acorn from 'acorn';
import fs from 'fs';

const file = process.argv[2] || 'uploads/threeforge-v2_6_0.js';
const src = fs.readFileSync(file, 'utf8');
const comments = [];
const ast = acorn.parse(src, { ecmaVersion: 2022, sourceType: 'module', locations: true,
  onComment: (block, text, start, end, sl, el) => comments.push({ block, text, start, end, sl, el }) });

// ---------- top-level declarations ----------
const topLevel = new Map();
for (const node of ast.body) {
  if (node.type === 'VariableDeclaration') {
    for (const d of node.declarations) if (d.id.type === 'Identifier') { d._stmtStart = node.start; topLevel.set(d.id.name, d); }
  } else if (node.type === 'FunctionDeclaration' && node.id) { node._stmtStart = node.start; topLevel.set(node.id.name, node); }
}

// ---------- jsdoc lookup (comment directly attached before pos) ----------
function jsdocFor(pos) {
  for (let i = comments.length - 1; i >= 0; i--) {
    const c = comments[i];
    if (c.end > pos) continue;
    if (c.start < pos - 8000) break;
    if (/^\s*$/.test(src.slice(c.end, pos))) {
      if (c.block) return cleanJsdoc(c.text);
      // line comment directly above: keep as desc too
      return c.text.trim();
    }
    break;
  }
  return null;
}
function cleanJsdoc(t) {
  return t.split('\n').map(l => l.replace(/^\s*\*+\/?/, '').replace(/^\s+/, '').trimEnd())
    .join('\n').replace(/^\s*\*\s*/, '').trim();
}

// ---------- constructor options extraction ----------
function descAbove(absPos) {
  const lineStart = src.lastIndexOf('\n', absPos) + 1;
  let idx = -1;
  for (let i = comments.length - 1; i >= 0; i--) {
    const c = comments[i];
    if (c.end > lineStart) continue;
    if (c.start < lineStart - 3000) break;
    if (/^\s*$/.test(src.slice(c.end, lineStart))) idx = i;
    break;
  }
  if (idx < 0) return null;
  // merge adjacent line-comment block upwards
  const chain = [comments[idx]];
  if (!comments[idx].block) {
    for (let i = idx - 1; i >= 0; i--) {
      const prev = comments[i];
      if (prev.block) break;
      if (/^\s*$/.test(src.slice(prev.end, chain[0].start))) chain.unshift(prev);
      else break;
    }
  }
  const text = chain.map(c => cleanJsdoc(c.text)).join(' ');
  const t = text.split('\n');
  return (t.length > 1 ? t.join(' ') : text).slice(0, 320).trim();
}
function extractOptions(ctorNode) {
  const body = src.slice(ctorNode.start, ctorNode.end);
  const opts = new Map(); // name -> {default, note}
  // destructured params: constructor({ a = 1, b })
  const p0 = ctorNode.params[0];
  if (p0 && p0.type === 'AssignmentPattern' && p0.left.type === 'ObjectPattern') {
    for (const pr of p0.left.properties) {
      if (pr.key.type === 'Identifier') {
        const dflt = pr.value ? src.slice(pr.value.start, pr.value.end) : undefined;
        opts.set(pr.key.name, { default: dflt });
      }
    }
  } else if (p0 && p0.type === 'ObjectPattern') {
    for (const pr of p0.properties) if (pr.key.type === 'Identifier') opts.set(pr.key.name, {});
  }
  const add = (name, dflt, at) => {
    if (!opts.has(name)) opts.set(name, { default: dflt, desc: at !== undefined ? descAbove(at) : null });
    else {
      const o = opts.get(name);
      if (dflt !== undefined && o.default === undefined) o.default = dflt;
      if (!o.desc && at !== undefined) o.desc = descAbove(at);
    }
  };
  for (const m of body.matchAll(/options\.(\w+)\s*!==\s*undefined\s*\?\s*options\.\w+\s*:\s*([^;)\n]+?)(?=\s*[;\n)])/g)) add(m[1], m[2].trim(), ctorNode.start + m.index);
  for (const m of body.matchAll(/options\.(\w+)\s*!==\s*undefined\s*\?\s*([^;)\n]+?)\s*:\s*options\.\w+/g)) add(m[1], m[2].trim(), ctorNode.start + m.index);
  for (const m of body.matchAll(/options\.(\w+)\s*(\|\||\?\?)\s*([^;)\n]+?)(?=\s*[;\n)])/g)) add(m[1], m[3].trim(), ctorNode.start + m.index);
  for (const m of body.matchAll(/options\.(\w+)\s*===\s*true/g)) add(m[1], 'false');
  for (const m of body.matchAll(/options\.(\w+)\s*!==\s*false/g)) add(m[1], 'true');
  for (const m of body.matchAll(/options\.(\w+)\s*===\s*false/g)) add(m[1], 'true');
  for (const m of body.matchAll(/options\.(\w+)\s*!==\s*true/g)) add(m[1], 'false');
  for (const m of body.matchAll(/\boptions\.(\w+)/g)) add(m[1], undefined, ctorNode.start + m.index);
  return [...opts.entries()].map(([name, v]) => ({ name, default: v.default ? v.default.replace(/[,;]+\s*$/, '').trim() : undefined, desc: v.desc }));
}

// ---------- class info ----------
function classInfo(decl) {
  const cls = decl.init;
  const superClass = cls.superClass ? src.slice(cls.superClass.start, cls.superClass.end) : null;
  const methods = [], fields = [];
  let ctor = null;
  for (const el of cls.body.body) {
    if (el.type === 'MethodDefinition') {
      const name = el.key.name ?? src.slice(el.key.start, el.key.end);
      const params = el.value.params.map(p => src.slice(p.start, p.end));
      const info = { name, kind: el.kind, static: el.static, async: el.value.async, params, jsdoc: jsdocFor(el.start) };
      if (el.kind === 'constructor') { ctor = { params, options: extractOptions(el.value), jsdoc: info.jsdoc }; }
      else methods.push(info);
    } else if (el.type === 'StaticBlock') { /* skip */
    } else if (el.type === 'PropertyDefinition') {
      fields.push({ name: el.key.name ?? src.slice(el.key.start, el.key.end), static: el.static });
    }
  }
  const bodySrc = src.slice(cls.start, cls.end);
  const events = [...new Set([...bodySrc.matchAll(/dispatchEvent\(\s*\{\s*type:\s*['"`]([^'"`]+)['"`]/g)].map(m => m[1]))];
  return { kind: 'class', superClass, ctor, methods, fields, events, jsdoc: jsdocFor(decl._stmtStart ?? decl.start) };
}

// ---------- const / function info ----------
function constInfo(decl) {
  const v = decl.init;
  if (!v) return { kind: 'const' };
  if (v.type === 'ClassExpression') return classInfo(decl);
  if (v.type === 'ArrowFunctionExpression' || v.type === 'FunctionExpression')
    return { kind: 'function', params: v.params.map(p => src.slice(p.start, p.end)), jsdoc: jsdocFor(decl._stmtStart ?? decl.start) };
  if (v.type === 'TemplateLiteral') {
    const raw = src.slice(v.start, v.end);
    return { kind: 'glsl', jsdoc: jsdocFor(decl._stmtStart ?? decl.start), bytes: raw.length, head: raw.slice(1, 80).replace(/\n/g, ' ') };
  }
  if (v.type === 'ObjectExpression') {
    const keys = v.properties.filter(p => p.key).map(p => p.key.name ?? src.slice(p.key.start, p.key.end));
    return { kind: 'object', keys, jsdoc: jsdocFor(decl._stmtStart ?? decl.start) };
  }
  if (v.type === 'ArrayExpression') return { kind: 'array', items: v.elements.map(e => e ? src.slice(e.start, e.end) : 'null').slice(0, 40), jsdoc: jsdocFor(decl.start) };
  if (v.type === 'Literal') return { kind: 'literal', value: v.value, jsdoc: jsdocFor(decl._stmtStart ?? decl.start) };
  return { kind: 'expr', expr: src.slice(v.start, Math.min(v.end, v.start + 120)), jsdoc: jsdocFor(decl._stmtStart ?? decl.start) };
}

// ---------- export groups ----------
const exportNode = ast.body.find(n => n.type === 'ExportNamedDeclaration' && n.specifiers.length);
const items = [
  ...comments.filter(c => c.start >= exportNode.start && c.end <= exportNode.end).map(c => ({ kind: 'c', pos: c.start, text: c.text })),
  ...exportNode.specifiers.map(s => ({ kind: 's', pos: s.start, name: s.local.name }))
].sort((a, b) => a.pos - b.pos);
let group = '', subgroup = '';
const exportsList = [];
for (const it of items) {
  if (it.kind === 'c') {
    const m = it.text.match(/-{2,}\s*(.*?)\s*-{2,}/);
    if (m) { group = m[1]; subgroup = ''; }
    else { const t = it.text.replace(/^\/?\s*/, '').trim(); if (t) subgroup = t; }
  } else exportsList.push({ name: it.name, group, subgroup });
}

// ---------- description fallback (banner anywhere mentioning "Name — ...") ----------
function findDesc(name, nearLine) {
  let best = null, bestDist = 1e9;
  for (const c of comments) {
    for (const rawLine of c.text.split('\n')) {
      const line = rawLine.replace(/^[\s\-=*\/]+/, '');
      if (line.startsWith(name + ' —') || line.startsWith(name + ' –') || line.startsWith(name + ' -')) {
        const cLine = (c.sl && c.sl.line) || c.sl;
        const dist = nearLine ? Math.abs(cLine - nearLine) : 0;
        if (dist < bestDist) { bestDist = dist; best = cleanJsdoc(c.text); }
        break;
      }
    }
  }
  return best ? best.slice(0, 800) : null;
}

// ---------- section banners ----------
const sections = [];
for (const c of comments) {
  const m = c.text.match(/ThreeForge Engine — часть ([\d.]+):([^\n]*)/);
  if (m && c.block) sections.push({ part: m[1], title: m[2].trim(), line: c.sl.line ?? c.sl, text: cleanJsdoc(c.text).slice(0, 900) });
}

// ---------- build ----------
const out = [];
for (const e of exportsList) {
  const decl = topLevel.get(e.name);
  const info = decl
    ? (decl.type === 'FunctionDeclaration'
        ? { kind: 'function', params: decl.params.map(p => src.slice(p.start, p.end)), jsdoc: jsdocFor(decl._stmtStart ?? decl.start) }
        : constInfo(decl))
    : { kind: 'unknown' };
  const line = decl?.loc?.start?.line ?? null;
  if ((info.kind === 'class' || info.kind === 'function') && !info.jsdoc) info.jsdoc = findDesc(e.name, line);
  out.push({ ...e, ...info, line });
}
const result = { sections, exports: out };
fs.writeFileSync(process.argv[3] || 'structure.json', JSON.stringify(result, null, 1));

// summary
const byKind = {};
for (const x of result.exports) byKind[x.kind] = (byKind[x.kind] || 0) + 1;
console.log('exports:', result.exports.length, JSON.stringify(byKind));
console.log('groups:', [...new Set(result.exports.map(x => x.group))].join(' | '));
console.log('section banners found:', sections.length);
const cls = result.exports.filter(x => x.kind === 'class');
console.log('classes:', cls.length);
let methods = 0, opts = 0;
for (const c of cls) { methods += c.methods.length; opts += c.ctor?.options?.length ?? 0; }
console.log('methods total:', methods, 'ctor options total:', opts);
console.log('unknown exports:', result.exports.filter(x => x.kind === 'unknown').map(x => x.name).join(', ') || '(none)');
