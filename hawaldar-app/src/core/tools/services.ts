import {
	isEngineControlServiceId,
	isServiceStarted,
	listToolServices,
	startToolService,
	stopToolService,
	type ServiceSettingsPatch,
} from '../sandbox/podman-services';
import type { HawaldarSettings } from '../settings';
import { isServiceControlTool, TOOL_CATALOG } from './catalog';

export type PersistServiceSettings = (
	patch: ServiceSettingsPatch,
) => Promise<void | HawaldarSettings>;

const METASPLOIT_KEYS = new Set(['metasploit', 'msf']);
const SERVICE_ID_ALIASES: Record<string, string> = {
	wireshark: 'tshark',
};

export function normalizeServiceKey(value: string): string {
	return value.trim().toLowerCase().replace(/[\s_]+/g, '-');
}

export function modelServiceRefuseReason(raw: string): string | undefined {
	const key = normalizeServiceKey(raw);
	if (!key) {
		return 'agentId is required (catalog or custom service id, e.g. nmap).';
	}
	if (METASPLOIT_KEYS.has(key) || key.startsWith('msf-')) {
		return 'Metasploit is not controllable from the model. Start or stop it in Runtime if needed.';
	}
	if (isEngineControlServiceId(key)) {
		return 'The Linux VM and container engine are human-only. Start the VM in Runtime. These tools only start catalog service images.';
	}
	return undefined;
}

export function resolveControllableServiceId(
	settings: HawaldarSettings,
	raw: unknown,
): { ok: true; serviceId: string } | { ok: false; reason: string } {
	if (typeof raw !== 'string' || !raw.trim()) {
		return { ok: false, reason: 'agentId is required (catalog or custom service id, e.g. nmap).' };
	}
	const trimmed = raw.trim();
	const refused = modelServiceRefuseReason(trimmed);
	if (refused) {
		return { ok: false, reason: refused };
	}

	const key = SERVICE_ID_ALIASES[normalizeServiceKey(trimmed)] ?? normalizeServiceKey(trimmed);
	const services = listToolServices(settings);
	const exact = services.find((item) => item.id === trimmed || normalizeServiceKey(item.id) === key);
	if (exact) {
		const again = modelServiceRefuseReason(exact.id);
		if (again) {
			return { ok: false, reason: again };
		}
		return { ok: true, serviceId: exact.id };
	}

	const tool = TOOL_CATALOG.find((item) => (
		!isServiceControlTool(item.id)
		&& (item.id === trimmed || normalizeServiceKey(item.id) === key)
	));
	if (tool) {
		const again = modelServiceRefuseReason(tool.agentId);
		if (again) {
			return { ok: false, reason: again };
		}
		const mapped = services.find((item) => item.id === tool.agentId);
		if (mapped) {
			return { ok: true, serviceId: mapped.id };
		}
	}

	const custom = settings.customTools.find((item) => (
		normalizeServiceKey(item.id) === key || normalizeServiceKey(item.agentId) === key
	));
	if (custom) {
		const serviceId = custom.agentId || custom.id;
		const again = modelServiceRefuseReason(serviceId);
		if (again) {
			return { ok: false, reason: again };
		}
		return { ok: true, serviceId };
	}

	return {
		ok: false,
		reason: `Unknown service: ${trimmed}. Use a catalog or custom service id (nmap, dns, research, tshark, ghidra, scrapling, …).`,
	};
}

export function serviceOffMessage(agentId: string): string {
	if (modelServiceRefuseReason(agentId)) {
		return `Container service "${agentId}" is stopped. Start it in Runtime. The model cannot start this service.`;
	}
	return `Container service "${agentId}" is stopped. Call start_service with agentId "${agentId}" and retry. An in-app approval is required to start Podman or the image.`;
}

export async function applyServicePatch(
	settings: HawaldarSettings,
	patch: ServiceSettingsPatch,
	persist?: PersistServiceSettings,
): Promise<HawaldarSettings> {
	if (persist) {
		const next = await persist(patch);
		if (next && typeof next === 'object' && Array.isArray(next.startedServices)) {
			return next;
		}
	}
	return {
		...settings,
		startedServices: patch.startedServices ?? settings.startedServices,
		toolImages: patch.toolImages ?? settings.toolImages,
	};
}

export async function ensureServiceStartedOnce(
	settings: HawaldarSettings,
	agentId: string,
	persist?: PersistServiceSettings,
): Promise<{ settings: HawaldarSettings; ok: boolean; detail: string }> {
	const resolved = resolveControllableServiceId(settings, agentId);
	if (!resolved.ok) {
		return { settings, ok: false, detail: resolved.reason };
	}
	if (isServiceStarted(settings, resolved.serviceId)) {
		return { settings, ok: true, detail: `${resolved.serviceId} already started` };
	}
	const result = await startToolService(settings, resolved.serviceId);
	if (!result.ok) {
		return { settings, ok: false, detail: result.detail };
	}
	return {
		settings: await applyServicePatch(settings, result.settings, persist),
		ok: true,
		detail: result.detail,
	};
}

export async function runServiceControlTool(
	settings: HawaldarSettings,
	id: string,
	agentId: unknown,
	persist?: PersistServiceSettings,
): Promise<{ ok: boolean; stdout: string; stderr: string; exitCode: number }> {
	if (!isServiceControlTool(id)) {
		return { ok: false, stdout: '', stderr: `Unknown tool: ${id}`, exitCode: 1 };
	}
	const resolved = resolveControllableServiceId(settings, agentId);
	if (!resolved.ok) {
		return { ok: false, stdout: '', stderr: resolved.reason, exitCode: 1 };
	}

	let current = settings;
	if (id === 'stop_service' || id === 'restart_service') {
		const stopped = await stopToolService(current, resolved.serviceId);
		if (!stopped.ok) {
			return { ok: false, stdout: '', stderr: stopped.detail, exitCode: 1 };
		}
		current = await applyServicePatch(current, stopped.settings, persist);
		if (id === 'stop_service') {
			return { ok: true, stdout: stopped.detail, stderr: '', exitCode: 0 };
		}
	}

	const started = await startToolService(current, resolved.serviceId);
	if (!started.ok) {
		return { ok: false, stdout: '', stderr: started.detail, exitCode: 1 };
	}
	await applyServicePatch(current, started.settings, persist);
	const stdout = id === 'restart_service'
		? `${resolved.serviceId} restarted · ${started.detail}`
		: started.detail;
	return { ok: true, stdout, stderr: '', exitCode: 0 };
}

/** Mastra inputSchema for start/stop/restart. Uses the runtime `z` instance. */
export function buildServiceControlInputSchema(z: any) {
	return z.object({
		agentId: z.string().min(1).describe(
			'Catalog or custom service id to start/stop (nmap, dns, research, tshark, wireshark→tshark, ghidra, scrapling, …). Not the Podman machine, Docker Desktop, or metasploit.',
		),
	});
}
