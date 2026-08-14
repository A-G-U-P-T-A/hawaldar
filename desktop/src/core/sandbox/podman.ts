import { randomUUID } from 'node:crypto';
import * as os from 'node:os';
import { looksLikeDockerBin } from './host-info';
import { assertPodmanBin } from './podman-path';
import { runCommand, type CommandResult } from './runner';
import {
	WORKSPACE_CONTAINER_PATH,
	WORKSPACE_ENV_NAME,
	bindMountSource,
	ensureWorkspace,
	withWorkspaceMount,
} from './workspace';

const IMAGE_RE = /^[a-zA-Z0-9._\/:-]+$/;

export interface PodmanRunRequest {
	podmanPath: string;
	image: string;
	command?: string;
	args: readonly string[];
	timeoutMs: number;
	network: 'none' | 'target';
	memoryMb?: number;
	entrypoint?: string;
	mounts?: Array<{ source: string; target: string; readonly: boolean }>;
}

export async function podmanRun(request: PodmanRunRequest): Promise<CommandResult> {
	assertPodmanBin(request.podmanPath);
	if (!IMAGE_RE.test(request.image)) {
		throw new Error('Invalid container image.');
	}
	if (request.command && !/^[a-zA-Z0-9._-]+$/.test(request.command)) {
		throw new Error('Invalid container command.');
	}
	if (request.entrypoint && !/^[a-zA-Z0-9._\/-]+$/.test(request.entrypoint)) {
		throw new Error('Invalid container entrypoint.');
	}
	const docker = looksLikeDockerBin(request.podmanPath);
	const id = `hw-${randomUUID()}`;
	const args = [
		'run',
		'--rm',
		'--name',
		id,
		'--security-opt',
		'no-new-privileges',
		'--cap-drop=ALL',
		'--network',
		request.network === 'target' ? (docker ? 'bridge' : 'slirp4netns') : 'none',
		'--cpus',
		'1',
		'--memory',
		`${request.memoryMb ?? 512}m`,
		'--pids-limit',
		'128',
	];
	if (request.entrypoint) {
		args.push('--entrypoint', request.entrypoint);
	}
	if (!docker && os.platform() !== 'win32') {
		args.push('--userns=keep-id');
	}
	ensureWorkspace();
	args.push('-e', `${WORKSPACE_ENV_NAME}=${WORKSPACE_CONTAINER_PATH}`);
	args.push('-w', WORKSPACE_CONTAINER_PATH);
	for (const mount of withWorkspaceMount(request.mounts)) {
		args.push('-v', `${bindMountSource(mount.source)}:${mount.target}${mount.readonly ? ':ro' : ''}`);
	}
	args.push(request.image);
	if (request.command) {
		args.push(request.command);
	}
	args.push(...request.args);
	return runCommand(request.podmanPath, args, request.timeoutMs);
}

export async function podmanVersion(podmanPath: string): Promise<CommandResult> {
	assertPodmanBin(podmanPath);
	return runCommand(podmanPath, ['version', '--format', '{{.Client.Version}}'], 15_000);
}
