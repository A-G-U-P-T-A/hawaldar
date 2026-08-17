import * as fs from 'node:fs';
import * as path from 'node:path';
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

const STDOUT_CAP = 20_000;
const STDERR_CAP = 4_000;
const LIST_CAP = 200;
const WALK_DEPTH = 6;
const SKIP_DIRS = new Set([
	'.git',
	'node_modules',
	'dist',
	'build',
	'out',
	'.scrapling',
	'.ghidra',
	'__pycache__',
	'.venv',
	'venv',
	'http-objects',
	'scans',
	'binaries',
]);
const SOURCE_EXT = new Set([
	'.py', '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs',
	'.go', '.java', '.rb', '.php', '.cs', '.rs', '.kt',
	'.swift', '.scala', '.c', '.cc', '.cpp', '.h', '.hpp',
	'.vue', '.svelte', '.yaml', '.yml', '.json',
]);
const EXCLUDE_ARGS = [
	'--exclude=node_modules',
	'--exclude=.git',
	'--exclude=.env',
	'--exclude=.env.*',
	'--exclude=dist',
	'--exclude=build',
	'--exclude=__pycache__',
	'--exclude=.scrapling',
	'--exclude=.venv',
	'--exclude=venv',
	'--exclude=*.pem',
	'--exclude=*.p12',
];

export function isSemgrepListTool(id: string): boolean {
	return id === 'semgrep-list';
}

export function buildSemgrepInputSchema(z: any, id: string) {
	if (id === 'semgrep-list') {
		return z.object({});
	}
	const filePath = z.string().optional()
		.describe('Relative path under ~/.hawaldar/workspace. Omit to scan the whole workspace. Host paths outside the workspace are refused.');
	if (id === 'semgrep-path') {
		return z.object({
			filePath: z.string().describe('Relative path under ~/.hawaldar/workspace to scan (file or directory).'),
		});
	}
	return z.object({ filePath });
}

export async function runSemgrepTool(
	settings: HawaldarSettings,
	id: string,
	input: { filePath?: string },
) {
	if (!isToolEnabled(settings, id)) {
		return fail(`${id} is disabled.`);
	}
	ensureWorkspace();
	if (isSemgrepListTool(id)) {
		return listWorkspaceSources();
	}

	const scoped = resolveWorkspaceScanPath(input.filePath, id === 'semgrep-path');
	if (!scoped.ok) {
		return fail(scoped.reason);
	}
	if (!workspaceHasSource(scoped.hostPath)) {
		return {
			ok: true,
			stdout: [
				`No scannable source under ${scoped.display}.`,
				`Drop an application tree in ${WORKSPACE_DISPLAY_PATH} and re-run pre-recon / semgrep-scan.`,
			].join('\n'),
			stderr: '',
			exitCode: 0,
		};
	}

	const config = id === 'semgrep-owasp' ? '/rules/owasp.yml' : id === 'semgrep-path' ? '/rules' : '/rules/security.yml';
	const result = await podmanRun({
		podmanPath: settings.podmanPath,
		image: imageFor(settings, 'semgrep'),
		args: [
			'scan',
			'--config',
			config,
			'--metrics=off',
			'--disable-version-check',
			'--quiet',
			'--json',
			...EXCLUDE_ARGS,
			scoped.containerPath,
		],
		timeoutMs: TOOL_CATALOG.find((tool) => tool.id === id)?.timeoutMs ?? 300_000,
		network: 'none',
		memoryMb: 1536,
		pidsLimit: 256,
		workdir: WORKSPACE_CONTAINER_PATH,
	});
	const stdout = formatSemgrepJson(result.stdout).slice(0, STDOUT_CAP);
	const stderr = result.stderr.slice(0, STDERR_CAP);
	const ok = !result.timedOut && (result.exitCode === 0 || result.exitCode === 1);
	return {
		ok,
		stdout: stdout || (ok ? 'Semgrep finished with no JSON findings.' : ''),
		stderr: result.timedOut ? `${stderr}\nSemgrep timed out.` : stderr,
		exitCode: result.exitCode,
		timedOut: result.timedOut,
	};
}

function resolveWorkspaceScanPath(filePath: string | undefined, required: boolean):
	{ ok: true; hostPath: string; containerPath: string; display: string }
	| { ok: false; reason: string } {
	const root = path.resolve(workspaceHostPath());
	const raw = (filePath || '').trim();
	if (!raw) {
		if (required) {
			return { ok: false, reason: `filePath is required (relative path under ${WORKSPACE_DISPLAY_PATH}).` };
		}
		return {
			ok: true,
			hostPath: root,
			containerPath: WORKSPACE_CONTAINER_PATH,
			display: WORKSPACE_DISPLAY_PATH,
		};
	}
	if (raw.includes('..') || /[\s;|&$`<>]/.test(raw)) {
		return { ok: false, reason: 'Path failed safety checks.' };
	}
	const abs = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(root, raw);
	const container = containerPathUnderWorkspace(abs);
	if (!container) {
		return { ok: false, reason: `SAST is limited to ${WORKSPACE_DISPLAY_PATH}.` };
	}
	if (!fs.existsSync(abs)) {
		return { ok: false, reason: `Not found in workspace: ${raw}` };
	}
	return {
		ok: true,
		hostPath: abs,
		containerPath: container,
		display: `${WORKSPACE_DISPLAY_PATH}/${path.relative(root, abs).split(path.sep).join('/')}`,
	};
}

function listWorkspaceSources() {
	const root = workspaceHostPath();
	const files: string[] = [];
	walkSources(root, root, 0, files);
	if (files.length === 0) {
		return {
			ok: true,
			stdout: `No scannable source in ${WORKSPACE_DISPLAY_PATH}. Drop a repository there for pre-recon / SAST.`,
			stderr: '',
			exitCode: 0,
		};
	}
	const shown = files.slice(0, LIST_CAP);
	const extra = files.length > LIST_CAP ? `\n… ${files.length - LIST_CAP} more` : '';
	return {
		ok: true,
		stdout: `${files.length} source file(s) in ${WORKSPACE_DISPLAY_PATH}:\n${shown.join('\n')}${extra}`,
		stderr: '',
		exitCode: 0,
	};
}

function workspaceHasSource(hostPath: string): boolean {
	try {
		const stat = fs.statSync(hostPath);
		if (stat.isFile()) {
			return SOURCE_EXT.has(path.extname(hostPath).toLowerCase());
		}
		const found: string[] = [];
		walkSources(hostPath, hostPath, 0, found);
		return found.length > 0;
	} catch {
		return false;
	}
}

function walkSources(root: string, dir: string, depth: number, out: string[]): void {
	if (depth > WALK_DEPTH || out.length >= LIST_CAP * 4) {
		return;
	}
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (entry.name.startsWith('.') && entry.name !== '.env') {
			if (SKIP_DIRS.has(entry.name)) {
				continue;
			}
		}
		if (SKIP_DIRS.has(entry.name) || entry.name === '.env') {
			continue;
		}
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			walkSources(root, full, depth + 1, out);
			continue;
		}
		if (entry.isFile() && SOURCE_EXT.has(path.extname(entry.name).toLowerCase())) {
			out.push(path.relative(root, full).split(path.sep).join('/'));
		}
	}
}

function formatSemgrepJson(raw: string): string {
	const trimmed = raw.trim();
	if (!trimmed) {
		return '';
	}
	try {
		const parsed = JSON.parse(trimmed) as {
			results?: Array<{
				check_id?: string;
				path?: string;
				start?: { line?: number };
				extra?: { message?: string; severity?: string; metadata?: { 'hawaldar-class'?: string } };
			}>;
			errors?: Array<{ message?: string }>;
		};
		const rows = parsed.results ?? [];
		if (rows.length === 0) {
			const errors = (parsed.errors ?? []).map((item) => item.message).filter(Boolean);
			return errors.length > 0
				? `Semgrep reported no findings.\n${errors.join('\n')}`
				: 'Semgrep reported no findings.';
		}
		const lines = rows.slice(0, 80).map((item) => {
			const cls = item.extra?.metadata?.['hawaldar-class'] || 'sast';
			const sev = item.extra?.severity || 'INFO';
			const loc = `${item.path || '?'}:${item.start?.line ?? '?'}`;
			const msg = (item.extra?.message || '').replace(/\s+/g, ' ').slice(0, 200);
			return `- [${sev}] ${cls} \`${item.check_id}\` ${loc} — ${msg}`;
		});
		const extra = rows.length > 80 ? `\n… ${rows.length - 80} more findings` : '';
		return `Semgrep findings: ${rows.length}\n${lines.join('\n')}${extra}`;
	} catch {
		return trimmed;
	}
}

function fail(stderr: string) {
	return { ok: false, stdout: '', stderr, exitCode: 1 };
}
