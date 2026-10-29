#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Извлекает шапку-комментарий оригинала и конвертирует в CHANGELOG.md."""
import re, sys

src_file = sys.argv[1] if len(sys.argv) > 1 else 'uploads/threeforge-v2_6_0.js'
out_file = sys.argv[2] if len(sys.argv) > 2 else 'threeforge/CHANGELOG.md'
src = open(src_file, encoding='utf-8').read()

m = re.match(r'/\*(.*?)\*/', src, re.S)
assert m, 'header comment not found'
text = m.group(1)
lines = [re.sub(r'^\s*', '', l).rstrip() for l in text.split('\n')]
lines = [re.sub(r'^\*+\s?', '', l) for l in lines]

out = ['# ThreeForge Engine — CHANGELOG', '',
       '> История изменений, извлечённая из шапки исходного модуля v2.6.0.',
       '> Метки (**T**/**F**/**R**/**S**/**L**/**N**/**M**) встречаются в комментариях кода — по ним можно найти место фикса.',
       '']
sep_count = 0
i = 0
skip_composition = False
while i < len(lines):
    l = lines[i]
    if re.match(r'^[-=]{10,}$', l.strip()):
        i += 1
        continue
    vm = re.match(r'^(v\d+(?:\.\d+)*)\s*—\s*(.*)$', l.strip())
    if vm:
        out.append('')
        out.append(f'## {vm.group(1)} — {vm.group(2)}')
        out.append('')
        i += 1
        continue
    tm = re.match(r'^([TFRSLNM]\d+[a-z]?)\s+(.*)$', l.strip())
    if tm:
        out.append(f'- **{tm.group(1)}** {tm.group(2)}')
        i += 1
        # continuation lines (indented in original, start with lowercase/«) append
        while i < len(lines) and lines[i].strip() and not re.match(r'^([TFRSLNM]\d+[a-z]?)\s', lines[i].strip()) \
                and not re.match(r'^(v\d+)', lines[i].strip()) and not re.match(r'^[-=]{10,}$', lines[i].strip()) \
                and not re.match(r'^\d+\.\d+\s', lines[i].strip()) and not lines[i].strip().startswith('Тесты:'):
            out[-1] += ' ' + lines[i].strip()
            i += 1
        continue
    sm = re.match(r'^(\d+\.\d+)\s+(.*)$', l.strip())
    if sm and (not out or not out[-1].startswith('#')):
        out.append(f'- **{sm.group(1)}** {sm.group(2)}')
        i += 1
        while i < len(lines) and lines[i].strip() and not re.match(r'^(\d+\.\d+\s|[TFRSLNM]\d|v\d+|[-=]{10,}|Тесты:)', lines[i].strip()):
            out[-1] += ' ' + lines[i].strip()
            i += 1
        continue
    if l.strip().startswith('Тесты:'):
        out.append(f'- *{l.strip()}*')
        i += 1
        continue
    if l.strip():
        out.append(l.strip())
    i += 1

# clean multiple blank lines
res, prev_blank = [], False
for l in out:
    blank = not l.strip()
    if blank and prev_blank:
        continue
    res.append(l)
    prev_blank = blank
open(out_file, 'w', encoding='utf-8').write('\n'.join(res) + '\n')
print(f'written {out_file}: {len(res)} lines')
