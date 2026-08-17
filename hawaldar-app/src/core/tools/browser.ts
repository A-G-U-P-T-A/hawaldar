import * as path from 'node:path';
import {
	classifyBrowserResult,
	evaluateBrowserNavigation,
	isLocalMachineTarget,
	listBrowserAllowHosts,
	parseBrowserUrl,
	resolveLocalScanTarget,
	scopeIsConfigured,
	SEARCH_ENGINE_HOSTS,
} from '../policy';
import { looksLikeDockerBin } from '../sandbox/host-info';
import { daemonState } from '../sandbox/podman-daemon';
import { engineBin } from '../sandbox/podman-path';
import { containerLoopbackTarget, podmanRun } from '../sandbox/podman';
import { imageFor, isToolEnabled, type HawaldarSettings } from '../settings';
import { BUILTIN_SOURCE, TOOL_CATALOG } from './catalog';
import { JUICE_SHOP_CONTAINER, JUICE_SHOP_PORT, JUICE_SHOP_URL } from './juice-shop';

const MEMORY_MB = 1536;
const PIDS = 512;
export const BROWSER_RECON_SCRIPT = '/opt/hawaldar-browser/recon.mjs';
const SCRIPT = BROWSER_RECON_SCRIPT;

export function reconScriptMount(settings: HawaldarSettings): { source: string; target: string; readonly: boolean } {
	return {
		source: path.join(settings.extensionPath, 'containers', 'browser', 'recon.mjs'),
		target: SCRIPT,
		readonly: true,
	};
}

/** Juice Shop is loopback-published; sharing its netns makes 127.0.0.1:3000 work from the browser container. */
export async function bindLoopbackBrowser(
	settings: HawaldarSettings,
	href: string,
	reachHostLoopback: boolean,
): Promise<{ href: string; reachHostLoopback: boolean; networkContainer?: string }> {
	if (!reachHostLoopback) {
		return { href, reachHostLoopback };
	}
	let port = '';
	try {
		port = new URL(href).port;
	} catch {
		return { href, reachHostLoopback };
	}
	if (port !== String(JUICE_SHOP_PORT)) {
		return { href, reachHostLoopback };
	}
	const bin = engineBin(settings.containerEngine === 'docker' ? 'docker' : 'podman', settings.podmanPath);
	const state = await daemonState(bin, JUICE_SHOP_CONTAINER).catch(() => 'missing' as const);
	if (state !== 'running') {
		return { href, reachHostLoopback };
	}
	return {
		href: JUICE_SHOP_URL,
		reachHostLoopback: false,
		networkContainer: JUICE_SHOP_CONTAINER,
	};
}

const URL_TOOLS = new Set([
	'browser-open',
	'browser-snapshot',
	'browser-console',
	'browser-network',
	'browser-links',
]);

export type BrowserEngine = 'duckduckgo' | 'google' | 'bing';

export interface BrowserToolInput {
	target?: string;
	url?: string;
	query?: string;
	engine?: string;
}

const SEARCH_URLS: Record<BrowserEngine, (query: string) => string> = {
	duckduckgo: (query) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
	google: (query) => `https://www.google.com/search?q=${encodeURIComponent(query)}&hl=en&num=10`,
	bing: (query) => `https://www.bing.com/search?q=${encodeURIComponent(query)}`,
};

function timeoutMs(id: string): number {
	return TOOL_CATALOG.find((tool) => tool.id === id)?.timeoutMs ?? 90_000;
}

/** Mastra inputSchema for browser tools. Uses the runtime `z` instance. */
export function buildBrowserInputSchema(z: any, id: string) {
	const target = z.string().optional()
		.describe('In-scope http(s) URL or host. Loopback follows local-target rules. javascript: refused.');
	const engine = z.enum(['duckduckgo', 'google', 'bing']).optional()
		.describe('Search engine hop only (default duckduckgo). Result links are not auto-visited.');
	switch (id) {
		case 'browser-search':
			return z.object({
				query: z.string().describe('Web search query. Search engines are a hop; out-of-scope results are listed, not visited.'),
				engine,
			});
		case 'browser-close':
			return z.object({});
		default:
			return z.object({ target });
	}
}

export function parseBrowserQuery(raw: string | undefined): { ok: true; value: string } | { ok: false; reason: string } {
	const query = (raw ?? '').trim();
	if (!query) {
		return { ok: false, reason: 'query is required.' };
	}
	if (query.length > 200) {
		return { ok: false, reason: 'query is limited to 200 characters.' };
	}
	if (/[\x00-\x1f\x7f]/.test(query) || /javascript:|data:/i.test(query)) {
		return { ok: false, reason: 'query failed safety checks.' };
	}
	return { ok: true, value: query };
}

export function parseBrowserEngine(raw: string | undefined): { ok: true; value: BrowserEngine } | { ok: false; reason: string } {
	const engine = (raw ?? 'duckduckgo').trim().toLowerCase();
	if (engine === 'ddg') {
		return { ok: true, value: 'duckduckgo' };
	}
	if (engine === 'duckduckgo' || engine === 'google' || engine === 'bing') {
		return { ok: true, value: engine };
	}
	return { ok: false, reason: 'engine must be duckduckgo, google, or bing.' };
}

export async function runBrowserTool(
	settings: HawaldarSettings,
	id: string,
	input: BrowserToolInput,
) {
	if (!isToolEnabled(settings, id)) {
		return fail(`${id} is disabled.`);
	}
	if (id === 'browser-close') {
		return {
			ok: true,
			stdout: 'No persistent browser session. Each browser-* visit is ephemeral podman run --rm.',
			stderr: '',
			exitCode: 0,
			source: BUILTIN_SOURCE,
			tool: id,
		};
	}
	if (id === 'browser-search') {
		return runSearch(settings, input);
	}
	if (!URL_TOOLS.has(id)) {
		return fail(`Unknown tool: ${id}`);
	}
	return runVisit(settings, id, input);
}

async function runSearch(settings: HawaldarSettings, input: BrowserToolInput) {
	const query = parseBrowserQuery(input.query);
	if (!query.ok) {
		return fail(query.reason);
	}
	const engine = parseBrowserEngine(input.engine);
	if (!engine.ok) {
		return fail(engine.reason);
	}
	const href = SEARCH_URLS[engine.value](query.value);
	const decision = evaluateBrowserNavigation(settings.scope, href, 'search-hop');
	if (!decision.allow || !decision.url || !decision.host) {
		return fail(decision.reason);
	}
	const allowed = listBrowserAllowHosts(settings.scope, SEARCH_ENGINE_HOSTS);
	const result = await runRecon(settings, 'browser-search', {
		action: 'search',
		url: decision.url,
		query: query.value,
		engine: engine.value,
		allowedHosts: allowed,
		searchHop: true,
		reachHostLoopback: false,
		navTimeoutMs: 20_000,
	});
	if (!result.ok) {
		return result;
	}
	const payload = parseJson(result.stdout);
	const rows = Array.isArray(payload.results) ? payload.results : [];
	const classified = rows.map((row) => {
		const raw = typeof row?.url === 'string' ? row.url : '';
		const tagged = classifyBrowserResult(settings.scope, raw);
		return {
			title: typeof row?.title === 'string' ? row.title : tagged.host,
			url: tagged.href,
			snippet: typeof row?.snippet === 'string' ? row.snippet : '',
			host: tagged.host,
			inScope: tagged.inScope,
			visit: tagged.inScope ? 'in-scope (call browser-open to visit)' : 'not visited (out of scope)',
		};
	});
	const body = {
		action: 'search',
		engine: engine.value,
		query: query.value,
		title: payload.title,
		status: payload.status,
		results: classified,
		note: 'Search-engine hop only. Out-of-scope result links were not visited.',
	};
	return {
		ok: true,
		stdout: JSON.stringify(body, null, 2).slice(0, 20_000),
		stderr: '',
		exitCode: 0,
		source: BUILTIN_SOURCE,
		tool: 'browser-search',
	};
}

async function runVisit(settings: HawaldarSettings, id: string, input: BrowserToolInput) {
	const raw = (input.target || input.url || '').trim();
	if (!raw) {
		return fail('An in-scope http(s) URL or host is required.');
	}
	const parsed = parseBrowserUrl(raw);
	if (!parsed.ok) {
		return fail(parsed.reason);
	}
	const decision = evaluateBrowserNavigation(settings.scope, parsed.value.href, 'navigate');
	if (!decision.allow || !decision.url || !decision.host) {
		return fail(decision.reason);
	}
	const docker = looksLikeDockerBin(settings.podmanPath);
	const rewritten = rewriteLoopbackUrl(decision.url, docker);
	const bound = await bindLoopbackBrowser(settings, rewritten.href, rewritten.reachHostLoopback);
	const extra = [decision.host];
	if (rewritten.reachHostLoopback) {
		extra.push(new URL(rewritten.href).hostname);
	}
	try {
		extra.push(new URL(bound.href).hostname);
	} catch {
		/* keep extra */
	}
	const allowed = listBrowserAllowHosts(settings.scope, extra);
	const action = id.replace(/^browser-/, '');
	const result = await runRecon(settings, id, {
		action,
		url: bound.href,
		allowedHosts: allowed,
		searchHop: false,
		reachHostLoopback: bound.reachHostLoopback,
		networkContainer: bound.networkContainer,
		navTimeoutMs: Math.min(60_000, Math.max(45_000, timeoutMs(id) - 25_000)),
	});
	if (!result.ok) {
		return result;
	}
	const payload = parseJson(result.stdout);
	const finalHref = typeof payload.url === 'string' ? payload.url : decision.url;
	const final = evaluateBrowserNavigation(settings.scope, finalHref, 'navigate');
	if (!final.allow) {
		return fail(final.reason);
	}
	if (id === 'browser-links' && Array.isArray(payload.links)) {
		payload.links = payload.links
			.map((row: { url?: string; title?: string; sameOrigin?: boolean }) => {
				const tagged = classifyBrowserResult(settings.scope, String(row?.url || ''));
				if (!tagged.inScope && (scopeIsConfigured(settings.scope) || !row?.sameOrigin)) {
					return undefined;
				}
				return {
					title: row?.title || tagged.host,
					url: tagged.href,
					sameOrigin: Boolean(row?.sameOrigin),
				};
			})
			.filter(Boolean);
	}
	return {
		ok: true,
		stdout: JSON.stringify(payload, null, 2).slice(0, 20_000),
		stderr: '',
		exitCode: 0,
		source: BUILTIN_SOURCE,
		tool: id,
	};
}

export function rewriteLoopbackUrl(href: string, docker: boolean): { href: string; reachHostLoopback: boolean } {
	const parsed = new URL(href);
	if (!isLocalMachineTarget(parsed.hostname)) {
		return { href, reachHostLoopback: false };
	}
	const port = parsed.port;
	const local = resolveLocalScanTarget(parsed.hostname) ?? parsed.hostname;
	parsed.hostname = containerLoopbackTarget(local, docker);
	if (port) {
		parsed.port = port;
	}
	return { href: parsed.toString(), reachHostLoopback: true };
}

/** Playwright read raced a client-side navigation; transient, safe to retry once (read-only actions). */
const TRANSIENT_NAV_RE = /execution context was destroyed|most likely because of a navigation|frame was detached/i;

async function runRecon(
	settings: HawaldarSettings,
	id: string,
	job: {
		action: string;
		url: string;
		query?: string;
		engine?: string;
		allowedHosts: string[];
		searchHop: boolean;
		reachHostLoopback: boolean;
		networkContainer?: string;
		navTimeoutMs?: number;
	},
) {
	const args = [
		SCRIPT,
		'--action',
		job.action,
		'--url',
		job.url,
		'--allowed-hosts',
		JSON.stringify(job.allowedHosts),
	];
	if (job.query) {
		args.push('--query', job.query);
	}
	if (job.engine) {
		args.push('--engine', job.engine);
	}
	if (job.searchHop) {
		args.push('--search-hop');
	}
	if (job.navTimeoutMs) {
		args.push('--nav-timeout', String(job.navTimeoutMs));
	}
	const attempt = () => podmanRun({
		podmanPath: settings.podmanPath,
		image: imageFor(settings, 'browser'),
		command: 'node',
		args,
		timeoutMs: timeoutMs(id),
		network: 'target',
		reachHostLoopback: job.reachHostLoopback,
		networkContainer: job.networkContainer,
		memoryMb: MEMORY_MB,
		pidsLimit: PIDS,
		mounts: [reconScriptMount(settings)],
	});
	let result = await attempt();
	if (transientNavFailure(result)) {
		result = await attempt();
	}
	if (result.timedOut) {
		return fail('Browser visit timed out.');
	}
	const payload = parseJson(result.stdout);
	if (payload.ok === false) {
		const message = typeof payload.error === 'string' ? payload.error : (result.stderr || 'Browser visit failed.');
		return fail(TRANSIENT_NAV_RE.test(message) ? 'Page navigated during the read; retry browser-open.' : message);
	}
	if (result.exitCode !== 0 && payload.ok !== true) {
		const raw = result.stderr || result.stdout || `exit ${result.exitCode}`;
		return fail(TRANSIENT_NAV_RE.test(raw) ? 'Page navigated during the read; retry browser-open.' : raw);
	}
	return {
		ok: true,
		stdout: result.stdout.slice(0, 20_000),
		stderr: result.stderr.slice(0, 4_000),
		exitCode: result.exitCode,
		source: BUILTIN_SOURCE,
		tool: id,
	};
}

function transientNavFailure(result: { stdout: string; stderr: string }): boolean {
	if (TRANSIENT_NAV_RE.test(result.stderr)) {
		return true;
	}
	const payload = parseJson(result.stdout);
	return payload.ok === false && typeof payload.error === 'string' && TRANSIENT_NAV_RE.test(payload.error);
}

function parseJson(text: string): Record<string, any> {
	const trimmed = text.trim();
	if (!trimmed) {
		return {};
	}
	try {
		const parsed = JSON.parse(trimmed);
		return parsed && typeof parsed === 'object' ? parsed as Record<string, any> : {};
	} catch {
		const start = trimmed.indexOf('{');
		const end = trimmed.lastIndexOf('}');
		if (start >= 0 && end > start) {
			try {
				return JSON.parse(trimmed.slice(start, end + 1)) as Record<string, any>;
			} catch {
				return { raw: trimmed.slice(0, 2_000) };
			}
		}
		return { raw: trimmed.slice(0, 2_000) };
	}
}

function fail(stderr: string) {
	return { ok: false, stdout: '', stderr, exitCode: 1 };
}
