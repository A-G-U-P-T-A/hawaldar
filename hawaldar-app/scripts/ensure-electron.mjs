/**
 * Restore the Electron binary after npm install or electron-builder.
 * Electron 43 does not download itself during npm; call this AFTER npm ci/i
 * finishes (not from postinstall, which races the electron extract on Windows).
 * Packaged `npm run dist` often leaves node_modules/electron without path.txt / dist,
 * which makes electron-vite throw "Error: Electron uninstall".
 */
import {
	existsSync,
	readFileSync,
	writeFileSync,
	cpSync,
	rmSync,
	mkdirSync,
	mkdtempSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electronDir = path.join(appRoot, 'node_modules', 'electron');
const pathTxt = path.join(electronDir, 'path.txt');
const installJs = path.join(electronDir, 'install.js');

function distBinary() {
	if (process.platform === 'win32') {
		return { abs: path.join(electronDir, 'dist', 'electron.exe'), rel: 'electron.exe' };
	}
	if (process.platform === 'darwin') {
		return {
			abs: path.join(electronDir, 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron'),
			rel: 'Electron.app/Contents/MacOS/Electron',
		};
	}
	return { abs: path.join(electronDir, 'dist', 'electron'), rel: 'electron' };
}

function ensurePathTxt(rel) {
	if (existsSync(pathTxt)) {
		return;
	}
	try {
		writeFileSync(pathTxt, rel, 'utf8');
	} catch (err) {
		if (!isLockError(err)) {
			throw err;
		}
	}
}

function binaryOk() {
	const { abs, rel } = distBinary();
	if (!existsSync(abs)) {
		return false;
	}
	ensurePathTxt(rel);
	if (!existsSync(pathTxt)) {
		return false;
	}
	const listed = readFileSync(pathTxt, 'utf8').trim();
	if (!listed) {
		return false;
	}
	const resolved = path.isAbsolute(listed) ? listed : path.join(electronDir, 'dist', listed);
	return existsSync(resolved);
}

function isLockError(err) {
	return err && (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES');
}

function copySkippingLockedAsar(src, dest) {
	mkdirSync(dest, { recursive: true });
	cpSync(src, dest, {
		recursive: true,
		force: true,
		filter(source) {
			return !source.endsWith(`${path.sep}default_app.asar`);
		},
	});
	const asarSrc = path.join(src, 'resources', 'default_app.asar');
	const asarDest = path.join(dest, 'resources', 'default_app.asar');
	if (existsSync(asarSrc) && !existsSync(asarDest)) {
		try {
			mkdirSync(path.dirname(asarDest), { recursive: true });
			cpSync(asarSrc, asarDest);
		} catch (err) {
			if (!isLockError(err)) {
				throw err;
			}
			console.warn('[hawaldar] default_app.asar is locked; leaving the existing file in place.');
		}
	}
}

function runInstall(script, cwd) {
	return spawnSync(process.execPath, [script], {
		cwd,
		stdio: 'inherit',
		env: {
			...process.env,
			NODE_PATH: path.join(appRoot, 'node_modules'),
		},
	});
}

function restoreViaTemp() {
	const tmp = mkdtempSync(path.join(os.tmpdir(), 'hawaldar-electron-'));
	try {
		const tmpElectron = path.join(tmp, 'electron');
		cpSync(electronDir, tmpElectron, {
			recursive: true,
			filter(source) {
				return !source.endsWith(`${path.sep}default_app.asar`);
			},
		});
		const tmpInstall = path.join(tmpElectron, 'install.js');
		if (!existsSync(tmpInstall)) {
			return false;
		}
		const result = runInstall(tmpInstall, tmpElectron);
		if ((result.status ?? 1) !== 0) {
			return false;
		}
		const tmpDist = path.join(tmpElectron, 'dist');
		if (!existsSync(tmpDist)) {
			return false;
		}
		copySkippingLockedAsar(tmpDist, path.join(electronDir, 'dist'));
		const tmpPathTxt = path.join(tmpElectron, 'path.txt');
		if (existsSync(tmpPathTxt)) {
			try {
				cpSync(tmpPathTxt, pathTxt);
			} catch (err) {
				if (!isLockError(err)) {
					throw err;
				}
			}
		}
		return binaryOk();
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}

if (!existsSync(electronDir)) {
	// Production / packaged installs do not ship the electron devDependency.
	process.exit(0);
}

if (binaryOk()) {
	process.exit(0);
}

if (!existsSync(installJs)) {
	console.error(
		'[hawaldar] node_modules/electron is incomplete (missing install.js). Close Hawaldar.exe / electron.exe and re-run scripts/setup.bat',
	);
	process.exit(1);
}

console.log('[hawaldar] Electron binary missing (common after electron-builder). Downloading…');
const result = runInstall(installJs, appRoot);
if ((result.status ?? 1) === 0 && binaryOk()) {
	process.exit(0);
}

console.log('[hawaldar] In-place Electron restore failed (often a locked default_app.asar). Retrying in a temp folder…');
if (restoreViaTemp()) {
	process.exit(0);
}

console.error('[hawaldar] Failed to restore Electron. Run: npm i electron --save-dev');
process.exit(result.status || 1);
