import * as fs from 'node:fs';
import * as path from 'node:path';
import { TOOL_CATALOG } from '../tools/catalog';
import type { HawaldarSettings } from '../settings';
import { collectHostInfo, type HostInfo } from './host-info';
import { containerContextRel, hasMinContainerfile, minImageFor } from './images';
import {
	buildImage,
	ensureMachineRunning,
	getDockerInfo,
	getPodmanVersion,
	imageExists,
	listPodmanContainers,
	listPodmanMachines,
	platformNeedsPodmanMachine,
	pullImage,
	stopContainersForImage,
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
import { ensureWorkspace } from './workspace';

export interface ToolServiceDef {
	id: string;
	label: string;
	image: string;
	buildable: boolean;
}

export function listToolServices(settings: HawaldarSettings): ToolServiceDef[] {
	const map = new Map<string, ToolServiceDef>();
	for (const tool of TOOL_CATALOG) {
		if (!map.has(tool.agentId)) {
			const buildable = hasMinContainerfile(tool.agentId);
			map.set(tool.agentId, {
				id: tool.agentId,
				label: tool.agentId,
				image: buildable
					? minImageFor(tool.agentId)
					: (settings.toolImages[tool.agentId] || tool.image),
				buildable,
			});
		}
	}
	for (const tool of settings.customTools) {
		const key = tool.agentId || tool.id;
		if (!map.has(key)) {
			map.set(key, {
				id: key,
				label: tool.title || key,
				image: settings.toolImages[key] || tool.image,
				buildable: false,
			});
		}
	}
	return [...map.values()];
}

export function isServiceStarted(settings: HawaldarSettings, agentId: string): boolean {
	return settings.startedServices.includes(agentId);
}

function waitingServices(settings: HawaldarSettings, detail: string): PodmanServiceInfo[] {
	return listToolServices(settings).map((item) => ({
		id: item.id,
		label: item.label,
		image: item.image,
		started: settings.startedServices.includes(item.id),
		imagePresent: false,
		detail,
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
			detail: started
				? (present
					? (running > 0 ? `${running} container(s) running` : 'Ready (minimal image)')
					: (item.buildable ? 'Started but image missing — rebuild on next toggle' : 'Started but image missing'))
				: (item.buildable
					? 'Stopped · toggle on to build minimal image'
					: 'Stopped · will not run until toggled on'),
		});
	}
	return { containers, services };
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
	settings: Partial<Pick<HawaldarSettings, 'startedServices' | 'toolImages'>>;
	detail: string;
	ok: boolean;
}> {
	const service = listToolServices(settings).find((item) => item.id === serviceId);
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
		const machine = await ensureMachineRunning(bin);
		if (!machine.ok) {
			return { settings: {}, detail: machine.detail, ok: false };
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
				detail: 'Podman machine is stopped. Start the machine first, or enable “Auto-start machine with services”.',
				ok: false,
			};
		}
	}

	const image = service.image;
	const present = await imageExists(bin, image);
	if (!present) {
		if (service.buildable) {
			const contextDir = path.join(settings.extensionPath, containerContextRel(serviceId));
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

	const startedServices = settings.startedServices.includes(serviceId)
		? settings.startedServices
		: [...settings.startedServices, serviceId];

	return {
		ok: true,
		detail: service.buildable
			? `${serviceId} started · minimal image ${image}`
			: `${serviceId} started · image ready`,
		settings: {
			startedServices,
			toolImages: { ...settings.toolImages, [serviceId]: image },
		},
	};
}

export async function stopToolService(
	settings: HawaldarSettings,
	serviceId: string,
): Promise<{ settings: Partial<Pick<HawaldarSettings, 'startedServices'>>; detail: string; ok: boolean }> {
	const service = listToolServices(settings).find((item) => item.id === serviceId);
	if (!service) {
		return { settings: {}, detail: `Unknown service: ${serviceId}`, ok: false };
	}

	const engine: 'podman' | 'docker' = settings.containerEngine === 'docker' ? 'docker' : 'podman';
	const stopped = await stopContainersForImage(engineBin(engine, settings.podmanPath), service.image);
	const startedServices = settings.startedServices.filter((id) => id !== serviceId);
	return {
		ok: true,
		detail: `${serviceId} stopped${stopped ? ` · removed ${stopped} container(s)` : ''}`,
		settings: { startedServices },
	};
}

export function serviceRequiredMessage(agentId: string): string {
	return `Container service "${agentId}" is stopped. Open Podman in the sidebar and toggle it on before running this tool.`;
}
