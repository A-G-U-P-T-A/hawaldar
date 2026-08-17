import {
	classifyBrowserResult,
	evaluateBrowserNavigation,
	listBrowserAllowHosts,
	parseBrowserUrl,
	scopeIsConfigured,
} from '../policy';
import { looksLikeDockerBin } from '../sandbox/host-info';
import { podmanRun } from '../sandbox/podman';
import { imageFor, isToolEnabled, type HawaldarSettings } from '../settings';
import { rewriteLoopbackUrl } from './browser';
import { BUILTIN_SOURCE, TOOL_CATALOG } from './catalog';

const MEMORY_MB = 768;
const PIDS = 256;
const SCRIPT = '/opt/hawaldar-scrapling/recon.py';

const URL_TOOLS = new Set([
	'scrapling-fetch',
	'scrapling-text',
	'scrapling-links',
	'scrapling-select',
	'scrapling-adaptive',
]);

const SELECT_TOOLS = new Set(['scrapling-select', 'scrapling-adaptive']);

export type ScraplingMode = 'http' | 'stealth';
export type ScraplingSelectorType = 'css' | 'xpath';

export interface ScraplingToolInput {
	target?: string;
	url?: string;
	selector?: string;
	selectorType?: string;
	identifier?: string;
	mode?: string;
}

function timeoutMs(id: string): number {
	return TOOL_CATALOG.find((tool) => tool.id === id)?.timeoutMs ?? 90_000;
}

/** Mastra inputSchema for scrapling tools. Uses the runtime `z` instance. */
export function buildScraplingInputSchema(z: any, id: string) {
	const target = z.string().optional()
		.describe('In-scope http(s) URL or host. Loopback follows local-target rules. javascript: refused. Empty scope does not block a named URL.');
	const mode = z.enum(['http', 'stealth']).optional()
		.describe('http (default) or stealth TLS impersonation via Fetcher. No CAPTCHA/WAF-attack kit. JS-heavy pages → browser specialist.');
	if (SELECT_TOOLS.has(id)) {
		return z.object({
			target,
			url: z.string().optional(),
			selector: z.string().describe(id === 'scrapling-adaptive'
				? 'CSS or XPath to save, then relocate if the DOM changed.'
				: 'CSS or XPath selector. No Python.'),
			selectorType: z.enum(['css', 'xpath']).optional().describe('css (default) or xpath.'),
			identifier: z.string().optional()
				.describe('Optional adaptive storage key. Defaults to the selector.'),
			mode,
		});
	}
	return z.object({ target, url: z.string().optional(), mode });
}

export function parseScraplingMode(raw: string | undefined): { ok: true; value: ScraplingMode } | { ok: false; reason: string } {
	const mode = (raw ?? 'http').trim().toLowerCase();
	if (mode === 'http' || mode === 'stealth') {
		return { ok: true, value: mode };
	}
	return { ok: false, reason: 'mode must be http or stealth.' };
}

export function parseSelectorType(raw: string | undefined): { ok: true; value: ScraplingSelectorType } | { ok: false; reason: string } {
	const type = (raw ?? 'css').trim().toLowerCase();
	if (type === 'css' || type === 'xpath') {
		return { ok: true, value: type };
	}
	return { ok: false, reason: 'selectorType must be css or xpath.' };
}

export function parseScraplingSelector(raw: string | undefined): { ok: true; value: string } | { ok: false; reason: string } {
	const selector = (raw ?? '').trim();
	if (!selector) {
		return { ok: false, reason: 'selector is required.' };
	}
	if (selector.length > 500) {
		return { ok: false, reason: 'selector is limited to 500 characters.' };
	}
	if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(selector) || /javascript:|data:/i.test(selector)) {
		return { ok: false, reason: 'selector failed safety checks.' };
	}
	return { ok: true, value: selector };
}

export function parseScraplingIdentifier(raw: string | undefined, fallback: string): { ok: true; value: string } | { ok: false; reason: string } {
	const identifier = (raw ?? '').trim() || fallback;
	if (identifier.length > 120) {
		return { ok: false, reason: 'identifier is limited to 120 characters.' };
	}
	if (/[\x00-\x1f\x7f]/.test(identifier)) {
		return { ok: false, reason: 'identifier failed safety checks.' };
	}
	return { ok: true, value: identifier };
}

export async function runScraplingTool(
	settings: HawaldarSettings,
	id: string,
	input: ScraplingToolInput,
) {
	if (!isToolEnabled(settings, id)) {
		return fail(`${id} is disabled.`);
	}
	if (!URL_TOOLS.has(id)) {
		return fail(`Unknown tool: ${id}`);
	}

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

	const mode = parseScraplingMode(input.mode);
	if (!mode.ok) {
		return fail(mode.reason);
	}

	let selector = '';
	let selectorType: ScraplingSelectorType = 'css';
	let identifier = '';
	if (SELECT_TOOLS.has(id)) {
		const sel = parseScraplingSelector(input.selector);
		if (!sel.ok) {
			return fail(sel.reason);
		}
		const kind = parseSelectorType(input.selectorType);
		if (!kind.ok) {
			return fail(kind.reason);
		}
		const ident = parseScraplingIdentifier(input.identifier, sel.value);
		if (!ident.ok) {
			return fail(ident.reason);
		}
		selector = sel.value;
		selectorType = kind.value;
		identifier = ident.value;
	}

	const docker = looksLikeDockerBin(settings.podmanPath);
	const rewritten = rewriteLoopbackUrl(decision.url, docker);
	const extra = [decision.host];
	if (rewritten.reachHostLoopback) {
		extra.push(new URL(rewritten.href).hostname);
	}
	const allowed = listBrowserAllowHosts(settings.scope, extra);
	const action = id.replace(/^scrapling-/, '');
	const result = await runRecon(settings, id, {
		action,
		url: rewritten.href,
		allowedHosts: allowed,
		reachHostLoopback: rewritten.reachHostLoopback,
		mode: mode.value,
		selector,
		selectorType,
		identifier,
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
	if (id === 'scrapling-links' && Array.isArray(payload.links)) {
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

async function runRecon(
	settings: HawaldarSettings,
	id: string,
	job: {
		action: string;
		url: string;
		allowedHosts: string[];
		reachHostLoopback: boolean;
		mode: ScraplingMode;
		selector: string;
		selectorType: ScraplingSelectorType;
		identifier: string;
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
		'--mode',
		job.mode,
	];
	if (job.selector) {
		args.push('--selector', job.selector, '--selector-type', job.selectorType);
	}
	if (job.identifier) {
		args.push('--identifier', job.identifier);
	}
	if (job.reachHostLoopback) {
		args.push('--insecure');
	}
	const result = await podmanRun({
		podmanPath: settings.podmanPath,
		image: imageFor(settings, 'scrapling'),
		command: 'python',
		args,
		timeoutMs: timeoutMs(id),
		network: 'target',
		reachHostLoopback: job.reachHostLoopback,
		memoryMb: MEMORY_MB,
		pidsLimit: PIDS,
	});
	if (result.timedOut) {
		return fail('Scrapling fetch timed out.');
	}
	const payload = parseJson(result.stdout);
	if (payload.ok === false) {
		return fail(typeof payload.error === 'string' ? payload.error : (result.stderr || 'Scrapling fetch failed.'));
	}
	if (result.exitCode !== 0 && payload.ok !== true) {
		return fail(result.stderr || result.stdout || `exit ${result.exitCode}`);
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
