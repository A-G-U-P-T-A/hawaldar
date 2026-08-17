import { daemonState, ensureDaemon, stopDaemon } from '../sandbox/podman-daemon';
import { engineBin } from '../sandbox/podman-path';
import { imageFor, type HawaldarSettings } from '../settings';
import { BUILTIN_SOURCE, TOOL_CATALOG } from './catalog';

/**
 * OWASP Juice Shop — built-in vulnerable web lab target. Runs as `hw-juice-shop`
 * with loopback-only port publish (127.0.0.1:3000). Pull-only image; started
 * from Runtime → Tool services or start_service / juice-shop-status.
 */

export const JUICE_SHOP_AGENT_ID = 'juice-shop';
export const JUICE_SHOP_IMAGE = 'bkimminich/juice-shop';
export const JUICE_SHOP_PORT = 3000;
export const JUICE_SHOP_URL = 'http://127.0.0.1:3000';
export const JUICE_SHOP_CONTAINER = 'hw-juice-shop';
const DAEMON_NAME = JUICE_SHOP_CONTAINER;
const MEMORY_MB = 1024;
const PIDS = 512;
const READY_BUDGET_MS = 90_000;
const POLL_MS = 1500;
const FETCH_TIMEOUT_MS = 8000;

export function isJuiceShopService(serviceId: string): boolean {
	return serviceId === JUICE_SHOP_AGENT_ID;
}

function podmanBin(settings: HawaldarSettings): string {
	const engine = settings.containerEngine === 'docker' ? 'docker' : 'podman';
	return engineBin(engine, settings.podmanPath);
}

async function juiceShopReady(): Promise<boolean> {
	try {
		const res = await fetch(JUICE_SHOP_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
		return res.ok || res.status < 500;
	} catch {
		return false;
	}
}

/** Start (or reuse) the Juice Shop daemon after the image is present. */
export async function ensureJuiceShopDaemon(settings: HawaldarSettings): Promise<{ ok: boolean; detail: string }> {
	const started = await ensureDaemon({
		podmanPath: podmanBin(settings),
		name: DAEMON_NAME,
		image: imageFor(settings, JUICE_SHOP_AGENT_ID),
		hostPort: JUICE_SHOP_PORT,
		containerPort: JUICE_SHOP_PORT,
		memoryMb: MEMORY_MB,
		pidsLimit: PIDS,
	});
	if (!started.ok) {
		return started;
	}
	if (await juiceShopReady()) {
		return { ok: true, detail: `${DAEMON_NAME} ready at ${JUICE_SHOP_URL}` };
	}
	const deadline = Date.now() + READY_BUDGET_MS;
	while (Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, POLL_MS));
		if (await juiceShopReady()) {
			return { ok: true, detail: `${DAEMON_NAME} ready at ${JUICE_SHOP_URL}` };
		}
	}
	return { ok: false, detail: `${DAEMON_NAME} started but ${JUICE_SHOP_URL} did not respond in time.` };
}

export async function stopJuiceShopDaemon(settings: HawaldarSettings): Promise<{ ok: boolean; detail: string }> {
	return stopDaemon(podmanBin(settings), DAEMON_NAME);
}

function finish(id: string, payload: Record<string, unknown>) {
	const spec = TOOL_CATALOG.find((tool) => tool.id === id);
	return {
		ok: true,
		stdout: JSON.stringify({ source: BUILTIN_SOURCE, ...payload }, null, 2),
		stderr: '',
		exitCode: 0,
	};
}

function fail(reason: string) {
	return { ok: false, stdout: '', stderr: reason, exitCode: 1 };
}

/** Mastra inputSchema for juice-shop tools. Uses the runtime `z` instance. */
export function buildJuiceShopInputSchema(z: any) {
	return z.object({});
}

export async function runJuiceShopTool(settings: HawaldarSettings, id: string) {
	if (id !== 'juice-shop-status') {
		return fail(`Unknown Juice Shop tool: ${id}`);
	}

	const state = await daemonState(podmanBin(settings), DAEMON_NAME);
	if (state !== 'running') {
		const started = await ensureJuiceShopDaemon(settings);
		if (!started.ok) {
			return fail(started.detail);
		}
	}

	const ready = await juiceShopReady();
	return finish('juice-shop-status', {
		tool: 'juice-shop-status',
		url: JUICE_SHOP_URL,
		host: '127.0.0.1',
		port: JUICE_SHOP_PORT,
		ready,
		container: DAEMON_NAME,
		image: imageFor(settings, JUICE_SHOP_AGENT_ID),
		note: ready
			? 'OWASP Juice Shop lab target is up. Recon tools (httpx, katana, browser-open, scrapling-fetch, zap-spider, nuclei, …) may use this URL; localhost is always in-scope.'
			: 'Container is running but the HTTP endpoint did not respond yet — retry in a few seconds.',
	});
}
