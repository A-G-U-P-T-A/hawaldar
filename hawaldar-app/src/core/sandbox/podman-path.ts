import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { dockerWellKnownBins, looksLikeDockerBin, resolveDockerPath } from './host-info';

export type PodmanResolveSource = 'settings' | 'path' | 'well-known' | 'missing';

export interface PodmanResolveResult {
	path?: string;
	source: PodmanResolveSource;
	error?: string;
}

const PATH_SEP = process.platform === 'win32' ? ';' : ':';

/** Reject shell metacharacters. Spaces / parentheses are valid in Windows paths. */
export function assertPodmanBin(podmanPath: string): void {
	const cleaned = stripQuotes(podmanPath);
	if (!cleaned || /[\n\r;|&$`<>]/.test(cleaned)) {
		throw new Error('Invalid podman path.');
	}
}

export function stripQuotes(value: string): string {
	return value.trim().replace(/^["']|["']$/g, '');
}

export function isExistingFile(filePath: string): boolean {
	try {
		return Boolean(filePath) && fs.existsSync(filePath) && fs.statSync(filePath).isFile();
	} catch {
		return false;
	}
}

export function commonPodmanDirs(): string[] {
	if (process.platform === 'win32') {
		const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
		const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
		return unique([
			path.join(programFiles, 'RedHat', 'Podman'),
			path.join(programFiles, 'RedHat', 'Podman', 'bin'),
			path.join(programFiles, 'Podman'),
			path.join(localAppData, 'Programs', 'Podman'),
			path.join(localAppData, 'Programs', 'Podman', 'bin'),
			path.join(localAppData, 'Programs', 'podman'),
			path.join(localAppData, 'Programs', 'RedHat', 'Podman'),
			path.join(localAppData, 'RedHat', 'Podman'),
			'C:\\Program Files\\RedHat\\Podman',
			'C:\\Program Files\\Podman',
		]);
	}
	return unique(['/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/opt/podman/bin']);
}

export function wellKnownPodmanBins(): string[] {
	if (process.platform === 'win32') {
		return unique(commonPodmanDirs().map((dir) => path.join(dir, 'podman.exe')));
	}
	return unique(commonPodmanDirs().map((dir) => path.join(dir, 'podman')));
}

export function augmentedPath(): string {
	const current = process.env.PATH || '';
	const dockerDirs = dockerWellKnownBins().map((file) => path.dirname(file));
	return unique([...commonPodmanDirs(), ...dockerDirs, ...current.split(PATH_SEP)]).join(PATH_SEP);
}

export function podmanInstallHint(): string {
	if (process.platform === 'win32') {
		return 'On Windows, containers need a Linux VM (WSL or Hyper-V). Click Set up Podman — Hawaldar installs via winget or the official MSI (a permission prompt is normal).';
	}
	if (process.platform === 'darwin') {
		return 'On macOS, containers need a Linux VM (Podman machine). Click Set up Podman — Hawaldar uses Homebrew or an existing install.';
	}
	if (process.platform === 'linux') {
		return 'On Linux, containers run natively. Hawaldar locates Podman or Docker already installed; it will not install packages with sudo.';
	}
	return 'Scans run in isolated Linux containers. Click Set up Podman if this app can install the runtime on your OS.';
}

/** Podman 5/6 removed slirp4netns. Not a stopped VM. */
export const STALE_NETWORK_BACKEND =
	'Container network backend is outdated; Hawaldar will use pasta/bridge.';

export function isStaleNetworkBackend(text: string): boolean {
	return /slirp4netns/i.test(text);
}

export function classifySpawnError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	if (isStaleNetworkBackend(message)) {
		return STALE_NETWORK_BACKEND;
	}
	const err = error as NodeJS.ErrnoException;
	if (err?.code === 'ENOENT') {
		return 'The container runtime client was not found. Open Podman and click Set up Podman.';
	}
	return message;
}

export function looksLikeBarePodman(value: string): boolean {
	const cleaned = stripQuotes(value).toLowerCase();
	return cleaned === '' || cleaned === 'podman' || cleaned === 'podman.exe';
}

/** Walk PATH (plus common install dirs) for podman / podman.exe. */
export function whichPodman(searchPath = augmentedPath()): string | undefined {
	const names = process.platform === 'win32' ? ['podman.exe', 'podman'] : ['podman'];
	for (const dir of searchPath.split(PATH_SEP)) {
		if (!dir) {
			continue;
		}
		for (const name of names) {
			const full = path.join(dir, name);
			if (isExistingFile(full)) {
				return full;
			}
		}
	}
	return undefined;
}

/**
 * Resolve the Podman client binary.
 * Prefer an existing settings path; otherwise PATH (augmented); otherwise well-known Windows locations.
 */
export function resolvePodmanPath(preferred?: string): PodmanResolveResult {
	const cleaned = stripQuotes(preferred || '');

	if (cleaned && looksLikeDockerBin(cleaned)) {
		// Fall through — a Docker CLI path is not Podman.
	} else if (cleaned && !looksLikeBarePodman(cleaned) && isExistingFile(cleaned)) {
		return { path: cleaned, source: 'settings' };
	}

	const fromPath = whichPodman();
	if (fromPath) {
		return { path: fromPath, source: 'path' };
	}

	for (const candidate of wellKnownPodmanBins()) {
		if (isExistingFile(candidate)) {
			return { path: candidate, source: 'well-known' };
		}
	}

	return {
		source: 'missing',
		error: cleaned && !looksLikeBarePodman(cleaned)
			? `Podman not found at "${cleaned}". Click Set up Podman to install the runtime.`
			: 'Container runtime is not set up yet. Click Set up Podman to install and start it.',
	};
}

/** Path to spawn, or the original setting if still unresolved. */
export function podmanBin(preferred?: string): string {
	return resolvePodmanPath(preferred).path || stripQuotes(preferred || '') || 'podman';
}

export interface EngineAlternative {
	engine: 'podman' | 'docker';
	path?: string;
	available: boolean;
}

export function resolveEnginePath(
	engine: 'podman' | 'docker',
	preferred?: string,
): { path?: string; source: string; error?: string } {
	if (engine === 'docker') {
		const resolved = resolveDockerPath(preferred);
		return {
			path: resolved.path,
			source: resolved.source,
			error: resolved.path
				? undefined
				: 'Docker CLI not found. Hawaldar does not install Docker Desktop. Browse to an existing docker binary, or Set up Podman instead.',
		};
	}
	return resolvePodmanPath(preferred);
}

/** Spawn path for the selected engine. Never remaps a Docker CLI through Podman lookup. */
export function engineBin(engine: 'podman' | 'docker', preferred?: string): string {
	if (engine === 'docker') {
		const resolved = resolveDockerPath(preferred);
		if (resolved.path) {
			return resolved.path;
		}
		const cleaned = stripQuotes(preferred || '');
		return looksLikeDockerBin(cleaned) ? cleaned : 'docker';
	}
	return podmanBin(preferred);
}

export function listEngineAlternatives(engine: 'podman' | 'docker', preferred?: string): EngineAlternative[] {
	const preferDocker = engine === 'docker' || looksLikeDockerBin(preferred || '');
	const podman = resolvePodmanPath(preferDocker ? undefined : preferred);
	const docker = resolveDockerPath(preferDocker ? preferred : undefined);
	return [
		{ engine: 'podman', path: podman.path, available: Boolean(podman.path) },
		{ engine: 'docker', path: docker.path, available: Boolean(docker.path) },
	];
}

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
