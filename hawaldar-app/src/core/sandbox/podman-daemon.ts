import { looksLikeDockerBin } from './host-info';
import { hostGatewayAlias } from './podman';
import { listPodmanContainers, stopContainer } from './podman-control';
import { assertPodmanBin } from './podman-path';
import { runCommand } from './runner';

/**
 * Long-running tool daemons (e.g. the ZAP API). Unlike the ephemeral
 * `podman run --rm` tools, a daemon is `podman run -d` with a stable hw-* name,
 * idempotent start, and a loopback-only published port. The hw-* name means
 * `stopHawaldarContainers` (quit teardown) and `stopContainersForImage`
 * (stop_service) both reap it.
 */

const IMAGE_RE = /^[a-zA-Z0-9._\/:-]+$/;
const DAEMON_NAME_RE = /^hw-[a-z0-9][a-z0-9-]{0,30}$/;
const ENV_KEY_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
/** Env values must stay shell/log safe: printable, no whitespace or quotes. */
const ENV_VALUE_RE = /^[a-zA-Z0-9._\/:@+-]{1,256}$/;

export interface DaemonSpec {
	podmanPath: string;
	/** Stable container name, must start with hw- (quit teardown + stop_service match on it). */
	name: string;
	image: string;
	/** Host port bound on 127.0.0.1. */
	hostPort: number;
	containerPort: number;
	env?: Record<string, string>;
	/** Optional argv after the image (omit to use the image CMD). */
	args?: readonly string[];
	memoryMb?: number;
	pidsLimit?: number;
}

export type DaemonState = 'running' | 'stopped' | 'missing';

export async function daemonState(podmanPath: string, name: string): Promise<DaemonState> {
	assertPodmanBin(podmanPath);
	const containers = await listPodmanContainers(podmanPath);
	const found = containers.find((item) => item.name === name);
	if (!found) {
		return 'missing';
	}
	return found.state === 'running' ? 'running' : 'stopped';
}

/**
 * Idempotent daemon start. A running container is reused as-is; a stale
 * (exited) one is removed first so env/args changes (e.g. a fresh API key)
 * always apply. Binds the published port to 127.0.0.1 only and adds the
 * host-gateway alias so the daemon can reach operator-loopback targets the
 * policy gate already allowed.
 */
export async function ensureDaemon(spec: DaemonSpec): Promise<{ ok: boolean; detail: string }> {
	assertPodmanBin(spec.podmanPath);
	if (!DAEMON_NAME_RE.test(spec.name)) {
		return { ok: false, detail: 'Invalid daemon name.' };
	}
	if (!IMAGE_RE.test(spec.image)) {
		return { ok: false, detail: 'Invalid container image.' };
	}
	if (!Number.isInteger(spec.hostPort) || !Number.isInteger(spec.containerPort)
		|| spec.hostPort < 1 || spec.hostPort > 65535 || spec.containerPort < 1 || spec.containerPort > 65535) {
		return { ok: false, detail: 'Invalid daemon port.' };
	}
	for (const [key, value] of Object.entries(spec.env ?? {})) {
		if (!ENV_KEY_RE.test(key) || !ENV_VALUE_RE.test(value)) {
			return { ok: false, detail: `Invalid daemon env ${key}.` };
		}
	}

	const state = await daemonState(spec.podmanPath, spec.name);
	if (state === 'running') {
		return { ok: true, detail: `${spec.name} already running.` };
	}
	if (state === 'stopped') {
		await runCommand(spec.podmanPath, ['rm', '-f', spec.name], 30_000).catch(() => undefined);
	}

	const docker = looksLikeDockerBin(spec.podmanPath);
	const args = [
		'run',
		'-d',
		'--name',
		spec.name,
		'--security-opt',
		'no-new-privileges',
		'--cap-drop=ALL',
		'-p',
		`127.0.0.1:${spec.hostPort}:${spec.containerPort}`,
	];
	// Daemons (e.g. ZAP) dial operator-loopback targets themselves, so they need
	// the same pasta --map-gw gateway as ephemeral tools; plain pasta resolves
	// host.containers.internal but cannot route to it on WSL2.
	args.push('--network', docker ? 'bridge' : 'pasta:--map-gw');
	args.push(
		'--add-host',
		`${hostGatewayAlias(docker)}:host-gateway`,
		'--memory',
		`${spec.memoryMb ?? 1024}m`,
		'--pids-limit',
		String(spec.pidsLimit ?? 512),
	);
	for (const [key, value] of Object.entries(spec.env ?? {})) {
		args.push('-e', `${key}=${value}`);
	}
	args.push(spec.image);
	if (spec.args) {
		args.push(...spec.args);
	}
	const result = await runCommand(spec.podmanPath, args, 60_000);
	if (result.exitCode !== 0 || result.timedOut) {
		const detail = (result.stderr || result.stdout).trim().split(/\r?\n/).slice(-3).join(' ') || `exit ${result.exitCode}`;
		return { ok: false, detail: detail.slice(0, 400) };
	}
	return { ok: true, detail: `${spec.name} started.` };
}

export async function stopDaemon(podmanPath: string, name: string): Promise<{ ok: boolean; detail: string }> {
	assertPodmanBin(podmanPath);
	if (!DAEMON_NAME_RE.test(name)) {
		return { ok: false, detail: 'Invalid daemon name.' };
	}
	if ((await daemonState(podmanPath, name)) === 'missing') {
		return { ok: true, detail: `${name} is not running.` };
	}
	return stopContainer(podmanPath, name);
}
