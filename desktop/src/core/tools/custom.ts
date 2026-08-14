import { evaluateScope } from '../policy';
import { rejectForbiddenTool } from '../policy';
import { podmanRun } from '../sandbox/podman';
import { containerPathUnderWorkspace } from '../sandbox/workspace';
import type { HawaldarSettings } from '../settings';
import type { ToolKind } from './catalog';
import { assertLocalFile } from './files';

const ID_RE = /^[a-z][a-z0-9_-]{1,47}$/;
const CMD_RE = /^[a-zA-Z0-9._-]+$/;
const IMAGE_RE = /^[a-zA-Z0-9._\/:-]+$/;
const ARG_RE = /^[a-zA-Z0-9._\/=:,@{}\[\]+-]+$/;

export interface CustomToolDef {
	id: string;
	title: string;
	kind: Exclude<ToolKind, 'meta'>;
	agentId: string;
	image: string;
	command: string;
	/** Args with {{target}}, {{filePath}}, {{pcapPath}}, {{functionName}} placeholders. */
	argsTemplate: string[];
	network: 'none' | 'target';
	timeoutMs: number;
	description: string;
	enabled: boolean;
}

export function validateCustomTool(raw: Partial<CustomToolDef>): { ok: true; tool: CustomToolDef } | { ok: false; error: string } {
	const id = String(raw.id || '').trim().toLowerCase();
	const title = String(raw.title || '').trim();
	const kind = raw.kind;
	const agentId = String(raw.agentId || 'custom').trim() || 'custom';
	const image = String(raw.image || '').trim();
	const command = String(raw.command || '').trim();
	const argsTemplate = Array.isArray(raw.argsTemplate) ? raw.argsTemplate.map(String) : [];
	const network = raw.network === 'target' ? 'target' : 'none';
	const timeoutMs = Math.min(Math.max(Number(raw.timeoutMs) || 120_000, 10_000), 600_000);
	const description = String(raw.description || title || id).trim();
	const enabled = raw.enabled !== false;

	if (!ID_RE.test(id)) {
		return { ok: false, error: 'Tool id must be lowercase letters/digits/_/- (2–48 chars).' };
	}
	const forbidden = rejectForbiddenTool(id) || rejectForbiddenTool(command);
	if (forbidden) {
		return { ok: false, error: forbidden.reason };
	}
	if (!title) {
		return { ok: false, error: 'Title is required.' };
	}
	if (kind !== 'host' && kind !== 'file' && kind !== 'pcap') {
		return { ok: false, error: 'Kind must be host, file, or pcap.' };
	}
	if (!IMAGE_RE.test(image)) {
		return { ok: false, error: 'Invalid container image.' };
	}
	if (!CMD_RE.test(command)) {
		return { ok: false, error: 'Invalid container command.' };
	}
	if (argsTemplate.length === 0 || argsTemplate.length > 32) {
		return { ok: false, error: 'Provide 1–32 args (use {{target}} / {{filePath}} / {{pcapPath}}).' };
	}
	for (const arg of argsTemplate) {
		if (!ARG_RE.test(arg) && !/^\{\{(target|filePath|pcapPath|functionName)\}\}$/.test(arg)) {
			return { ok: false, error: `Unsafe arg: ${arg}` };
		}
	}
	if (kind === 'host' && network !== 'target') {
		return { ok: false, error: 'Host tools must use target network.' };
	}
	if ((kind === 'file' || kind === 'pcap') && network !== 'none') {
		return { ok: false, error: 'File/pcap tools must use network none.' };
	}

	return {
		ok: true,
		tool: { id, title, kind, agentId, image, command, argsTemplate, network, timeoutMs, description, enabled },
	};
}

export async function runCustomTool(settings: HawaldarSettings, tool: CustomToolDef, input: {
	target?: string;
	filePath?: string;
	pcapPath?: string;
	functionName?: string;
}) {
	if (!tool.enabled || !settings.enabledTools.includes(tool.id)) {
		return { ok: false, stdout: '', stderr: `${tool.id} is disabled.`, exitCode: 1 };
	}

	let mounts: Array<{ source: string; target: string; readonly: boolean }> | undefined;
	const vars: Record<string, string> = {};

	if (tool.kind === 'host') {
		if (!input.target) {
			return { ok: false, stdout: '', stderr: 'target is required.', exitCode: 1 };
		}
		const decision = evaluateScope(settings.scope, input.target);
		if (!decision.allow) {
			return { ok: false, stdout: '', stderr: decision.reason, exitCode: 1 };
		}
		vars.target = input.target;
	} else if (tool.kind === 'pcap') {
		if (!input.pcapPath) {
			return { ok: false, stdout: '', stderr: 'pcapPath is required.', exitCode: 1 };
		}
		const resolved = assertLocalFile(input.pcapPath, /\.(pcap|pcapng)$/i);
		vars.pcapPath = containerPathUnderWorkspace(resolved) ?? '/pcap/capture.pcap';
		mounts = [{ source: resolved, target: '/pcap/capture.pcap', readonly: true }];
	} else {
		if (!input.filePath) {
			return { ok: false, stdout: '', stderr: 'filePath is required.', exitCode: 1 };
		}
		const resolved = assertLocalFile(input.filePath);
		vars.filePath = containerPathUnderWorkspace(resolved) ?? '/in/sample.bin';
		vars.functionName = input.functionName || '';
		mounts = [{ source: resolved, target: '/in/sample.bin', readonly: true }];
	}

	const args = tool.argsTemplate.map((part) => {
		const match = part.match(/^\{\{(target|filePath|pcapPath|functionName)\}\}$/);
		if (match) {
			return vars[match[1]] ?? '';
		}
		return part;
	});

	const result = await podmanRun({
		podmanPath: settings.podmanPath,
		image: settings.toolImages[tool.agentId] || tool.image,
		command: tool.command,
		args,
		timeoutMs: tool.timeoutMs,
		network: tool.network,
		mounts,
	});

	return {
		ok: result.exitCode === 0 && !result.timedOut,
		stdout: result.stdout.slice(0, 20_000),
		stderr: result.stderr.slice(0, 4_000),
		exitCode: result.exitCode,
		timedOut: result.timedOut,
		tool: tool.id,
		source: 'custom',
	};
}
