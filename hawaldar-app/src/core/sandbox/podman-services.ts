import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	aliasedServiceIds,
	isServiceControlTool,
	resolveCatalogServiceImage,
	resolveServiceBuildTarget,
	serviceLane,
	SERVICE_LANE_META,
	SERVICE_LANE_ORDER,
	TOOL_CATALOG,
} from '../tools/catalog';
import type { HawaldarSettings } from '../settings';
import { collectHostInfo, type HostInfo } from './host-info';
import { containerContextRel, hasMinContainerfile } from './images';
import {
	buildImage,
	getDockerInfo,
	getPodmanVersion,
	imageExists,
	listPodmanContainers,
	listPodmanMachines,
	platformNeedsPodmanMachine,
	pullImage,
	startPodmanMachine,
	stopContainersForImage,
	type MachineOpOptions,
	type PodmanAvailability,
	type PodmanServiceInfo,
	type PodmanStatusSnapshot,
} from './podman-control';
import {
	engineBin,
	listEngineAlternatives,
	podmanInstallHint,
	resolveEnginePath,
	type EngineAlternative,
} from './podman-path';
import { ensureJuiceShopDaemon, isJuiceShopService, JUICE_SHOP_URL, stopJuiceShopDaemon } from '../tools/juice-shop';
import { ensureWorkspace } from './workspace';

export interface ToolServiceDef {
	id: string;
	label: string;
	image: string;
	buildable: boolean;
	lane: ReturnType<typeof serviceLane>;
	laneLabel: string;
	webLab: boolean;
}

export type ServiceSettingsPatch = Partial<Pick<HawaldarSettings, 'startedServices' | 'toolImages'>>;

const ENGINE_CONTROL_KEYS = new Set([
	'podman',
	'machine',
	'podman-machine',
	'docker',
	'docker-desktop',
	'desktop',
	'wsl',
]);

/** Exact operator-facing copy when the VM is down and auto-start is off. */
export const MACHINE_STOPPED_DETAIL = 'Linux VM is stopped — start it in Runtime.';

export interface AutoStartMachineResult {
	attempted: boolean;
	ok: boolean;
	detail: string;
}

export interface AutoStartMachineOptions extends MachineOpOptions {
	/** Start an existing stopped machine even when autoStartMachine is off (remembered HITL). Never creates a machine. */
	force?: boolean;
}

let autoStartInFlight: Promise<AutoStartMachineResult> | null = null;

/**
 * When auto-start is enabled (or `force` after a remembered HITL approve),
 * start an existing stopped Podman machine. Never creates a machine — that
 * stays a human / HITL action.
 */
export async function autoStartMachineIfEnabled(
	settings: HawaldarSettings,
	options?: AutoStartMachineOptions,
): Promise<AutoStartMachineResult> {
	const { force, ...machineOpts } = options ?? {};
	if (!settings.autoStartMachine && !force) {
		return { attempted: false, ok: true, detail: '' };
	}
	const engine: 'podman' | 'docker' = settings.containerEngine === 'docker' ? 'docker' : 'podman';
	if (engine === 'docker' || !platformNeedsPodmanMachine()) {
		return { attempted: false, ok: true, detail: '' };
	}

	const resolved = resolveEnginePath(engine, settings.podmanPath);
	const bin = resolved.path || engineBin(engine, settings.podmanPath);
	if (!resolved.path) {
		return { attempted: false, ok: false, detail: resolved.error || 'Podman not found.' };
	}

	const version = await getPodmanVersion(bin);
	if (!version.ok) {
		return { attempted: false, ok: false, detail: version.error || 'Podman unavailable.' };
	}

	const machines = await listPodmanMachines(bin);
	if (machines.length === 0) {
		return {
			attempted: false,
			ok: false,
			detail: 'No Podman machine. Initialize one from the Podman panel first.',
		};
	}
	if (machines.some((item) => item.running)) {
		return { attempted: false, ok: true, detail: '' };
	}

	const run = async (): Promise<AutoStartMachineResult> => {
		const target = machines.find((item) => !item.running) || machines[0];
		const started = await startPodmanMachine(bin, target?.name, machineOpts);
		return {
			attempted: true,
			ok: started.ok,
			detail: started.detail,
		};
	};

	if (autoStartInFlight) {
		return autoStartInFlight;
	}
	autoStartInFlight = run().finally(() => {
		autoStartInFlight = null;
	});
	return autoStartInFlight;
}

export function isEngineControlServiceId(id: string): boolean {
	const key = id.trim().toLowerCase().replace(/[\s_]+/g, '-');
	if (ENGINE_CONTROL_KEYS.has(key)) {
		return true;
	}
	if (key.includes('podman-machine') || key.includes('docker-desktop')) {
		return true;
	}
	return /\bpodman\b.*\bmachine\b/.test(key.replace(/-/g, ' '));
}

function engineControlRefuse(): { settings: ServiceSettingsPatch; detail: string; ok: false } {
	return {
		settings: {},
		detail: 'The Linux VM and container engine are human-only. Start the VM in Runtime.',
		ok: false,
	};
}

export function listToolServices(settings: HawaldarSettings): ToolServiceDef[] {
	const map = new Map<string, ToolServiceDef>();
	for (const tool of TOOL_CATALOG) {
		if (isServiceControlTool(tool.id) || !tool.image) {
			continue;
		}
		if (!map.has(tool.agentId)) {
			const buildable = hasMinContainerfile(resolveServiceBuildTarget(tool.agentId));
			const lane = serviceLane(tool.agentId);
			const meta = SERVICE_LANE_META[lane];
			map.set(tool.agentId, {
				id: tool.agentId,
				label: tool.agentId,
				image: resolveCatalogServiceImage(
					tool.agentId,
					settings.toolImages[tool.agentId],
					tool.image,
				),
				buildable,
				lane,
				laneLabel: meta.label,
				webLab: meta.webLab,
			});
		}
	}
	for (const tool of settings.customTools) {
		const key = tool.agentId || tool.id;
		if (isEngineControlServiceId(key) || isServiceControlTool(key)) {
			continue;
		}
		if (!map.has(key)) {
			const lane = serviceLane(key);
			const meta = SERVICE_LANE_META[lane];
			map.set(key, {
				id: key,
				label: tool.title || key,
				image: resolveCatalogServiceImage(key, settings.toolImages[key], tool.image),
				buildable: false,
				lane,
				laneLabel: meta.label,
				webLab: meta.webLab,
			});
		}
	}
	const rank = new Map(SERVICE_LANE_ORDER.map((lane, index) => [lane, index]));
	return [...map.values()].sort((a, b) => (rank.get(a.lane) ?? 99) - (rank.get(b.lane) ?? 99));
}

export function isServiceStarted(settings: HawaldarSettings, agentId: string): boolean {
	return aliasedServiceIds(agentId).some((id) => settings.startedServices.includes(id));
}

function waitingServices(settings: HawaldarSettings, detail: string): PodmanServiceInfo[] {
	return listToolServices(settings).map((item) => ({
		id: item.id,
		label: item.label,
		image: item.image,
		started: settings.startedServices.includes(item.id),
		imagePresent: false,
		detail,
		lane: item.lane,
		laneLabel: item.laneLabel,
		webLab: item.webLab,
	}));
}

function notInstalledHint(host: HostInfo, engine: 'podman' | 'docker', alternatives: EngineAlternative[]): string {
	const dockerAvailable = alternatives.some((item) => item.engine === 'docker' && item.available);
	const podmanAvailable = alternatives.some((item) => item.engine === 'podman' && item.available);
	if (engine === 'docker') {
		if (host.os === 'linux' && !podmanAvailable) {
			return 'Docker was not found. Install docker or podman with your distro packages, then Locate. Hawaldar will not sudo. Or browse to an existing docker binary.';
		}
		return 'Docker was not found. Hawaldar does not install Docker Desktop. Browse to an existing Docker CLI, or Set up Podman — that is the install this app owns.';
	}
	if (host.os === 'linux') {
		return dockerAvailable
			? 'Podman was not found. Use Docker instead, or install Podman with your distro packages. Hawaldar will not sudo.'
			: 'Neither Podman nor Docker was found. Install one with your distro packages, then Locate. Hawaldar will not sudo.';
	}
	return podmanInstallHint();
}

async function readyServices(settings: HawaldarSettings, bin: string): Promise<{
	containers: PodmanStatusSnapshot['containers'];
	services: PodmanServiceInfo[];
}> {
	const containers = await listPodmanContainers(bin);
	const services: PodmanServiceInfo[] = [];
	for (const item of listToolServices(settings)) {
		const started = settings.startedServices.includes(item.id);
		const present = await imageExists(bin, item.image);
		const running = containers.filter(
			(c) => c.state === 'running' && (c.image.includes(item.image.split(':')[0] || item.id) || c.name.includes(item.id)),
		).length;
		services.push({
			id: item.id,
			label: item.label,
			image: item.image,
			started,
			imagePresent: present,
			lane: item.lane,
			laneLabel: item.laneLabel,
			webLab: item.webLab,
			detail: started
				? (present
					? (running > 0 ? `${running} container(s) running` : 'Ready (minimal image)')
					: (item.buildable ? 'Started but image missing — rebuild on next toggle' : 'Started but image missing'))
				: serviceStoppedDetail(item),
		});
	}
	return { containers, services };
}

function serviceStoppedDetail(item: ToolServiceDef): string {
	if (item.webLab) {
		return item.buildable
			? 'Stopped · toggle on to build (needed for Juice Shop)'
			: 'Stopped · toggle on to pull (needed for Juice Shop)';
	}
	if (item.lane === 'web-optional') {
		return item.buildable
			? 'Stopped · optional for Juice Shop · toggle on to build'
			: 'Stopped · optional for Juice Shop';
	}
	if (item.buildable) {
		return 'Stopped · not needed for a localhost web lab · toggle on to build';
	}
	return 'Stopped · not needed for a localhost web lab';
}

export async function buildPodmanStatus(settings: HawaldarSettings): Promise<PodmanStatusSnapshot> {
	const host = collectHostInfo();
	const engine: 'podman' | 'docker' = settings.containerEngine === 'docker' ? 'docker' : 'podman';
	const alternatives = listEngineAlternatives(engine, settings.podmanPath);
	const resolved = resolveEnginePath(engine, settings.podmanPath);
	const bin = resolved.path || engineBin(engine, settings.podmanPath);
	const base = {
		engine,
		host,
		alternatives,
		resolvedPath: resolved.path || settings.podmanPath || (engine === 'docker' ? 'docker' : 'podman'),
		autoStartMachine: settings.autoStartMachine,
		canInitMachine: false,
		workspace: ensureWorkspace(),
	};

	if (!resolved.path) {
		return {
			...base,
			ok: false,
			availability: 'not_installed',
			version: '',
			error: resolved.error,
			hint: notInstalledHint(host, engine, alternatives),
			machines: [],
			containers: [],
			services: waitingServices(settings, 'waiting for runtime'),
		};
	}

	const version = await getPodmanVersion(bin);
	if (!version.ok) {
		const enoent = (version.error || '').includes('ENOENT') || (version.error || '').includes('was not found');
		const availability: PodmanAvailability = enoent ? 'not_installed' : 'error';
		return {
			...base,
			ok: false,
			availability,
			version: '',
			error: version.error,
			hint: enoent ? notInstalledHint(host, engine, alternatives) : undefined,
			machines: [],
			containers: [],
			services: waitingServices(settings, 'waiting for runtime'),
		};
	}

	if (engine === 'docker') {
		const info = await getDockerInfo(bin);
		if (!info.ok) {
			return {
				...base,
				ok: false,
				availability: 'machine_stopped',
				version: version.version,
				error: info.error,
				hint: host.os === 'linux'
					? 'The Docker CLI is here, but the daemon is not running. Start the docker service, then refresh.'
					: 'The Docker CLI is here, but the engine is not running. Start Docker Desktop, then refresh.',
				machines: [],
				containers: [],
				services: waitingServices(settings, 'waiting for runtime'),
			};
		}
		const ready = await readyServices(settings, bin);
		return {
			...base,
			ok: true,
			availability: 'ok',
			version: version.version,
			machines: [],
			containers: ready.containers,
			services: ready.services,
		};
	}

	const machines = await listPodmanMachines(bin);
	const needsMachine = platformNeedsPodmanMachine();
	const machineRunning = machines.some((item) => item.running);

	if (needsMachine && machines.length === 0) {
		return {
			...base,
			ok: false,
			availability: 'no_machine',
			version: version.version,
			hint: 'On Windows and macOS, Podman runs containers inside a Linux VM. Set up Podman creates and starts it. Services stay off until you toggle them.',
			machines,
			containers: [],
			services: waitingServices(settings, 'waiting for runtime'),
			canInitMachine: true,
		};
	}

	if (machines.length > 0 && !machineRunning) {
		return {
			...base,
			ok: false,
			availability: 'machine_stopped',
			version: version.version,
			hint: 'The runtime is installed, but the Linux VM is stopped. Start it before toggling tool services.',
			machines,
			containers: [],
			services: waitingServices(settings, 'waiting for runtime'),
		};
	}

	const ready = await readyServices(settings, bin);
	return {
		...base,
		ok: true,
		availability: 'ok',
		version: version.version,
		machines,
		containers: ready.containers,
		services: ready.services,
	};
}

export async function startToolService(
	settings: HawaldarSettings,
	serviceId: string,
): Promise<{
	settings: ServiceSettingsPatch;
	detail: string;
	ok: boolean;
}> {
	if (isEngineControlServiceId(serviceId)) {
		return engineControlRefuse();
	}
	const buildId = resolveServiceBuildTarget(serviceId);
	const service = listToolServices(settings).find((item) => item.id === buildId)
		?? listToolServices(settings).find((item) => item.id === serviceId);
	if (!service) {
		return { settings: {}, detail: `Unknown service: ${serviceId}`, ok: false };
	}

	const engine: 'podman' | 'docker' = settings.containerEngine === 'docker' ? 'docker' : 'podman';
	const bin = engineBin(engine, settings.podmanPath);

	if (engine === 'docker') {
		const info = await getDockerInfo(bin);
		if (!info.ok) {
			return {
				settings: {},
				detail: info.error || 'Docker engine is not running. Start Docker Desktop (or the docker service), then try again.',
				ok: false,
			};
		}
	} else if (settings.autoStartMachine) {
		const auto = await autoStartMachineIfEnabled(settings);
		if (!auto.ok) {
			return { settings: {}, detail: auto.detail || MACHINE_STOPPED_DETAIL, ok: false };
		}
	} else {
		const machines = await listPodmanMachines(bin);
		if (platformNeedsPodmanMachine() && machines.length === 0) {
			return {
				settings: {},
				detail: 'No Podman machine. Initialize one from the Podman panel first.',
				ok: false,
			};
		}
		if (machines.length > 0 && !machines.some((item) => item.running)) {
			return {
				settings: {},
				detail: MACHINE_STOPPED_DETAIL,
				ok: false,
			};
		}
	}

	const image = service.image;
	const present = await imageExists(bin, image);
	if (!present) {
		if (service.buildable) {
			const contextDir = path.join(settings.extensionPath, containerContextRel(buildId));
			if (!fs.existsSync(path.join(contextDir, 'Containerfile'))) {
				return { settings: {}, detail: `Missing Containerfile at ${contextDir}`, ok: false };
			}
			const built = await buildImage(bin, image, contextDir);
			if (!built.ok) {
				return { settings: {}, detail: `Build failed: ${built.detail}`, ok: false };
			}
		} else {
			const pulled = await pullImage(bin, image);
			if (!pulled.ok) {
				return { settings: {}, detail: `Pull failed: ${pulled.detail}`, ok: false };
			}
		}
	}

	if (isJuiceShopService(buildId)) {
		const daemon = await ensureJuiceShopDaemon(settings);
		if (!daemon.ok) {
			return { settings: {}, detail: `Image ready but daemon failed: ${daemon.detail}`, ok: false };
		}
	}

	const startedServices = [...settings.startedServices];
	for (const id of aliasedServiceIds(serviceId)) {
		if (!startedServices.includes(id)) {
			startedServices.push(id);
		}
	}

	const detail = isJuiceShopService(buildId)
		? `${serviceId} started · ${JUICE_SHOP_URL}`
		: (service.buildable
			? `${serviceId} started · minimal image ${image}`
			: `${serviceId} started · image ready`);

	return {
		ok: true,
		detail,
		settings: {
			startedServices,
			toolImages: { ...settings.toolImages, [serviceId]: image, [buildId]: image },
		},
	};
}

export async function stopToolService(
	settings: HawaldarSettings,
	serviceId: string,
): Promise<{ settings: ServiceSettingsPatch; detail: string; ok: boolean }> {
	if (isEngineControlServiceId(serviceId)) {
		return engineControlRefuse();
	}
	const buildId = resolveServiceBuildTarget(serviceId);
	const service = listToolServices(settings).find((item) => item.id === serviceId)
		?? listToolServices(settings).find((item) => item.id === buildId);
	if (!service) {
		return { settings: {}, detail: `Unknown service: ${serviceId}`, ok: false };
	}

	const engine: 'podman' | 'docker' = settings.containerEngine === 'docker' ? 'docker' : 'podman';
	if (isJuiceShopService(buildId)) {
		await stopJuiceShopDaemon(settings);
	}
	const stopped = await stopContainersForImage(engineBin(engine, settings.podmanPath), service.image);
	const drop = new Set(aliasedServiceIds(serviceId));
	const startedServices = settings.startedServices.filter((id) => !drop.has(id));
	return {
		ok: true,
		detail: `${serviceId} stopped${stopped ? ` · removed ${stopped} container(s)` : ''}`,
		settings: { startedServices },
	};
}

export function serviceRequiredMessage(agentId: string): string {
	return `Container service "${agentId}" is stopped. Call start_service with agentId "${agentId}" and retry. An in-app approval is required to start Podman or the image.`;
}
