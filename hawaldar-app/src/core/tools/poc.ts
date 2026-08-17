import { evaluateBrowserNavigation, listBrowserAllowHosts } from '../policy';
import { looksLikeDockerBin } from '../sandbox/host-info';
import { podmanRun } from '../sandbox/podman';
import { imageFor, isToolEnabled, type HawaldarSettings } from '../settings';
import { bindLoopbackBrowser, BROWSER_RECON_SCRIPT, reconScriptMount, rewriteLoopbackUrl } from './browser';
import { BUILTIN_SOURCE, TOOL_CATALOG } from './catalog';

/**
 * PoC validation tools. Shannon-style proof execution, bounded:
 * in-scope URLs only (double allow-list), per-probe HITL approval, no DELETE,
 * no destructive SQL, no credential/cookie exfiltration, response excerpts capped.
 * Everything runs in the contained browser image (podman run --rm).
 */

export const POC_TOOL_IDS = ['poc-request', 'poc-act', 'poc-xss-canary'] as const;

export function isPocTool(id: string): boolean {
	return (POC_TOOL_IDS as readonly string[]).includes(id);
}

const SCRIPT = BROWSER_RECON_SCRIPT;
const MEMORY_MB = 1536;
const PIDS = 512;

const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'HEAD', 'OPTIONS']);
const MAX_ACTIONS = 10;
const MAX_BODY = 8_000;
const MAX_URL = 2_000;
const MAX_HEADER_VALUE = 2_000;

/** Data-mutating SQL has no place in a proof probe. Read-only error/boolean/time techniques stay allowed. */
const DESTRUCTIVE_SQL = /\b(drop\s+table|truncate\s+table|delete\s+from|alter\s+table|update\s+[\w."`]+\s+set|insert\s+into\b|xp_cmdshell|into\s+(?:out|dump)file|load_file\s*\(|shutdown\b)/i;
const SLEEP_RE = /(?:pg_)?sleep\s*\(\s*(\d+(?:\.\d+)?)\s*\)/i;
const BENCHMARK_RE = /benchmark\s*\(/i;
/** A canary proves JS execution. Exfiltration / session theft / navigation are refused. */
const XSS_EXFIL = /document\.cookie|document\.domain|localstorage|sessionstorage|indexeddb|fetch\s*\(|xmlhttprequest|sendbeacon|websocket|eventsource|window\.open|(?:top\.|window\.)?location(?:\.href)?\s*=|location\.(?:assign|replace|href)|import\s*\(|postmessage\s*\(/i;
const SECRET_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token)$/i;
const ACTION_OPS = new Set(['goto', 'fill', 'click', 'submit', 'wait', 'extract']);
const SELECTOR_RE = /^[a-zA-Z0-9\s\[\]#.:='"_*()>,+~-]{1,200}$/;

export interface PocAction {
	op: string;
	selector?: string;
	value?: string;
	ms?: number;
}

export interface PocToolInput {
	url?: string;
	method?: string;
	headers?: Record<string, string>;
	body?: string | Record<string, unknown>;
	payload?: string;
	actions?: PocAction[];
}

export interface PocAskSummary {
	title: string;
	explanation: string;
}

/** Mastra inputSchema for PoC tools. Uses the runtime `z` instance. */
export function buildPocInputSchema(z: any, id: string) {
	if (id === 'poc-request') {
		return z.object({
			url: z.string().describe('In-scope http(s) URL. Scope + allow-list enforced; loopback rewritten for the container.'),
			method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'HEAD', 'OPTIONS']).optional()
				.describe('Default GET. DELETE is refused (non-destructive policy).'),
			headers: z.record(z.string()).optional()
				.describe('Optional headers. Cookie/Authorization values are redacted in output, never echoed back.'),
			body: z.union([z.string(), z.record(z.unknown())]).optional()
				.describe('Optional request body (max 8 KB). Objects are JSON-stringified. Destructive SQL (DROP/DELETE/UPDATE/INSERT) is refused.'),
		});
	}
	if (id === 'poc-act') {
		const action = z.object({
			op: z.enum(['goto', 'fill', 'click', 'submit', 'wait', 'extract']),
			selector: z.string().optional().describe('CSS selector for fill/click/submit/extract.'),
			value: z.string().optional().describe('Fill value (never echoed back; password fields reported as [set]).'),
			ms: z.number().optional().describe('wait duration, max 4000.'),
		});
		return z.object({
			url: z.string().describe('In-scope start URL for the flow.'),
			actions: z.array(action).min(1).max(MAX_ACTIONS)
				.describe('Ordered browser actions, e.g. register a test user then open the protected route. Max 10.'),
		});
	}
	return z.object({
		url: z.string().describe('In-scope URL carrying the canary payload (query or fragment).'),
		payload: z.string().describe('The exact canary payload string. Must set window.__hwPocFired; cookie/storage/fetch exfiltration is refused.'),
	});
}

/**
 * Per-probe operator approval. Third gate after engine + tool image.
 * IPC askHitl only — Mastra suspend/resume after Approve crashed the app.
 */
export { ensurePocApproval } from '../hitl-gate';

export function pocAskSummary(settings: HawaldarSettings, id: string, input: PocToolInput): { ok: true; value: PocAskSummary } | { ok: false; reason: string } {
	const scope = settings.scope;
	const docker = looksLikeDockerBin(settings.podmanPath);
	if (id === 'poc-request') {
		const checked = checkRequest(input, scope, docker);
		if (!checked.ok) {
			return checked;
		}
		const bits = [`${checked.method} ${checked.url}`];
		if (checked.bodyBytes > 0) {
			bits.push(`body ${checked.bodyBytes} chars`);
		}
		if (checked.headerCount > 0) {
			bits.push(`${checked.headerCount} header(s)`);
		}
		return {
			ok: true,
			value: {
				title: `Approve PoC probe: ${checked.method} ${hostOf(checked.url)}?`,
				explanation: [
					`poc-request sends ${bits.join(' · ')} from the contained browser image.`,
					'Non-destructive policy: no DELETE, no DROP/UPDATE/INSERT, secrets redacted from output.',
				].join('\n'),
			},
		};
	}
	if (id === 'poc-act') {
		const checked = checkActions(input, scope, docker);
		if (!checked.ok) {
			return checked;
		}
		const verbs = checked.actions.map((action) => action.op === 'fill' ? `fill ${action.selector}` : action.op === 'goto' ? `goto ${hostOf(action.value || '')}` : action.op).slice(0, 6);
		return {
			ok: true,
			value: {
				title: `Approve PoC browser flow on ${hostOf(checked.startUrl)}?`,
				explanation: [
					`poc-act runs ${checked.actions.length} action(s) in contained Chromium: ${verbs.join(' → ')}${checked.actions.length > 6 ? ' → …' : ''}.`,
					'Fill values are never echoed. State changes (e.g. registering a test user) target in-scope, disposable apps only.',
				].join('\n'),
			},
		};
	}
	const checked = checkCanary(input, scope, docker);
	if (!checked.ok) {
		return checked;
	}
	return {
		ok: true,
		value: {
			title: `Approve reflected-XSS canary on ${hostOf(checked.url)}?`,
			explanation: [
				`poc-xss-canary loads ${checked.url.slice(0, 160)} in contained Chromium and checks whether the canary executed (window marker).`,
				`Payload ${checked.payload.length} chars. Cookie/storage/network exfiltration is refused by the tool.`,
			].join('\n'),
		},
	};
}

export async function runPocTool(settings: HawaldarSettings, id: string, input: PocToolInput) {
	if (!isToolEnabled(settings, id)) {
		return fail(`${id} is disabled.`);
	}
	const docker = looksLikeDockerBin(settings.podmanPath);
	if (id === 'poc-request') {
		const checked = checkRequest(input, settings.scope, docker);
		if (!checked.ok) {
			return fail(checked.reason);
		}
		return runReconPoc(settings, id, {
			action: 'request',
			url: checked.url,
			allowedHosts: checked.allowedHosts,
			reachHostLoopback: checked.reachHostLoopback,
			method: checked.method,
			headers: checked.headersJson,
			body: checked.body,
		});
	}
	if (id === 'poc-act') {
		const checked = checkActions(input, settings.scope, docker);
		if (!checked.ok) {
			return fail(checked.reason);
		}
		return runReconPoc(settings, id, {
			action: 'act',
			url: checked.startUrl,
			allowedHosts: checked.allowedHosts,
			reachHostLoopback: checked.reachHostLoopback,
			actions: JSON.stringify(checked.actions),
		});
	}
	if (id === 'poc-xss-canary') {
		const checked = checkCanary(input, settings.scope, docker);
		if (!checked.ok) {
			return fail(checked.reason);
		}
		return runReconPoc(settings, id, {
			action: 'xss-canary',
			url: checked.url,
			allowedHosts: checked.allowedHosts,
			reachHostLoopback: checked.reachHostLoopback,
			payload: checked.payload,
		});
	}
	return fail(`Unknown tool: ${id}`);
}

function checkRequest(input: PocToolInput, scope: readonly string[], docker: boolean):
	| { ok: true; url: string; method: string; headersJson: string; body: string; bodyBytes: number; headerCount: number; allowedHosts: string[]; reachHostLoopback: boolean }
	| { ok: false; reason: string } {
	const raw = (input.url || '').trim();
	if (!raw) {
		return { ok: false, reason: 'url is required.' };
	}
	if (raw.length > MAX_URL) {
		return { ok: false, reason: 'url is too long.' };
	}
	const method = (input.method || 'GET').trim().toUpperCase();
	if (!ALLOWED_METHODS.has(method)) {
		return { ok: false, reason: `Method ${method} is refused. Allowed: ${[...ALLOWED_METHODS].join(', ')} (DELETE is destructive).` };
	}
	const body = typeof input.body === 'string'
		? input.body
		: (input.body && typeof input.body === 'object' ? JSON.stringify(input.body) : '');
	if (body.length > MAX_BODY) {
		return { ok: false, reason: `body is limited to ${MAX_BODY} characters.` };
	}
	const headers = sanitizeHeaders(input.headers);
	if (!headers.ok) {
		return headers;
	}
	const guarded = guardDestructive(raw) ?? (body ? guardDestructive(body) : undefined) ?? guardSqlTiming(`${raw}\n${body}`);
	if (guarded) {
		return { ok: false, reason: guarded };
	}
	const nav = allowUrl(scope, raw, docker);
	if (!nav.ok) {
		return nav;
	}
	return {
		ok: true,
		url: nav.url,
		method,
		headersJson: JSON.stringify(headers.value),
		body,
		bodyBytes: body.length,
		headerCount: headers.count,
		allowedHosts: nav.allowedHosts,
		reachHostLoopback: nav.reachHostLoopback,
	};
}

function checkActions(input: PocToolInput, scope: readonly string[], docker: boolean):
	| { ok: true; startUrl: string; actions: PocAction[]; allowedHosts: string[]; reachHostLoopback: boolean }
	| { ok: false; reason: string } {
	const raw = (input.url || '').trim();
	if (!raw) {
		return { ok: false, reason: 'url (flow start) is required.' };
	}
	const actions = Array.isArray(input.actions) ? input.actions.slice(0, MAX_ACTIONS) : [];
	if (actions.length === 0) {
		return { ok: false, reason: 'actions are required (goto / fill / click / submit / wait / extract).' };
	}
	const urls: string[] = [raw];
	let totalWait = 0;
	for (const [index, action] of actions.entries()) {
		const op = String(action?.op || '').toLowerCase();
		if (!ACTION_OPS.has(op)) {
			return { ok: false, reason: `Action ${index + 1}: unknown op "${action?.op}".` };
		}
		if (op === 'fill' || op === 'click' || op === 'submit' || op === 'extract') {
			if (op !== 'submit' && !action.selector) {
				return { ok: false, reason: `Action ${index + 1} (${op}): selector is required.` };
			}
			if (action.selector && !SELECTOR_RE.test(action.selector)) {
				return { ok: false, reason: `Action ${index + 1}: selector failed safety checks.` };
			}
		}
		if (op === 'fill') {
			const value = String(action.value ?? '');
			if (value.length > 500) {
				return { ok: false, reason: `Action ${index + 1}: fill value is limited to 500 characters.` };
			}
			const bad = guardDestructive(value);
			if (bad) {
				return { ok: false, reason: `Action ${index + 1}: ${bad}` };
			}
		}
		if (op === 'goto') {
			const target = String(action.value || '').trim();
			if (!target) {
				return { ok: false, reason: `Action ${index + 1} (goto): value (URL) is required.` };
			}
			urls.push(target);
		}
		if (op === 'wait') {
			const ms = Math.min(Math.max(Number(action.ms) || 800, 100), 4_000);
			totalWait += ms;
		}
	}
	if (totalWait > 12_000) {
		return { ok: false, reason: 'Total wait time is capped at 12s per flow.' };
	}
	const extraHosts: string[] = [];
	let reachHostLoopback = false;
	const rewrittenUrls: string[] = [];
	for (const url of urls) {
		const nav = allowUrl(scope, url, docker);
		if (!nav.ok) {
			return nav;
		}
		rewrittenUrls.push(nav.url);
		extraHosts.push(...nav.extraHosts);
		reachHostLoopback = reachHostLoopback || nav.reachHostLoopback;
	}
	const startUrl = rewrittenUrls.shift()!;
	const mapped = actions.map((action) => {
		if (action.op === 'goto') {
			return { ...action, value: rewrittenUrls.shift() };
		}
		if (action.op === 'wait') {
			return { ...action, ms: Math.min(Math.max(Number(action.ms) || 800, 100), 4_000) };
		}
		return action;
	});
	return {
		ok: true,
		startUrl,
		actions: mapped,
		allowedHosts: listBrowserAllowHosts(scope, extraHosts),
		reachHostLoopback,
	};
}

function checkCanary(input: PocToolInput, scope: readonly string[], docker: boolean):
	| { ok: true; url: string; payload: string; allowedHosts: string[]; reachHostLoopback: boolean }
	| { ok: false; reason: string } {
	const raw = (input.url || '').trim();
	const payload = (input.payload || '').trim();
	if (!raw || !payload) {
		return { ok: false, reason: 'url and payload are required.' };
	}
	if (payload.length > 800) {
		return { ok: false, reason: 'payload is limited to 800 characters.' };
	}
	if (XSS_EXFIL.test(payload)) {
		return { ok: false, reason: 'Payload refused: cookie/storage/network exfiltration and navigation are not allowed. Prove execution with a window marker (window.__hwPocFired = 1).' };
	}
	if (!raw.includes('__hwPoc') && !payload.includes('__hwPoc')) {
		return { ok: false, reason: 'Canary payload must set window.__hwPocFired (or push into window.__hwPoc) so the tool can prove execution.' };
	}
	const nav = allowUrl(scope, raw, docker);
	if (!nav.ok) {
		return nav;
	}
	return { ok: true, url: nav.url, payload, allowedHosts: nav.allowedHosts, reachHostLoopback: nav.reachHostLoopback };
}

function allowUrl(scope: readonly string[], raw: string, docker: boolean):
	| { ok: true; url: string; allowedHosts: string[]; extraHosts: string[]; reachHostLoopback: boolean }
	| { ok: false; reason: string } {
	const decision = evaluateBrowserNavigation(scope, raw, 'navigate');
	if (!decision.allow || !decision.url || !decision.host) {
		return { ok: false, reason: decision.reason };
	}
	const rewritten = rewriteLoopbackUrl(decision.url, docker);
	const extra = [decision.host];
	if (rewritten.reachHostLoopback) {
		extra.push(new URL(rewritten.href).hostname);
	}
	return {
		ok: true,
		url: rewritten.href,
		allowedHosts: listBrowserAllowHosts(scope, extra),
		extraHosts: extra,
		reachHostLoopback: rewritten.reachHostLoopback,
	};
}

function sanitizeHeaders(raw: Record<string, string> | undefined):
	| { ok: true; value: Record<string, string>; count: number }
	| { ok: false; reason: string } {
	const out: Record<string, string> = {};
	const entries = Object.entries(raw ?? {}).slice(0, 20);
	for (const [name, value] of entries) {
		const key = name.trim();
		if (!/^[!#$%&'*+\-.^_`|~a-zA-Z0-9]{1,80}$/.test(key)) {
			return { ok: false, reason: `Header name failed safety checks: ${key || '(empty)'}` };
		}
		const val = String(value ?? '');
		if (val.length > MAX_HEADER_VALUE || /[\r\n]/.test(val)) {
			return { ok: false, reason: `Header ${key}: value failed safety checks.` };
		}
		out[key] = val;
	}
	return { ok: true, value: out, count: entries.length };
}

function guardDestructive(text: string): string | undefined {
	if (DESTRUCTIVE_SQL.test(text)) {
		return 'Destructive SQL (DROP/DELETE/UPDATE/INSERT/INTO OUTFILE/xp_cmdshell) is refused. PoC proofs are read-only: error, boolean, or time-based evidence.';
	}
	return undefined;
}

function guardSqlTiming(text: string): string | undefined {
	const sleep = text.match(SLEEP_RE);
	if (sleep && Number(sleep[1]) > 5) {
		return 'Time-based proof delay is capped at 5 seconds (non-destructive).';
	}
	if (BENCHMARK_RE.test(text)) {
		return 'BENCHMARK() is refused (CPU burn). Use SLEEP(≤5) for time-based evidence.';
	}
	return undefined;
}

async function runReconPoc(
	settings: HawaldarSettings,
	id: string,
	job: {
		action: string;
		url: string;
		allowedHosts: string[];
		reachHostLoopback: boolean;
		method?: string;
		headers?: string;
		body?: string;
		payload?: string;
		actions?: string;
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
	if (job.method) {
		args.push('--method', job.method);
	}
	if (job.headers) {
		args.push('--headers', job.headers);
	}
	if (job.body) {
		args.push('--body', job.body);
	}
	if (job.payload) {
		args.push('--payload', job.payload);
	}
	if (job.actions) {
		args.push('--actions', job.actions);
	}
	args.push('--nav-timeout', '60000');
	const bound = await bindLoopbackBrowser(settings, job.url, job.reachHostLoopback);
	if (bound.href !== job.url) {
		const idx = args.indexOf('--url');
		if (idx >= 0) {
			args[idx + 1] = bound.href;
		}
	}
	const result = await podmanRun({
		podmanPath: settings.podmanPath,
		image: imageFor(settings, 'browser'),
		command: 'node',
		args,
		timeoutMs: TOOL_CATALOG.find((tool) => tool.id === id)?.timeoutMs ?? 120_000,
		network: 'target',
		reachHostLoopback: bound.reachHostLoopback,
		networkContainer: bound.networkContainer,
		memoryMb: MEMORY_MB,
		pidsLimit: PIDS,
		mounts: [reconScriptMount(settings)],
	});
	if (result.timedOut) {
		return fail('PoC probe timed out.');
	}
	const payload = parseJson(result.stdout);
	if (payload.ok === false) {
		return fail(typeof payload.error === 'string' ? payload.error : (result.stderr || 'PoC probe failed.'));
	}
	if (result.exitCode !== 0 && payload.ok !== true) {
		return fail(result.stderr || result.stdout || `exit ${result.exitCode}`);
	}
	return {
		ok: true,
		stdout: redactSecrets(result.stdout).slice(0, 20_000),
		stderr: result.stderr.slice(0, 4_000),
		exitCode: result.exitCode,
		source: BUILTIN_SOURCE,
		tool: id,
	};
}

/** Last-line defense: never echo credential material in tool output. */
export function redactSecrets(text: string): string {
	return text.replace(/("(?:cookie|authorization|set-cookie|x-api-key|x-auth-token|password)"\s*:\s*")[^"]*(")/gi, '$1REDACTED$2');
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

function hostOf(raw: string): string {
	try {
		return new URL(raw).hostname;
	} catch {
		return raw.slice(0, 60);
	}
}

function fail(stderr: string) {
	return { ok: false, stdout: '', stderr, exitCode: 1 };
}
