import { isIPv4 } from 'node:net';

export type ScopeKind = 'ip' | 'host' | 'domain' | 'cidr';

export interface PolicyDecision {
	allow: boolean;
	code?: 'OUT_OF_SCOPE' | 'EMPTY_SCOPE' | 'INVALID_TARGET' | 'FORBIDDEN_TOOL';
	reason: string;
	kind?: ScopeKind;
}

const FORBIDDEN_TOOLS = new Set([
	'metasploit', 'msfconsole', 'msfvenom', 'sqlmap', 'hydra', 'medusa',
	'hashcat', 'john', 'mimikatz', 'bloodhound', 'impacket', 'responder',
]);

const TARGET_RE = /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*|\d{1,3}(?:\.\d{1,3}){3})$/;

export function classifyTarget(value: string): ScopeKind | undefined {
	const trimmed = value.trim();
	if (trimmed.includes('/')) {
		const [network, prefix] = trimmed.split('/');
		if (network && isIPv4(network) && Number(prefix) >= 0 && Number(prefix) <= 32) {
			return 'cidr';
		}
		return undefined;
	}
	if (isIPv4(trimmed)) {
		return 'ip';
	}
	if (TARGET_RE.test(trimmed)) {
		return trimmed.includes('.') ? 'domain' : 'host';
	}
	return undefined;
}

export function assertSafeTarget(value: string): PolicyDecision {
	const trimmed = value.trim();
	if (!trimmed || /[\s;|&$`<>\\]/.test(trimmed) || trimmed.includes('..')) {
		return { allow: false, code: 'INVALID_TARGET', reason: 'Target failed safety checks.' };
	}
	const kind = classifyTarget(trimmed);
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
		const allow = scope.map((line) => line.trim()).filter((line) => line && !line.startsWith('!'));
		if (allow.length === 0) {
			return { allow: false, code: 'EMPTY_SCOPE', reason: 'Engagement scope is empty. Add hosts in Hawaldar Settings.' };
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
	const allow = scope.map((line) => line.trim()).filter((line) => line && !line.startsWith('!'));
	const deny = scope.map((line) => line.trim()).filter((line) => line.startsWith('!')).map((line) => line.slice(1).trim());
	if (allow.length === 0) {
		return { allow: false, code: 'EMPTY_SCOPE', reason: 'Engagement scope is empty. Add hosts in Hawaldar Settings before any scan.' };
	}
	if (deny.some((rule) => matchesRule(rule, target))) {
		return { allow: false, code: 'OUT_OF_SCOPE', reason: `Target ${target} is denied by scope.` };
	}
	if (!allow.some((rule) => matchesRule(rule, target))) {
		return { allow: false, code: 'OUT_OF_SCOPE', reason: `Target ${target} is not in engagement scope.` };
	}
	return { allow: true, kind: safe.kind, reason: 'in scope' };
}

export function rejectForbiddenTool(name: string): PolicyDecision | undefined {
	const key = name.trim().toLowerCase();
	if (FORBIDDEN_TOOLS.has(key)) {
		return {
			allow: false,
			code: 'FORBIDDEN_TOOL',
			reason: `${name} is outside Hawaldar policy (recon only). Metasploit and credential-dumping tools are not wired.`,
		};
	}
	return undefined;
}

function matchesRule(rule: string, target: string): boolean {
	if (rule.includes('/')) {
		return cidrContains(rule, target);
	}
	if (isIPv4(rule)) {
		return rule === target.trim();
	}
	const allowed = normalizeHost(rule);
	const value = normalizeHost(target);
	return value === allowed || value.endsWith(`.${allowed}`);
}

function normalizeHost(value: string): string {
	return value.trim().toLowerCase().replace(/\.$/, '');
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
