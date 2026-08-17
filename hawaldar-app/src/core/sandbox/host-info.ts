import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';

export type HostOs = 'windows' | 'macos' | 'linux' | 'other';
export type ContainerEngine = 'podman' | 'docker';

export interface HostInfo {
	os: HostOs;
	osLabel: string;
	release: string;
	arch: string;
	cpus: number;
	memoryGiB: number;
	/** Windows/macOS need a Linux VM. Linux can run containers natively. */
	needsLinuxVm: boolean;
	virtHint: string;
}

export function hostOs(): HostOs {
	if (process.platform === 'win32') {
		return 'windows';
	}
	if (process.platform === 'darwin') {
		return 'macos';
	}
	if (process.platform === 'linux') {
		return 'linux';
	}
	return 'other';
}

export function hostOsLabel(id = hostOs()): string {
	if (id === 'windows') {
		return 'Windows';
	}
	if (id === 'macos') {
		return 'macOS';
	}
	if (id === 'linux') {
		return 'Linux';
	}
	return process.platform;
}

export function collectHostInfo(): HostInfo {
	const id = hostOs();
	const needsLinuxVm = id === 'windows' || id === 'macos';
	return {
		os: id,
		osLabel: hostOsLabel(id),
		release: os.release(),
		arch: os.arch(),
		cpus: os.cpus().length,
		memoryGiB: Math.round((os.totalmem() / (1024 ** 3)) * 10) / 10,
		needsLinuxVm,
		virtHint: virtHint(id, needsLinuxVm),
	};
}

function virtHint(id: HostOs, needsLinuxVm: boolean): string {
	if (id === 'linux') {
		return 'Native containers — no extra Linux VM.';
	}
	if (id === 'windows') {
		return 'Windows needs a Linux VM (WSL or Hyper-V) plus CPU virtualization.';
	}
	if (id === 'macos') {
		return 'macOS needs a Linux VM (Podman machine or Docker Desktop).';
	}
	return needsLinuxVm ? 'This OS needs a Linux VM for containers.' : 'Unknown host.';
}

const PATH_SEP = process.platform === 'win32' ? ';' : ':';

function unique(values: string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const value of values) {
		const key = process.platform === 'win32' ? value.toLowerCase() : value;
		if (!value || seen.has(key)) {
			continue;
		}
		seen.add(key);
		out.push(value);
	}
	return out;
}

function isFile(filePath: string): boolean {
	try {
		return Boolean(filePath) && fs.existsSync(filePath) && fs.statSync(filePath).isFile();
	} catch {
		return false;
	}
}

function whichNamed(names: string[], extraDirs: string[]): string | undefined {
	const dirs = unique([...extraDirs, ...(process.env.PATH || '').split(PATH_SEP)]);
	for (const dir of dirs) {
		if (!dir) {
			continue;
		}
		for (const name of names) {
			const full = path.join(dir, name);
			if (isFile(full)) {
				return full;
			}
		}
	}
	return undefined;
}

export function dockerWellKnownBins(): string[] {
	if (process.platform === 'win32') {
		const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
		return [
			path.join(programFiles, 'Docker', 'Docker', 'resources', 'bin', 'docker.exe'),
			path.join(programFiles, 'Docker', 'Docker', 'resources', 'docker.exe'),
		];
	}
	return ['/usr/local/bin/docker', '/opt/homebrew/bin/docker', '/usr/bin/docker'];
}

export function resolveDockerPath(preferred?: string): { path?: string; source: string } {
	const cleaned = (preferred || '').trim().replace(/^["']|["']$/g, '');
	if (cleaned && /docker(\.exe)?$/i.test(cleaned) && isFile(cleaned)) {
		return { path: cleaned, source: 'settings' };
	}
	const extra = dockerWellKnownBins().map((p) => path.dirname(p));
	const fromPath = whichNamed(process.platform === 'win32' ? ['docker.exe', 'docker'] : ['docker'], extra);
	if (fromPath) {
		return { path: fromPath, source: 'path' };
	}
	for (const candidate of dockerWellKnownBins()) {
		if (isFile(candidate)) {
			return { path: candidate, source: 'well-known' };
		}
	}
	return { source: 'missing' };
}

export function looksLikeDockerBin(filePath: string): boolean {
	return /docker(\.exe)?$/i.test(filePath.trim());
}
