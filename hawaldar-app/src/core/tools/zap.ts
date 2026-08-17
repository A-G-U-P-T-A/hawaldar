import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { evaluateBrowserNavigation } from '../policy';
import { looksLikeDockerBin } from '../sandbox/host-info';
import { daemonState, ensureDaemon, stopDaemon } from '../sandbox/podman-daemon';
import { imageFor, isToolEnabled, type HawaldarSettings } from '../settings';
import { rewriteLoopbackUrl } from './browser';
import { BUILTIN_SOURCE, TOOL_CATALOG } from './catalog';
import { redactSecrets } from './poc';

/**
 * OWASP ZAP via its REST API. ZAP is the one long-running tool: a `hw-zap`
 * daemon container publishing 127.0.0.1:8090 only. The API key is generated
 * host-side per daemon start, stored in ~/.hawaldar/zap-daemon.json (0600),
 * and never logged or embedded in URLs (X-ZAP-API-Key header only).
 * The operator may also proxy their own browser/Burp through 127.0.0.1:8090
 * while the daemon runs — that is the supported way to share the session.
 */

const ZAP_PORT = 8090;
const DAEMON_NAME = 'hw-zap';
const MEMORY_MB = 2048;
const PIDS = 512;
const READY_BUDGET_MS = 75_000;
const FETCH_TIMEOUT_MS = 15_000;
const SPIDER_URL_CAP = 100;
const ALERT_CAP = 200;
const HISTORY_CAP = 200;
const EVIDENCE_CAP = 160;
const ASCAN_RESERVE_MS = 30_000;

const URLISH_TOOLS = new Set(['zap-spider', 'zap-ascan']);
const DAEMON_TOOLS = new Set(['zap-status', 'zap-spider', 'zap-pscan', 'zap-history', 'zap-ascan', 'zap-alerts']);

export interface ZapToolInput {
	target?: string;
	url?: string;
}

interface ZapState {
	apiKey: string;
	port: number;
	containerName: string;
}

function statePath(): string {
	return path.join(os.homedir(), '.hawaldar', 'zap-daemon.json');
}

function readState(): ZapState | undefined {
	try {
		if (!fs.existsSync(statePath())) {
			return undefined;
		}
		const parsed = JSON.parse(fs.readFileSync(statePath(), 'utf8')) as Partial<ZapState>;
		if (typeof parsed.apiKey === 'string' && /^[a-f0-9]{48}$/.test(parsed.apiKey)) {
			return { apiKey: parsed.apiKey, port: ZAP_PORT, containerName: DAEMON_NAME };
		}
		return undefined;
	} catch {
		return undefined;
	}
}

function writeState(state: ZapState): void {
	try {
		fs.mkdirSync(path.dirname(statePath()), { recursive: true });
		fs.writeFileSync(statePath(), JSON.stringify(state), { mode: 0o600 });
	} catch {
		// In-memory key still works for this process run.
	}
}

async function zapGet(apiKey: string, apiPath: string, params?: Record<string, string>): Promise<{ ok: boolean; status: number; json: Record<string, any> }> {
	const qs = params && Object.keys(params).length > 0 ? `?${new URLSearchParams(params).toString()}` : '';
	try {
		const res = await fetch(`http://127.0.0.1:${ZAP_PORT}${apiPath}${qs}`, {
			headers: { 'X-ZAP-API-Key': apiKey, Accept: 'application/json' },
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
		const text = await res.text();
		let json: Record<string, any> = {};
		try {
			json = JSON.parse(text) as Record<string, any>;
		} catch {
			json = { raw: text.slice(0, 500) };
		}
		return { ok: res.ok, status: res.status, json };
	} catch (error) {
		return { ok: false, status: 0, json: { error: error instanceof Error ? error.message : String(error) } };
	}
}

async function zapReady(apiKey: string): Promise<boolean> {
	const res = await zapGet(apiKey, '/JSON/core/view/version/');
	return res.ok && typeof res.json.version === 'string';
}

/**
 * Reuse a running daemon when its key still answers; otherwise recreate it
 * with a fresh key (stale containers are removed by ensureDaemon). Polls the
 * version view until the JVM is up.
 */
async function ensureZap(settings: HawaldarSettings): Promise<{ ok: true; apiKey: string } | { ok: false; reason: string }> {
	const state = readState();
	if ((await daemonState(settings.podmanPath, DAEMON_NAME)) === 'running') {
		if (state && await zapReady(state.apiKey)) {
			return { ok: true, apiKey: state.apiKey };
		}
		await stopDaemon(settings.podmanPath, DAEMON_NAME);
	}
	const next: ZapState = { apiKey: randomBytes(24).toString('hex'), port: ZAP_PORT, containerName: DAEMON_NAME };
	const started = await ensureDaemon({
		podmanPath: settings.podmanPath,
		name: DAEMON_NAME,
		image: imageFor(settings, 'zap'),
		hostPort: ZAP_PORT,
		containerPort: ZAP_PORT,
		env: { ZAP_API_KEY: next.apiKey },
		memoryMb: MEMORY_MB,
		pidsLimit: PIDS,
	});
	if (!started.ok) {
		return { ok: false, reason: started.detail };
	}
	writeState(next);
	const deadline = Date.now() + READY_BUDGET_MS;
	while (Date.now() < deadline) {
		if (await zapReady(next.apiKey)) {
			return { ok: true, apiKey: next.apiKey };
		}
		await sleep(1_500);
	}
	return { ok: false, reason: 'ZAP daemon did not become ready in time.' };
}

function timeoutMs(id: string): number {
	return TOOL_CATALOG.find((tool) => tool.id === id)?.timeoutMs ?? 120_000;
}

/** Mastra inputSchema for ZAP tools. Uses the runtime `z` instance. */
export function buildZapInputSchema(z: any, id: string) {
	const url = z.string().describe('In-scope http(s) URL. Loopback follows local-target rules (rewritten for the daemon container).');
	switch (id) {
		case 'zap-status':
		case 'zap-history':
		case 'zap-alerts':
			return z.object({});
		case 'zap-spider':
			return z.object({ url });
		case 'zap-ascan':
			return z.object({
				url: z.string().describe('In-scope http(s) URL to ACTIVE scan. Intrusive: the operator approves each run. Alerts are capped to the target host.'),
			});
		case 'zap-pscan':
			return z.object({
				url: url.optional().describe('Optional in-scope base URL to summarize alerts for. Omit for all alerts.'),
			});
		default:
			return z.object({ url: url.optional() });
	}
}

/** HITL summary for the intrusive zap-ascan (validated before the dialog shows). */
export function zapAskSummary(
	settings: HawaldarSettings,
	id: string,
	input: ZapToolInput,
): { ok: true; value: { title: string; explanation: string } } | { ok: false; reason: string } {
	if (id !== 'zap-ascan') {
		return { ok: false, reason: `Unknown intrusive ZAP tool: ${id}` };
	}
	const checked = checkTargetUrl(settings, (input.url ?? input.target ?? '').trim());
	if (!checked.ok) {
		return checked;
	}
	return {
		ok: true,
		value: {
			title: `Approve ZAP active scan of ${checked.displayHost}?`,
			explanation: [
				`zap-ascan sends attack payloads (XSS, SQLi, path traversal probes) at ${checked.originalUrl} via the local ZAP daemon.`,
				'Bounded: this in-scope host only, alerts capped at 200, secrets redacted. The scan can take several minutes; partial alerts return on timeout.',
			].join('\n'),
		},
	};
}

export async function runZapTool(settings: HawaldarSettings, id: string, input: ZapToolInput) {
	if (!isToolEnabled(settings, id)) {
		return fail(`${id} is disabled.`);
	}
	if (!DAEMON_TOOLS.has(id)) {
		return fail(`Unknown tool: ${id}`);
	}
	const zap = await ensureZap(settings);
	if (!zap.ok) {
		return fail(zap.reason);
	}

	if (id === 'zap-status') {
		return runStatus(zap.apiKey);
	}

	if (id === 'zap-history') {
		return runHistory(zap.apiKey);
	}

	if (id === 'zap-alerts') {
		return runAlerts(zap.apiKey);
	}

	// Remaining tools take an (optional) in-scope URL.
	const rawUrl = (input.url ?? input.target ?? '').trim();
	if (URLISH_TOOLS.has(id) && !rawUrl) {
		return fail('An in-scope http(s) URL is required.');
	}
	let checked: CheckedUrl | undefined;
	if (rawUrl) {
		const verdict = checkTargetUrl(settings, rawUrl);
		if (!verdict.ok) {
			return fail(verdict.reason);
		}
		checked = verdict;
	}

	if (id === 'zap-spider') {
		return runSpider(zap.apiKey, checked!, timeoutMs(id));
	}
	if (id === 'zap-pscan') {
		return runPscan(zap.apiKey, checked);
	}
	return runAscan(zap.apiKey, checked!, timeoutMs(id));
}

interface CheckedUrl {
	ok: true;
	/** URL the daemon should hit (loopback rewritten for the container). */
	scanUrl: string;
	/** URL as the operator named it (display). */
	originalUrl: string;
	displayHost: string;
	/** Authority (host[:port]) in scanUrl when it was rewritten for loopback. */
	rewrittenAuthority?: string;
}

function checkTargetUrl(settings: HawaldarSettings, raw: string): CheckedUrl | { ok: false; reason: string } {
	const decision = evaluateBrowserNavigation(settings.scope, raw, 'navigate');
	if (!decision.allow || !decision.url || !decision.host) {
		return { ok: false, reason: decision.reason };
	}
	const rewritten = rewriteLoopbackUrl(decision.url, looksLikeDockerBin(settings.podmanPath));
	const out: CheckedUrl = {
		ok: true,
		scanUrl: rewritten.href,
		originalUrl: decision.url,
		displayHost: decision.host,
	};
	if (rewritten.reachHostLoopback) {
		try {
			out.rewrittenAuthority = new URL(rewritten.href).host;
		} catch {
			out.rewrittenAuthority = undefined;
		}
	}
	return out;
}

/** Map daemon-side URLs back to the operator-facing host when loopback was rewritten. */
function restoreUrl(url: string, checked: CheckedUrl): string {
	if (!checked.rewrittenAuthority) {
		return url;
	}
	return url.replace(checked.rewrittenAuthority, new URL(checked.originalUrl).host);
}

/** Scrub credential-looking query values from URLs before display. */
function scrubUrl(url: string): string {
	try {
		const parsed = new URL(url);
		for (const key of [...parsed.searchParams.keys()]) {
			if (/(sess|token|auth|cookie|key|pwd|pass|secret)/i.test(key)) {
				parsed.searchParams.set(key, 'REDACTED');
			}
		}
		return parsed.toString();
	} catch {
		return url.slice(0, 300);
	}
}

function finish(id: string, body: Record<string, unknown>) {
	return {
		ok: true,
		stdout: redactSecrets(JSON.stringify(body, null, 2)).slice(0, 20_000),
		stderr: '',
		exitCode: 0,
		source: BUILTIN_SOURCE,
		tool: id,
	};
}

async function runStatus(apiKey: string) {
	const version = await zapGet(apiKey, '/JSON/core/view/version/');
	if (!version.ok) {
		return fail(`ZAP API unreachable (HTTP ${version.status || 'error'}).`);
	}
	const queue = await zapGet(apiKey, '/JSON/pscan/view/recordsToScan/');
	return finish('zap-status', {
		tool: 'zap-status',
		daemon: 'running',
		version: version.json.version,
		passiveQueue: Number(queue.json.recordsToScan ?? 0),
		proxy: 'http://127.0.0.1:8090',
		note: 'Daemon is up. The operator can proxy their own browser or Burp through 127.0.0.1:8090 to share this session.',
	});
}

async function runSpider(apiKey: string, checked: CheckedUrl, budgetMs: number) {
	const started = await zapGet(apiKey, '/JSON/spider/action/scan/', {
		url: checked.scanUrl,
		recurse: 'true',
		subtreeOnly: 'true',
	});
	const scanId = String(started.json.scan ?? '');
	if (!started.ok || !scanId) {
		return fail(`Spider start failed: ${JSON.stringify(started.json).slice(0, 300)}`);
	}
	const deadline = Date.now() + Math.max(10_000, budgetMs - 15_000);
	let status = '0';
	while (Date.now() < deadline) {
		const poll = await zapGet(apiKey, '/JSON/spider/view/status/', { scanId });
		status = String(poll.json.status ?? status);
		if (status === '100') {
			break;
		}
		await sleep(2_000);
	}
	let urls: string[] = [];
	const results = await zapGet(apiKey, '/JSON/spider/view/results/', { scanId });
	if (Array.isArray(results.json.results)) {
		urls = results.json.results.map((item: unknown) => String(item));
	}
	if (urls.length === 0) {
		const all = await zapGet(apiKey, '/JSON/spider/view/allUrls/');
		if (Array.isArray(all.json.allUrls)) {
			urls = all.json.allUrls.map((item: unknown) => String(item));
		}
	}
	const host = new URL(checked.originalUrl).host;
	const scoped = urls
		.map((item) => restoreUrl(item, checked))
		.filter((item) => {
			try {
				return new URL(item).host === host;
			} catch {
				return false;
			}
		});
	const capped = scoped.slice(0, SPIDER_URL_CAP).map(scrubUrl);
	return finish('zap-spider', {
		tool: 'zap-spider',
		target: checked.originalUrl,
		scannedAs: checked.scanUrl !== checked.originalUrl ? checked.scanUrl : undefined,
		progress: Number(status),
		complete: status === '100',
		urlsFound: scoped.length,
		urls: capped,
		note: scoped.length > SPIDER_URL_CAP ? `Capped at ${SPIDER_URL_CAP} URLs.` : undefined,
	});
}

async function runPscan(apiKey: string, checked: CheckedUrl | undefined) {
	let waited = 0;
	const deadline = Date.now() + 90_000;
	let remaining = Number.NaN;
	while (Date.now() < deadline) {
		const queue = await zapGet(apiKey, '/JSON/pscan/view/recordsToScan/');
		remaining = Number(queue.json.recordsToScan ?? 0);
		if (remaining <= 0) {
			break;
		}
		await sleep(3_000);
		waited += 3_000;
	}
	const alerts = await fetchAlerts(apiKey, checked);
	const byRisk = countByRisk(alerts);
	return finish('zap-pscan', {
		tool: 'zap-pscan',
		baseurl: checked?.originalUrl,
		passiveQueueDrained: remaining <= 0,
		passiveQueueRemaining: Number.isNaN(remaining) ? undefined : remaining,
		waitedMs: waited,
		total: alerts.length,
		alertsByRisk: byRisk,
		alerts: alerts.slice(0, 50).map((alert) => briefAlert(alert, checked)),
	});
}

async function runHistory(apiKey: string) {
	const sitesRes = await zapGet(apiKey, '/JSON/core/view/sites/');
	const sites: string[] = Array.isArray(sitesRes.json.sites) ? sitesRes.json.sites.map((item: unknown) => String(item)) : [];
	const urlsRes = await zapGet(apiKey, '/JSON/core/view/urls/');
	const urls: string[] = Array.isArray(urlsRes.json.urls) ? urlsRes.json.urls.map((item: unknown) => String(item)) : [];

	const hosts: Record<string, number> = {};
	const methods: Record<string, number> = {};
	const statuses: Record<string, number> = {};
	let messagesCounted = 0;
	const messages = await zapGet(apiKey, '/JSON/core/view/messages/', { start: '0', count: String(HISTORY_CAP) });
	const rows: any[] = Array.isArray(messages.json.messages) ? messages.json.messages : [];
	for (const row of rows) {
		messagesCounted += 1;
		const reqHeader = typeof row?.reqHeader === 'string' ? row.reqHeader : '';
		const resHeader = typeof row?.resHeader === 'string' ? row.resHeader : '';
		const method = reqHeader.split(/\s+/)[0] || '';
		if (method) {
			methods[method] = (methods[method] ?? 0) + 1;
		}
		const hostMatch = /^Host:\s*(.+)$/im.exec(reqHeader);
		if (hostMatch) {
			const host = hostMatch[1].trim();
			hosts[host] = (hosts[host] ?? 0) + 1;
		}
		const statusMatch = /HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(resHeader);
		if (statusMatch) {
			statuses[statusMatch[1]] = (statuses[statusMatch[1]] ?? 0) + 1;
		}
	}
	return finish('zap-history', {
		tool: 'zap-history',
		sites: sites.slice(0, 50).map(scrubUrl),
		urlsTotal: urls.length,
		urls: urls.slice(0, SPIDER_URL_CAP).map(scrubUrl),
		messagesCounted,
		hosts,
		methods,
		statuses,
		note: 'Credential header values are redacted; query values that look like tokens are scrubbed.',
	});
}

async function runAlerts(apiKey: string) {
	const alerts = await fetchAlerts(apiKey, undefined);
	return finish('zap-alerts', {
		tool: 'zap-alerts',
		total: alerts.length,
		alertsByRisk: countByRisk(alerts),
		alerts: alerts.slice(0, ALERT_CAP).map((alert) => briefAlert(alert, undefined)),
		note: alerts.length > ALERT_CAP ? `Capped at ${ALERT_CAP} alerts.` : undefined,
	});
}

async function runAscan(apiKey: string, checked: CheckedUrl, budgetMs: number) {
	const started = await zapGet(apiKey, '/JSON/ascan/action/scan/', {
		url: checked.scanUrl,
		recurse: 'true',
	});
	const scanId = String(started.json.scan ?? '');
	if (!started.ok || !scanId) {
		return fail(`Active scan start failed: ${JSON.stringify(started.json).slice(0, 300)}`);
	}
	const deadline = Date.now() + Math.max(30_000, budgetMs - ASCAN_RESERVE_MS);
	let status = '0';
	while (Date.now() < deadline) {
		const poll = await zapGet(apiKey, '/JSON/ascan/view/status/', { scanId });
		status = String(poll.json.status ?? status);
		if (status === '100') {
			break;
		}
		await sleep(5_000);
	}
	const alerts = await fetchAlerts(apiKey, checked);
	return finish('zap-ascan', {
		tool: 'zap-ascan',
		target: checked.originalUrl,
		scannedAs: checked.scanUrl !== checked.originalUrl ? checked.scanUrl : undefined,
		progress: Number(status),
		complete: status === '100',
		partial: status !== '100',
		total: alerts.length,
		alertsByRisk: countByRisk(alerts),
		alerts: alerts.slice(0, ALERT_CAP).map((alert) => briefAlert(alert, checked)),
		note: 'Active scan ran with operator approval. Alerts are capped to the target host.',
	});
}

/** Alerts from the alert component (core view as fallback), host-capped to the checked target. */
async function fetchAlerts(apiKey: string, checked: CheckedUrl | undefined): Promise<any[]> {
	const params: Record<string, string> = { start: '0', count: String(ALERT_CAP) };
	if (checked) {
		const original = new URL(checked.originalUrl);
		params.baseurl = `${original.protocol}//${original.host}`;
	}
	let res = await zapGet(apiKey, '/JSON/alert/view/alerts/', params);
	if (!res.ok || !Array.isArray(res.json.alerts)) {
		res = await zapGet(apiKey, '/JSON/core/view/alerts/', params);
	}
	const rows: any[] = Array.isArray(res.json.alerts) ? res.json.alerts : [];
	if (!checked) {
		return rows;
	}
	const host = new URL(checked.originalUrl).host;
	return rows.filter((alert) => {
		try {
			return new URL(restoreUrl(String(alert?.url ?? ''), checked)).host === host;
		} catch {
			return false;
		}
	});
}

function countByRisk(alerts: any[]): Record<string, number> {
	const out: Record<string, number> = {};
	for (const alert of alerts) {
		const risk = String(alert?.risk ?? 'Informational');
		out[risk] = (out[risk] ?? 0) + 1;
	}
	return out;
}

function briefAlert(alert: any, checked: CheckedUrl | undefined) {
	const url = String(alert?.url ?? '');
	const restored = checked ? restoreUrl(url, checked) : url;
	return {
		risk: String(alert?.risk ?? ''),
		name: String(alert?.name ?? ''),
		url: scrubUrl(restored),
		param: String(alert?.param ?? ''),
		evidence: String(alert?.evidence ?? '').slice(0, EVIDENCE_CAP),
		cweId: String(alert?.cweid ?? alert?.cweId ?? ''),
	};
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function fail(stderr: string) {
	return { ok: false, stdout: '', stderr, exitCode: 1 };
}
