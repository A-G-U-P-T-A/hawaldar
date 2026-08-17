/**
 * Restore the Electron binary after electron-builder.
 * Packaged `npm run dist` often leaves node_modules/electron without path.txt / dist,
 * which makes electron-vite throw "Error: Electron uninstall".
 */
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electronDir = path.join(appRoot, 'node_modules', 'electron');
const pathTxt = path.join(electronDir, 'path.txt');
const installJs = path.join(electronDir, 'install.js');

function binaryOk() {
	if (!existsSync(pathTxt)) {
		return false;
	}
	const rel = readFileSync(pathTxt, 'utf8').trim();
	if (!rel) {
		return false;
	}
	const abs = path.isAbsolute(rel) ? rel : path.join(electronDir, 'dist', rel);
	return existsSync(abs);
}

if (!existsSync(electronDir) || !existsSync(installJs)) {
	// Production / packaged installs do not ship the electron devDependency.
	process.exit(0);
}

if (binaryOk()) {
	process.exit(0);
}

console.log('[hawaldar] Electron binary missing (common after electron-builder). Downloading…');
const result = spawnSync(process.execPath, [installJs], {
	cwd: appRoot,
	stdio: 'inherit',
	env: process.env,
});
if ((result.status ?? 1) !== 0 || !binaryOk()) {
	console.error('[hawaldar] Failed to restore Electron. Run: npm i electron --save-dev');
	process.exit(result.status || 1);
}
