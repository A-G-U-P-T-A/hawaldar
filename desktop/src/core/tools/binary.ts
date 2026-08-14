import * as fs from 'node:fs';
import * as path from 'node:path';
import { podmanRun } from '../sandbox/podman';
import { containerPathUnderWorkspace, WORKSPACE_DISPLAY_PATH, workspaceHostPath } from '../sandbox/workspace';
import { imageFor, isToolEnabled, type HawaldarSettings } from '../settings';
import { assertLocalFile, fileHash } from './files';

const DISASM_LIMIT = 64;
const ADDR_RE = /^(0x)?[0-9a-fA-F]{1,16}$/;
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_.:]*$/;

const R2: Record<string, string[]> = {
	r2_info: ['-q', '-c', 'iI', '/in/sample.bin'],
	r2_functions: ['-q', '-c', 'aaa;afl', '/in/sample.bin'],
	r2_imports: ['-q', '-c', 'ii', '/in/sample.bin'],
	r2_strings: ['-q', '-c', 'iz', '/in/sample.bin'],
	r2_sections: ['-q', '-c', 'iS', '/in/sample.bin'],
	r2_libs: ['-q', '-c', 'il', '/in/sample.bin'],
};

const BINWALK: Record<string, string[]> = {
	binwalk_scan: ['/in/sample.bin'],
	binwalk_entropy: ['-E', '/in/sample.bin'],
	binwalk_signature: ['-B', '/in/sample.bin'],
};

export interface BinaryToolInput {
	functionName?: string;
	address?: string;
}

export async function runRadareTool(settings: HawaldarSettings, id: string, filePath: string, extra?: BinaryToolInput) {
	if (!isToolEnabled(settings, id)) {
		return fail(`${id} is disabled.`);
	}
	if (id === 'r2_disasm') {
		const built = r2DisasmArgs(extra?.functionName, extra?.address);
		if ('error' in built) {
			return fail(built.error);
		}
		return runFile(settings, 'radare', 'r2', built.args, filePath, 180_000);
	}
	const args = R2[id];
	if (!args) {
		return fail(`Unknown r2 tool: ${id}`);
	}
	return runFile(settings, 'radare', 'r2', args, filePath, 180_000);
}

export async function runBinwalkTool(settings: HawaldarSettings, id: string, filePath: string) {
	if (!isToolEnabled(settings, id)) {
		return fail(`${id} is disabled.`);
	}
	if (id === 'binwalk_extract') {
		return runBinwalkExtract(settings, filePath);
	}
	const args = BINWALK[id];
	if (!args) {
		return fail(`Unknown binwalk tool: ${id}`);
	}
	return runFile(settings, 'binwalk', 'binwalk', args, filePath, 180_000);
}

function r2DisasmArgs(functionName?: string, address?: string): { args: string[] } | { error: string } {
	const raw = (address || functionName || '').trim();
	if (!raw) {
		return { error: 'functionName or address is required for r2_disasm.' };
	}
	if (ADDR_RE.test(raw)) {
		const addr = raw.toLowerCase().startsWith('0x') ? raw : `0x${raw}`;
		return { args: ['-q', '-c', `pd ${DISASM_LIMIT} @ ${addr}`, '/in/sample.bin'] };
	}
	if (NAME_RE.test(raw)) {
		return { args: ['-q', '-c', 'aaa', '-c', `pd ${DISASM_LIMIT} @ ${raw}`, '/in/sample.bin'] };
	}
	return { error: 'Invalid functionName or address for r2_disasm.' };
}

async function runBinwalkExtract(settings: HawaldarSettings, filePath: string) {
	const resolved = assertLocalFile(filePath);
	const digest = fileHash(resolved).slice(0, 12);
	const base = path.basename(resolved).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) || 'sample.bin';
	const relDir = `binaries/binwalk-${digest}`;
	const hostDir = path.join(workspaceHostPath(), 'binaries', `binwalk-${digest}`);
	fs.mkdirSync(hostDir, { recursive: true });
	const hostSample = path.join(hostDir, base);
	if (path.resolve(resolved) !== path.resolve(hostSample)) {
		fs.copyFileSync(resolved, hostSample);
	}
	const containerSample = `/workspace/${relDir}/${base}`;
	const result = await podmanRun({
		podmanPath: settings.podmanPath,
		image: imageFor(settings, 'binwalk'),
		command: 'binwalk',
		args: ['-e', containerSample],
		timeoutMs: 180_000,
		network: 'none',
		mounts: [{ source: resolved, target: '/in/sample.bin', readonly: true }],
	});
	const files = listExtracted(hostDir, 80, 4);
	const header = [
		`Extracted under ${WORKSPACE_DISPLAY_PATH}/${relDir}`,
		files.length ? files.join('\n') : '(no carved files)',
		'',
	].join('\n');
	return {
		ok: result.exitCode === 0 && !result.timedOut,
		stdout: (header + result.stdout).slice(0, 20_000),
		stderr: result.stderr.slice(0, 4_000),
		exitCode: result.exitCode,
		timedOut: result.timedOut,
		filePath: resolved,
	};
}

function listExtracted(root: string, maxFiles: number, maxDepth: number): string[] {
	const out: string[] = [];
	const walk = (dir: string, depth: number) => {
		if (out.length >= maxFiles || depth > maxDepth) {
			return;
		}
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const ent of entries) {
			if (out.length >= maxFiles) {
				return;
			}
			if (ent.isSymbolicLink()) {
				continue;
			}
			const full = path.join(dir, ent.name);
			if (ent.isDirectory()) {
				walk(full, depth + 1);
				continue;
			}
			if (ent.isFile()) {
				out.push(path.relative(root, full).split(path.sep).join('/'));
			}
		}
	};
	walk(root, 0);
	return out;
}

async function runFile(settings: HawaldarSettings, agent: string, command: string, args: string[], filePath: string, timeoutMs: number) {
	const resolved = assertLocalFile(filePath);
	const inWorkspace = containerPathUnderWorkspace(resolved);
	const result = await podmanRun({
		podmanPath: settings.podmanPath,
		image: imageFor(settings, agent),
		command,
		args: args.map((part) => (part === '/in/sample.bin' && inWorkspace ? inWorkspace : part)),
		timeoutMs,
		network: 'none',
		mounts: [{ source: resolved, target: '/in/sample.bin', readonly: true }],
	});
	return {
		ok: result.exitCode === 0 && !result.timedOut,
		stdout: result.stdout.slice(0, 20_000),
		stderr: result.stderr.slice(0, 4_000),
		exitCode: result.exitCode,
		timedOut: result.timedOut,
		filePath: resolved,
	};
}

function fail(stderr: string) {
	return { ok: false, stdout: '', stderr, exitCode: 1 };
}
