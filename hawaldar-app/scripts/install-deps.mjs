/**
 * Install hawaldar-app deps even when Windows locks node_modules/electron
 * (Cursor indexing default_app.asar, leftover electron.exe, etc.).
 * Used by setup.bat after npm ci/i when node_modules/.bin is still missing.
 */
import { existsSync, mkdirSync, cpSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const viteBin = path.join(appRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'electron-vite.cmd' : 'electron-vite');
const tscBin = path.join(appRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');

const installJs = path.join(appRoot, 'node_modules', 'electron', 'install.js');

function treeOk() {
	return existsSync(viteBin) && existsSync(tscBin) && existsSync(installJs);
}

function runNpm(args, cwd) {
	const cmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
	const result = spawnSync(cmd, args, {
		cwd,
		stdio: 'inherit',
		env: process.env,
	});
	return result.status ?? 1;
}

function copyTree(src, dest) {
	mkdirSync(dest, { recursive: true });
	cpSync(src, dest, {
		recursive: true,
		force: true,
		errorOnExist: false,
		filter(source) {
			// Skip the locked asar if a previous copy left it behind.
			return !source.endsWith(`${path.sep}default_app.asar`);
		},
	});
	// Best-effort copy of default_app.asar; ignore EBUSY.
	const asarSrc = path.join(src, 'electron', 'dist', 'resources', 'default_app.asar');
	const asarDest = path.join(dest, 'electron', 'dist', 'resources', 'default_app.asar');
	if (existsSync(asarSrc) && !existsSync(asarDest)) {
		try {
			cpSync(asarSrc, asarDest);
		} catch (err) {
			if (err && err.code !== 'EBUSY' && err.code !== 'EPERM') {
				throw err;
			}
			console.warn('[hawaldar] default_app.asar is locked; leaving the existing file in place.');
		}
	}
}

if (treeOk()) {
	process.exit(0);
}

console.log('[hawaldar] Installing into a temp folder, then copying around any locked Electron files…');
const tmp = path.join(os.tmpdir(), `hawaldar-npm-${process.pid}`);
rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });
cpSync(path.join(appRoot, 'package.json'), path.join(tmp, 'package.json'));
const lock = path.join(appRoot, 'package-lock.json');
if (existsSync(lock)) {
	cpSync(lock, path.join(tmp, 'package-lock.json'));
}

let status = existsSync(lock) ? runNpm(['ci'], tmp) : 1;
if (status !== 0) {
	console.log('[hawaldar] npm ci in temp failed, trying npm install…');
	status = runNpm(['install'], tmp);
}
if (status !== 0) {
	console.error('[hawaldar] Temp-folder npm install failed.');
	process.exit(status);
}

copyTree(path.join(tmp, 'node_modules'), path.join(appRoot, 'node_modules'));
rmSync(tmp, { recursive: true, force: true });

if (!treeOk()) {
	console.error('[hawaldar] Copy finished but electron-vite / tsc / electron install.js are still missing.');
	process.exit(1);
}
