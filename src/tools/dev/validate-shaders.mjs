/**
 * Валидация GLSL теневых шейдеров ThreeForge через glslangValidator (ESSL 3.00).
 *
 * Сборка: onBeforeCompile-патчи движка → ассемблер (glslassm.mjs) → glslang.
 * Матрица комбинаций: тип карты теней × число каскадов × тиры тапов × soft ×
 * состав источников (sun/dir/spot/point).
 *
 * Запуск: npm run shaders   (или node tools/dev/validate-shaders.mjs)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GLSLANG_URL = 'https://github.com/KhronosGroup/glslang/releases/download/16.6.0/glslang-16.6.0-linux-x86_64-release.tar.gz';

/** Резолв бинаря glslang: GLSLANG_PATH → tools/dev/bin/glslang → автозагрузка. */
async function resolveGlslang() {
	if (process.env.GLSLANG_PATH && fs.existsSync(process.env.GLSLANG_PATH)) return process.env.GLSLANG_PATH;
	const local = path.join(__dirname, 'bin', process.platform === 'win32' ? 'glslang.exe' : 'glslang');
	if (fs.existsSync(local)) return local;
	if (process.platform !== 'linux' || process.arch !== 'x64') {
		throw new Error('glslang не найден: установите GLSLANG_PATH на бинарь glslangValidator 15+ '
			+ '(npm-пакет glslang-validator-prebuilt не годится — глючный ESSL300-билд, ложные ошибки на three r186)');
	}
	console.log('glslang не найден — скачиваю 16.6.0 в tools/dev/bin/ …');
	const res = await fetch(GLSLANG_URL);
	if (!res.ok) throw new Error('не удалось скачать glslang: HTTP ' + res.status);
	const tgz = path.join(os.tmpdir(), 'glslang16.tar.gz');
	fs.writeFileSync(tgz, Buffer.from(await res.arrayBuffer()));
	fs.mkdirSync(path.dirname(local), { recursive: true });
	execFileSync('tar', ['-xzf', tgz, '-C', path.dirname(local), '--strip-components=2',
		'glslang-16.6.0-linux-x86_64/bin/glslang'], { stdio: 'pipe' });
	fs.chmodSync(local, 0o755);
	return local;
}
const glslangPath = await resolveGlslang();

import { assembleFragment, rawLibFragment, SHADOWMAP_TYPE_DEFINES } from './glslassm.mjs';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-glsl-'));
let failures = 0;
let passed = 0;

export function validateFragment(label, glsl) {
	const file = path.join(tmpDir, label.replace(/[^\w.-]/g, '_') + '.frag');
	fs.writeFileSync(file, glsl);
	try {
		execFileSync(glslangPath, [file], { stdio: 'pipe' });
		passed++;
		return true;
	} catch (e) {
		failures++;
		console.error('✗ ' + label);
		const out = String(e.stdout || '') + String(e.stderr || '');
		console.error(out.split('\n').slice(0, 14).map(l => '    ' + l).join('\n'));
		return false;
	}
}

// ------------------------------------------------------------------ драйвер
async function main() {
	const TF = await import('../../src/threeforge-v2_6_0.js');
	const THREE = await import('three');

	// 0. Sanity: чистый physical-шейдер three с тенями (без патчей движка)
	for (const [type, def] of Object.entries(SHADOWMAP_TYPE_DEFINES)) {
		const glsl = assembleFragment(rawLibFragment('physical'),
			{ numSunLights: 1, numSunLightShadows: 1, numDirLights: 1, numDirLightShadows: 1,
				numSpotLights: 1, numSpotLights1Shadows: 0, numSpotLightShadows: 1, numSpotLightMaps: 0,
				numSpotLightShadowsWithMaps: 0, numPointLights: 1, numPointLightShadows: 1,
				numHemiLights: 0, numRectAreaLights: 0 },
			['USE_SHADOWMAP', def]);
		validateFragment('sanity-three-' + type, glsl);
	}

	// 1. Текущий патч движка (installSunShadowPatch) — базовая линия
	const combos = [];
	const cascadeCounts = TF.getSunCascadeCount !== undefined ? [2, 3, 4] : [2];
	const tiers = TF.getShadowQuality !== undefined
		? [{ taps: 4, soft: false }, { taps: 12, soft: false }, { taps: 16, soft: true }, { taps: 24, soft: true }]
		: [{ taps: 12, soft: false }];
	for (const n of cascadeCounts) {
		for (const tier of tiers) {
			for (const type of ['pcf', 'vsm', 'basic']) {
				combos.push({ n, tier, type, sun: 1, dir: 1, spot: 0, point: 0, fadeAll: true });
			}
		}
	}
	// крайние составы: без солнца (фейд для dir/spot/point), всё вместе
	if (TF.getSunCascadeCount !== undefined) {
		combos.push({ n: 2, tier: { taps: 12, soft: false }, type: 'pcf', sun: 0, dir: 1, spot: 1, point: 1, fadeAll: true });
		combos.push({ n: 2, tier: { taps: 12, soft: false }, type: 'vsm', sun: 0, dir: 1, spot: 1, point: 1, fadeAll: true });
		combos.push({ n: 2, tier: { taps: 12, soft: false }, type: 'basic', sun: 0, dir: 1, spot: 1, point: 1, fadeAll: true });
		combos.push({ n: 2, tier: { taps: 12, soft: false }, type: 'pcf', sun: 0, dir: 1, spot: 0, point: 1, fadeAll: false });
		combos.push({ n: 4, tier: { taps: 32, soft: true }, type: 'pcf', sun: 1, dir: 1, spot: 1, point: 1, fadeAll: true });
		combos.push({ n: 3, tier: { taps: 8, soft: true }, type: 'pcf', sun: 1, dir: 0, spot: 0, point: 0, fadeAll: true });
	}

	for (const c of combos) {
		if (TF.setSunCascadeCount !== undefined) TF.setSunCascadeCount(c.n);
		if (TF.setShadowQuality !== undefined) TF.setShadowQuality({
			taps: c.tier.taps, soft: c.tier.soft, fadeAllLights: c.fadeAll
		});
		const material = new THREE.MeshStandardMaterial();
		TF.installSunShadowPatch(material);
		const shader = { uniforms: {}, fragmentShader: rawLibFragment('physical'), vertexShader: '' };
		material.onBeforeCompile(shader, null);

		const nums = {
			numSunLights: c.sun, numSunLightShadows: c.sun,
			numDirLights: c.dir, numDirLightShadows: c.dir,
			numSpotLights: c.spot, numSpotLightShadows: c.spot, numSpotLightMaps: 0,
			numSpotLightShadowsWithMaps: 0,
			numPointLights: c.point, numPointLightShadows: c.point,
			numHemiLights: 0, numRectAreaLights: 0
		};
		const glsl = assembleFragment(shader.fragmentShader, nums,
			['USE_SHADOWMAP', SHADOWMAP_TYPE_DEFINES[c.type]]);
		const label = `tf-n${c.n}-t${c.tier.taps}${c.tier.soft ? '-soft' : ''}-${c.type}-s${c.sun}d${c.dir}p${c.spot}q${c.point}${c.fadeAll ? '' : '-nofade'}`;
		validateFragment(label, glsl);
	}

	// 2. Совместимость с туманом + дизером + terrain detail (цепочка патчей)
	if (TF.setSunCascadeCount !== undefined) TF.setSunCascadeCount(2);
	{
		const material = new THREE.MeshStandardMaterial({ fog: true });
		const fog = new TF.FogManager({});
		TF.installSunShadowPatch(material);
		TF.installFogPatch(material, fog);
		TF.installDitherLODPatch(material);
		const shader = { uniforms: {}, fragmentShader: rawLibFragment('physical'),
			vertexShader: THREE.ShaderLib.physical.vertexShader };
		material.onBeforeCompile(shader, null);
		const glsl = assembleFragment(shader.fragmentShader,
			{ numSunLights: 1, numSunLightShadows: 1, numDirLights: 0, numDirLightShadows: 0,
				numSpotLights: 0, numSpotLightShadows: 0, numSpotLightMaps: 0, numSpotLightShadowsWithMaps: 0,
				numPointLights: 0, numPointLightShadows: 0, numHemiLights: 0, numRectAreaLights: 0 },
			['USE_SHADOWMAP', SHADOWMAP_TYPE_DEFINES.pcf, 'USE_FOG', 'FOG_LINEAR']);
		validateFragment('tf-chain-fog-dither', glsl);
	}

	// 3. v2.8 Gameplay Kit: stylized-материалы (rim) и final-пасс с grade
	{
		// toon + rim + туман + CSM-тени солнца (цепочка патчей v2.7+v2.8)
		const toon = TF.createStylizedMaterial({ color: 0x8899bb, steps: 3, rim: 0.4 });
		TF.installSunShadowPatch(toon);
		TF.installFogPatch(toon, new TF.FogManager({}));
		const shT = { uniforms: {}, fragmentShader: THREE.ShaderLib.toon.fragmentShader, vertexShader: THREE.ShaderLib.toon.vertexShader };
		toon.onBeforeCompile(shT, null);
		validateFragment('tf-stylized-toon-rim-fog-csm', assembleFragment(shT.fragmentShader,
			{ numSunLights: 1, numSunLightShadows: 1, numDirLights: 1, numDirLightShadows: 0,
				numSpotLights: 0, numSpotLightShadows: 0, numSpotLightMaps: 0,
				numSpotLightShadowsWithMaps: 0,
				numPointLights: 0, numPointLightShadows: 0, numHemiLights: 1, numRectAreaLights: 0 },
			['USE_SHADOWMAP', SHADOWMAP_TYPE_DEFINES.pcf, 'USE_FOG', 'FOG_LINEAR']));

		// rim-патч на standard-материале (PBR-путь)
		const std = new THREE.MeshStandardMaterial();
		TF.installStylizedPatch(std, { rim: 0.3, rimPower: 3.2 });
		const shS = { uniforms: {}, fragmentShader: THREE.ShaderLib.physical.fragmentShader, vertexShader: '' };
		std.onBeforeCompile(shS, null);
		validateFragment('tf-stylized-standard-rim', assembleFragment(shS.fragmentShader,
			{ numSunLights: 0, numSunLightShadows: 0, numDirLights: 1, numDirLightShadows: 0,
				numSpotLights: 0, numSpotLightShadows: 0, numSpotLightMaps: 0,
				numSpotLightShadowsWithMaps: 0,
				numPointLights: 0, numPointLightShadows: 0, numHemiLights: 0, numRectAreaLights: 0 },
			[]));

		// final-пасс с grade-униформами (виньетка/насыщенность/тон)
		validateFragment('tf-final-grade', assembleFragment(TF.TF_FINAL_FRAG,
			{ numSunLights: 0, numSunLightShadows: 0, numDirLights: 0, numDirLightShadows: 0,
				numSpotLights: 0, numSpotLightShadows: 0, numSpotLightMaps: 0,
				numSpotLightShadowsWithMaps: 0,
				numPointLights: 0, numPointLightShadows: 0, numHemiLights: 0, numRectAreaLights: 0 },
			[]));
	}

	console.log(`\nGLSL validation: ${passed} passed, ${failures} failed`);
	if (failures > 0) process.exit(1);
	console.log('✓ все шейдеры компилируются');
}

main().catch((e) => { console.error(e); process.exit(1); });
