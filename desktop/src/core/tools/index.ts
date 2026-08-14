import { evaluateToolRules, type RuleRecord, type WorkflowRecord } from '../playbook-store';
import { rejectForbiddenTool } from '../policy';
import { isServiceStarted, serviceRequiredMessage } from '../sandbox/podman-services';
import type { HawaldarSettings } from '../settings';
import { runBinwalkTool, runRadareTool } from './binary';
import { TOOL_CATALOG } from './catalog';
import { runCustomTool } from './custom';
import { runGhidraTool } from './ghidra';
import { runNmapTool } from './nmap';
import { runPdTool } from './projectdiscovery';
import { runTsharkTool } from './tshark';

export interface ToolInput {
	target?: string;
	filePath?: string;
	pcapPath?: string;
	functionName?: string;
	address?: string;
	topPorts?: number;
	portRange?: string;
	scanType?: string;
	streamIndex?: number;
	streamProto?: 'tcp' | 'udp';
	limit?: number;
}

export interface ExecuteToolOptions {
	rules?: RuleRecord[];
	workflow?: WorkflowRecord;
}

export async function executeTool(
	settings: HawaldarSettings,
	id: string,
	input: ToolInput,
	options?: ExecuteToolOptions,
) {
	if (options?.rules) {
		const decision = evaluateToolRules(options.rules, id, settings, options.workflow);
		if (!decision.ok) {
			return { ok: false, stdout: '', stderr: decision.reason, exitCode: 1 };
		}
		if (decision.maxTimeoutMs) {
			try {
				return await withDeadline(runTool(settings, id, input), decision.maxTimeoutMs);
			} catch (error) {
				return {
					ok: false,
					stdout: '',
					stderr: error instanceof Error ? error.message : String(error),
					exitCode: 1,
				};
			}
		}
	}
	return runTool(settings, id, input);
}

async function runTool(settings: HawaldarSettings, id: string, input: ToolInput) {
	const forbidden = rejectForbiddenTool(id);
	if (forbidden) {
		return { ok: false, stdout: '', stderr: forbidden.reason, exitCode: 1 };
	}
	if (input.scanType && input.scanType !== 'tcp_connect') {
		return { ok: false, stdout: '', stderr: `Scan type ${input.scanType} is refused. Only tcp_connect.`, exitCode: 1 };
	}
	const custom = settings.customTools.find((tool) => tool.id === id);
	if (custom) {
		if (!isServiceStarted(settings, custom.agentId)) {
			return { ok: false, stdout: '', stderr: serviceRequiredMessage(custom.agentId), exitCode: 1 };
		}
		return runCustomTool(settings, custom, input);
	}
	const spec = TOOL_CATALOG.find((tool) => tool.id === id);
	if (!spec) {
		return { ok: false, stdout: '', stderr: `Unknown tool: ${id}`, exitCode: 1 };
	}
	if (spec.agentId === 'nmap' && id === 'nmap-xml-summary') {
		return runNmapTool(settings, id, input.target ?? '', {
			topPorts: input.topPorts,
			portRange: input.portRange,
			filePath: input.filePath,
		});
	}
	if (!isServiceStarted(settings, spec.agentId)) {
		return { ok: false, stdout: '', stderr: serviceRequiredMessage(spec.agentId), exitCode: 1 };
	}
	if (spec.agentId === 'nmap') {
		if (!input.target) {
			return missing('target');
		}
		return runNmapTool(settings, id, input.target, {
			topPorts: input.topPorts,
			portRange: input.portRange,
			filePath: input.filePath,
		});
	}
	if (spec.agentId === 'tshark') {
		return runTsharkTool(settings, id, input);
	}
	if (spec.agentId === 'ghidra') {
		if (!input.filePath) {
			return missing('filePath');
		}
		return runGhidraTool(settings, id, input.filePath, input.functionName ?? input.address);
	}
	if (spec.agentId === 'radare') {
		if (!input.filePath) {
			return missing('filePath');
		}
		return runRadareTool(settings, id, input.filePath, {
			functionName: input.functionName,
			address: input.address,
		});
	}
	if (spec.agentId === 'binwalk') {
		if (!input.filePath) {
			return missing('filePath');
		}
		return runBinwalkTool(settings, id, input.filePath);
	}
	if (
		spec.agentId === 'subfinder'
		|| spec.agentId === 'dnsx'
		|| spec.agentId === 'httpx'
		|| spec.agentId === 'naabu'
		|| spec.agentId === 'katana'
		|| spec.agentId === 'nuclei'
		|| spec.agentId === 'amass'
		|| spec.agentId === 'ffuf'
	) {
		if (!input.target) {
			return missing('target');
		}
		return runPdTool(settings, id, input.target);
	}
	return { ok: false, stdout: '', stderr: `Unknown tool: ${id}`, exitCode: 1 };
}

function missing(field: string) {
	return { ok: false, stdout: '', stderr: `${field} is required.`, exitCode: 1 };
}

function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`Tool exceeded max timeout (${ms}ms)`)), ms);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}
