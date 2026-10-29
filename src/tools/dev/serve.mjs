/**
 * Мини-статик-сервер для демо threeForge (live preview).
 * Запуск: node tools/dev/serve.mjs [port]   (PORT=... тоже уважается)
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Корень репозитория: serve.mjs лежит в <root>/src/tools/dev (или <root>/tools/dev).
// Поднимаемся на два уровня и, если попали в src/ (новая раскладка), ещё на один.
let root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
if (path.basename(root) === 'src') root = path.resolve(root, '..');
const port = Number(process.argv[2] || process.env.PORT || 8123);

const MIME = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
	'.wasm': 'application/wasm', '.ico': 'image/x-icon'
};

const server = http.createServer((req, res) => {
	let urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
	if (urlPath === '/') urlPath = '/examples/sword-field.html';
	const file = path.join(root, path.normalize(urlPath));
	if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
	fs.readFile(file, (err, data) => {
		if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('404 ' + urlPath); return; }
		res.writeHead(200, {
			'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
			'Cache-Control': 'no-store'
		});
		res.end(data);
	});
});
server.listen(port, '0.0.0.0', () => console.log('serve: http://0.0.0.0:' + port + '/ (root ' + root + ')'));
