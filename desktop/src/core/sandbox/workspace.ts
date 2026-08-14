/**
 * Shared host workspace for ephemeral tool containers.
 * Host: ~/.hawaldar/workspace  →  container: /workspace
 * Never mounts $HOME or the Electron app tree.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export const WORKSPACE_CONTAINER_PATH = '/workspace';
export const WORKSPACE_ENV_NAME = 'HAWALDAR_WORKSPACE';
export const WORKSPACE_DISPLAY_PATH = '~/.hawaldar/workspace';

const SUBDIRS = ['scripts', 'logs', 'scans', 'binaries'] as const;

export interface BindMount {
	source: string;
	target: string;
	readonly: boolean;
}

export interface WorkspaceSnapshot {
	hostPath: string;
	displayPath: string;
	containerPath: string;
}

export function hawaldarHome(): string {
	return path.join(os.homedir(), '.hawaldar');
}

export function workspaceHostPath(): string {
	return path.join(hawaldarHome(), 'workspace');
}

/** Absolute host path formatted for `podman/docker run -v` (Windows drive-letter safe). */
export function bindMountSource(hostPath: string): string {
	const resolved = path.resolve(hostPath);
	return process.platform === 'win32' ? resolved.replace(/\\/g, '/') : resolved;
}

export function ensureWorkspace(): WorkspaceSnapshot {
	const hostPath = workspaceHostPath();
	fs.mkdirSync(hostPath, { recursive: true });
	for (const dir of SUBDIRS) {
		fs.mkdirSync(path.join(hostPath, dir), { recursive: true });
	}
	return workspaceSnapshot();
}

export function workspaceSnapshot(): WorkspaceSnapshot {
	return {
		hostPath: workspaceHostPath(),
		displayPath: WORKSPACE_DISPLAY_PATH,
		containerPath: WORKSPACE_CONTAINER_PATH,
	};
}

export function workspaceMount(): BindMount {
	return {
		source: workspaceHostPath(),
		target: WORKSPACE_CONTAINER_PATH,
		readonly: false,
	};
}

/** Workspace first, then any tool-specific mounts (file/pcap/wordlist). Dedupes /workspace. */
export function withWorkspaceMount(mounts?: readonly BindMount[]): BindMount[] {
	const rest = (mounts ?? []).filter((item) => item.target !== WORKSPACE_CONTAINER_PATH);
	return [workspaceMount(), ...rest];
}

export function isUnderWorkspace(hostPath: string): boolean {
	return containerPathUnderWorkspace(hostPath) !== undefined;
}

/** If the host file lives in the shared workspace, return its path inside the container. */
export function containerPathUnderWorkspace(hostPath: string): string | undefined {
	const resolved = path.resolve(hostPath);
	const root = path.resolve(workspaceHostPath());
	const rel = path.relative(root, resolved);
	if (rel.startsWith('..') || path.isAbsolute(rel)) {
		return undefined;
	}
	const posix = rel.split(path.sep).join('/');
	return posix ? `${WORKSPACE_CONTAINER_PATH}/${posix}` : WORKSPACE_CONTAINER_PATH;
}
