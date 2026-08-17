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

export const HOST_CONTAINERS_INTERNAL = 'host.containers.internal';
export const HOST_DOCKER_INTERNAL = 'host.docker.internal';

export interface PodmanRunRequest {
	podmanPath: string;
	image: string;
	command?: string;
	args: readonly string[];
	timeoutMs: number;
	network: 'none' | 'target';
	/** Reach the operator machine (loopback) from inside the container. */
	reachHostLoopback?: boolean;
	memoryMb?: number;
	pidsLimit?: number;
	workdir?: string;
	entrypoint?: string;
	/** Share the named hw-* daemon's network namespace (`--network container:name`). */
	networkContainer?: string;
	mounts?: Array<{ source: string; target: string; readonly: boolean }>;
}

const DAEMON_CONTAINER_RE = /^hw-[a-z0-9][a-z0-9-]{0,30}$/;

/** Windows/macOS: container 127.0.0.1 is the VM, not the operator host. */
export function usesHostGatewayAlias(platform = process.platform): boolean {
	return platform === 'win32' || platform === 'darwin';
}

export function hostGatewayAlias(docker: boolean): string {
	return docker ? HOST_DOCKER_INTERNAL : HOST_CONTAINERS_INTERNAL;
}

/**
 * Connect-scan target inside the container for a policy-local host.
 * Linux keeps 127.0.0.1 / ::1 (paired with --network host).
 * Windows/macOS use host.containers.internal (pasta/gvproxy gateway; 10.0.2.2 on QEMU).
 */
export function containerLoopbackTarget(
	policyTarget: string,
	docker: boolean,
	platform = process.platform,
): string {
	return usesHostGatewayAlias(platform) ? hostGatewayAlias(docker) : policyTarget;
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
	if (request.networkContainer && !DAEMON_CONTAINER_RE.test(request.networkContainer)) {
		throw new Error('Invalid container network target.');
	}
	if (request.workdir && !/^\/[a-zA-Z0-9._\/-]+$/.test(request.workdir)) {
		throw new Error('Invalid container workdir.');
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
	];
	appendNetworkArgs(args, request, docker);
	args.push(
		'--cpus',
		'1',
		'--memory',
		`${request.memoryMb ?? 512}m`,
		'--pids-limit',
		String(request.pidsLimit ?? 128),
	);
	if (request.entrypoint) {
		// JSON exec-form so Podman/Docker never wrap the binary in `sh -c`.
		args.push('--entrypoint', JSON.stringify([request.entrypoint]));
	}
	if (!docker && os.platform() !== 'win32') {
		args.push('--userns=keep-id');
	}
	ensureWorkspace();
	args.push('-e', `${WORKSPACE_ENV_NAME}=${WORKSPACE_CONTAINER_PATH}`);
	args.push('-w', request.workdir || WORKSPACE_CONTAINER_PATH);
	for (const mount of withWorkspaceMount(request.mounts)) {
		args.push('-v', `${bindMountSource(mount.source)}:${mount.target}${mount.readonly ? ':ro' : ''}`);
	}
	args.push(request.image);
	const command = commandIfDistinct(request);
	if (command) {
		args.push(command);
	}
	args.push(...request.args);
	return runCommand(request.podmanPath, args, request.timeoutMs);
}

/** Drop `command` when it repeats `--entrypoint` (`katana katana` → missing dynamic library). */
function commandIfDistinct(request: PodmanRunRequest): string | undefined {
	if (!request.command) {
		return undefined;
	}
	if (!request.entrypoint) {
		return request.command;
	}
	const base = request.entrypoint.split('/').pop();
	if (request.command === request.entrypoint || request.command === base) {
		return undefined;
	}
	return request.command;
}

/**
 * Target network: Podman default (pasta on 5/6 rootless, bridge when that is the engine default).
 * Never slirp4netns — removed in Podman 5/6. Docker uses bridge.
 * --network host only on Linux, and only when reaching operator loopback.
 * `networkContainer` shares an hw-* daemon netns (loopback-published Juice Shop).
 */
function appendNetworkArgs(args: string[], request: PodmanRunRequest, docker: boolean): void {
	if (request.networkContainer) {
		args.push('--network', `container:${request.networkContainer}`);
		return;
	}
	if (request.network === 'none') {
		args.push('--network', 'none');
		return;
	}
	if (request.reachHostLoopback && os.platform() === 'linux') {
		args.push('--network', 'host');
		return;
	}
	if (docker) {
		args.push('--network', 'bridge');
	}
	if (request.reachHostLoopback && usesHostGatewayAlias()) {
		args.push('--add-host', `${hostGatewayAlias(docker)}:host-gateway`);
	}
}

export async function podmanVersion(podmanPath: string): Promise<CommandResult> {
	assertPodmanBin(podmanPath);
	return runCommand(podmanPath, ['version', '--format', '{{.Client.Version}}'], 15_000);
}
