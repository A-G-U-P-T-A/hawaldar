import { isIPv4, isIPv6 } from 'node:net';

export type ScopeKind = 'ip' | 'host' | 'domain' | 'cidr';

export interface PolicyDecision {
	allow: boolean;
	code?: 'OUT_OF_SCOPE' | 'EMPTY_SCOPE' | 'INVALID_TARGET' | 'FORBIDDEN_TOOL';
	reason: string;
	kind?: ScopeKind;
}

/** Hostnames that clearly mean this machine (not LAN / RFC1918). */
const LOCAL_MACHINE_HOSTS = new Set([
	'localhost',
	'localhost.localdomain',
	'ip6-localhost',
	'ip6-loopback',
	'host.containers.internal',
	'host.docker.internal',
	'local',
	'this-pc',
	'this-machine',
	'this-computer',
	'this-host',
	'my-pc',
	'my-machine',
	'my-computer',
	'my-host',
]);

// sqlmap the raw CLI stays out of the model's hands; the bounded sqlmap-scan
// runner (strict flag allowlist, HITL) is the sanctioned replacement.
const FORBIDDEN_TOOLS = new Set([
	'msfvenom', 'hydra', 'medusa',
	'hashcat', 'john', 'mimikatz', 'bloodhound', 'impacket', 'responder',
]);

const TARGET_RE = /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*|\d{1,3}(?:\.\d{1,3}){3})$/;

/** Built-in OWASP Juice Shop lab. Keep in sync with tools/juice-shop.ts. */
export const JUICE_SHOP_LAB_URL = 'http://127.0.0.1:3000';
export const JUICE_SHOP_LAB_PORT = 3000;
const JUICE_SHOP_HINT = /\b(?:owasp\s+)?juice[\s-]*shop\b/i;

const DNS_ENUM_TOOLS = new Set([
	'dns-resolve', 'dns-records', 'dns-ns', 'dns-mx', 'dns-txt', 'dns-cname', 'dns-soa',
	'dns-axfr-check', 'dns-ptr',
	'subfinder', 'subfinder-silent', 'subfinder-sources',
	'amass', 'amass-passive',
	'dnsx', 'dnsx-a', 'dnsx-cname',
	'reverse-dns',
]);

const SAST_TOOLS = new Set(['semgrep-list', 'semgrep-scan', 'semgrep-owasp', 'semgrep-path']);

const URL_FACING_TOOLS = new Set([
	'httpx', 'httpx-title', 'httpx-tech',
	'katana', 'katana-depth', 'katana-js',
	'nuclei', 'nuclei-tech', 'nuclei-severity-info',
	'ffuf_dir', 'ffuf_vhost', 'ffuf_extensions',
	'browser-open', 'browser-snapshot', 'browser-console', 'browser-network', 'browser-links',
	'scrapling-fetch', 'scrapling-text', 'scrapling-links', 'scrapling-select', 'scrapling-adaptive',
	'research-open',
	'zap-spider', 'zap-ascan',
	'poc-request', 'poc-act', 'poc-xss-canary',
	'sqlmap-scan',
]);

const BROAD_LOCAL_SCAN_TOOLS = new Set([
	'scan-top-ports', 'quick-scan', 'scan-ports', 'detect-services', 'scan-local-ports',
	'naabu', 'naabu-top-ports',
]);

export interface TargetRef {
	raw: string;
	/** Operator-facing value (URL with port when this is a web target). */
	display: string;
	host: string;
	port?: number;
	url?: string;
	local: boolean;
	lab?: 'juice-shop';
}

export function classifyTarget(value: string): ScopeKind | undefined {
	const trimmed = restoreTargetPlaceholders(value).trim();
	if (trimmed.includes('/') && !/^https?:\/\//i.test(trimmed)) {
		const [network, prefix] = trimmed.split('/');
		if (network && isIPv4(network) && Number(prefix) >= 0 && Number(prefix) <= 32) {
			return 'cidr';
		}
		return undefined;
	}
	const host = hostOf(trimmed);
	if (!host) {
		return undefined;
	}
	if (isIPv4(host) || isIPv6(host)) {
		return 'ip';
	}
	if (TARGET_RE.test(host)) {
		return host.includes('.') ? 'domain' : 'host';
	}
	return undefined;
}

/** Loopback / this-machine names. Not 192.168/10/172.16 or other LAN ranges. */
export function isLocalMachineTarget(value: string): boolean {
	const host = hostOf(value);
	if (!host) {
		return false;
	}
	if (isLoopbackIp(host) || host === '0.0.0.0') {
		return true;
	}
	return LOCAL_MACHINE_HOSTS.has(host.toLowerCase().replace(/\.$/, ''));
}

/**
 * 0.0.0.0 is bind-all language, not “scan the internet”.
 * Map it to loopback; never treat it as 0.0.0.0/0.
 */
export function isLocalBindAny(value: string): boolean {
	return hostOf(value) === '0.0.0.0';
}

const LOCAL_MACHINE_HINT = /\b(?:localhost|127\.0\.0\.1|::1|local(?:ly)?|this\s+(?:pc|machine|computer|host|system)|my\s+(?:pc|machine|computer|host|system)|this\s+box)\b/i;

const IPV4_IN_TEXT = /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g;
const CIDR_IN_TEXT = /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\/(?:3[0-2]|[12]?\d)\b/g;
const FQDN_IN_TEXT = /\b[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+\b/g;
const MAX_IMPLICIT_TARGETS = 8;

/** Operator-facing copy when nothing was named and Settings → Scope is empty. */
export const MISSING_TARGET_REASON =
	'No target. Name a host, IP, domain, or CIDR, or say local / this machine.';

export function scopeIsConfigured(scope: readonly string[]): boolean {
	return allowlistedScopeEntries(scope).length > 0;
}

export type ImpliedTargetSource = 'local' | 'message' | 'scope-single' | 'scope-multi' | 'none';

export interface ImpliedTargets {
	targets: string[];
	source: ImpliedTargetSource;
	note: string;
}

export function messageImpliesLocalMachine(text: string): boolean {
	return LOCAL_MACHINE_HINT.test(text);
}

export function allowlistedScopeEntries(scope: readonly string[]): string[] {
	return scope.map((line) => line.trim()).filter((line) => line && !line.startsWith('!'));
}

/** Host-shaped implied values that connect-scan tools can take (not a wide CIDR). */
export function firstConnectScanTarget(targets: readonly string[]): string | undefined {
	for (const raw of targets) {
		const host = hostFromScopeEntry(raw);
		if (host) {
			return host;
		}
	}
	return undefined;
}

export function resolveImpliedTargets(message: string, scope: readonly string[]): ImpliedTargets {
	const text = restoreTargetPlaceholders(message);
	const canonical = extractCanonicalTarget(text, scope);
	if (canonical) {
		const lab = canonical.lab === 'juice-shop'
			? `OWASP Juice Shop lab at ${JUICE_SHOP_LAB_URL}.`
			: canonical.url
				? 'URL named in the operator message.'
				: canonical.local
					? 'Operator meant this machine.'
					: 'Host named in the operator message.';
		return {
			targets: [canonical.display],
			source: canonical.local ? 'local' : 'message',
			note: lab,
		};
	}
	const entries = allowlistedScopeEntries(scope);
	if (entries.length === 1) {
		const ref = parseTargetRef(entries[0]);
		return {
			targets: [ref?.display || entries[0]],
			source: 'scope-single',
			note: 'Sole engagement-scope entry.',
		};
	}
	if (entries.length > 1) {
		return {
			targets: entries,
			source: 'scope-multi',
			note: `All ${entries.length} in-scope entries; start with ${entries[0]}.`,
		};
	}
	return { targets: [], source: 'none', note: 'No implied target.' };
}

export function formatImpliedTargetBlock(implied: ImpliedTargets): string {
	if (implied.source === 'none' || implied.targets.length === 0) {
		return `No implied target. ${MISSING_TARGET_REASON} Empty Settings → Scope does not block a host they already named or local language.`;
	}
	const listed = implied.targets.join(', ');
	const cidrOnly = implied.targets.every((item) => classifyTarget(item) === 'cidr' && !hostFromScopeEntry(item));
	if (implied.source === 'local') {
		const ref = parseTargetRef(listed);
		const url = ref?.url || listed;
		const lab = ref?.lab === 'juice-shop' ? ' OWASP Juice Shop lab.' : '';
		const web = ref?.url
			? `Use httpx, katana, browser-open, and scrapling-fetch on ${url}. Do not run subfinder, dns-resolve, or a broad nmap/naabu of the host gateway.`
			: 'Call scan-local-ports or scan-ports on 127.0.0.1 now.';
		return [
			`Resolved target: ${url} (this machine).${lab}`,
			'127.0.0.1 / localhost are real in-scope loopback addresses — not missing values. Do not ask for an IP.',
			web,
			'Semgrep scans ~/.hawaldar/workspace only, never this URL. An empty workspace is a gap, not a reason to stop.',
		].join(' ');
	}
	if (cidrOnly) {
		return [
			`Resolved target: ${listed} (${implied.note})`,
			'Run discover-hosts on that CIDR, then connect-scan live hosts. Do not ask the operator to retype it.',
		].join(' ');
	}
	if (implied.targets.length === 1) {
		return [
			`Resolved target: ${listed} (${implied.note})`,
			`Call nmap / dns / httpx / naabu (or the matching gated tool) on ${listed} now. Do not ask which target.`,
		].join(' ');
	}
	return [
		`Resolved targets: ${listed} (${implied.note})`,
		`Call nmap / dns / httpx / naabu on each, starting with ${implied.targets[0]}. Do not ask the operator to retype or pick.`,
	].join(' ');
}

/** Live Settings → Scope list plus this-turn resolution. Injected into agent context. */
export function formatEngagementScopeContext(scope: readonly string[], implied: ImpliedTargets): string {
	const allow = allowlistedScopeEntries(scope);
	const lines = [
		'Engagement scope this turn (Settings → Scope). Use this list when the operator did not name a host.',
	];
	if (allow.length === 0) {
		lines.push('- (empty — a named host/IP/domain/CIDR or local/this machine is still allowed. Do not demand Settings.)');
	} else {
		for (const entry of allow) {
			lines.push(`- ${entry}`);
		}
	}
	lines.push(formatImpliedTargetBlock(implied));
	return lines.join('\n');
}

export function impliedConnectScanTargets(implied: readonly string[], scope: readonly string[]): string[] {
	const pool = implied.length > 0 ? implied : allowlistedScopeEntries(scope);
	const out: string[] = [];
	for (const item of pool) {
		const host = hostFromScopeEntry(item);
		if (host && !out.includes(host)) {
			out.push(host);
		}
	}
	return out.slice(0, MAX_IMPLICIT_TARGETS);
}

export function impliedDiscoveryTargets(implied: readonly string[], scope: readonly string[]): string[] {
	const pool = implied.length > 0 ? implied : allowlistedScopeEntries(scope);
	const out: string[] = [];
	for (const item of pool) {
		const host = hostFromScopeEntry(item);
		if (host) {
			if (!out.includes(host)) {
				out.push(host);
			}
			continue;
		}
		if (classifyTarget(item) !== 'cidr') {
			continue;
		}
		const prefix = Number(item.split('/')[1]);
		if (Number.isInteger(prefix) && prefix >= 24 && prefix <= 32 && !out.includes(item)) {
			out.push(item);
		}
	}
	return out.slice(0, MAX_IMPLICIT_TARGETS);
}

function extractNamedTargets(message: string, scope: readonly string[]): string[] {
	const found: string[] = [];
	const add = (value: string) => {
		const trimmed = unwrapTarget(value);
		if (!trimmed) {
			return;
		}
		if (!classifyTarget(trimmed) && !isLocalMachineTarget(trimmed) && !parseTargetRef(trimmed)?.url) {
			return;
		}
		const host = normalizeHost(trimmed);
		const existing = found.findIndex((item) => normalizeHost(item) === host);
		if (existing >= 0) {
			if (isRicherTarget(trimmed, found[existing])) {
				found[existing] = trimmed;
			}
			return;
		}
		found.push(trimmed);
	};
	for (const match of message.matchAll(/https?:\/\/[^\s<>"')\]]+/gi)) {
		try {
			const parsed = new URL(match[0].replace(/[),.;]+$/, ''));
			add(parsed.origin);
		} catch {
			// ignore malformed URL
		}
	}
	const cidrs = [...message.matchAll(CIDR_IN_TEXT)].map((match) => match[0]);
	for (const cidr of cidrs) {
		add(cidr);
	}
	for (const match of message.matchAll(IPV4_IN_TEXT)) {
		if (cidrs.some((cidr) => cidr.startsWith(`${match[0]}/`))) {
			continue;
		}
		add(match[0]);
	}
	if (/\b::1\b/.test(message) || /\[::1\]/.test(message)) {
		add('::1');
	}
	for (const match of message.matchAll(FQDN_IN_TEXT)) {
		if (isIPv4(match[0])) {
			continue;
		}
		add(match[0]);
	}
	const scopeHosts = new Set(allowlistedScopeEntries(scope).map((item) => normalizeHost(item)));
	for (const token of message.split(/[^\w.-]+/)) {
		if (scopeHosts.has(normalizeHost(token)) && classifyTarget(token)) {
			add(token);
		}
	}
	return found;
}

function hostFromScopeEntry(value: string): string | undefined {
	const trimmed = restoreTargetPlaceholders(value).trim();
	const kind = classifyTarget(trimmed);
	if (kind === 'cidr') {
		const [network, prefix] = trimmed.split('/');
		if (network && prefix === '32' && isIPv4(network)) {
			return network;
		}
		return undefined;
	}
	const host = hostOf(trimmed);
	if (kind === 'ip' || kind === 'host' || kind === 'domain') {
		return resolveLocalScanTarget(host) ?? host;
	}
	return undefined;
}

/**
 * Fill a missing tool target when exactly one host is implied.
 * Several hosts stay unset so nmap/httpx can iterate the list.
 */
export function fillImpliedToolTarget(
	toolId: string,
	requested: string | undefined,
	implied: readonly string[],
	scope: readonly string[] = [],
): string | undefined {
	if (SAST_TOOLS.has(toolId)) {
		return undefined;
	}
	const restoredReq = requested?.trim()
		? restoreTargetPlaceholders(requested.trim(), implied)
		: undefined;
	const impliedRef = (implied[0] ? parseTargetRef(implied[0]) : undefined)
		|| extractCanonicalTarget(implied.filter(Boolean).join(' '), scope);
	const reqRef = restoredReq ? parseTargetRef(restoredReq) : undefined;
	const merged = preferRicherTargetRef(reqRef, impliedRef);

	if (toolId === 'scan-local-ports' && !merged && !restoredReq) {
		return '127.0.0.1';
	}

	if (isUrlFacingTool(toolId)) {
		if (restoredReq && keepsUrlPath(restoredReq)) {
			return restoredReq;
		}
		return merged?.url || merged?.display || restoredReq;
	}

	if (merged) {
		return merged.display;
	}
	if (restoredReq) {
		return restoredReq;
	}

	const discovery = toolId === 'discover-hosts' || toolId === 'reverse-dns' || toolId === 'dns-ptr';
	const list = discovery
		? impliedDiscoveryTargets(implied, scope)
		: impliedConnectScanTargets(implied, scope);
	return list.length === 1 ? list[0] : undefined;
}

/** Keep path+query for probe URLs (sqlmap/poc/zap). parseTargetRef otherwise collapses to origin. */
function keepsUrlPath(value: string): boolean {
	try {
		const parsed = new URL(value);
		return (parsed.pathname && parsed.pathname !== '/') || Boolean(parsed.search);
	} catch {
		return false;
	}
}

export function isSastTool(toolId: string): boolean {
	return SAST_TOOLS.has(toolId);
}

export function isUrlFacingTool(toolId: string): boolean {
	return URL_FACING_TOOLS.has(toolId)
		|| toolId.startsWith('browser-')
		|| toolId.startsWith('scrapling-')
		|| toolId.startsWith('poc-');
}

export function isDnsEnumTool(toolId: string): boolean {
	return DNS_ENUM_TOOLS.has(toolId);
}

/** Host-side skip: localhost has no public DNS / subdomains; Juice Shop / loopback URLs skip host-gateway nmap/naabu. */
export function skipReasonForTool(toolId: string, target: string | undefined, implied: readonly string[] = []): string | undefined {
	const candidates = [target, ...implied].map((item) => (item || '').trim()).filter(Boolean);
	const refs = candidates.map((item) => parseTargetRef(item)).filter((item): item is TargetRef => Boolean(item));
	const local = refs.find((item) => item.local);
	if (!local) {
		return undefined;
	}
	if (DNS_ENUM_TOOLS.has(toolId)) {
		return `Skipped: ${local.display} is loopback — no public DNS or subdomains.`;
	}
	const loopbackWeb = refs.some((item) => item.local && (
		item.lab === 'juice-shop'
		|| Boolean(item.port)
		|| Boolean(item.url)
		|| looksLikeHttpUrl(item.raw)
	));
	if (loopbackWeb && BROAD_LOCAL_SCAN_TOOLS.has(toolId)) {
		const shown = refs.find((item) => item.local && (item.url || item.port))?.display || local.display;
		return `Skipped: ${shown} is a loopback web app — no broad host-gateway nmap/naabu. Recon uses httpx/katana/browser/scrapling on this URL.`;
	}
	return undefined;
}

/** Named port on a localhost web lab: scan that port instead of the whole host gateway. */
export function focusedPortForLocalScan(toolId: string, target: string | undefined, implied: readonly string[] = []): number | undefined {
	if (!BROAD_LOCAL_SCAN_TOOLS.has(toolId) && toolId !== 'scan-port-range' && toolId !== 'probe-http-ports') {
		return undefined;
	}
	const ref = parseTargetRef(target || implied[0] || '');
	if (ref?.local && ref.port) {
		return ref.port;
	}
	return undefined;
}

/** Canonical nmap target for local/bind language, or undefined if not this machine. */
export function resolveLocalScanTarget(value: string): string | undefined {
	const host = hostOf(value);
	if (!host || !isLocalMachineTarget(host)) {
		return undefined;
	}
	if (isIPv6Loopback(host)) {
		return '::1';
	}
	return '127.0.0.1';
}

export function assertSafeTarget(value: string): PolicyDecision {
	const restored = restoreTargetPlaceholders(value).trim();
	if (!restored) {
		return { allow: false, code: 'INVALID_TARGET', reason: 'Target failed safety checks.' };
	}
	const host = hostOf(restored);
	if (!host || /[\s;|&$`<>\\]/.test(host) || host.includes('..')) {
		return { allow: false, code: 'INVALID_TARGET', reason: 'Target failed safety checks.' };
	}
	const kind = classifyTarget(host);
	if (!kind || kind === 'cidr') {
		return { allow: false, code: 'INVALID_TARGET', reason: 'Scan targets must be a single host or IPv4 address, not a CIDR.' };
	}
	return { allow: true, kind, reason: 'ok' };
}

export function evaluateDiscoveryScope(scope: readonly string[], target: string): PolicyDecision {
	const trimmed = target.trim();
	if (classifyTarget(trimmed) === 'cidr') {
		const prefix = Number(trimmed.split('/')[1]);
		if (!Number.isInteger(prefix) || prefix < 24 || prefix > 32) {
			return { allow: false, code: 'INVALID_TARGET', reason: 'Discovery CIDR must be /24 or smaller.' };
		}
		const allow = allowlistedScopeEntries(scope);
		if (allow.length === 0) {
			return { allow: true, kind: 'cidr', reason: 'named CIDR (scope unset)' };
		}
		if (!allow.includes(trimmed)) {
			return { allow: false, code: 'OUT_OF_SCOPE', reason: `CIDR ${trimmed} is not an exact scope entry.` };
		}
		return { allow: true, kind: 'cidr', reason: 'in scope' };
	}
	return evaluateScope(scope, target);
}

export function evaluateScope(scope: readonly string[], target: string): PolicyDecision {
	const safe = assertSafeTarget(target);
	if (!safe.allow) {
		return safe;
	}
	const host = hostOf(target);
	const allow = scope.map((line) => line.trim()).filter((line) => line && !line.startsWith('!'));
	const deny = scope.map((line) => line.trim()).filter((line) => line.startsWith('!')).map((line) => line.slice(1).trim());
	if (deny.some((rule) => matchesRule(rule, host) || deniesLocalMachine(rule, host))) {
		return { allow: false, code: 'OUT_OF_SCOPE', reason: `Target ${target} is denied by scope.` };
	}
	if (isLocalMachineTarget(host)) {
		return {
			allow: true,
			kind: safe.kind,
			reason: isLocalBindAny(host) ? 'local bind (loopback)' : 'local machine',
		};
	}
	if (allow.length === 0) {
		return { allow: true, kind: safe.kind, reason: 'named target (scope unset)' };
	}
	if (!allow.some((rule) => matchesRule(rule, host))) {
		return { allow: false, code: 'OUT_OF_SCOPE', reason: `Target ${target} is not in engagement scope.` };
	}
	return { allow: true, kind: safe.kind, reason: 'in scope' };
}

/** Search-engine hosts allowed only as a hop for `browser-search`. Result links still need scope. */
export const SEARCH_ENGINE_HOSTS = [
	'google.com',
	'www.google.com',
	'duckduckgo.com',
	'www.duckduckgo.com',
	'html.duckduckgo.com',
	'bing.com',
	'www.bing.com',
] as const;

export type BrowserNavMode = 'navigate' | 'search-hop';

export interface ParsedBrowserUrl {
	href: string;
	host: string;
	protocol: 'http:' | 'https:';
}

const REFUSED_BROWSER_SCHEME = /^(javascript|data|file|blob|about|vbscript|chrome|chrome-extension):/i;

export function isSearchEngineHost(value: string): boolean {
	const host = normalizeHost(value);
	return (SEARCH_ENGINE_HOSTS as readonly string[]).includes(host);
}

export function parseBrowserUrl(raw: string): { ok: true; value: ParsedBrowserUrl } | { ok: false; reason: string; code: PolicyDecision['code'] } {
	const trimmed = raw.trim();
	if (!trimmed) {
		return { ok: false, code: 'INVALID_TARGET', reason: 'URL is required.' };
	}
	if (REFUSED_BROWSER_SCHEME.test(trimmed) || /javascript:/i.test(trimmed)) {
		return { ok: false, code: 'INVALID_TARGET', reason: 'javascript:, data:, file:, and other non-http schemes are refused.' };
	}
	let href = trimmed;
	if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href)) {
		const hostToken = (href.split('/')[0] || href).replace(/:\d+$/, '');
		href = `${isLocalMachineTarget(hostToken) ? 'http' : 'https'}://${href}`;
	}
	let parsed: URL;
	try {
		parsed = new URL(href);
	} catch {
		return { ok: false, code: 'INVALID_TARGET', reason: 'URL could not be parsed.' };
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		return { ok: false, code: 'INVALID_TARGET', reason: 'Only http/https URLs are allowed.' };
	}
	if (parsed.username || parsed.password) {
		return { ok: false, code: 'INVALID_TARGET', reason: 'URLs with embedded credentials are refused.' };
	}
	const host = parsed.hostname;
	if (!host) {
		return { ok: false, code: 'INVALID_TARGET', reason: 'URL host is required.' };
	}
	if (/[\s;|&$`<>\\]/.test(host) || host.includes('..')) {
		return { ok: false, code: 'INVALID_TARGET', reason: 'Target failed safety checks.' };
	}
	return {
		ok: true,
		value: {
			href: parsed.href,
			host,
			protocol: parsed.protocol,
		},
	};
}

/**
 * Gate every browser navigation. `search-hop` allows google/duckduckgo/bing
 * even when those hosts are not in engagement scope. Loopback follows evaluateScope.
 */
export function evaluateBrowserNavigation(
	scope: readonly string[],
	raw: string,
	mode: BrowserNavMode = 'navigate',
): PolicyDecision & { url?: string; host?: string } {
	const parsed = parseBrowserUrl(raw);
	if (!parsed.ok) {
		return { allow: false, code: parsed.code, reason: parsed.reason };
	}
	if (mode === 'search-hop' && isSearchEngineHost(parsed.value.host)) {
		return {
			allow: true,
			kind: classifyTarget(parsed.value.host) ?? 'domain',
			reason: 'search engine hop',
			url: parsed.value.href,
			host: parsed.value.host,
		};
	}
	const decision = evaluateScope(scope, parsed.value.host);
	return { ...decision, url: parsed.value.href, host: parsed.value.host };
}

export function classifyBrowserResult(scope: readonly string[], raw: string): {
	href: string;
	host: string;
	inScope: boolean;
	reason: string;
} {
	const parsed = parseBrowserUrl(raw);
	if (!parsed.ok) {
		return { href: raw.trim(), host: '', inScope: false, reason: parsed.reason };
	}
	if (!scopeIsConfigured(scope)) {
		const local = isLocalMachineTarget(parsed.value.host);
		return {
			href: parsed.value.href,
			host: parsed.value.host,
			inScope: local,
			reason: local ? 'local machine' : 'not in a configured engagement scope',
		};
	}
	const decision = evaluateScope(scope, parsed.value.host);
	return {
		href: parsed.value.href,
		host: parsed.value.host,
		inScope: decision.allow,
		reason: decision.reason,
	};
}

/** Hosts the container may land on (scope + optional search-hop extras). */
export function listBrowserAllowHosts(scope: readonly string[], extra: readonly string[] = []): string[] {
	const hosts = new Set<string>();
	for (const entry of allowlistedScopeEntries(scope)) {
		const host = hostFromScopeEntry(entry);
		if (host) {
			hosts.add(normalizeHost(host));
		}
		const kind = classifyTarget(entry);
		if (kind === 'domain' || kind === 'host' || kind === 'ip') {
			hosts.add(normalizeHost(entry));
		}
	}
	for (const item of extra) {
		const host = hostOf(item);
		if (host) {
			hosts.add(normalizeHost(host));
		}
	}
	return [...hosts];
}

export function rejectForbiddenTool(name: string): PolicyDecision | undefined {
	const key = name.trim().toLowerCase();
	if (FORBIDDEN_TOOLS.has(key)) {
		return {
			allow: false,
			code: 'FORBIDDEN_TOOL',
			reason: `${name} is outside Hawaldar policy. Payload builders, credential-dumping, and unbounded exploitation are not wired; bounded proofs run through poc-*, sqlmap-scan, and zap-ascan.`,
		};
	}
	return undefined;
}

function matchesRule(rule: string, target: string): boolean {
	const host = hostOf(target);
	if (rule.includes('/')) {
		return cidrContains(rule, host);
	}
	if (isIPv4(rule) || isIPv6(rule)) {
		return normalizeHost(rule) === normalizeHost(host);
	}
	const allowed = normalizeHost(rule);
	const value = normalizeHost(host);
	return value === allowed || value.endsWith(`.${allowed}`);
}

function deniesLocalMachine(rule: string, target: string): boolean {
	if (isLocalBindAny(rule) || isLocalBindAny(target)) {
		return isLocalBindAny(rule) && isLocalBindAny(target);
	}
	return isLocalMachineTarget(target) && isLocalMachineTarget(rule);
}

function unwrapTarget(value: string): string {
	const trimmed = value.trim();
	if (trimmed.startsWith('[') && trimmed.endsWith(']') && trimmed.includes(':')) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

/** Hostname/IP from a URL, host:port, or bare host. Never returns a placeholder token. */
export function hostOf(value: string): string {
	const trimmed = restoreTargetPlaceholders(value).trim();
	if (!trimmed) {
		return '';
	}
	try {
		if (/^https?:\/\//i.test(trimmed)) {
			return new URL(trimmed).hostname;
		}
	} catch {
		// fall through
	}
	if (trimmed.startsWith('[') && trimmed.includes(']')) {
		const end = trimmed.indexOf(']');
		if (end > 1) {
			return trimmed.slice(1, end);
		}
	}
	const colon = trimmed.lastIndexOf(':');
	if (colon > 0 && /^\d{1,5}$/.test(trimmed.slice(colon + 1)) && !trimmed.includes('/')) {
		const maybe = trimmed.slice(0, colon);
		if (isIPv4(maybe) || isIPv6(maybe) || TARGET_RE.test(maybe) || LOCAL_MACHINE_HOSTS.has(maybe.toLowerCase())) {
			return maybe;
		}
	}
	return unwrapTarget(trimmed);
}

export function looksLikeHttpUrl(value: string): boolean {
	return /^https?:\/\//i.test(value.trim());
}

/** Workspace / pcap paths. http(s) URLs are never files even though they contain `/`. */
export function looksLikeLocalPath(value: string): boolean {
	const trimmed = value.trim();
	if (!trimmed || looksLikeHttpUrl(trimmed)) {
		return false;
	}
	return /[\\/]/.test(trimmed) || /\.(pcap|pcapng|exe|dll|so|bin)$/i.test(trimmed);
}

export function restoreTargetPlaceholders(text: string, targets: readonly string[] = []): string {
	if (!text || (!text.includes('[IP_ADDRESS]') && !text.includes('[ip_address]'))) {
		return text;
	}
	const preferred = pickPreferredTarget(targets);
	return text
		.replace(/https?:\/\/\[IP_ADDRESS\](?::(\d+))?/gi, (_m, port: string | undefined) => {
			if (preferred?.url) {
				if (port && preferred.port && Number(port) !== preferred.port) {
					return `${preferred.local ? 'http' : 'https'}://${preferred.host}:${port}`;
				}
				return preferred.url;
			}
			const n = port ? Number(port) : undefined;
			if (n === JUICE_SHOP_LAB_PORT) {
				return JUICE_SHOP_LAB_URL;
			}
			return `http://127.0.0.1${port ? `:${port}` : ''}`;
		})
		.replace(/\[IP_ADDRESS\](?::(\d+))?/gi, (_m, port: string | undefined) => {
			if (preferred) {
				if (port) {
					return `${preferred.host}:${port}`;
				}
				return preferred.display;
			}
			if (port && Number(port) === JUICE_SHOP_LAB_PORT) {
				return `127.0.0.1:${JUICE_SHOP_LAB_PORT}`;
			}
			return port ? `127.0.0.1:${port}` : '127.0.0.1';
		});
}

export function parseTargetRef(value: string): TargetRef | undefined {
	const raw = restoreTargetPlaceholders(value).trim().replace(/[),.;]+$/, '');
	if (!raw) {
		return undefined;
	}
	let parsed: URL | undefined;
	try {
		if (/^https?:\/\//i.test(raw)) {
			parsed = new URL(raw);
		}
	} catch {
		return undefined;
	}
	if (parsed) {
		const host = parsed.hostname;
		if (!host) {
			return undefined;
		}
		const port = parsed.port ? Number(parsed.port) : undefined;
		const origin = `${parsed.protocol}//${parsed.host}`;
		const local = isLocalMachineTarget(host);
		return {
			raw,
			display: origin,
			host,
			port: Number.isFinite(port) ? port : undefined,
			url: origin,
			local,
			lab: juiceLabFor(host, port, raw),
		};
	}

	const hostPort = raw.match(/^(\[?[A-Za-z0-9._:-]+\]?):(\d{1,5})$/);
	if (hostPort) {
		const host = hostPort[1].replace(/^\[|\]$/g, '');
		const port = Number(hostPort[2]);
		if (port >= 1 && port <= 65535 && (isIPv4(host) || isIPv6(host) || TARGET_RE.test(host) || LOCAL_MACHINE_HOSTS.has(host.toLowerCase()))) {
			const local = isLocalMachineTarget(host);
			const url = `${local ? 'http' : 'https'}://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${port}`;
			return {
				raw,
				display: url,
				host,
				port,
				url,
				local,
				lab: juiceLabFor(host, port, raw),
			};
		}
	}

	const host = hostOf(raw);
	if (!host) {
		return undefined;
	}
	if (classifyTarget(raw) === 'cidr') {
		return { raw, display: raw.trim(), host: raw.trim(), local: false };
	}
	if (!classifyTarget(host) && !isLocalMachineTarget(host)) {
		return undefined;
	}
	const local = isLocalMachineTarget(host);
	return {
		raw,
		display: host,
		host,
		local,
		lab: juiceLabFor(host, undefined, raw),
	};
}

export function extractCanonicalTarget(message: string, scope: readonly string[] = []): TargetRef | undefined {
	const text = restoreTargetPlaceholders(message);
	const juice = JUICE_SHOP_HINT.test(text);

	const urls: TargetRef[] = [];
	for (const match of text.matchAll(/https?:\/\/[^\s<>"')\]]+/gi)) {
		const ref = parseTargetRef(match[0]);
		if (ref) {
			urls.push(ref);
		}
	}
	if (urls.length > 0) {
		const chosen = urls.find((item) => item.local) || urls[0];
		if (juice && chosen.local && !chosen.port) {
			return { ...parseTargetRef(JUICE_SHOP_LAB_URL)!, lab: 'juice-shop' };
		}
		if (juice && chosen.local) {
			return { ...chosen, lab: 'juice-shop' };
		}
		return chosen;
	}

	const hostPort = text.match(/\b(?:127\.\d{1,3}\.\d{1,3}\.\d{1,3}|localhost|\[::1\]):(\d{2,5})\b/i);
	if (hostPort) {
		const ref = parseTargetRef(hostPort[0]);
		if (ref) {
			return juice && ref.local ? { ...ref, lab: 'juice-shop' } : ref;
		}
	}

	if (juice) {
		return { ...parseTargetRef(JUICE_SHOP_LAB_URL)!, lab: 'juice-shop' };
	}

	if (messageImpliesLocalMachine(text)) {
		return parseTargetRef('127.0.0.1');
	}

	const named = extractNamedTargets(text, scope);
	if (named[0]) {
		return parseTargetRef(named[0]);
	}
	return undefined;
}

function juiceLabFor(host: string, port: number | undefined, raw: string): 'juice-shop' | undefined {
	if (JUICE_SHOP_HINT.test(raw)) {
		return 'juice-shop';
	}
	if (isLocalMachineTarget(host) && port === JUICE_SHOP_LAB_PORT) {
		return 'juice-shop';
	}
	return undefined;
}

function pickPreferredTarget(targets: readonly string[]): TargetRef | undefined {
	for (const item of targets) {
		const ref = parseTargetRef(item);
		if (ref) {
			return ref;
		}
	}
	return undefined;
}

function preferRicherTargetRef(requested: TargetRef | undefined, implied: TargetRef | undefined): TargetRef | undefined {
	if (!requested) {
		return implied;
	}
	if (!implied) {
		return requested;
	}
	const sameHost = normalizeHost(requested.host) === normalizeHost(implied.host)
		|| (requested.local && implied.local);
	if (sameHost && ((implied.port && !requested.port) || (implied.url && !requested.url))) {
		return { ...implied, lab: implied.lab || requested.lab };
	}
	return requested;
}

function isRicherTarget(next: string, existing: string): boolean {
	const a = parseTargetRef(next);
	const b = parseTargetRef(existing);
	if (!a) {
		return false;
	}
	if (!b) {
		return true;
	}
	if (a.url && !b.url) {
		return true;
	}
	if (a.port && !b.port) {
		return true;
	}
	return false;
}

function isLoopbackIp(value: string): boolean {
	if (isIPv4(value)) {
		const first = Number(value.split('.')[0]);
		return first === 127;
	}
	return isIPv6Loopback(value);
}

function isIPv6Loopback(value: string): boolean {
	if (!isIPv6(value)) {
		return false;
	}
	const lowered = value.toLowerCase();
	return lowered === '::1' || lowered === '0:0:0:0:0:0:0:1';
}

function normalizeHost(value: string): string {
	return hostOf(value).toLowerCase().replace(/\.$/, '');
}

function ipToInt(ip: string): number | undefined {
	if (!isIPv4(ip)) {
		return undefined;
	}
	const parts = ip.split('.').map((part) => Number(part));
	if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) {
		return undefined;
	}
	return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function cidrContains(cidr: string, ip: string): boolean {
	const [network, prefixRaw] = cidr.split('/');
	if (!network || prefixRaw === undefined) {
		return false;
	}
	const prefix = Number(prefixRaw);
	const networkInt = ipToInt(network);
	const ipInt = ipToInt(ip);
	if (networkInt === undefined || ipInt === undefined || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
		return false;
	}
	if (prefix === 0) {
		return true;
	}
	const mask = (0xffffffff << (32 - prefix)) >>> 0;
	return (networkInt & mask) === (ipInt & mask);
}
