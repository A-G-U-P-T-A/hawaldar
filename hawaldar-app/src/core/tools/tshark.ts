import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { z } from 'zod';
import { podmanRun } from '../sandbox/podman';
import {
	WORKSPACE_CONTAINER_PATH,
	WORKSPACE_DISPLAY_PATH,
	containerPathUnderWorkspace,
	ensureWorkspace,
	workspaceHostPath,
} from '../sandbox/workspace';
import { imageFor, isToolEnabled, type HawaldarSettings } from '../settings';
import { TOOL_CATALOG } from './catalog';
import { assertLocalFile } from './files';

const FALLBACK_PCAP = '/pcap/capture.pcap';
const PCAP_RE = /\.(pcap|pcapng)$/i;
const STDOUT_CAP = 20_000;
const STDERR_CAP = 4_000;
const LIST_CAP = 200;
const WALK_DEPTH = 3;
const SKIP_DIRS = new Set(['.ghidra', '.git', 'node_modules', 'http-objects']);
const COMMON_CAPTURE_NAMES = [
	'capture.pcap',
	'capture.pcapng',
	'youtube.pcap',
	'youtube.pcapng',
	'traffic.pcap',
	'traffic.pcapng',
	'dump.pcap',
	'dump.pcapng',
	'packets.pcap',
	'packets.pcapng',
	'wireshark.pcap',
	'wireshark.pcapng',
];

const NO_PCAP_MESSAGE = [
	`No .pcap / .pcapng in ${WORKSPACE_DISPLAY_PATH}.`,
	`Drop a capture in that folder, give a host path, or keep tshark running (contained CLI — no desktop Wireshark window).`,
	'Live capture and host dumpcap are not available.',
].join(' ');

const tsharkInputSchema = z.object({
	pcapPath: z.string().optional(),
	streamIndex: z.coerce.number().int().min(0).max(10_000).optional(),
	streamProto: z.enum(['tcp', 'udp']).optional(),
	limit: z.coerce.number().int().min(1).max(2_000).optional(),
});

export type TsharkInput = z.infer<typeof tsharkInputSchema>;

export const TSHARK_LIST_TOOL_ID = 'tshark-list-pcaps';

export function isTsharkListTool(id: string): boolean {
	return id === TSHARK_LIST_TOOL_ID;
}

/** Mastra inputSchema for tshark tools. Uses the runtime `z` instance. */
export function buildTsharkInputSchema(z: any, id: string) {
	if (id === TSHARK_LIST_TOOL_ID) {
		return z.object({});
	}
	const pcapPath = z.string().optional()
		.describe('Optional .pcap / .pcapng. Bare workspace names work (capture.pcap). Omit to use ~/.hawaldar/workspace captures (common names, then newest). Do not ask the operator for a path first.');
	const limit = z.number().int().min(1).max(2_000).optional()
		.describe('Packet read cap for analyze_pcap (default 200)');
	if (id === 'pcap-follow-stream') {
		return z.object({
			pcapPath,
			streamIndex: z.number().int().min(0).max(10_000).optional()
				.describe('TCP or UDP stream index (default 0)'),
			streamProto: z.enum(['tcp', 'udp']).optional()
				.describe('Stream protocol (default tcp)'),
		});
	}
	if (id === 'analyze_pcap') {
		return z.object({ pcapPath, limit });
	}
	return z.object({ pcapPath });
}

function timeoutMs(id: string): number {
	return TOOL_CATALOG.find((tool) => tool.id === id)?.timeoutMs ?? 120_000;
}

function fail(stderr: string) {
	return { ok: false, stdout: '', stderr, exitCode: 1 };
}

interface PcapHit {
	hostPath: string;
	rel: string;
	size: number;
	mtimeMs: number;
}

function displayPcap(rel: string): string {
	return `${WORKSPACE_DISPLAY_PATH}/${rel}`;
}

function listWorkspacePcaps(): PcapHit[] {
	ensureWorkspace();
	const root = workspaceHostPath();
	const out: PcapHit[] = [];
	const walk = (dir: string, depth: number) => {
		if (depth > WALK_DEPTH || out.length >= LIST_CAP) {
			return;
		}
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry.name.startsWith('.')) {
				continue;
			}
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (SKIP_DIRS.has(entry.name.toLowerCase())) {
					continue;
				}
				walk(full, depth + 1);
				continue;
			}
			if (!entry.isFile() || !PCAP_RE.test(entry.name)) {
				continue;
			}
			try {
				const st = fs.statSync(full);
				const rel = path.relative(root, full).split(path.sep).join('/');
				out.push({ hostPath: full, rel, size: st.size, mtimeMs: st.mtimeMs });
			} catch {
				// skip unreadable
			}
		}
	};
	walk(root, 0);
	return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function pickPreferredPcap(hits: PcapHit[]): PcapHit | undefined {
	if (hits.length === 0) {
		return undefined;
	}
	const byRel = new Map(hits.map((hit) => [hit.rel.toLowerCase(), hit]));
	const byBase = new Map(hits.map((hit) => [path.posix.basename(hit.rel).toLowerCase(), hit]));
	for (const name of COMMON_CAPTURE_NAMES) {
		const hit = byRel.get(name) || byBase.get(name);
		if (hit) {
			return hit;
		}
	}
	return hits[0];
}

function normalizeHint(hint: string): string {
	return hint.trim().replace(/\\/g, '/');
}

function hostPathFromHint(hint: string): string {
	const posix = normalizeHint(hint);
	if (posix === WORKSPACE_CONTAINER_PATH || posix.startsWith(`${WORKSPACE_CONTAINER_PATH}/`)) {
		const rel = posix.slice(WORKSPACE_CONTAINER_PATH.length).replace(/^\/+/, '');
		return rel ? path.join(workspaceHostPath(), ...rel.split('/')) : workspaceHostPath();
	}
	if (posix === WORKSPACE_DISPLAY_PATH || posix.startsWith(`${WORKSPACE_DISPLAY_PATH}/`)) {
		const rel = posix.slice(WORKSPACE_DISPLAY_PATH.length).replace(/^\/+/, '');
		return rel ? path.join(workspaceHostPath(), ...rel.split('/')) : workspaceHostPath();
	}
	if (posix.startsWith('~/')) {
		return path.join(os.homedir(), ...posix.slice(2).split('/'));
	}
	if (/^[a-zA-Z]:\//.test(posix) || hint.trim().startsWith('\\\\')) {
		return path.resolve(hint.trim());
	}
	if (posix.startsWith('/') && process.platform !== 'win32') {
		return path.resolve(posix);
	}
	return path.join(workspaceHostPath(), ...posix.replace(/^\/+/, '').split('/').filter(Boolean));
}

function stripKnownPrefix(posix: string, prefix: string): string {
	if (posix === prefix) {
		return '';
	}
	const withSlash = prefix.endsWith('/') ? prefix : `${prefix}/`;
	return posix.startsWith(withSlash) ? posix.slice(withSlash.length) : posix;
}

function findHitByHint(hits: PcapHit[], hint: string): PcapHit | undefined {
	const posix = stripKnownPrefix(
		stripKnownPrefix(normalizeHint(hint), WORKSPACE_CONTAINER_PATH),
		WORKSPACE_DISPLAY_PATH,
	);
	const lower = posix.toLowerCase();
	const base = path.posix.basename(lower);
	const exactRel = hits.find((hit) => hit.rel.toLowerCase() === lower);
	if (exactRel) {
		return exactRel;
	}
	const byBase = hits.filter((hit) => path.posix.basename(hit.rel).toLowerCase() === base);
	if (byBase.length === 0) {
		return undefined;
	}
	return byBase.sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
}

function formatListing(hits: PcapHit[]): string {
	const header = `Workspace ${WORKSPACE_DISPLAY_PATH}`;
	if (hits.length === 0) {
		return `${header}\n${NO_PCAP_MESSAGE}`;
	}
	const lines = hits.slice(0, LIST_CAP).map((hit) => {
		const when = new Date(hit.mtimeMs).toISOString();
		return `${hit.rel}\t${hit.size}\t${when}`;
	});
	if (hits.length > LIST_CAP) {
		lines.push(`… ${hits.length - LIST_CAP} more files omitted`);
	}
	lines.push('Bare names work as pcapPath (no /workspace/ prefix needed).');
	return `${header}\n${lines.join('\n')}`;
}

function usingNote(chosen: PcapHit, hits: PcapHit[]): string {
	const others = hits.filter((hit) => hit.hostPath !== chosen.hostPath).map((hit) => hit.rel);
	const lines = [`Using ${displayPcap(chosen.rel)}`];
	if (others.length > 0) {
		lines.push(`Other workspace captures: ${others.join(', ')}`);
	}
	return lines.join('\n');
}

function resolvePcap(pcapPath?: string): {
	resolved: string;
	containerPath: string;
	mounts: Array<{ source: string; target: string; readonly: boolean }>;
	note: string;
} {
	ensureWorkspace();
	const hits = listWorkspacePcaps();
	const hint = pcapPath?.trim() ?? '';

	if (hint) {
		const mapped = hostPathFromHint(hint);
		if (fs.existsSync(mapped) && fs.statSync(mapped).isFile()) {
			const resolved = assertLocalFile(mapped, PCAP_RE);
			const inWorkspace = containerPathUnderWorkspace(resolved);
			const hit = hits.find((item) => item.hostPath === resolved);
			return {
				resolved,
				containerPath: inWorkspace ?? FALLBACK_PCAP,
				mounts: inWorkspace ? [] : [{ source: resolved, target: FALLBACK_PCAP, readonly: true }],
				note: hit ? usingNote(hit, hits) : `Using ${resolved}`,
			};
		}
		const match = findHitByHint(hits, hint);
		if (match) {
			const resolved = assertLocalFile(match.hostPath, PCAP_RE);
			return {
				resolved,
				containerPath: containerPathUnderWorkspace(resolved) ?? `${WORKSPACE_CONTAINER_PATH}/${match.rel}`,
				mounts: [],
				note: usingNote(match, hits),
			};
		}
		throw new Error(`File not found: ${hint}\n${formatListing(hits)}`);
	}

	const chosen = pickPreferredPcap(hits);
	if (!chosen) {
		throw new Error(NO_PCAP_MESSAGE);
	}
	const resolved = assertLocalFile(chosen.hostPath, PCAP_RE);
	return {
		resolved,
		containerPath: containerPathUnderWorkspace(resolved) ?? `${WORKSPACE_CONTAINER_PATH}/${chosen.rel}`,
		mounts: [],
		note: usingNote(chosen, hits),
	};
}

function fieldArgs(containerPath: string, filter: string, fields: string[]): string[] {
	return [
		'-r', containerPath,
		'-Y', filter,
		'-T', 'fields',
		'-E', 'header=y',
		'-E', 'separator=/t',
		'-E', 'occurrence=a',
		'-E', 'aggregator=,',
		...fields.flatMap((field) => ['-e', field]),
	];
}

function argsFor(id: string, containerPath: string, input: TsharkInput): string[] | { error: string } {
	const packetCap = String(input.limit ?? 200);
	switch (id) {
		case 'analyze_pcap':
			return [
				'-r', containerPath, '-c', packetCap, '-T', 'json',
				'-e', 'frame.number', '-e', 'ip.src', '-e', 'ip.dst',
				'-e', 'tcp.srcport', '-e', 'tcp.dstport', '-e', 'frame.protocols',
			];
		case 'get_summary_stats':
		case 'pcap-protocols':
			return ['-r', containerPath, '-q', '-z', 'io,phs'];
		case 'get_conversations':
			return ['-r', containerPath, '-q', '-z', 'conv,tcp'];
		case 'pcap-endpoints':
			return ['-r', containerPath, '-q', '-z', 'endpoints,ip', '-z', 'endpoints,ipv6'];
		case 'pcap-dns':
			return fieldArgs(containerPath, 'dns', [
				'frame.number', 'ip.src', 'ip.dst',
				'dns.flags.response', 'dns.qry.name', 'dns.qry.type',
				'dns.a', 'dns.aaaa', 'dns.cname',
			]);
		case 'pcap-http':
			return fieldArgs(containerPath, 'http.request', [
				'frame.number', 'ip.src', 'ip.dst',
				'http.host', 'http.request.method', 'http.request.uri', 'http.request.full_uri',
			]);
		case 'pcap-follow-stream': {
			const proto = input.streamProto ?? 'tcp';
			const index = input.streamIndex ?? 0;
			return ['-r', containerPath, '-q', '-z', `follow,${proto},ascii,${index}`];
		}
		default:
			return { error: `Unknown tshark tool: ${id}` };
	}
}

function safeExportName(filePath: string): string {
	const base = path.basename(filePath, path.extname(filePath));
	const cleaned = base.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
	return cleaned || 'pcap';
}

function listExported(hostDir: string): string {
	if (!fs.existsSync(hostDir)) {
		return '(no HTTP objects exported)';
	}
	const names = fs.readdirSync(hostDir).filter((name) => {
		try {
			return fs.statSync(path.join(hostDir, name)).isFile();
		} catch {
			return false;
		}
	});
	if (names.length === 0) {
		return '(no HTTP objects exported)';
	}
	const lines = names.slice(0, LIST_CAP).map((name) => {
		const size = fs.statSync(path.join(hostDir, name)).size;
		return `${name}\t${size}`;
	});
	if (names.length > LIST_CAP) {
		lines.push(`… ${names.length - LIST_CAP} more files omitted`);
	}
	return lines.join('\n');
}

async function exportHttpObjects(
	settings: HawaldarSettings,
	resolved: string,
	containerPath: string,
	mounts: Array<{ source: string; target: string; readonly: boolean }>,
	note: string,
) {
	ensureWorkspace();
	const dirName = `${safeExportName(resolved)}-${Date.now().toString(36)}`;
	const hostDir = path.join(workspaceHostPath(), 'scans', 'http-objects', dirName);
	fs.mkdirSync(hostDir, { recursive: true });
	const containerDir = `${WORKSPACE_CONTAINER_PATH}/scans/http-objects/${dirName}`;
	const result = await podmanRun({
		podmanPath: settings.podmanPath,
		image: imageFor(settings, 'tshark'),
		command: 'tshark',
		args: ['-r', containerPath, '--export-objects', `http,${containerDir}`],
		timeoutMs: timeoutMs('pcap-export-objects'),
		network: 'none',
		mounts,
	});
	const listing = listExported(hostDir);
	const header = `${note}\nHTTP objects → ${WORKSPACE_DISPLAY_PATH}/scans/http-objects/${dirName}`;
	return {
		ok: result.exitCode === 0 && !result.timedOut,
		stdout: `${header}\n${listing}`.slice(0, STDOUT_CAP),
		stderr: result.stderr.slice(0, STDERR_CAP),
		exitCode: result.exitCode,
		timedOut: result.timedOut,
		tool: 'pcap-export-objects',
		pcapPath: resolved,
		exportDir: hostDir,
	};
}

function listPcapsResult() {
	const hits = listWorkspacePcaps();
	return {
		ok: true,
		stdout: formatListing(hits).slice(0, STDOUT_CAP),
		stderr: '',
		exitCode: 0,
		tool: TSHARK_LIST_TOOL_ID,
	};
}

export async function runTsharkTool(settings: HawaldarSettings, id: string, raw: unknown) {
	if (!isToolEnabled(settings, id)) {
		return fail(`${id} is disabled.`);
	}
	if (id === TSHARK_LIST_TOOL_ID) {
		return listPcapsResult();
	}
	const parsed = tsharkInputSchema.safeParse(raw);
	if (!parsed.success) {
		return fail(parsed.error.issues.map((issue) => issue.message).join('; '));
	}
	let resolved: string;
	let containerPath: string;
	let mounts: Array<{ source: string; target: string; readonly: boolean }>;
	let note: string;
	try {
		({ resolved, containerPath, mounts, note } = resolvePcap(parsed.data.pcapPath));
	} catch (error) {
		return fail(error instanceof Error ? error.message : String(error));
	}
	if (id === 'pcap-export-objects') {
		return exportHttpObjects(settings, resolved, containerPath, mounts, note);
	}
	const args = argsFor(id, containerPath, parsed.data);
	if ('error' in args) {
		return fail(args.error);
	}
	const result = await podmanRun({
		podmanPath: settings.podmanPath,
		image: imageFor(settings, 'tshark'),
		command: 'tshark',
		args,
		timeoutMs: timeoutMs(id),
		network: 'none',
		mounts,
	});
	const stdout = `${note}\n\n${result.stdout}`.slice(0, STDOUT_CAP);
	return {
		ok: result.exitCode === 0 && !result.timedOut,
		stdout,
		stderr: result.stderr.slice(0, STDERR_CAP),
		exitCode: result.exitCode,
		timedOut: result.timedOut,
		tool: id,
		pcapPath: resolved,
	};
}
