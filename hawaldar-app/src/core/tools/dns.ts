import { isIPv4, isIPv6 } from 'node:net';
import {
	assertSafeTarget,
	classifyTarget,
	evaluateScope,
	impliedConnectScanTargets,
	isLocalMachineTarget,
	MISSING_TARGET_REASON,
	resolveLocalScanTarget,
	skipReasonForTool,
} from '../policy';
import { podmanRun } from '../sandbox/podman';
import { imageFor, isToolEnabled, type HawaldarSettings } from '../settings';
import { BUILTIN_SOURCE, TOOL_CATALOG } from './catalog';

export const DNS_RECORD_TYPES = ['A', 'AAAA', 'MX', 'NS', 'TXT', 'CNAME', 'SOA'] as const;
export type DnsRecordType = (typeof DNS_RECORD_TYPES)[number];

const DEFAULT_RECORD_TYPES: DnsRecordType[] = [...DNS_RECORD_TYPES];
const MAX_AXFR_NS = 4;
const TYPE_SET = new Set<string>(DNS_RECORD_TYPES);

export interface DnsToolInput {
	target?: string;
	types?: string[];
	nameserver?: string;
	impliedTargets?: string[];
}

function timeoutMs(id: string): number {
	return TOOL_CATALOG.find((tool) => tool.id === id)?.timeoutMs ?? 60_000;
}

function fail(stderr: string) {
	return { ok: false, stdout: '', stderr, exitCode: 1 };
}

/** Mastra inputSchema for dns tools. Uses the runtime `z` instance. */
export function buildDnsInputSchema(z: any, id: string) {
	const target = z.string().optional()
		.describe('Host, IP, or domain. Omit to use a host named this turn, local/this machine → 127.0.0.1, or Settings → Scope if set. Empty scope does not block a named target.');
	switch (id) {
		case 'dns-records':
			return z.object({
				target,
				types: z.array(z.enum(DNS_RECORD_TYPES)).optional()
					.describe('Record types to query (default A, AAAA, MX, NS, TXT, CNAME, SOA).'),
			});
		case 'dns-axfr-check':
			return z.object({
				target,
				nameserver: z.string().optional()
					.describe('Optional nameserver to test. Defaults to the zone NS set. Zone is scope-gated; this is a permit-check only.'),
			});
		case 'dns-ptr':
			return z.object({
				target: z.string().optional()
					.describe('IPv4 or IPv6 address for reverse DNS. localhost → 127.0.0.1.'),
			});
		default:
			return z.object({ target });
	}
}

export function parseRecordTypes(raw: unknown): { ok: true; value: DnsRecordType[] } | { ok: false; reason: string } {
	if (raw == null) {
		return { ok: true, value: DEFAULT_RECORD_TYPES };
	}
	const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[,\s]+/) : [];
	const out: DnsRecordType[] = [];
	for (const item of list) {
		const type = String(item || '').trim().toUpperCase();
		if (!type) {
			continue;
		}
		if (type === 'AXFR' || type === 'ANY') {
			return { ok: false, reason: 'AXFR and ANY are refused here. Use dns-axfr-check for a permit-only AXFR test.' };
		}
		if (!TYPE_SET.has(type)) {
			return { ok: false, reason: `Unsupported record type: ${type}. Allowed: ${DNS_RECORD_TYPES.join(', ')}.` };
		}
		if (!out.includes(type as DnsRecordType)) {
			out.push(type as DnsRecordType);
		}
		if (out.length > 8) {
			return { ok: false, reason: 'At most 8 record types per query.' };
		}
	}
	return { ok: true, value: out.length > 0 ? out : DEFAULT_RECORD_TYPES };
}

export async function runDnsTool(
	settings: HawaldarSettings,
	id: string,
	input: DnsToolInput,
) {
	if (!isToolEnabled(settings, id)) {
		return fail(`${id} is disabled.`);
	}
	const raw = (input.target ?? '').trim();
	if (!raw) {
		const hosts = impliedConnectScanTargets(input.impliedTargets ?? [], settings.scope);
		if (hosts.length === 0) {
			return fail(MISSING_TARGET_REASON);
		}
		if (hosts.length === 1) {
			return runDnsOnce(settings, id, hosts[0], input);
		}
		const rows = [];
		for (const item of hosts) {
			rows.push({ ...await runDnsOnce(settings, id, item, input), target: item });
		}
		const ok = rows.every((row) => row.ok);
		return {
			ok,
			stdout: rows.map((row) => `## ${row.target}\n${row.stdout || row.stderr}`).join('\n\n').slice(0, 20_000),
			stderr: rows.filter((row) => !row.ok).map((row) => `${row.target}: ${row.stderr}`).join('\n').slice(0, 4_000),
			exitCode: ok ? 0 : 1,
			source: BUILTIN_SOURCE,
			tool: id,
		};
	}
	return runDnsOnce(settings, id, raw, input);
}

async function runDnsOnce(
	settings: HawaldarSettings,
	id: string,
	raw: string,
	input: DnsToolInput,
) {
	const host = resolveLocalScanTarget(raw) ?? raw.trim();
	const skip = skipReasonForTool(id, host);
	if (skip) {
		return { ok: true, stdout: skip, stderr: '', exitCode: 0, source: BUILTIN_SOURCE, tool: id, target: host };
	}
	if (isLocalMachineTarget(host) && id !== 'dns-ptr') {
		const reason = `Skipped: ${host} is loopback — no public DNS or subdomains.`;
		return { ok: true, stdout: reason, stderr: '', exitCode: 0, source: BUILTIN_SOURCE, tool: id, target: host };
	}
	const decision = evaluateScope(settings.scope, host);
	if (!decision.allow) {
		return fail(decision.reason);
	}

	if (id === 'dns-ptr') {
		if (!isIPv4(host) && !isIPv6(host)) {
			return fail('dns-ptr requires an IPv4 or IPv6 address.');
		}
		return runDig(settings, id, host, ['+time=5', '+tries=1', '+short', '-x', host]);
	}

	if (id === 'dns-axfr-check') {
		return runAxfrCheck(settings, host, input.nameserver);
	}

	const kind = classifyTarget(host);
	if (kind === 'cidr') {
		return fail('DNS tools take a host, IP, or domain — not a CIDR.');
	}

	switch (id) {
		case 'dns-resolve':
			return runDig(settings, id, host, ['+time=5', '+tries=1', '+nocmd', '+noall', '+answer', host, 'A', host, 'AAAA']);
		case 'dns-records': {
			const types = parseRecordTypes(input.types);
			if (!types.ok) {
				return fail(types.reason);
			}
			const args = ['+time=5', '+tries=1', '+nocmd', '+noall', '+answer'];
			for (const type of types.value) {
				args.push(host, type);
			}
			return runDig(settings, id, host, args);
		}
		case 'dns-ns':
			return runDig(settings, id, host, ['+time=5', '+tries=1', '+short', host, 'NS']);
		case 'dns-mx':
			return runDig(settings, id, host, ['+time=5', '+tries=1', '+short', host, 'MX']);
		case 'dns-txt':
			return runDig(settings, id, host, ['+time=5', '+tries=1', '+short', host, 'TXT']);
		case 'dns-cname':
			return runDig(settings, id, host, ['+time=5', '+tries=1', '+short', host, 'CNAME']);
		case 'dns-soa':
			return runDig(settings, id, host, ['+time=5', '+tries=1', '+short', host, 'SOA']);
		default:
			return fail(`Unknown dns tool: ${id}`);
	}
}

async function runAxfrCheck(settings: HawaldarSettings, zone: string, nameserver?: string) {
	const kind = classifyTarget(zone);
	if (kind !== 'domain' && kind !== 'host') {
		return fail('dns-axfr-check needs a domain (the zone to test).');
	}

	let servers: string[] = [];
	const requested = (nameserver ?? '').trim();
	if (requested) {
		const safe = assertSafeTarget(requested);
		if (!safe.allow) {
			return fail(safe.reason);
		}
		servers = [resolveLocalScanTarget(requested) ?? requested];
	} else {
		const ns = await runDigRaw(settings, 'dns-ns', ['+time=5', '+tries=1', '+short', zone, 'NS']);
		const found = ns.stdout.split(/\r?\n/).map((line) => line.trim().replace(/\.$/, '')).filter((line) => {
			if (!line || line.startsWith(';') || line.toLowerCase().startsWith('target:')) {
				return false;
			}
			return assertSafeTarget(line).allow;
		});
		servers = found.slice(0, MAX_AXFR_NS);
		if (servers.length === 0) {
			return {
				ok: true,
				stdout: `target: ${zone}\nAXFR check: no nameservers returned. Cannot test zone transfer.`,
				stderr: ns.stderr.slice(0, 4_000),
				exitCode: 0,
				source: BUILTIN_SOURCE,
				tool: 'dns-axfr-check',
				target: zone,
			};
		}
	}

	const lines = [`target: ${zone}`, 'AXFR permit-check (zone contents are not dumped).'];
	for (const ns of servers) {
		const result = await runDigRaw(settings, 'dns-axfr-check', [
			'+time=3',
			'+tries=1',
			'+noall',
			'+answer',
			'AXFR',
			zone,
			`@${ns}`,
		]);
		lines.push(summarizeAxfr(ns, result.stdout, result.stderr, result.exitCode));
	}
	return {
		ok: true,
		stdout: lines.join('\n').slice(0, 20_000),
		stderr: '',
		exitCode: 0,
		source: BUILTIN_SOURCE,
		tool: 'dns-axfr-check',
		target: zone,
	};
}

export function summarizeAxfr(ns: string, stdout: string, stderr: string, exitCode: number): string {
	const text = `${stdout}\n${stderr}`;
	if (/Transfer failed|REFUSED|NOTAUTH|not permitted|connection timed out|network unreachable|timed out/i.test(text)) {
		const rcode = text.match(/\b(?:REFUSED|NOTAUTH|SERVFAIL|NXDOMAIN|FORMERR)\b/i)?.[0];
		return `${ns}: AXFR not permitted${rcode ? ` (${rcode})` : ''}`;
	}
	const answers = stdout.split(/\r?\n/).filter((line) => {
		const trimmed = line.trim();
		return trimmed && !trimmed.startsWith(';');
	});
	if (answers.length >= 2 && /SOA/i.test(stdout)) {
		return `${ns}: AXFR permitted (${answers.length} records observed; zone not dumped)`;
	}
	if (exitCode !== 0) {
		return `${ns}: AXFR not permitted (exit ${exitCode})`;
	}
	return `${ns}: AXFR inconclusive`;
}

async function runDigRaw(settings: HawaldarSettings, id: string, args: string[]) {
	return podmanRun({
		podmanPath: settings.podmanPath,
		image: imageFor(settings, 'dns'),
		command: 'dig',
		args,
		timeoutMs: timeoutMs(id),
		network: 'target',
	});
}

async function runDig(
	settings: HawaldarSettings,
	id: string,
	target: string,
	args: string[],
) {
	const result = await runDigRaw(settings, id, args);
	const stdout = result.stdout.trim()
		? `target: ${target}\n\n${result.stdout}`.slice(0, 20_000)
		: `target: ${target}`;
	return {
		ok: result.exitCode === 0 && !result.timedOut,
		stdout,
		stderr: result.stderr.slice(0, 4_000),
		exitCode: result.exitCode,
		timedOut: result.timedOut,
		source: BUILTIN_SOURCE,
		tool: id,
		target,
	};
}
