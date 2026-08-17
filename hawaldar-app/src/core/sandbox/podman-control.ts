import { looksLikeDockerBin, type HostInfo } from './host-info';
import {
	assertPodmanBin,
	classifySpawnError,
	isStaleNetworkBackend,
	STALE_NETWORK_BACKEND,
	type EngineAlternative,
} from './podman-path';
import { runCommand, type CommandOutputHandler } from './runner';
import { ensureWindowsCgroupV2, terminateWslDistro } from './wsl-host';

export interface MachineOpOptions {
	timeoutMs?: number;
	initTimeoutMs?: number;
	startTimeoutMs?: number;
	onOutput?: CommandOutputHandler;
}

const IMAGE_RE = /^[a-zA-Z0-9._\/:-]+$/;
const NAME_RE = /^[a-zA-Z0-9._-]+$/;
const DEFAULT_START_TIMEOUT_MS = 600_000;
const ENGINE_SETTLE_MS = 90_000;
const POLL_MS = 2_000;
const START_RETRY_WAIT_MS = 8_000;

const ROOTLESS_NOTE_RE = /this machine is currently configured in rootless mode[\s\S]*?podman machine set --rootful/gi;
const ROOTLESS_LINE_RE = /rootless mode|podman machine set --rootful|consider using rootful|require root permissions|ports < 1024|non-podman clients/i;
const WSL_NOISE_RE = /your \d+x\d+ screen size is bogus[^\n]*/gi;
const DOCKER_PIPE_NOTE_RE = /API forwarding for Docker API clients[\s\S]*?Podman clients are still able to connect\.\s*/gi;

export type PodmanAvailability = 'ok' | 'not_installed' | 'machine_stopped' | 'no_machine' | 'error';

export interface PodmanMachineInfo {
	name: string;
	running: boolean;
	starting?: boolean;
	lastUp?: string;
	cpus?: number;
	memoryMiB?: number;
}

export interface PodmanContainerInfo {
	id: string;
	name: string;
	image: string;
	status: string;
	state: string;
	created: string;
	hawaldar: boolean;
}

export interface PodmanServiceInfo {
	id: string;
	label: string;
	image: string;
	started: boolean;
	imagePresent: boolean;
	detail: string;
	lane?: string;
	laneLabel?: string;
	webLab?: boolean;
}

export interface PodmanStatusSnapshot {
	ok: boolean;
	availability: PodmanAvailability;
	version: string;
	error?: string;
	hint?: string;
	resolvedPath: string;
	engine: 'podman' | 'docker';
	host: HostInfo;
	alternatives: EngineAlternative[];
	machines: PodmanMachineInfo[];
	containers: PodmanContainerInfo[];
	services: PodmanServiceInfo[];
	autoStartMachine: boolean;
	canInitMachine: boolean;
	workspace: {
		hostPath: string;
		displayPath: string;
		containerPath: string;
	};
}

function assertBin(podmanPath: string): void {
	assertPodmanBin(podmanPath);
}

export async function getPodmanVersion(podmanPath: string): Promise<{ ok: boolean; version: string; error?: string }> {
	assertBin(podmanPath);
	try {
		const result = await runCommand(podmanPath, ['version', '--format', '{{.Client.Version}}'], 15_000);
		if (result.exitCode !== 0 || result.timedOut) {
			return { ok: false, version: '', error: result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}` };
		}
		return { ok: true, version: result.stdout.trim() };
	} catch (error) {
		return { ok: false, version: '', error: classifySpawnError(error) };
	}
}

export function isIgnorableMachineNote(text: string): boolean {
	return ROOTLESS_LINE_RE.test(text) || /screen size is bogus/i.test(text);
}

export function stripMachineNotes(text: string): string {
	const stripped = text
		.replace(ROOTLESS_NOTE_RE, '')
		.replace(WSL_NOISE_RE, '')
		.replace(DOCKER_PIPE_NOTE_RE, '');
	const lines: string[] = [];
	for (const raw of stripped.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || isIgnorableMachineNote(line)) {
			continue;
		}
		if (lines[lines.length - 1] === line) {
			continue;
		}
		lines.push(line);
	}
	return lines.join('\n');
}

export function normalizeMachineLastUp(value: unknown): string | undefined {
	if (value == null) {
		return undefined;
	}
	const text = String(value).trim();
	if (!text || /^0001-01-01/.test(text)) {
		return undefined;
	}
	const ms = Date.parse(text);
	if (Number.isNaN(ms) || ms <= 0) {
		return undefined;
	}
	return text;
}

export function machineNeverRan(lastUp?: string): boolean {
	return !normalizeMachineLastUp(lastUp);
}

export function isSshNotRunningFailure(detail: string): boolean {
	return /did not transition|ssh error|machine not in running state|not listening on ssh|did not reach a running state|exit 125/i.test(detail);
}

export function lastActionableMachineLine(text: string): string {
	const lines = stripMachineNotes(text)
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 2 && !/^starting machine\b/i.test(line) && !/^waiting for\b/i.test(line));
	return lines.at(-1) || '';
}

export function classifyMachineOpFailure(detail: string): string {
	const cleaned = stripMachineNotes(detail);
	if (isStaleNetworkBackend(cleaned)) {
		return STALE_NETWORK_BACKEND;
	}
	const text = cleaned.toLowerCase();
	if (/timed out|did not come up in time/i.test(cleaned)) {
		return 'The Linux VM did not come up in time. First start on Windows can take several minutes — click Set up Podman again.';
	}
	if (/wsl.*(not installed|not found|disabled|is required)|windows subsystem for linux.*(not|install|enable)|wsl\.exe.*(not found|not recognized)/i.test(text)) {
		return 'WSL is missing or not ready. Install Windows Subsystem for Linux, restart if asked, then click Set up Podman again.';
	}
	if (/virtual machine platform|hyper-v|hypervisor|virtualization.*(disabled|not enabled)|enable virtualization/i.test(text)) {
		return 'The Linux VM needs WSL or Hyper-V (and CPU virtualization). Turn those on in Windows Features, restart if asked, then click Set up Podman again.';
	}
	if (/did not transition|ssh error|machine not in running state/i.test(text)) {
		return 'The Linux VM did not reach a running state. Click Set up Podman again. If it keeps failing, check that WSL can start.';
	}
	if (/no machine|does not exist|vm already exists/i.test(text) && /not found|does not exist/i.test(text)) {
		return 'No Podman machine exists yet. Click Set up Podman again to create one.';
	}
	const last = lastActionableMachineLine(cleaned);
	return last
		? `Could not start the Linux VM. ${last.slice(0, 220)}`
		: 'Could not start the Linux VM.';
}

export async function getPodmanEngineInfo(podmanPath: string): Promise<{ ok: boolean; version: string; error?: string }> {
	assertBin(podmanPath);
	try {
		const result = await runCommand(podmanPath, ['info', '--format', '{{.Version.Version}}'], 30_000);
		if (result.exitCode !== 0 || result.timedOut) {
			const error = lastActionableMachineLine(`${result.stderr}\n${result.stdout}`) || 'Podman engine is not running.';
			return { ok: false, version: '', error };
		}
		return { ok: true, version: result.stdout.trim() };
	} catch (error) {
		return { ok: false, version: '', error: classifySpawnError(error) };
	}
}

export async function getDockerInfo(bin: string): Promise<{ ok: boolean; version: string; error?: string }> {
	assertBin(bin);
	try {
		const result = await runCommand(bin, ['info', '--format', '{{.ServerVersion}}'], 20_000);
		if (result.exitCode !== 0 || result.timedOut) {
			return {
				ok: false,
				version: '',
				error: result.stderr.trim() || result.stdout.trim() || 'Docker engine is not running.',
			};
		}
		return { ok: true, version: result.stdout.trim() };
	} catch (error) {
		return { ok: false, version: '', error: classifySpawnError(error) };
	}
}

export async function listPodmanMachines(podmanPath: string): Promise<PodmanMachineInfo[]> {
	if (looksLikeDockerBin(podmanPath)) {
		return [];
	}
	assertBin(podmanPath);
	try {
		const result = await runCommand(podmanPath, ['machine', 'list', '--format', 'json'], 20_000);
		if (result.exitCode !== 0 || result.timedOut) {
			return [];
		}
		const raw = result.stdout.trim();
		if (!raw) {
			return [];
		}
		const parsed = JSON.parse(raw) as Array<Record<string, unknown>>;
		if (!Array.isArray(parsed)) {
			return [];
		}
		return parsed.map((item) => ({
			name: String(item.Name || item.name || 'podman-machine-default'),
			running: Boolean(item.Running ?? item.running),
			starting: Boolean(item.Starting ?? item.starting),
			lastUp: normalizeMachineLastUp(item.LastUp ?? item.lastUp),
			cpus: typeof item.CPUs === 'number' ? item.CPUs : undefined,
			memoryMiB: typeof item.Memory === 'number' ? Math.round(Number(item.Memory) / (1024 * 1024)) : undefined,
		}));
	} catch {
		return [];
	}
}

export async function listPodmanContainers(podmanPath: string): Promise<PodmanContainerInfo[]> {
	assertBin(podmanPath);
	try {
		const result = await runCommand(podmanPath, [
			'ps', '-a',
			'--format',
			'{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.State}}\t{{.CreatedAt}}',
		], 20_000);
		if (result.exitCode !== 0 || result.timedOut) {
			return [];
		}
		return result.stdout
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter(Boolean)
			.map((line) => {
				const [id, name, image, status, state, ...createdParts] = line.split('\t');
				const created = createdParts.join('\t');
				return {
					id: id || '',
					name: name || '',
					image: image || '',
					status: status || '',
					state: state || '',
					created: created || '',
					hawaldar: Boolean(name?.startsWith('hw-') || name?.startsWith('hwsvc-')),
				};
			});
	} catch {
		return [];
	}
}

export async function imageExists(podmanPath: string, image: string): Promise<boolean> {
	assertBin(podmanPath);
	if (!IMAGE_RE.test(image)) {
		return false;
	}
	try {
		if (looksLikeDockerBin(podmanPath)) {
			const result = await runCommand(podmanPath, ['image', 'inspect', image], 20_000);
			return result.exitCode === 0;
		}
		const result = await runCommand(podmanPath, ['image', 'exists', image], 20_000);
		return result.exitCode === 0;
	} catch {
		return false;
	}
}

export async function buildImage(
	podmanPath: string,
	image: string,
	contextDir: string,
): Promise<{ ok: boolean; detail: string }> {
	assertBin(podmanPath);
	if (!IMAGE_RE.test(image)) {
		return { ok: false, detail: 'Invalid image.' };
	}
	try {
		const result = await runCommand(
			podmanPath,
			['build', '-t', image, '-f', `${contextDir.replace(/\\/g, '/')}/Containerfile`, contextDir],
			900_000,
		);
		const detail = (result.stdout || result.stderr).trim().split(/\r?\n/).slice(-5).join(' ') || `exit ${result.exitCode}`;
		return { ok: result.exitCode === 0 && !result.timedOut, detail };
	} catch (error) {
		return { ok: false, detail: classifySpawnError(error) };
	}
}

export async function pullImage(podmanPath: string, image: string): Promise<{ ok: boolean; detail: string }> {
	assertBin(podmanPath);
	if (!IMAGE_RE.test(image)) {
		return { ok: false, detail: 'Invalid image.' };
	}
	try {
		const result = await runCommand(podmanPath, ['pull', image], 600_000);
		const detail = (result.stdout || result.stderr).trim().split(/\r?\n/).slice(-3).join(' ') || `exit ${result.exitCode}`;
		return { ok: result.exitCode === 0 && !result.timedOut, detail };
	} catch (error) {
		return { ok: false, detail: classifySpawnError(error) };
	}
}

function dockerMachineRefuse(): { ok: boolean; detail: string } {
	return {
		ok: false,
		detail: 'Docker does not use Podman machines. Start Docker Desktop (or the docker service) if the engine is down.',
	};
}

function wrapMachineOutput(onOutput?: CommandOutputHandler): CommandOutputHandler | undefined {
	if (!onOutput) {
		return undefined;
	}
	let last = '';
	return (chunk, stream) => {
		const line = lastActionableMachineLine(chunk) || stripMachineNotes(chunk).split(/\r?\n/).find((item) => item.length > 2) || '';
		if (!line || line === last || isIgnorableMachineNote(line)) {
			return;
		}
		last = line;
		onOutput(line, stream);
	};
}

function machineCommandDetail(stdout: string, stderr: string, exitCode: number, timedOut: boolean): string {
	const combined = stripMachineNotes(`${stdout}\n${stderr}`);
	const last = lastActionableMachineLine(combined);
	if (timedOut) {
		return last
			? `The Linux VM did not come up in time. ${last}`
			: 'The Linux VM did not come up in time.';
	}
	return last || combined || `exit ${exitCode}`;
}

async function waitUntilMachineReady(
	podmanPath: string,
	name: string | undefined,
	timeoutMs: number,
	onOutput?: CommandOutputHandler,
): Promise<{ ok: boolean; detail: string }> {
	const deadline = Date.now() + timeoutMs;
	let lastEmit = 0;
	while (Date.now() < deadline) {
		const machines = await listPodmanMachines(podmanPath);
		const target = name
			? machines.find((item) => item.name === name)
			: machines.find((item) => item.running) || machines[0];
		if (target?.running) {
			const info = await getPodmanEngineInfo(podmanPath);
			if (info.ok) {
				return { ok: true, detail: `Machine ${target.name} running.` };
			}
		}
		if (Date.now() - lastEmit >= 4_000) {
			onOutput?.('Waiting for the Linux VM…', 'stdout');
			lastEmit = Date.now();
		}
		await sleep(POLL_MS);
	}
	return { ok: false, detail: 'The Linux VM did not come up in time.' };
}

export async function startPodmanMachine(
	podmanPath: string,
	name?: string,
	options?: MachineOpOptions,
): Promise<{ ok: boolean; detail: string }> {
	if (looksLikeDockerBin(podmanPath)) {
		return dockerMachineRefuse();
	}
	assertBin(podmanPath);
	const args = name && NAME_RE.test(name) ? ['machine', 'start', name] : ['machine', 'start'];
	const onOutput = wrapMachineOutput(options?.onOutput);
	const startTimeout = options?.startTimeoutMs ?? options?.timeoutMs ?? DEFAULT_START_TIMEOUT_MS;
	try {
		const existing = await listPodmanMachines(podmanPath);
		const alreadyUp = name
			? existing.find((item) => item.name === name && item.running)
			: existing.find((item) => item.running);
		if (alreadyUp) {
			const info = await getPodmanEngineInfo(podmanPath);
			if (info.ok) {
				return { ok: true, detail: `Machine ${alreadyUp.name} already running.` };
			}
		}
		const result = await runCommand(podmanPath, args, startTimeout, onOutput);
		const after = await listPodmanMachines(podmanPath);
		const target = name ? after.find((item) => item.name === name) : after.find((item) => item.running) || after[0];
		const settleMs = result.timedOut
			? 15_000
			: (result.exitCode === 0 || target?.starting || target?.running)
				? ENGINE_SETTLE_MS
				: 12_000;
		const ready = await waitUntilMachineReady(podmanPath, name, settleMs, onOutput);
		if (ready.ok) {
			return ready;
		}
		const raw = machineCommandDetail(result.stdout, result.stderr, result.exitCode, result.timedOut);
		return { ok: false, detail: classifyMachineOpFailure(raw) };
	} catch (error) {
		return { ok: false, detail: classifySpawnError(error) };
	}
}

export async function initPodmanMachine(
	podmanPath: string,
	name?: string,
	options?: MachineOpOptions,
): Promise<{ ok: boolean; detail: string }> {
	if (looksLikeDockerBin(podmanPath)) {
		return dockerMachineRefuse();
	}
	assertBin(podmanPath);
	const args = name && NAME_RE.test(name) ? ['machine', 'init', name] : ['machine', 'init'];
	const onOutput = wrapMachineOutput(options?.onOutput);
	try {
		const result = await runCommand(
			podmanPath,
			args,
			options?.initTimeoutMs ?? options?.timeoutMs ?? 600_000,
			onOutput,
		);
		const after = await listPodmanMachines(podmanPath);
		if (after.length > 0 && !result.timedOut) {
			return { ok: true, detail: `Machine ${after[0].name} created.` };
		}
		const raw = machineCommandDetail(result.stdout, result.stderr, result.exitCode, result.timedOut);
		return { ok: result.exitCode === 0 && !result.timedOut, detail: result.exitCode === 0 && !result.timedOut ? raw : classifyMachineOpFailure(raw) };
	} catch (error) {
		return { ok: false, detail: classifySpawnError(error) };
	}
}

export async function removePodmanMachine(
	podmanPath: string,
	name?: string,
	options?: MachineOpOptions,
): Promise<{ ok: boolean; detail: string }> {
	if (looksLikeDockerBin(podmanPath)) {
		return dockerMachineRefuse();
	}
	assertBin(podmanPath);
	const args = name && NAME_RE.test(name) ? ['machine', 'rm', '-f', name] : ['machine', 'rm', '-f'];
	try {
		if (name && NAME_RE.test(name)) {
			await terminateWslDistro(name);
		}
		const result = await runCommand(podmanPath, args, options?.timeoutMs ?? 120_000, options?.onOutput);
		const after = await listPodmanMachines(podmanPath);
		const stillThere = name
			? after.some((item) => item.name === name)
			: after.length > 0;
		if (!stillThere) {
			return { ok: true, detail: `Machine ${name || 'default'} removed.` };
		}
		const raw = machineCommandDetail(result.stdout, result.stderr, result.exitCode, result.timedOut);
		return { ok: false, detail: classifyMachineOpFailure(raw) };
	} catch (error) {
		return { ok: false, detail: classifySpawnError(error) };
	}
}

async function initDefaultMachine(
	podmanPath: string,
	options?: MachineOpOptions,
): Promise<{ ok: boolean; detail: string }> {
	const inited = await initPodmanMachine(podmanPath, undefined, options);
	const afterInit = await listPodmanMachines(podmanPath);
	if (afterInit.length === 0) {
		return inited.ok
			? { ok: false, detail: 'Machine init finished but no machine exists.' }
			: inited;
	}
	return { ok: true, detail: inited.detail };
}

/** User-triggered: create a machine if none exist, then start it. Never called automatically. */
export async function bootstrapPodmanMachine(
	podmanPath: string,
	options?: MachineOpOptions,
): Promise<{ ok: boolean; detail: string }> {
	await ensureWindowsCgroupV2(options?.onOutput);

	let machines = await listPodmanMachines(podmanPath);
	if (machines.length === 0) {
		const inited = await initDefaultMachine(podmanPath, options);
		if (inited.ok === false && (await listPodmanMachines(podmanPath)).length === 0) {
			return inited;
		}
	}

	machines = await listPodmanMachines(podmanPath);
	const running = machines.find((item) => item.running);
	if (running) {
		const info = await getPodmanEngineInfo(podmanPath);
		if (info.ok) {
			return { ok: true, detail: `Machine ${running.name} already running.` };
		}
	}

	const target = machines[0];
	let started = await startPodmanMachine(podmanPath, target?.name, options);
	if (started.ok) {
		return started;
	}
	if (!isSshNotRunningFailure(started.detail)) {
		return started;
	}

	options?.onOutput?.('Retrying Linux VM start…', 'stdout');
	await sleep(START_RETRY_WAIT_MS);
	if (target?.name) {
		await terminateWslDistro(target.name);
	}
	started = await startPodmanMachine(podmanPath, target?.name, options);
	if (started.ok) {
		return started;
	}

	const afterRetry = await listPodmanMachines(podmanPath);
	const dead = target
		? afterRetry.find((item) => item.name === target.name) || afterRetry[0]
		: afterRetry[0];
	const brokenFromBirth = Boolean(dead && !dead.running && machineNeverRan(dead.lastUp));
	if (!brokenFromBirth || !isSshNotRunningFailure(started.detail)) {
		return started;
	}

	options?.onOutput?.('The Linux VM never started. Recreating it…', 'stdout');
	const removed = await removePodmanMachine(podmanPath, dead.name, options);
	const leftover = (await listPodmanMachines(podmanPath)).some((item) => item.name === dead.name);
	if (leftover) {
		return removed.ok
			? { ok: false, detail: 'Could not remove the never-started Linux VM.' }
			: removed;
	}
	const recreated = await initDefaultMachine(podmanPath, options);
	if ((await listPodmanMachines(podmanPath)).length === 0) {
		return recreated;
	}
	const fresh = await listPodmanMachines(podmanPath);
	return startPodmanMachine(podmanPath, fresh[0]?.name, options);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function stopPodmanMachine(
	podmanPath: string,
	name?: string,
	timeoutMs = 120_000,
): Promise<{ ok: boolean; detail: string }> {
	if (looksLikeDockerBin(podmanPath)) {
		return dockerMachineRefuse();
	}
	assertBin(podmanPath);
	const args = name && NAME_RE.test(name) ? ['machine', 'stop', name] : ['machine', 'stop'];
	try {
		const result = await runCommand(podmanPath, args, timeoutMs);
		const detail = (result.stdout || result.stderr).trim() || `exit ${result.exitCode}`;
		return { ok: result.exitCode === 0 && !result.timedOut, detail };
	} catch (error) {
		return { ok: false, detail: classifySpawnError(error) };
	}
}

export async function stopContainer(podmanPath: string, nameOrId: string): Promise<{ ok: boolean; detail: string }> {
	assertBin(podmanPath);
	if (!NAME_RE.test(nameOrId) && !/^[a-f0-9]+$/i.test(nameOrId)) {
		return { ok: false, detail: 'Invalid container id.' };
	}
	try {
		const result = await runCommand(podmanPath, ['stop', '-t', '5', nameOrId], 60_000);
		await runCommand(podmanPath, ['rm', '-f', nameOrId], 30_000).catch(() => undefined);
		const detail = (result.stdout || result.stderr).trim() || `exit ${result.exitCode}`;
		return { ok: result.exitCode === 0 && !result.timedOut, detail };
	} catch (error) {
		return { ok: false, detail: classifySpawnError(error) };
	}
}

export async function stopContainersForImage(podmanPath: string, image: string): Promise<number> {
	const containers = await listPodmanContainers(podmanPath);
	const imageBase = image.split(':')[0] || image;
	let stopped = 0;
	for (const item of containers) {
		const match = item.image === image || item.image.startsWith(`${imageBase}:`) || item.image.includes(imageBase);
		if (!match) {
			continue;
		}
		if (item.state === 'running' || item.state === 'created' || item.state === 'paused') {
			await stopContainer(podmanPath, item.name || item.id);
			stopped += 1;
		}
	}
	return stopped;
}

export function platformNeedsPodmanMachine(): boolean {
	return process.platform === 'win32' || process.platform === 'darwin';
}

export async function ensureMachineRunning(podmanPath: string): Promise<{ ok: boolean; detail: string }> {
	if (looksLikeDockerBin(podmanPath)) {
		const info = await getDockerInfo(podmanPath);
		return info.ok
			? { ok: true, detail: info.version ? `Docker engine ${info.version}.` : 'Docker engine is up.' }
			: { ok: false, detail: info.error || 'Docker engine is not running. Start Docker Desktop, then try again.' };
	}
	const machines = await listPodmanMachines(podmanPath);
	if (machines.length === 0) {
		if (platformNeedsPodmanMachine()) {
			return { ok: false, detail: 'No Podman machine. Initialize one from the Podman panel.' };
		}
		const version = await getPodmanVersion(podmanPath);
		return version.ok
			? { ok: true, detail: 'No podman machine (native runtime).' }
			: { ok: false, detail: version.error || 'Podman unavailable.' };
	}
	const running = machines.find((item) => item.running) || machines[0];
	if (running.running) {
		return { ok: true, detail: `Machine ${running.name} running.` };
	}
	return startPodmanMachine(podmanPath, running.name);
}

const QUIT_TEARDOWN_MS = 45_000;
const QUIT_MACHINE_STOP_MS = 40_000;

function withDeadline<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
	return new Promise((resolve) => {
		const timer = setTimeout(() => resolve(fallback), ms);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			() => {
				clearTimeout(timer);
				resolve(fallback);
			},
		);
	});
}

/** Best-effort stop of Hawaldar-named tool containers (`hw-*` / `hwsvc-*`). */
export async function stopHawaldarContainers(bin: string): Promise<{ stopped: number; detail: string }> {
	try {
		assertBin(bin);
		const containers = await listPodmanContainers(bin);
		const ours = containers.filter((item) => (
			item.hawaldar && (item.state === 'running' || item.state === 'created' || item.state === 'paused')
		));
		let stopped = 0;
		for (const item of ours) {
			await stopContainer(bin, item.name || item.id);
			stopped += 1;
		}
		return {
			stopped,
			detail: stopped ? `Stopped ${stopped} Hawaldar container(s).` : 'No Hawaldar containers running.',
		};
	} catch (error) {
		return { stopped: 0, detail: classifySpawnError(error) };
	}
}

/** Stop every listed Podman machine. Missing CLI / no machines is success (best-effort). */
export async function stopAllPodmanMachines(
	podmanPath: string,
	timeoutMs = QUIT_MACHINE_STOP_MS,
): Promise<{ ok: boolean; detail: string }> {
	if (looksLikeDockerBin(podmanPath)) {
		return { ok: true, detail: 'Docker engine left running.' };
	}
	try {
		assertBin(podmanPath);
	} catch (error) {
		return { ok: true, detail: classifySpawnError(error) };
	}

	const work = (async () => {
		const machines = await listPodmanMachines(podmanPath);
		const targets = machines.filter((item) => item.running || item.starting);
		if (targets.length === 0) {
			if (machines.length === 0) {
				const fallback = await stopPodmanMachine(podmanPath, undefined, Math.min(15_000, timeoutMs));
				return { ok: true, detail: fallback.detail || 'No Podman machines.' };
			}
			return { ok: true, detail: 'No running Podman machines.' };
		}
		const perMachine = Math.max(8_000, Math.floor(timeoutMs / Math.max(targets.length, 1)));
		const notes: string[] = [];
		for (const machine of targets) {
			const result = await stopPodmanMachine(podmanPath, machine.name, perMachine);
			notes.push(result.ok ? `${machine.name} stopped` : `${machine.name}: ${result.detail}`);
		}
		let leftover = (await listPodmanMachines(podmanPath)).filter((item) => item.running || item.starting);
		if (leftover.length > 0) {
			await stopPodmanMachine(podmanPath, undefined, Math.min(12_000, timeoutMs));
			leftover = (await listPodmanMachines(podmanPath)).filter((item) => item.running || item.starting);
		}
		return { ok: leftover.length === 0, detail: notes.join(' ') || 'Podman machines stopped.' };
	})();

	return withDeadline(work, timeoutMs, { ok: true, detail: 'Machine stop timed out.' });
}

/**
 * Confirmed-quit teardown. Never starts anything.
 * Docker: stop Hawaldar containers only (leave Docker Desktop running).
 * Podman: stop Hawaldar containers, then every machine.
 */
export async function teardownRuntimeOnQuit(options: {
	engine: 'podman' | 'docker';
	bin: string;
	timeoutMs?: number;
}): Promise<{ ok: boolean; detail: string }> {
	const timeoutMs = options.timeoutMs ?? QUIT_TEARDOWN_MS;
	const work = (async () => {
		const parts: string[] = [];
		const containers = await stopHawaldarContainers(options.bin);
		parts.push(containers.detail);
		if (options.engine === 'podman' && !looksLikeDockerBin(options.bin)) {
			const machines = await stopAllPodmanMachines(options.bin, Math.min(QUIT_MACHINE_STOP_MS, timeoutMs));
			parts.push(machines.detail);
		}
		return { ok: true, detail: parts.filter(Boolean).join(' ') };
	})();
	return withDeadline(work, timeoutMs, { ok: true, detail: 'Teardown timed out; exiting.' });
}
