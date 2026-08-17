import { PODMAN_MACHINE_SUBJECT, type ApprovalsStore } from './approvals-store';
import {
	bootstrapPodmanMachine,
	ensureMachineRunning,
	getDockerInfo,
	getPodmanVersion,
	listPodmanMachines,
	platformNeedsPodmanMachine,
	type PodmanAvailability,
} from './sandbox/podman-control';
import { setupPodmanRuntime } from './sandbox/podman-provision';
import { engineBin, resolveEnginePath } from './sandbox/podman-path';
import { autoStartMachineIfEnabled, isServiceStarted, MACHINE_STOPPED_DETAIL } from './sandbox/podman-services';
import type { HawaldarSettings } from './settings';
import { aliasedServiceIds, resolveServiceBuildTarget } from './tools/catalog';
import {
	ensureServiceStartedOnce,
	resolveControllableServiceId,
	type PersistServiceSettings,
} from './tools/services';
import {
	USER_DECLINED,
	parseHitlResume,
	type HitlAsk,
	type HitlToolContext,
} from './hitl-gate';

export {
	USER_DECLINED,
	definedToolResult,
	ensurePocApproval,
	hitlToolSchemas,
	parseHitlResume,
	parseHitlSuspendPayload,
	releaseHitlWaiter,
	type HitlAsk,
	type HitlKind,
	type HitlResumeData,
	type HitlSuspendPayload,
	type HitlToolContext,
} from './hitl-gate';

export type HitlGateResult =
	| { status: 'ok'; settings: HawaldarSettings }
	| { status: 'declined'; detail: string }
	| { status: 'failed'; detail: string }
	| { status: 'suspended'; value: unknown };

export interface EnsureRuntimeHitlOptions {
	hitlContext?: HitlToolContext;
	askHitl?: (req: HitlAsk) => Promise<boolean>;
	persist?: PersistServiceSettings;
	onActivity?: (event: { type: 'tool:start' | 'tool:done'; name: string; detail: string; status: 'start' | 'ok' | 'error' }) => void;
	persistEnginePath?: (podmanPath: string) => Promise<void>;
	approvals?: ApprovalsStore;
}

export async function inspectEngine(settings: HawaldarSettings): Promise<{
	up: boolean;
	availability: PodmanAvailability;
	bin: string;
	engine: 'podman' | 'docker';
}> {
	const engine: 'podman' | 'docker' = settings.containerEngine === 'docker' ? 'docker' : 'podman';
	const resolved = resolveEnginePath(engine, settings.podmanPath);
	const bin = resolved.path || engineBin(engine, settings.podmanPath);
	if (!resolved.path) {
		return { up: false, availability: 'not_installed', bin, engine };
	}
	const version = await getPodmanVersion(bin);
	if (!version.ok) {
		const enoent = (version.error || '').includes('ENOENT') || (version.error || '').includes('was not found');
		return { up: false, availability: enoent ? 'not_installed' : 'error', bin, engine };
	}
	if (engine === 'docker') {
		const info = await getDockerInfo(bin);
		return { up: info.ok, availability: info.ok ? 'ok' : 'machine_stopped', bin, engine };
	}
	if (!platformNeedsPodmanMachine()) {
		return { up: true, availability: 'ok', bin, engine };
	}
	const machines = await listPodmanMachines(bin);
	if (machines.length === 0) {
		return { up: false, availability: 'no_machine', bin, engine };
	}
	if (!machines.some((item) => item.running)) {
		return { up: false, availability: 'machine_stopped', bin, engine };
	}
	return { up: true, availability: 'ok', bin, engine };
}

export function podmanAsk(engine: 'podman' | 'docker', availability: PodmanAvailability): HitlAsk {
	if (engine === 'docker') {
		return {
			kind: 'podman',
			title: 'Start the container engine?',
			explanation: 'Hawaldar needs Docker to run this tool. Approve to start it here. You do not need to open Settings → Runtime.',
		};
	}
	if (availability === 'not_installed') {
		return {
			kind: 'podman',
			title: 'Set up Podman?',
			explanation: 'Podman is not installed. Approve to install it and start the Linux VM. You do not need to leave chat for Settings.',
		};
	}
	if (availability === 'no_machine') {
		return {
			kind: 'podman',
			title: 'Create and start the Linux VM?',
			explanation: 'On Windows and macOS, Podman runs containers inside a Linux VM. Approve to create and start it here.',
		};
	}
	return {
		kind: 'podman',
		title: 'Start Podman?',
		explanation: 'Hawaldar needs the container runtime (Podman / the Linux VM) to run this tool. Approve to start it here. You do not need to open Settings → Runtime.',
	};
}

export function toolImageAsk(serviceId: string): HitlAsk {
	const label = serviceId.trim() || 'tool';
	return {
		kind: 'tool-image',
		title: `Start the ${label} image?`,
		explanation: `This tool runs in a contained ${label} image. Approve to build or start it. You do not need to open Settings → Runtime.`,
		serviceId: label,
	};
}

export async function startEngineAfterApproval(
	settings: HawaldarSettings,
	options?: {
		onActivity?: (event: { type: 'tool:start' | 'tool:done'; name: string; detail: string; status: 'start' | 'ok' | 'error' }) => void;
		persistEnginePath?: (podmanPath: string) => Promise<void>;
	},
): Promise<{ ok: boolean; detail: string }> {
	const emit = options?.onActivity;
	const engine: 'podman' | 'docker' = settings.containerEngine === 'docker' ? 'docker' : 'podman';
	const resolved = resolveEnginePath(engine, settings.podmanPath);
	const bin = resolved.path || engineBin(engine, settings.podmanPath);

	if (!resolved.path || (await inspectEngine(settings)).availability === 'not_installed') {
		emit?.({ type: 'tool:start', name: 'podman', detail: 'Setting up Podman…', status: 'start' });
		const setup = await setupPodmanRuntime({
			preferredPath: settings.podmanPath,
			engine,
			persistPath: async (podmanPath) => {
				await options?.persistEnginePath?.(podmanPath);
			},
			onProgress: (progress) => {
				emit?.({
					type: 'tool:start',
					name: 'podman',
					detail: progress.message || progress.step,
					status: 'start',
				});
			},
		});
		emit?.({
			type: 'tool:done',
			name: 'podman',
			detail: setup.ok ? 'Podman is ready' : setup.detail,
			status: setup.ok ? 'ok' : 'error',
		});
		return { ok: setup.ok, detail: setup.detail };
	}

	if (engine === 'docker') {
		emit?.({ type: 'tool:start', name: 'podman', detail: 'Checking Docker…', status: 'start' });
		const info = await getDockerInfo(bin);
		emit?.({
			type: 'tool:done',
			name: 'podman',
			detail: info.ok ? 'Docker is ready' : (info.error || 'Docker is not running.'),
			status: info.ok ? 'ok' : 'error',
		});
		return info.ok
			? { ok: true, detail: 'Docker engine is up.' }
			: { ok: false, detail: info.error || 'Docker is not running. Start Docker Desktop, then retry.' };
	}

	emit?.({ type: 'tool:start', name: 'podman', detail: 'Starting Podman…', status: 'start' });
	const machines = await listPodmanMachines(bin);
	let result: { ok: boolean; detail: string };
	if (platformNeedsPodmanMachine() && machines.length === 0) {
		result = await bootstrapPodmanMachine(bin);
	} else {
		result = await ensureMachineRunning(bin);
		if (!result.ok && platformNeedsPodmanMachine()) {
			result = await bootstrapPodmanMachine(bin);
		}
	}
	emit?.({
		type: 'tool:done',
		name: 'podman',
		detail: result.ok ? 'Podman is ready' : result.detail,
		status: result.ok ? 'ok' : 'error',
	});
	return result;
}

function persistablePodmanStart(engine: 'podman' | 'docker', availability: PodmanAvailability): boolean {
	return engine === 'podman' && availability === 'machine_stopped';
}

async function hasRemembered(
	store: ApprovalsStore | undefined,
	kind: 'podman' | 'tool-image',
	subjects: string[],
): Promise<boolean> {
	if (!store) {
		return false;
	}
	for (const subject of subjects) {
		if (await store.has(kind, subject)) {
			return true;
		}
	}
	return false;
}

/**
 * HITL gate: Podman approval, then tool-image approval.
 * IPC `askHitl` only — never Mastra suspend/resumeStream (that path crashed
 * the app after Approve). Remembered SQLite approvals skip `podman`
 * (existing-machine start only) and `tool-image`. Install / create-machine
 * still asks. `poc-probe` is never stored.
 */
export async function ensureRuntimeHitl(
	settings: HawaldarSettings,
	serviceId: string,
	options?: EnsureRuntimeHitlOptions,
): Promise<HitlGateResult> {
	const resume = parseHitlResume(
		options?.hitlContext?.agent?.resumeData ?? options?.hitlContext?.workflow?.resumeData,
	);
	if (resume && resume.approved === false) {
		return { status: 'declined', detail: USER_DECLINED };
	}

	const request = async (ask: HitlAsk): Promise<HitlGateResult | undefined> => {
		if (!options?.askHitl) {
			return { status: 'declined', detail: USER_DECLINED };
		}
		const approved = await options.askHitl(ask);
		if (!approved) {
			return { status: 'declined', detail: USER_DECLINED };
		}
		return undefined;
	};

	const store = options?.approvals;
	const remember = async (kind: 'podman' | 'tool-image', subject: string) => {
		await store?.remember(kind, subject);
	};

	let current = settings;
	const engine = await inspectEngine(current);
	if (!engine.up) {
		const approvedEngine = resume?.kind === 'podman' && resume.approved === true;
		const canRememberStart = persistablePodmanStart(engine.engine, engine.availability);
		const rememberedStart = canRememberStart
			&& await hasRemembered(store, 'podman', [PODMAN_MACHINE_SUBJECT]);
		const autoStartEligible = current.autoStartMachine
			&& engine.engine === 'podman'
			&& engine.availability === 'machine_stopped';
		if (!approvedEngine && !autoStartEligible && !rememberedStart) {
			const blocked = await request(podmanAsk(engine.engine, engine.availability));
			if (blocked) {
				return blocked;
			}
			if (canRememberStart) {
				await remember('podman', PODMAN_MACHINE_SUBJECT);
			}
		}
		if (approvedEngine && canRememberStart) {
			await remember('podman', PODMAN_MACHINE_SUBJECT);
		}
		if (rememberedStart) {
			await remember('podman', PODMAN_MACHINE_SUBJECT);
		}
		const startExistingOnly = (autoStartEligible || rememberedStart) && !approvedEngine;
		if (startExistingOnly) {
			options?.onActivity?.({
				type: 'tool:start',
				name: 'podman',
				detail: 'Starting Podman…',
				status: 'start',
			});
			const started = await autoStartMachineIfEnabled(current, {
				force: rememberedStart,
				onOutput: (line) => {
					options?.onActivity?.({
						type: 'tool:start',
						name: 'podman',
						detail: line,
						status: 'start',
					});
				},
			});
			options?.onActivity?.({
				type: 'tool:done',
				name: 'podman',
				detail: started.ok ? 'Podman is ready' : (started.detail || MACHINE_STOPPED_DETAIL),
				status: started.ok ? 'ok' : 'error',
			});
			if (!started.ok) {
				return { status: 'failed', detail: started.detail || MACHINE_STOPPED_DETAIL };
			}
		} else {
			const started = await startEngineAfterApproval(current, {
				onActivity: options?.onActivity,
				persistEnginePath: options?.persistEnginePath,
			});
			if (!started.ok) {
				return { status: 'failed', detail: started.detail };
			}
		}
	}

	const resolved = resolveControllableServiceId(current, serviceId);
	if (!resolved.ok) {
		return { status: 'failed', detail: resolved.reason };
	}
	if (isServiceStarted(current, resolved.serviceId)) {
		await remember('tool-image', resolved.serviceId);
		return { status: 'ok', settings: current };
	}

	const imageSubjects = aliasedServiceIds(resolved.serviceId);
	const approvedImage = resume?.kind === 'tool-image'
		&& resume.approved === true
		&& (!resume.serviceId || resume.serviceId === resolved.serviceId || resume.serviceId === resolveServiceBuildTarget(resolved.serviceId));
	const rememberedImage = await hasRemembered(store, 'tool-image', imageSubjects);
	if (!approvedImage && !rememberedImage) {
		const blocked = await request(toolImageAsk(resolved.serviceId));
		if (blocked) {
			return blocked;
		}
		await remember('tool-image', resolved.serviceId);
	}
	if (approvedImage || rememberedImage) {
		await remember('tool-image', resolved.serviceId);
	}

	options?.onActivity?.({
		type: 'tool:start',
		name: resolved.serviceId,
		detail: `Starting ${resolved.serviceId} image…`,
		status: 'start',
	});
	const auto = await ensureServiceStartedOnce(current, resolved.serviceId, options?.persist);
	options?.onActivity?.({
		type: 'tool:done',
		name: resolved.serviceId,
		detail: auto.ok ? `Starting ${resolved.serviceId} image…` : auto.detail,
		status: auto.ok ? 'ok' : 'error',
	});
	if (!auto.ok) {
		return { status: 'failed', detail: auto.detail };
	}
	return { status: 'ok', settings: auto.settings };
}
