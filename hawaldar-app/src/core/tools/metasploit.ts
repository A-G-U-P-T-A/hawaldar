import { evaluateScope } from '../policy';
import { podmanRun } from '../sandbox/podman';
import { imageFor, isToolEnabled, type HawaldarSettings } from '../settings';
import { BUILTIN_SOURCE, TOOL_CATALOG } from './catalog';

const MSF_BIN = '/usr/src/metasploit-framework/msfconsole';
const MSF_HOME = '/usr/src/metasploit-framework';
const MEMORY_MB = 2048;
const PIDS = 512;

const QUERY_RE = /^[a-zA-Z0-9][a-zA-Z0-9:_\-/\s]{0,119}$/;
const MODULE_RE = /^(auxiliary|exploit|payload|post|encoder|nop)\/[a-z0-9_]+(?:\/[a-z0-9_]+)+$/;
const SCANNER_PREFIX = 'auxiliary/scanner/';
const REFUSED_MODULE = /(?:^|\/)(?:login|smb_login|ssh_login|ftp_login|http_login|cred|hashdump|brute|spray|dump)(?:\/|_|$)/i;
const PAYLOAD_RE = /^[a-z0-9_]+(?:\/[a-z0-9_]+){1,3}$/;
/** Persistence payloads are refused; bind/reverse to the in-scope target stay allowed. */
const REFUSED_PAYLOAD = /persist|vnc|metsvc/i;

const PINNED: Record<string, { module: string; port: number }> = {
	'msf-http-version': { module: 'auxiliary/scanner/http/http_version', port: 80 },
	'msf-smb-version': { module: 'auxiliary/scanner/smb/smb_version', port: 445 },
	'msf-ssh-version': { module: 'auxiliary/scanner/ssh/ssh_version', port: 22 },
};

export interface MetasploitToolInput {
	target?: string;
	query?: string;
	module?: string;
	port?: number;
	payload?: string;
}

function timeoutMs(id: string): number {
	return TOOL_CATALOG.find((tool) => tool.id === id)?.timeoutMs ?? 180_000;
}

/** Mastra inputSchema for Metasploit tools. Uses the runtime `z` instance. */
export function buildMetasploitInputSchema(z: any, id: string) {
	const target = z.string().describe('In-scope host or IPv4 address');
	const port = z.number().int().min(1).max(65535).optional().describe('TCP RPORT');
	switch (id) {
		case 'msf-search':
			return z.object({
				query: z.string().describe('Module search, e.g. type:auxiliary http or cve:2021-41773'),
			});
		case 'msf-info':
			return z.object({
				module: z.string().describe('Full module path, e.g. auxiliary/scanner/http/http_version'),
			});
	case 'msf-aux-scan':
		return z.object({
			target,
			module: z.string().describe('auxiliary/scanner/… module path'),
			port,
		});
	case 'msf-check':
		return z.object({
			target,
			module: z.string().describe('exploit/* or auxiliary/* module path. check is read-only. Operator approval per run.'),
			port,
		});
	case 'msf-run':
		return z.object({
			target,
			module: z.string().describe('exploit/* or auxiliary/scanner/* module path. Operator approval per run; any session is backgrounded and auto-killed.'),
			port,
			payload: z.string().optional().describe('Optional payload path (bind/reverse only, e.g. generic/shell_bind_tcp). Persistence/VNC/metsvc payloads refused. Default: the module default payload.'),
		});
	case 'msf-http-version':
	case 'msf-smb-version':
	case 'msf-ssh-version':
		return z.object({ target, port });
	default:
		return z.object({
			target: target.optional(),
			query: z.string().optional(),
			module: z.string().optional(),
			port,
		});
	}
}

export function parseSearchQuery(raw: string | undefined): { ok: true; value: string } | { ok: false; reason: string } {
	const query = (raw ?? '').trim();
	if (!query) {
		return { ok: false, reason: 'query is required (e.g. type:auxiliary http).' };
	}
	if (!QUERY_RE.test(query) || /[;|&$`'"\\]/.test(query)) {
		return { ok: false, reason: 'query may only use letters, digits, spaces, and : _ - /.' };
	}
	return { ok: true, value: query };
}

export function parseModulePath(
	raw: string | undefined,
	mode: 'info' | 'run' | 'check' | 'execute',
): { ok: true; value: string } | { ok: false; reason: string } {
	const module = (raw ?? '').trim().toLowerCase();
	if (!module) {
		return { ok: false, reason: 'module is required (full path, e.g. auxiliary/scanner/http/http_version).' };
	}
	if (!MODULE_RE.test(module)) {
		return { ok: false, reason: 'module must be a full path like auxiliary/scanner/http/http_version.' };
	}
	if (REFUSED_MODULE.test(module)) {
		return { ok: false, reason: 'Login, credential, and dump modules are refused.' };
	}
	if (mode === 'run' && !module.startsWith(SCANNER_PREFIX)) {
		return { ok: false, reason: 'Only auxiliary/scanner modules may run unattended. exploit/* runs through msf-run (HITL-gated); payload/post are refused.' };
	}
	if (mode === 'check' && !module.startsWith('auxiliary/') && !module.startsWith('exploit/')) {
		return { ok: false, reason: 'Only exploit/* and auxiliary/* modules support check. payload/post/encoder/nop are refused.' };
	}
	if (mode === 'execute' && !module.startsWith('exploit/') && !module.startsWith(SCANNER_PREFIX)) {
		return { ok: false, reason: 'msf-run allows exploit/* and auxiliary/scanner/* only. post/* and payload builders (msfvenom) are refused.' };
	}
	return { ok: true, value: module };
}

export function parsePayload(raw: string | undefined): { ok: true; value?: string } | { ok: false; reason: string } {
	const payload = (raw ?? '').trim().toLowerCase();
	if (!payload) {
		return { ok: true, value: undefined };
	}
	if (!PAYLOAD_RE.test(payload)) {
		return { ok: false, reason: 'payload must be a module path like generic/shell_bind_tcp.' };
	}
	if (REFUSED_PAYLOAD.test(payload)) {
		return { ok: false, reason: 'Persistence, VNC, and metsvc payloads are refused. Bind/reverse payloads only.' };
	}
	return { ok: true, value: payload };
}

/** HITL summary for msf-check / msf-run (validated before the dialog shows). */
export function msfAskSummary(
	settings: HawaldarSettings,
	id: string,
	input: MetasploitToolInput,
): { ok: true; value: { title: string; explanation: string } } | { ok: false; reason: string } {
	const target = (input.target ?? '').trim();
	if (!target) {
		return { ok: false, reason: 'target is required.' };
	}
	const scope = evaluateScope(settings.scope, target);
	if (!scope.allow) {
		return { ok: false, reason: scope.reason };
	}
	const port = parsePort(input.port);
	if (!port.ok) {
		return { ok: false, reason: port.reason };
	}
	if (id === 'msf-check') {
		const module = parseModulePath(input.module, 'check');
		if (!module.ok) {
			return { ok: false, reason: module.reason };
		}
		return {
			ok: true,
			value: {
				title: `Approve Metasploit check on ${target}?`,
				explanation: [
					`msf-check runs \`check\` for ${module.value} against ${target}${port.value !== undefined ? `:${port.value}` : ''}.`,
					'check is read-only (no exploit, no payload, no session). exploit/* and auxiliary/* only; login/credential/dump modules stay refused.',
				].join('\n'),
			},
		};
	}
	if (id === 'msf-run') {
		const module = parseModulePath(input.module, 'execute');
		if (!module.ok) {
			return { ok: false, reason: module.reason };
		}
		const payload = parsePayload(input.payload);
		if (!payload.ok) {
			return { ok: false, reason: payload.reason };
		}
		return {
			ok: true,
			value: {
				title: `Approve Metasploit run: ${module.value} on ${target}?`,
				explanation: [
					`msf-run executes ${module.value} against ${target}${port.value !== undefined ? `:${port.value}` : ''} with payload ${payload.value ?? '(module default)'}.`,
					'Boundaries: exploit/* and auxiliary/scanner/* only; post/* and payload builders refused. The run uses run -z / exploit -z so any session is backgrounded, then sessions -K kills opened sessions before exit. Console output (capped) is the evidence.',
				].join('\n'),
			},
		};
	}
	return { ok: false, reason: `Unknown Metasploit tool: ${id}` };
}

export function parsePort(value: number | undefined, fallback?: number): { ok: true; value?: number } | { ok: false; reason: string } {
	if (value === undefined || value === null) {
		return { ok: true, value: fallback };
	}
	const port = Math.trunc(value);
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		return { ok: false, reason: 'port must be a TCP port 1–65535.' };
	}
	return { ok: true, value: port };
}

export async function runMetasploitTool(
	settings: HawaldarSettings,
	id: string,
	input: MetasploitToolInput,
) {
	if (!isToolEnabled(settings, id)) {
		return fail(`${id} is disabled.`);
	}

	if (id === 'msf-search') {
		const query = parseSearchQuery(input.query);
		if (!query.ok) {
			return fail(query.reason);
		}
		return runMsf(settings, id, 'none', [`search ${query.value}`, 'exit']);
	}

	if (id === 'msf-info') {
		const module = parseModulePath(input.module, 'info');
		if (!module.ok) {
			return fail(module.reason);
		}
		return runMsf(settings, id, 'none', [`info ${module.value}`, 'exit']);
	}

	const target = (input.target ?? '').trim();
	if (!target) {
		return fail('target is required.');
	}
	const scope = evaluateScope(settings.scope, target);
	if (!scope.allow) {
		return fail(scope.reason);
	}

	if (id === 'msf-check') {
		const module = parseModulePath(input.module, 'check');
		if (!module.ok) {
			return fail(module.reason);
		}
		const port = parsePort(input.port);
		if (!port.ok) {
			return fail(port.reason);
		}
		const lines = [
			`use ${module.value}`,
			`set RHOSTS ${target}`,
			'set THREADS 1',
		];
		if (port.value !== undefined) {
			lines.push(`set RPORT ${port.value}`);
		}
		lines.push('check', 'exit');
		return runMsf(settings, id, 'target', lines, 6_000);
	}

	if (id === 'msf-run') {
		const module = parseModulePath(input.module, 'execute');
		if (!module.ok) {
			return fail(module.reason);
		}
		const port = parsePort(input.port);
		if (!port.ok) {
			return fail(port.reason);
		}
		const payload = parsePayload(input.payload);
		if (!payload.ok) {
			return fail(payload.reason);
		}
		const lines = [
			`use ${module.value}`,
			`set RHOSTS ${target}`,
			'set THREADS 1',
		];
		if (port.value !== undefined) {
			lines.push(`set RPORT ${port.value}`);
		}
		if (payload.value !== undefined) {
			lines.push(`set PAYLOAD ${payload.value}`);
		}
		// Sessions never persist: -z backgrounds any opened session, then -K kills all.
		lines.push(module.value.startsWith('exploit/') ? 'exploit -z' : 'run', 'sessions -K', 'exit');
		return runMsf(settings, id, 'target', lines, 6_000);
	}

	const pinned = PINNED[id];
	const module = parseModulePath(pinned?.module ?? input.module, 'run');
	if (!module.ok) {
		return fail(module.reason);
	}
	const port = parsePort(input.port, pinned?.port);
	if (!port.ok) {
		return fail(port.reason);
	}

	const lines = [
		`use ${module.value}`,
		`set RHOSTS ${target}`,
		`set THREADS 1`,
	];
	if (port.value !== undefined) {
		lines.push(`set RPORT ${port.value}`);
	}
	lines.push('run', 'exit');
	return runMsf(settings, id, 'target', lines);
}

async function runMsf(
	settings: HawaldarSettings,
	id: string,
	network: 'none' | 'target',
	lines: string[],
	stdoutCap = 20_000,
) {
	const script = lines.join('; ');
	const result = await podmanRun({
		podmanPath: settings.podmanPath,
		image: imageFor(settings, 'metasploit'),
		entrypoint: MSF_BIN,
		args: ['-q', '-x', script],
		timeoutMs: timeoutMs(id),
		network,
		memoryMb: MEMORY_MB,
		pidsLimit: PIDS,
		workdir: MSF_HOME,
	});
	return {
		ok: result.exitCode === 0 && !result.timedOut,
		stdout: result.stdout.slice(0, stdoutCap),
		stderr: result.stderr.slice(0, 4_000),
		exitCode: result.exitCode,
		timedOut: result.timedOut,
		source: BUILTIN_SOURCE,
		tool: id,
	};
}

function fail(stderr: string) {
	return { ok: false, stdout: '', stderr, exitCode: 1 };
}
