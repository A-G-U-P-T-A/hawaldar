import { AsyncLocalStorage } from 'node:async_hooks';

export interface ProbeSnippet {
	tool: string;
	at: number;
	method?: string;
	url?: string;
	body?: string;
	status?: number;
	stdout: string;
	payload?: string;
	actions?: Array<{ op: string; selector?: string; value?: string; ms?: number }>;
}

export interface ToolExecContext {
	impliedTargets: string[];
	readOnlyMemory?: boolean;
	lastProbes: ProbeSnippet[];
}

export const toolExecContext = new AsyncLocalStorage<ToolExecContext>();

/** Process-wide recent probes so finding-record can attach poc-request/sqlmap/zap stdout after playbook tool steps. */
const recentProbes: ProbeSnippet[] = [];
const PROBE_CAP = 24;

export function currentToolContext(): ToolExecContext | undefined {
	return toolExecContext.getStore();
}

export function rememberProbe(snippet: ProbeSnippet): void {
	const store = toolExecContext.getStore();
	if (store) {
		store.lastProbes.push(snippet);
		if (store.lastProbes.length > PROBE_CAP) {
			store.lastProbes.splice(0, store.lastProbes.length - PROBE_CAP);
		}
	}
	recentProbes.push(snippet);
	if (recentProbes.length > PROBE_CAP) {
		recentProbes.splice(0, recentProbes.length - PROBE_CAP);
	}
}

export function lastMatchingProbe(opts?: { toolIds?: string[]; classHint?: string }): ProbeSnippet | undefined {
	const local = toolExecContext.getStore()?.lastProbes ?? [];
	const pool = local.length > 0 ? local : recentProbes;
	const tools = opts?.toolIds;
	for (let i = pool.length - 1; i >= 0; i -= 1) {
		const item = pool[i];
		if (tools && tools.length > 0 && !tools.includes(item.tool)) {
			continue;
		}
		if (opts?.classHint === 'xss' && item.tool !== 'poc-xss-canary' && item.tool !== 'zap-ascan') {
			continue;
		}
		if (opts?.classHint === 'injection' && item.tool !== 'poc-request' && item.tool !== 'sqlmap-scan') {
			continue;
		}
		return item;
	}
	return pool[pool.length - 1];
}
