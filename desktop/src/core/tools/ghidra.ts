import * as fs from 'node:fs';
import * as path from 'node:path';
import { podmanRun } from '../sandbox/podman';
import { containerPathUnderWorkspace, workspaceHostPath } from '../sandbox/workspace';
import { imageFor, isToolEnabled, type HawaldarSettings } from '../settings';
import { assertLocalFile, fileHash } from './files';

interface GhidraXref {
	name: string;
	entry: string;
	refs: Array<{ from: string; type: string }>;
}

interface GhidraDump {
	program?: string;
	language?: string;
	image_base?: string;
	functions?: Array<{ name: string; entry: string }>;
	imports?: Array<{ name: string }>;
	exports?: Array<{ name: string }>;
	strings?: Array<{ value: string }>;
	decompiled?: Array<{ name: string; c: string }>;
	entries?: Array<{ name: string; address: string }>;
	xrefs?: GhidraXref[];
}

export async function runGhidraTool(settings: HawaldarSettings, id: string, filePath: string, functionName?: string) {
	if (!isToolEnabled(settings, id)) {
		return { ok: false, stdout: '', stderr: `${id} is disabled.`, exitCode: 1 };
	}
	const resolved = assertLocalFile(filePath);
	const dump = await loadDump(settings, resolved);
	if (!dump.ok) {
		return dump;
	}
	const data = dump.data;
	if (id === 'list_methods') {
		return ok(JSON.stringify(data.functions ?? [], null, 2), resolved);
	}
	if (id === 'list_imports') {
		return ok(JSON.stringify(data.imports ?? [], null, 2), resolved);
	}
	if (id === 'list_exports') {
		return ok(JSON.stringify(data.exports ?? [], null, 2), resolved);
	}
	if (id === 'list_strings') {
		return ok(JSON.stringify(data.strings ?? [], null, 2), resolved);
	}
	if (id === 'decompile_function') {
		const match = (data.decompiled ?? []).find((item) => !functionName || item.name === functionName);
		if (!match) {
			return { ok: false, stdout: '', stderr: functionName ? `No decompile for ${functionName}.` : 'No decompiled functions.', exitCode: 1 };
		}
		return ok(match.c, resolved);
	}
	if (id === 'list_xrefs') {
		const rows = filterXrefs(data.xrefs ?? [], functionName);
		if (functionName && rows.length === 0) {
			return { ok: false, stdout: '', stderr: `No xrefs for ${functionName}.`, exitCode: 1 };
		}
		return ok(JSON.stringify(rows, null, 2), resolved);
	}
	if (id === 'ghidra-entry') {
		return ok(JSON.stringify({
			image_base: data.image_base,
			entries: data.entries ?? [],
		}, null, 2), resolved);
	}
	return { ok: false, stdout: '', stderr: `Unknown ghidra tool: ${id}`, exitCode: 1 };
}

function filterXrefs(rows: GhidraXref[], query?: string): GhidraXref[] {
	const q = query?.trim();
	if (!q) {
		return rows;
	}
	return rows.filter((row) => row.name === q || sameAddress(row.entry, q));
}

function sameAddress(left: string, right: string): boolean {
	const norm = (value: string) => value.replace(/^0x/i, '').replace(/^[^:]+:/, '').toLowerCase();
	return norm(left) === norm(right);
}

function dumpIsCurrent(data: GhidraDump): boolean {
	return Array.isArray(data.xrefs) && Array.isArray(data.entries);
}

async function loadDump(settings: HawaldarSettings, resolved: string): Promise<{ ok: true; data: GhidraDump } | { ok: false; stdout: string; stderr: string; exitCode: number }> {
	const inWorkspace = containerPathUnderWorkspace(resolved);
	const cacheDir = inWorkspace ? path.join(workspaceHostPath(), '.ghidra') : settings.cacheDir;
	fs.mkdirSync(cacheDir, { recursive: true });
	const cache = path.join(cacheDir, `${fileHash(resolved)}.ghidra.json`);
	if (fs.existsSync(cache)) {
		try {
			const data = JSON.parse(fs.readFileSync(cache, 'utf8')) as GhidraDump;
			if (dumpIsCurrent(data)) {
				return { ok: true, data };
			}
		} catch {
			// Rebuild a stale or corrupt cache.
		}
	}
	const script = path.join(settings.extensionPath, 'scripts', 'ghidra_dump.py');
	if (!fs.existsSync(script)) {
		return { ok: false, stdout: '', stderr: 'Missing scripts/ghidra_dump.py', exitCode: 1 };
	}
	const result = await podmanRun({
		podmanPath: settings.podmanPath,
		image: imageFor(settings, 'ghidra'),
		entrypoint: 'analyzeHeadless',
		args: [
			'/tmp/hw-ghidra', 'Hawaldar',
			'-import', inWorkspace ?? '/in/sample.bin',
			'-scriptPath', '/scripts',
			'-postScript', 'ghidra_dump.py',
			'-deleteProject',
		],
		timeoutMs: 300_000,
		network: 'none',
		memoryMb: 2048,
		mounts: [
			{ source: resolved, target: '/in/sample.bin', readonly: true },
			{ source: path.dirname(script), target: '/scripts', readonly: true },
		],
	});
	const jsonLine = extractJson(result.stdout + '\n' + result.stderr);
	if (!jsonLine) {
		return { ok: false, stdout: result.stdout.slice(0, 4000), stderr: result.stderr.slice(0, 4000) || 'Ghidra produced no JSON dump.', exitCode: result.exitCode || 1 };
	}
	fs.writeFileSync(cache, jsonLine + '\n', 'utf8');
	return { ok: true, data: JSON.parse(jsonLine) as GhidraDump };
}

function extractJson(text: string): string | undefined {
	const start = text.indexOf('{"program"');
	if (start < 0) {
		return undefined;
	}
	const slice = text.slice(start);
	const end = slice.lastIndexOf('}');
	return end >= 0 ? slice.slice(0, end + 1) : undefined;
}

function ok(stdout: string, filePath: string) {
	return { ok: true, stdout: stdout.slice(0, 20_000), stderr: '', exitCode: 0, filePath };
}
