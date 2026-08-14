import * as fs from 'node:fs';
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

const tsharkInputSchema = z.object({
	pcapPath: z.string().min(1, 'pcapPath is required.'),
	streamIndex: z.coerce.number().int().min(0).max(10_000).optional(),
	streamProto: z.enum(['tcp', 'udp']).optional(),
	limit: z.coerce.number().int().min(1).max(2_000).optional(),
});

export type TsharkInput = z.infer<typeof tsharkInputSchema>;

/** Mastra inputSchema for tshark tools. Uses the runtime `z` instance. */
export function buildTsharkInputSchema(z: any, id: string) {
	const pcapPath = z.string().describe('Workspace or mounted .pcap / .pcapng path');
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

function resolvePcap(pcapPath: string) {
	const resolved = assertLocalFile(pcapPath, PCAP_RE);
	const inWorkspace = containerPathUnderWorkspace(resolved);
	return {
		resolved,
		containerPath: inWorkspace ?? FALLBACK_PCAP,
		mounts: inWorkspace ? [] : [{ source: resolved, target: FALLBACK_PCAP, readonly: true }],
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
	const header = `HTTP objects → ${WORKSPACE_DISPLAY_PATH}/scans/http-objects/${dirName}`;
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

export async function runTsharkTool(settings: HawaldarSettings, id: string, raw: unknown) {
	if (!isToolEnabled(settings, id)) {
		return fail(`${id} is disabled.`);
	}
	const parsed = tsharkInputSchema.safeParse(raw);
	if (!parsed.success) {
		return fail(parsed.error.issues.map((issue) => issue.message).join('; '));
	}
	let resolved: string;
	let containerPath: string;
	let mounts: Array<{ source: string; target: string; readonly: boolean }>;
	try {
		({ resolved, containerPath, mounts } = resolvePcap(parsed.data.pcapPath));
	} catch (error) {
		return fail(error instanceof Error ? error.message : String(error));
	}
	if (id === 'pcap-export-objects') {
		return exportHttpObjects(settings, resolved, containerPath, mounts);
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
	return {
		ok: result.exitCode === 0 && !result.timedOut,
		stdout: result.stdout.slice(0, STDOUT_CAP),
		stderr: result.stderr.slice(0, STDERR_CAP),
		exitCode: result.exitCode,
		timedOut: result.timedOut,
		tool: id,
		pcapPath: resolved,
	};
}
