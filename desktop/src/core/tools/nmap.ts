import * as fs from 'node:fs';
import * as path from 'node:path';
import { evaluateDiscoveryScope, evaluateScope } from '../policy';
import { podmanRun } from '../sandbox/podman';
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
	const target = z.string().describe('In-scope host or IPv4 address');
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

	const discovery = id === 'discover-hosts' || id === 'reverse-dns';
	const decision = discovery
		? evaluateDiscoveryScope(settings.scope, target)
		: evaluateScope(settings.scope, target);
	if (!decision.allow) {
		return fail(decision.reason);
	}

	const built = buildArgs(id, target, extra);
	if (!built.ok) {
		return fail(built.reason);
	}
	const refused = built.args.find((arg) => FORBIDDEN_ARG.test(arg));
	if (refused) {
		return fail(`Flag ${refused} is refused. Authorized recon uses TCP connect, ping, or list-scan only.`);
	}

	const result = await podmanRun({
		podmanPath: settings.podmanPath,
		image: imageFor(settings, 'nmap'),
		entrypoint: 'nmap',
		args: built.args,
		timeoutMs: timeout(id),
		network: 'target',
	});
	return wrap(result, { tool: id, target, argv: built.args });
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
			return { ok: true, args: ['-sT', '-Pn', '-n', '--top-ports', String(clampTop(extra?.topPorts, 100)), ...xml, target] };
		case 'detect-services':
			return { ok: true, args: ['-sT', '-sV', '-Pn', '-n', '--top-ports', String(clampTop(extra?.topPorts, 100)), ...xml, target] };
		case 'scan-top-ports':
			return { ok: true, args: ['-sT', '-Pn', '-n', '--top-ports', String(clampTop(extra?.topPorts, 1000)), ...xml, target] };
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

function fail(stderr: string) {
	return { ok: false, stdout: '', stderr, exitCode: 1 };
}

function wrap(result: { exitCode: number; stdout: string; stderr: string; timedOut: boolean }, extra: Record<string, unknown>) {
	return {
		ok: result.exitCode === 0 && !result.timedOut,
		stdout: result.stdout.slice(0, 20_000),
		stderr: result.stderr.slice(0, 4_000),
		exitCode: result.exitCode,
		timedOut: result.timedOut,
		...extra,
	};
}
