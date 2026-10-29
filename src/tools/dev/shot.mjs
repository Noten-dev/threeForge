/**
 * Headless-скриншот демо sword-field (для визуальной проверки фиксов).
 * Запуск: node src/tools/dev/shot.mjs <cam:wide|close> <out.png> [доп. query без &]
 * Ожидает сервер на 127.0.0.1:8123 (node src/tools/dev/serve.mjs).
 */
import { chromium } from 'playwright-core';

const cam = process.argv[2] || 'wide';
const out = process.argv[3] || `shots/${cam}.png`;
const extra = process.argv[4] ? '&' + process.argv[4] : '';

const browser = await chromium.launch({
	args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--no-sandbox']
});
const page = await browser.newPage({ viewport: { width: 1280, height: 420 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));

const url = `http://127.0.0.1:8123/examples/sword-field.html?shot=1&cam=${cam}${extra}`;
await page.goto(url, { waitUntil: 'load', timeout: 60000 });
try {
	await page.waitForFunction('window.__ready === true', null, { timeout: 240000 });
} catch (e) {
	const st = await page.evaluate('window.__dbg ? window.__dbg.world.streamer.stats : "no dbg"').catch(() => 'n/a');
	console.error('READY TIMEOUT; stats:', JSON.stringify(st), '; console:', errors.slice(0, 8).join('\n'));
	await page.evaluate('window.__dbg && window.__dbg.engine.stop()').catch(() => {});
	await page.waitForTimeout(1200);
	await page.screenshot({ path: out, timeout: 120000 });
	await browser.close();
	process.exit(3);
}
await page.waitForTimeout(600);
// замораживаем кадр: SwiftShader медленный, композитор должен успеть отдать поверхность
await page.evaluate('window.__dbg.engine.stop()').catch(() => {});
await page.waitForTimeout(1200);
await page.screenshot({ path: out, timeout: 120000 });
console.log('shot saved:', out, errors.length ? '| console errors: ' + errors.slice(0, 6).join(' | ') : '| no console errors');
await browser.close();
