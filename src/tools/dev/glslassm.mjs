/**
 * Мини-ассемблер шейдерных программ three.js r186 (реплика WebGLProgram).
 *
 * Собирает фрагментный шейдер встроенного материала (по умолчанию physical)
 * из ShaderLib: onBeforeCompile-патчи → resolveIncludes → replaceLightNums →
 * replaceClippingPlaneNums → unrollLoops → GLSL3-префикс. Результат можно
 * скормить glslangValidator — полноценная компиляция ESSL 3.00 без GPU.
 */
import * as THREE from 'three';

const { ShaderChunk } = THREE;

const includePattern = /^[ \t]*#include +<([\w\d./]+)>/gm;
export function resolveIncludes(src) {
	return src.replace(includePattern, (match, name) => {
		const chunk = ShaderChunk[name];
		if (chunk === undefined) throw new Error('ShaderChunk не найден: ' + name);
		return resolveIncludes(chunk);
	});
}

const unrollLoopPattern = /#pragma unroll_loop_start\s+for\s*\(\s*int\s+i\s*=\s*(\d+)\s*;\s*i\s*<\s*(\d+)\s*;\s*i\s*\+\+\s*\)\s*{([\s\S]+?)}\s+#pragma unroll_loop_end/g;
export function unrollLoops(src) {
	return src.replace(unrollLoopPattern, (match, start, end, snippet) => {
		let out = '';
		for (let i = parseInt(start, 10); i < parseInt(end, 10); i++) {
			out += snippet
				.replace(/\[\s*i\s*\]/g, '[ ' + i + ' ]')
				.replace(/UNROLLED_LOOP_INDEX/g, String(i));
		}
		return out;
	});
}

export function replaceLightNums(src, p) {
	const numSpotLightCoords = (p.numSpotLightShadows | 0) + (p.numSpotLightMaps | 0) - (p.numSpotLightShadowsWithMaps | 0);
	return src
		.replace(/NUM_SUN_LIGHTS/g, p.numSunLights | 0)
		.replace(/NUM_DIR_LIGHTS/g, p.numDirLights | 0)
		.replace(/NUM_SPOT_LIGHTS/g, p.numSpotLights | 0)
		.replace(/NUM_SPOT_LIGHT_MAPS/g, p.numSpotLightMaps | 0)
		.replace(/NUM_SPOT_LIGHT_COORDS/g, numSpotLightCoords)
		.replace(/NUM_RECT_AREA_LIGHTS/g, p.numRectAreaLights | 0)
		.replace(/NUM_POINT_LIGHTS/g, p.numPointLights | 0)
		.replace(/NUM_HEMI_LIGHTS/g, p.numHemiLights | 0)
		.replace(/NUM_SUN_LIGHT_SHADOWS/g, p.numSunLightShadows | 0)
		.replace(/NUM_DIR_LIGHT_SHADOWS/g, p.numDirLightShadows | 0)
		.replace(/NUM_SPOT_LIGHT_SHADOWS_WITH_MAPS/g, p.numSpotLightShadowsWithMaps | 0)
		.replace(/NUM_SPOT_LIGHT_SHADOWS/g, p.numSpotLightShadows | 0)
		.replace(/NUM_POINT_LIGHT_SHADOWS/g, p.numPointLightShadows | 0);
}

export function replaceClippingPlaneNums(src, p) {
	return src
		.replace(/NUM_CLIPPING_PLANES/g, p.numClippingPlanes | 0)
		.replace(/UNION_CLIPPING_PLANES/g, (p.numClippingPlanes | 0) - (p.numClipIntersection | 0));
}

/**
 * Префикс фрагментного шейдера: GLSL3-конверсия + precision + define'ы +
 * униформы, которые у three живут в префиксе (viewMatrix и пр.).
 * @param {string[]} defines Например ['USE_SHADOWMAP', 'SHADOWMAP_TYPE_PCF']
 */
export function fragmentPrefix(defines = []) {
	return [
		'#version 300 es',
		'#define varying in',
		'layout(location = 0) out highp vec4 pc_fragColor;',
		'#define gl_FragColor pc_fragColor',
		'#define gl_FragDepthEXT gl_FragDepth',
		'#define texture2D texture',
		'#define textureCube texture',
		'#define texture2DProj textureProj',
		'#define texture2DLodEXT textureLod',
		'#define texture2DProjLodEXT textureProjLod',
		'#define textureCubeLodEXT textureLod',
		'#define texture2DGradEXT textureGrad',
		'#define texture2DProjGradEXT textureProjGrad',
		'#define textureCubeGradEXT textureGrad',
		'precision highp float;',
		'precision highp int;',
		'precision highp sampler2D;',
		'precision highp sampler3D;',
		'precision highp samplerCube;',
		'precision highp sampler2DShadow;',
		'precision highp samplerCubeShadow;',
		'precision highp sampler2DArray;',
		...defines.map((d) => (d.trimStart().startsWith('#') || d.trim() === '') ? d : '#define ' + d),
		// three генерирует её в префиксе под outputColorSpace; для валидации — linear
		'vec4 linearToOutputTexel( vec4 value ) { return value; }',
		'uniform mat4 modelMatrix;',
		'uniform mat4 modelViewMatrix;',
		'uniform mat4 projectionMatrix;',
		'uniform mat4 viewMatrix;',
		'uniform mat3 normalMatrix;',
		'uniform vec3 cameraPosition;',
		'uniform bool isOrthographic;',
		''
	].join('\n');
}

export const SHADOWMAP_TYPE_DEFINES = {
	basic: 'SHADOWMAP_TYPE_BASIC',
	pcf: 'SHADOWMAP_TYPE_PCF',
	vsm: 'SHADOWMAP_TYPE_VSM'
};

/**
 * Собрать полный GLSL фрагментного шейдера из «сырого» источника материала
 * (с #include и #pragma — как после onBeforeCompile).
 *
 * @param {string} rawFragmentShader Исходник из shader.fragmentShader.
 * @param {object} lightNums Числа источников/теней (numSunLights, ...).
 * @param {string[]} defines Дополнительные define'ы префикса.
 * @param {string} [libName='physical'] Имя библиотеки шейдеров (для подстановки uniforms-заглушек не нужно, только источник).
 */
export function assembleFragment(rawFragmentShader, lightNums = {}, defines = [], libName = 'physical') {
	let src = rawFragmentShader;
	src = resolveIncludes(src);
	src = replaceLightNums(src, lightNums);
	src = replaceClippingPlaneNums(src, lightNums);
	src = unrollLoops(src);
	// Квирк glslang: `average` считается встроенным именем ESSL 3.00 (браузерный
	// ANGLE позволяет переопределение — three.js объявляет average() в common-чанке).
	// Переименовываем только для валидации; к коду движка отношения не имеет.
	src = src.replace(/\baverage\b/g, 'tfGlslAvg_');
	return fragmentPrefix(defines) + src;
}

/** «Сырой» фрагментный шейдер встроенной библиотеки three (до resolveIncludes). */
export function rawLibFragment(libName = 'physical') {
	return THREE.ShaderLib[libName].fragmentShader;
}
