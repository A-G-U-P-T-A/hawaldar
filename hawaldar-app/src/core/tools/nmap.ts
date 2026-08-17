import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	evaluateDiscoveryScope,
	evaluateScope,
	impliedConnectScanTargets,
	impliedDiscoveryTargets,
	MISSING_TARGET_REASON,
	parseTargetRef,
	resolveLocalScanTarget,
} from '../policy';
import { looksLikeDockerBin } from '../sandbox/host-info';
import { containerLoopbackTarget, podmanRun } from '../sandbox/podman';
import { classifySpawnError, isStaleNetworkBackend, STALE_NETWORK_BACKEND } from '../sandbox/podman-path';
import {
	ensureWorkspace,
	isUnderWorkspace,
	WORKSPACE_CONTAINER_PATH,
	workspaceHostPath,
} from '../sandbox/workspace';
import { imageFor, isToolEnabled, type HawaldarSettings } from '../settings';
import { TOOL_CATALOG } from './catalog';
import { assertLocalFile } from './files';

const XML_CONTAINER = `${WORKSPACE_CONTAINER_PATH}/scans/nmap-last.xml`;
const XML_NAME = 'nmap-last.xml';
const HTTP_PORTS = '80,443,8080,8443';
const FORBIDDEN_ARG = /^(?:-sS|-sU|-sF|-sX|-sN|-O|--script|--script-args|--traceroute|--privileged)$/i;
const PORT_TOKEN = /^(\d{1,5})(?:-(\d{1,5}))?$/;

export interface NmapToolInput {
	topPorts?: number;
	portRange?: string;
	filePath?: string;
	impliedTargets?: string[];
	operatorTarget?: string;
}

function timeout(id: string): number {
	return TOOL_CATALOG.find((tool) => tool.id === id)?.timeoutMs ?? 180_000;
}

function clampTop(value: number | undefined, max: number, fallback = 100): number {
	const n = value ?? fallback;
	return Math.min(Math.max(Math.trunc(n), 1), max);
}

/** Mastra inputSchema for nmap tools. Uses the runtime `z` instance. */
export function buildNmapInputSchema(z: any, id: string) {
	const target = z.string().optional()
		.describe('Host or IPv4. Omit to use a host named this turn, local/this machine → 127.0.0.1, or Settings → Scope if set. Empty scope does not block a named or local target.');
	const topPorts = z.number().int().min(1).max(1000).optional()
		.describe('Nmap --top-ports N (TCP connect)');
	switch (id) {
		case 'discover-hosts':
		case 'reverse-dns':
		case 'probe-http-ports':
			return z.object({ target });
		case 'quick-scan':
		case 'scan-ports':
		case 'detect-services':
			return z.object({ target, topPorts });
		case 'scan-top-ports':
			return z.object({
				target,
				topPorts: topPorts.describe('How many top TCP ports to connect-scan (default 100, max 1000)'),
			});
		case 'scan-local-ports':
			return z.object({
				target: z.string().optional()
					.describe('This machine. Defaults to 127.0.0.1. localhost / ::1 / local aliases accepted. Not LAN.'),
				topPorts,
				portRange: z.string().optional().describe('TCP ports or range, e.g. 1-1024. Default is nmap top ports.'),
			});
		case 'scan-port-range':
			return z.object({
				target,
				portRange: z.string().describe('TCP ports or range, e.g. 1-1024 or 80,443'),
			});
		case 'nmap-xml-summary':
			return z.object({
				filePath: z.string().optional().describe('Workspace nmap XML path. Defaults to the last scan file.'),
			});
		default:
			return z.object({ target: target.optional(), topPorts: topPorts.optional() });
	}
}

export function parsePortRange(raw: string | undefined): { ok: true; value: string } | { ok: false; reason: string } {
	if (!raw || !raw.trim()) {
		return { ok: false, reason: 'portRange is required (e.g. 1-1024 or 80,443).' };
	}
	const trimmed = raw.trim();
	if (/[^\d,\-]/.test(trimmed) || trimmed.includes('--')) {
		return { ok: false, reason: 'portRange must be TCP ports like 1-1024 or 80,443. UDP and flags are refused.' };
	}
	const tokens = trimmed.split(',').filter(Boolean);
	if (tokens.length === 0 || tokens.length > 32) {
		return { ok: false, reason: 'portRange must list 1–32 TCP ports or ranges.' };
	}
	let count = 0;
	const normalized: string[] = [];
	for (const token of tokens) {
		const match = token.match(PORT_TOKEN);
		if (!match) {
			return { ok: false, reason: `Invalid port token: ${token}` };
		}
		const start = Number(match[1]);
		const end = match[2] !== undefined ? Number(match[2]) : start;
		if (start < 1 || end > 65535 || start > end) {
			return { ok: false, reason: `Invalid port bounds: ${token}` };
		}
		count += end - start + 1;
		if (count > 2048) {
			return { ok: false, reason: 'portRange is limited to 2048 TCP ports per scan.' };
		}
		normalized.push(match[2] !== undefined ? `${start}-${end}` : String(start));
	}
	return { ok: true, value: normalized.join(',') };
}

export async function runNmapTool(
	settings: HawaldarSettings,
	id: string,
	target: string,
	extra?: NmapToolInput,
) {
	if (!isToolEnabled(settings, id)) {
		return fail(`${id} is disabled.`);
	}
	if (id === 'nmap-xml-summary') {
		return summarizeWorkspaceXml(extra?.filePath);
	}

	const raw = target.trim() || (id === 'scan-local-ports' ? '127.0.0.1' : '');
	if (id === 'scan-local-ports') {
		const local = resolveLocalScanTarget(raw || '127.0.0.1');
		if (!local) {
			return fail('scan-local-ports only targets this machine (127.0.0.1 / localhost). Use scan-ports for an in-scope remote host. LAN CIDRs are not implied.');
		}
		const decision = evaluateScope(settings.scope, local);
		if (!decision.allow) {
			return fail(decision.reason);
		}
		const ref = parseTargetRef(raw);
		return runConnectScan(settings, id, local, {
			...extra,
			portRange: extra?.portRange || (ref?.port ? String(ref.port) : undefined),
			operatorTarget: ref?.display || local,
		});
	}

	const discovery = id === 'discover-hosts' || id === 'reverse-dns';
	if (!raw) {
		return runImpliedTargets(settings, id, extra, discovery);
	}
	const ref = parseTargetRef(raw);
	const host = resolveLocalScanTarget(raw) ?? ref?.host ?? raw;
	const decision = discovery
		? evaluateDiscoveryScope(settings.scope, host)
		: evaluateScope(settings.scope, host);
	if (!decision.allow) {
		return fail(decision.reason);
	}
	return runConnectScan(settings, id, host, {
		...extra,
		portRange: extra?.portRange || (ref?.local && ref.port ? String(ref.port) : undefined),
		operatorTarget: ref?.display || host,
	});
}

async function runImpliedTargets(
	settings: HawaldarSettings,
	id: string,
	extra: NmapToolInput | undefined,
	discovery: boolean,
) {
	const implied = extra?.impliedTargets ?? [];
	const list = discovery
		? impliedDiscoveryTargets(implied, settings.scope)
		: impliedConnectScanTargets(implied, settings.scope);
	if (list.length === 0) {
		return fail(MISSING_TARGET_REASON);
	}
	const rows: Array<Record<string, unknown> & { target: string; ok: boolean; stdout: string; stderr: string; exitCode: number }> = [];
	for (const item of list) {
		const decision = discovery
			? evaluateDiscoveryScope(settings.scope, item)
			: evaluateScope(settings.scope, item);
		if (!decision.allow) {
			rows.push({
				ok: false,
				stdout: '',
				stderr: decision.reason,
				exitCode: 1,
				target: item,
			});
			continue;
		}
		const canon = resolveLocalScanTarget(item) ?? item;
		rows.push({ ...await runConnectScan(settings, id, canon, extra), target: canon });
	}
	if (rows.length === 1) {
		return rows[0];
	}
	const ok = rows.every((row) => row.ok);
	return {
		ok,
		stdout: rows.map((row) => `## ${row.target}\n${row.stdout || row.stderr}`).join('\n\n').slice(0, 20_000),
		stderr: rows.filter((row) => !row.ok).map((row) => `${row.target}: ${row.stderr}`).join('\n').slice(0, 4_000),
		exitCode: ok ? 0 : 1,
		tool: id,
		targets: rows.map((row) => row.target),
	};
}

async function runConnectScan(
	settings: HawaldarSettings,
	id: string,
	target: string,
	extra?: NmapToolInput,
) {
	const docker = looksLikeDockerBin(settings.podmanPath);
	const local = resolveLocalScanTarget(target);
	const reachHostLoopback = Boolean(local);
	const scanTarget = local ? containerLoopbackTarget(local, docker) : target;
	const operatorTarget = extra?.operatorTarget || target;
	const built = buildArgs(id, scanTarget, extra);
	if (!built.ok) {
		return fail(built.reason);
	}
	const refused = built.args.find((arg) => FORBIDDEN_ARG.test(arg));
	if (refused) {
		return fail(`Flag ${refused} is refused. Authorized recon uses TCP connect, ping, or list-scan only.`);
	}

	try {
		const result = await podmanRun({
			podmanPath: settings.podmanPath,
			image: imageFor(settings, 'nmap'),
			entrypoint: 'nmap',
			args: built.args,
			timeoutMs: timeout(id),
			network: 'target',
			reachHostLoopback,
		});
		const scannedAsIp = parseNmapReportAddress(result.stdout);
		const wrapped = wrap(result, {
			tool: id,
			target: operatorTarget,
			scannedAs: scanTarget,
			...(scannedAsIp && scannedAsIp !== scanTarget ? { scannedAsIp } : {}),
			argv: built.args,
		});
		return {
			...wrapped,
			stdout: formatNmapResultText(operatorTarget, scanTarget, wrapped.stdout, scannedAsIp).slice(0, 20_000),
		};
	} catch (error) {
		return fail(classifySpawnError(error));
	}
}

function buildArgs(
	id: string,
	target: string,
	extra?: NmapToolInput,
): { ok: true; args: string[] } | { ok: false; reason: string } {
	const xml = ['-oX', XML_CONTAINER];
	switch (id) {
		case 'discover-hosts':
			return { ok: true, args: ['-sn', '-n', ...xml, target] };
		case 'quick-scan':
		case 'scan-ports':
			if (extra?.portRange) {
				const range = parsePortRange(extra.portRange);
				if (!range.ok) {
					return range;
				}
				return { ok: true, args: ['-sT', '-Pn', '-n', '-p', range.value, ...xml, target] };
			}
			return { ok: true, args: ['-sT', '-Pn', '-n', '--top-ports', String(clampTop(extra?.topPorts, 100)), ...xml, target] };
		case 'detect-services':
			if (extra?.portRange) {
				const range = parsePortRange(extra.portRange);
				if (!range.ok) {
					return range;
				}
				return { ok: true, args: ['-sT', '-sV', '-Pn', '-n', '-p', range.value, ...xml, target] };
			}
			return { ok: true, args: ['-sT', '-sV', '-Pn', '-n', '--top-ports', String(clampTop(extra?.topPorts, 100)), ...xml, target] };
		case 'scan-top-ports':
			if (extra?.portRange) {
				const range = parsePortRange(extra.portRange);
				if (!range.ok) {
					return range;
				}
				return { ok: true, args: ['-sT', '-Pn', '-n', '-p', range.value, ...xml, target] };
			}
			return { ok: true, args: ['-sT', '-Pn', '-n', '--top-ports', String(clampTop(extra?.topPorts, 1000)), ...xml, target] };
		case 'scan-local-ports': {
			if (extra?.portRange) {
				const range = parsePortRange(extra.portRange);
				if (!range.ok) {
					return range;
				}
				return { ok: true, args: ['-sT', '-Pn', '-n', '-p', range.value, ...xml, target] };
			}
			return { ok: true, args: ['-sT', '-Pn', '-n', '--top-ports', String(clampTop(extra?.topPorts, 1000)), ...xml, target] };
		}
		case 'scan-port-range': {
			const range = parsePortRange(extra?.portRange);
			if (!range.ok) {
				return range;
			}
			return { ok: true, args: ['-sT', '-Pn', '-n', '-p', range.value, ...xml, target] };
		}
		case 'probe-http-ports':
			return { ok: true, args: ['-sT', '-sV', '-Pn', '-n', '-p', HTTP_PORTS, ...xml, target] };
		case 'reverse-dns':
			return { ok: true, args: ['-sL', '--system-dns', ...xml, target] };
		default:
			return { ok: false, reason: `Unknown nmap tool: ${id}` };
	}
}

function summarizeWorkspaceXml(filePath?: string) {
	try {
		ensureWorkspace();
		const resolved = resolveScanXml(filePath);
		if (!resolved) {
			return fail('No nmap XML in the workspace. Run a connect scan first (writes /workspace/scans/nmap-last.xml).');
		}
		const xml = fs.readFileSync(resolved, 'utf8');
		if (xml.length > 2_000_000) {
			return fail('Scan XML is larger than 2MB.');
		}
		const summary = summarizeNmapXml(xml);
		return {
			ok: true,
			stdout: summary.slice(0, 20_000),
			stderr: '',
			exitCode: 0,
			tool: 'nmap-xml-summary',
			filePath: resolved,
		};
	} catch (error) {
		return fail(error instanceof Error ? error.message : String(error));
	}
}

function resolveScanXml(filePath?: string): string | undefined {
	if (filePath && filePath.trim()) {
		const trimmed = filePath.trim();
		const host = trimmed.startsWith(`${WORKSPACE_CONTAINER_PATH}/`)
			? path.join(workspaceHostPath(), trimmed.slice(WORKSPACE_CONTAINER_PATH.length + 1))
			: trimmed;
		const resolved = assertLocalFile(host, /\.xml$/i);
		if (!isUnderWorkspace(resolved)) {
			throw new Error('XML path must be under the Hawaldar workspace.');
		}
		return resolved;
	}
	const last = path.join(workspaceHostPath(), 'scans', XML_NAME);
	if (fs.existsSync(last) && fs.statSync(last).isFile()) {
		return last;
	}
	const dir = path.join(workspaceHostPath(), 'scans');
	if (!fs.existsSync(dir)) {
		return undefined;
	}
	const newest = fs.readdirSync(dir)
		.filter((name) => name.toLowerCase().endsWith('.xml'))
		.map((name) => path.join(dir, name))
		.filter((item) => fs.statSync(item).isFile())
		.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
	return newest[0];
}

export function summarizeNmapXml(xml: string): string {
	const lines: string[] = [];
	const run = xml.match(/<nmaprun\b([^>]*)>/);
	if (run) {
		const args = xmlAttr(run[1], 'args');
		const started = xmlAttr(run[1], 'startstr');
		if (args) {
			lines.push(`args: ${args}`);
		}
		if (started) {
			lines.push(`started: ${started}`);
		}
	}
	const hosts = xml.matchAll(/<host\b[\s\S]*?<\/host>/g);
	for (const host of hosts) {
		const block = host[0];
		const addr = block.match(/<address\b[^>]*\baddr="([^"]+)"/)?.[1] ?? '?';
		const state = block.match(/<status\b[^>]*\bstate="([^"]+)"/)?.[1] ?? '';
		const ptr = block.match(/<hostname\b[^>]*\bname="([^"]+)"[^>]*type="PTR"/)?.[1]
			?? block.match(/<hostname\b[^>]*\bname="([^"]+)"/)?.[1];
		lines.push(`host ${addr}${state ? ` ${state}` : ''}${ptr ? ` PTR ${ptr}` : ''}`);
		const ports = block.matchAll(/<port\b([^>]*)>[\s\S]*?<\/port>/g);
		for (const port of ports) {
			const proto = xmlAttr(port[1], 'protocol') || 'tcp';
			const portid = xmlAttr(port[1], 'portid');
			const st = port[0].match(/<state\b[^>]*\bstate="([^"]+)"/)?.[1] ?? '';
			if (st !== 'open' && st !== 'open|filtered') {
				continue;
			}
			const svc = port[0].match(/<service\b([^>]*)>/);
			const name = svc ? xmlAttr(svc[1], 'name') : '';
			const product = svc ? xmlAttr(svc[1], 'product') : '';
			const version = svc ? xmlAttr(svc[1], 'version') : '';
			lines.push(`  ${proto}/${portid} ${st}${name ? ` ${name}` : ''}${product ? ` ${product}` : ''}${version ? ` ${version}` : ''}`);
		}
	}
	return lines.join('\n') || 'No hosts or open ports found in XML.';
}

function xmlAttr(attrs: string, name: string): string {
	return attrs.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1] ?? '';
}

/** IPv4 nmap printed for the host it actually reached (alias or bare). */
export function parseNmapReportAddress(stdout: string): string | undefined {
	const named = stdout.match(/Nmap scan report for \S+ \((\d{1,3}(?:\.\d{1,3}){3})\)/);
	if (named?.[1]) {
		return named[1];
	}
	const bare = stdout.match(/Nmap scan report for (\d{1,3}(?:\.\d{1,3}){3})\b/);
	return bare?.[1];
}

/** Structured lines the model must copy into the operator report. */
export function formatNmapResultText(
	target: string,
	scannedAs: string,
	stdout: string,
	scannedAsIp?: string,
): string {
	const via = scannedAsIp && scannedAsIp !== scannedAs ? `${scannedAs} (${scannedAsIp})` : scannedAs;
	const header = `target: ${target}\nscannedAs: ${via}`;
	return stdout.trim() ? `${header}\n\n${stdout}` : header;
}

function fail(stderr: string) {
	return { ok: false, stdout: '', stderr, exitCode: 1 };
}

function wrap(result: { exitCode: number; stdout: string; stderr: string; timedOut: boolean }, extra: Record<string, unknown>) {
	const stderr = isStaleNetworkBackend(`${result.stdout}\n${result.stderr}`)
		? STALE_NETWORK_BACKEND
		: result.stderr;
	return {
		ok: result.exitCode === 0 && !result.timedOut,
		stdout: result.stdout.slice(0, 20_000),
		stderr: stderr.slice(0, 4_000),
		exitCode: result.exitCode,
		timedOut: result.timedOut,
		...extra,
	};
}
