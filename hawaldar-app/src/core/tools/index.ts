import { formatScanActivityDetail, scanMetaFromResult, type ChatActivity } from '../chat-activity';
import type { ApprovalsStore } from '../approvals-store';
import type { FindingsStore } from '../findings-store';
import { ensureRuntimeHitl, USER_DECLINED, type HitlAsk, type HitlToolContext } from '../hitl';
import { evaluateToolRules, type RuleRecord, type WorkflowRecord } from '../playbook-store';
import { fillImpliedToolTarget, parseTargetRef, rejectForbiddenTool, resolveImpliedTargets, restoreTargetPlaceholders, skipReasonForTool } from '../policy';
import { isServiceStarted } from '../sandbox/podman-services';
import type { HawaldarSettings } from '../settings';
import { runBinwalkTool, runRadareTool } from './binary';
import { runBrowserTool } from './browser';
import { isIntrusiveTool, isKnowledgeTool, isServiceControlTool, TOOL_CATALOG } from './catalog';
import { isFindingTool, runFindingTool } from './findings';
import { runKnowledgeTool } from './knowledge';
import type { KnowledgeStore } from '../knowledge';
import { runCustomTool } from './custom';
import { runDnsTool } from './dns';
import { runGhidraTool } from './ghidra';
import { msfAskSummary, runMetasploitTool } from './metasploit';
import { runNmapTool } from './nmap';
import { ensurePocApproval, isPocTool, pocAskSummary, runPocTool } from './poc';
import { runPdTool } from './projectdiscovery';
import { runResearchTool } from './research';
import { runScraplingTool } from './scrapling';
import { isSemgrepListTool, runSemgrepTool } from './semgrep';
import { runSqlmapTool, sqlmapAskSummary } from './sqlmap';
import { runJuiceShopTool, buildJuiceShopInputSchema } from './juice-shop';
import { runZapTool, zapAskSummary } from './zap';
import {
	resolveControllableServiceId,
	runServiceControlTool,
	serviceOffMessage,
	type PersistServiceSettings,
} from './services';
import { isTsharkListTool, runTsharkTool } from './tshark';

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
	query?: string;
	module?: string;
	port?: number;
	level?: number;
	risk?: number;
	technique?: string;
	forms?: boolean;
	crawl?: number;
	timeoutSec?: number;
	retries?: number;
	banner?: boolean;
	currentUser?: boolean;
	currentDb?: boolean;
	dbs?: boolean;
	agentId?: string;
	url?: string;
	engine?: string;
	types?: string[];
	nameserver?: string;
	title?: string;
	text?: string;
	source?: string;
	selector?: string;
	selectorType?: string;
	identifier?: string;
	mode?: string;
	method?: string;
	headers?: Record<string, string>;
	body?: string;
	payload?: string;
	actions?: Array<{ op: string; selector?: string; value?: string; ms?: number }>;
	vulnClass?: string;
	severity?: string;
	status?: string;
	steps?: string[];
	evidence?: string;
	impact?: string;
	remediation?: string;
	references?: string[];
}

export interface ExecuteToolOptions {
	rules?: RuleRecord[];
	workflow?: WorkflowRecord;
	impliedTargets?: string[];
	persist?: PersistServiceSettings;
	onActivity?: (event: ChatActivity) => void;
	hitlContext?: HitlToolContext;
	askHitl?: (req: HitlAsk) => Promise<boolean>;
	persistEnginePath?: (podmanPath: string) => Promise<void>;
	knowledge?: KnowledgeStore;
	findings?: FindingsStore;
	approvals?: ApprovalsStore;
	/** Recording agent id (finding-record source). */
	sourceAgentId?: string;
}

function toolTargetDetail(input: ToolInput): string {
	return input.target || input.url || input.filePath || input.pcapPath || input.module || input.query || '';
}

function previewLocalScanDetail(target: string, _settings: HawaldarSettings): string {
	const restored = restoreTargetPlaceholders(target);
	const ref = parseTargetRef(restored);
	return ref?.display || restored;
}

function toolActivityDetail(
	input: ToolInput,
	settings: HawaldarSettings,
	result?: unknown,
): string {
	const meta = scanMetaFromResult(result);
	const fromResult = formatScanActivityDetail(meta.target ?? '', meta.scannedAs, meta.scannedAsIp);
	if (fromResult) {
		return fromResult;
	}
	if (input.target) {
		return previewLocalScanDetail(input.target, settings);
	}
	return toolTargetDetail(input);
}

export async function executeTool(
	settings: HawaldarSettings,
	id: string,
	input: ToolInput,
	options?: ExecuteToolOptions,
) {
	let current = settings;
	const emit = options?.onActivity;
	const emitStart = (name: string, detail: string) => {
		emit?.({ type: 'tool:start', name, detail, status: 'start' });
	};
	const emitDone = (name: string, ok: boolean, detail = '') => {
		emit?.({ type: 'tool:done', name, detail, status: ok ? 'ok' : 'error' });
	};
	const implied = options?.impliedTargets && options.impliedTargets.length > 0
		? options.impliedTargets
		: resolveImpliedTargets('', settings.scope).targets;
	const filled: ToolInput = {
		...input,
		target: fillImpliedToolTarget(id, input.target ?? input.url, implied, settings.scope),
		url: fillImpliedToolTarget(id, input.url ?? input.target, implied, settings.scope),
	};

	const skip = skipReasonForTool(id, filled.target ?? filled.url, implied);
	if (skip) {
		emitStart(id, skip);
		emitDone(id, true, skip);
		return { ok: true, stdout: skip, stderr: '', exitCode: 0 };
	}

	if (isKnowledgeTool(id)) {
		emitStart(id, input.query || input.title || 'knowledge');
		if (!options?.knowledge) {
			emitDone(id, false, 'Knowledge store is not ready.');
			return { ok: false, stdout: '', stderr: 'Knowledge store is not ready.', exitCode: 1 };
		}
		const result = await runKnowledgeTool(options.knowledge, id, input);
		emitDone(id, result.ok, result.ok ? (input.query || input.title || 'knowledge') : result.stderr);
		return result;
	}

	if (isFindingTool(id)) {
		const detail = input.title || input.query || input.status || 'findings';
		emitStart(id, String(detail));
		if (!options?.findings) {
			emitDone(id, false, 'Findings store is not ready.');
			return { ok: false, stdout: '', stderr: 'Findings store is not ready.', exitCode: 1 };
		}
		const result = await runFindingTool(options.findings, id, input as Record<string, unknown>, {
			source: options.sourceAgentId,
		});
		emitDone(id, result.ok, result.ok ? String(detail) : result.stderr);
		return result;
	}

	if (isServiceControlTool(id)) {
		const serviceName = typeof input.agentId === 'string' && input.agentId.trim()
			? input.agentId.trim()
			: 'service';
		const verb = id === 'stop_service' ? 'Stopping' : 'Starting';
		if (id !== 'stop_service') {
			const resolved = resolveControllableServiceId(current, input.agentId);
			if (resolved.ok) {
				const gate = await ensureRuntimeHitl(current, resolved.serviceId, {
					hitlContext: options?.hitlContext,
					askHitl: options?.askHitl,
					persist: options?.persist,
					onActivity: emit,
					persistEnginePath: options?.persistEnginePath,
					approvals: options?.approvals,
				});
				if (gate.status === 'suspended') {
					return gate.value;
				}
				if (gate.status !== 'ok') {
					emitStart(serviceName, `${verb} ${serviceName} image…`);
					emitDone(serviceName, false, gate.detail);
					return { ok: false, stdout: '', stderr: gate.detail, exitCode: 1 };
				}
				current = gate.settings;
			}
		}
		emitStart(serviceName, `${verb} ${serviceName} image…`);
		if (options?.rules) {
			const decision = evaluateToolRules(options.rules, id, current, options.workflow);
			if (!decision.ok) {
				emitDone(serviceName, false, decision.reason);
				return { ok: false, stdout: '', stderr: decision.reason, exitCode: 1 };
			}
		}
		const result = await runServiceControlTool(current, id, input.agentId, options?.persist);
		emitDone(serviceName, result.ok, result.ok ? `${verb} ${serviceName} image…` : result.stderr);
		return result;
	}

	const agentId = agentIdForTool(current, id);
	if (agentId && toolRequiresService(id)) {
		const gate = await ensureRuntimeHitl(current, agentId, {
			hitlContext: options?.hitlContext,
			askHitl: options?.askHitl,
			persist: options?.persist,
			onActivity: emit,
			persistEnginePath: options?.persistEnginePath,
			approvals: options?.approvals,
		});
		if (gate.status === 'suspended') {
			return gate.value;
		}
		if (gate.status !== 'ok') {
			const stderr = gate.detail || (gate.status === 'declined' ? USER_DECLINED : serviceOffMessage(agentId));
			emitStart(id, toolActivityDetail(filled, current));
			emitDone(id, false, stderr);
			return { ok: false, stdout: '', stderr, exitCode: 1 };
		}
		current = gate.settings;
	}

	if (isPocTool(id) || isIntrusiveTool(id)) {
		const summary = isPocTool(id)
			? pocAskSummary(current, id, filled)
			: intrusiveAskSummary(current, id, filled);
		if (!summary.ok) {
			emitStart(id, id);
			emitDone(id, false, summary.reason);
			return { ok: false, stdout: '', stderr: summary.reason, exitCode: 1 };
		}
		const approval = await ensurePocApproval(summary.value, {
			hitlContext: options?.hitlContext,
			askHitl: options?.askHitl,
		});
		if (approval.status === 'suspended') {
			return approval.value;
		}
		if (approval.status !== 'ok') {
			const stderr = approval.detail || USER_DECLINED;
			emitStart(id, toolActivityDetail(filled, current));
			emitDone(id, false, stderr);
			return { ok: false, stdout: '', stderr, exitCode: 1 };
		}
	}

	emitStart(id, toolActivityDetail(filled, current));

	if (options?.rules) {
		const decision = evaluateToolRules(options.rules, id, current, options.workflow);
		if (!decision.ok) {
			emitDone(id, false, decision.reason);
			return { ok: false, stdout: '', stderr: decision.reason, exitCode: 1 };
		}
		if (decision.maxTimeoutMs) {
			try {
				const result = await withDeadline(runTool(current, id, filled, implied), decision.maxTimeoutMs);
				emitDone(id, result.ok, result.ok ? toolActivityDetail(filled, current, result) : result.stderr);
				return result;
			} catch (error) {
				const stderr = error instanceof Error ? error.message : String(error);
				emitDone(id, false, stderr);
				return { ok: false, stdout: '', stderr, exitCode: 1 };
			}
		}
	}
	const result = await runTool(current, id, filled, implied);
	emitDone(id, result.ok, result.ok ? toolActivityDetail(filled, current, result) : result.stderr);
	return result;
}

/** Per-call approval text for intrusive tools (same HITL path as poc-* probes). */
function intrusiveAskSummary(
	settings: HawaldarSettings,
	id: string,
	input: ToolInput,
): { ok: true; value: { title: string; explanation: string } } | { ok: false; reason: string } {
	const agentId = TOOL_CATALOG.find((tool) => tool.id === id)?.agentId;
	if (agentId === 'zap') {
		return zapAskSummary(settings, id, { url: input.url ?? input.target });
	}
	if (agentId === 'sqlmap') {
		return sqlmapAskSummary(settings, id, {
			url: input.url ?? input.target,
			level: input.level,
			risk: input.risk,
			technique: input.technique,
			forms: input.forms,
			crawl: input.crawl,
			timeoutSec: input.timeoutSec,
			retries: input.retries,
			banner: input.banner,
			currentUser: input.currentUser,
			currentDb: input.currentDb,
			dbs: input.dbs,
		});
	}
	if (agentId === 'metasploit') {
		return msfAskSummary(settings, id, {
			target: input.target,
			module: input.module,
			port: input.port,
			payload: input.payload,
		});
	}
	return { ok: false, reason: `Unknown intrusive tool: ${id}` };
}

function agentIdForTool(settings: HawaldarSettings, id: string): string | undefined {
	const custom = settings.customTools.find((tool) => tool.id === id);
	if (custom) {
		return custom.agentId;
	}
	return TOOL_CATALOG.find((tool) => tool.id === id)?.agentId;
}

function toolRequiresService(id: string): boolean {
	return id !== 'nmap-xml-summary' && id !== 'browser-close' && !isTsharkListTool(id)
		&& !isSemgrepListTool(id)
		&& !isServiceControlTool(id) && !isKnowledgeTool(id);
}

async function runTool(settings: HawaldarSettings, id: string, input: ToolInput, impliedTargets: string[] = []) {
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
			return { ok: false, stdout: '', stderr: serviceOffMessage(custom.agentId), exitCode: 1 };
		}
		return runCustomTool(settings, custom, input);
	}
	const spec = TOOL_CATALOG.find((tool) => tool.id === id);
	if (!spec) {
		return { ok: false, stdout: '', stderr: `Unknown tool: ${id}`, exitCode: 1 };
	}
	if (isServiceControlTool(id)) {
		return runServiceControlTool(settings, id, input.agentId);
	}
	if (spec.agentId === 'nmap' && id === 'nmap-xml-summary') {
		return runNmapTool(settings, id, input.target ?? '', {
			topPorts: input.topPorts,
			portRange: input.portRange,
			filePath: input.filePath,
		});
	}
	if (spec.agentId === 'tshark' && isTsharkListTool(id)) {
		return runTsharkTool(settings, id, input);
	}
	if (spec.agentId === 'semgrep' && isSemgrepListTool(id)) {
		return runSemgrepTool(settings, id, input);
	}
	if (spec.agentId === 'browser' && id === 'browser-close') {
		return runBrowserTool(settings, id, input);
	}
	if (!isServiceStarted(settings, spec.agentId)) {
		return { ok: false, stdout: '', stderr: serviceOffMessage(spec.agentId), exitCode: 1 };
	}
	if (spec.agentId === 'nmap') {
		return runNmapTool(settings, id, input.target ?? '', {
			topPorts: input.topPorts,
			portRange: input.portRange,
			filePath: input.filePath,
			impliedTargets,
		});
	}
	if (spec.agentId === 'dns') {
		return runDnsTool(settings, id, {
			target: input.target,
			types: input.types,
			nameserver: input.nameserver,
			impliedTargets,
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
		return runPdTool(settings, id, input.target ?? '', impliedTargets);
	}
	if (spec.agentId === 'metasploit') {
		return runMetasploitTool(settings, id, {
			target: input.target,
			query: input.query,
			module: input.module,
			port: input.port,
			payload: input.payload,
		});
	}
	if (spec.agentId === 'zap') {
		return runZapTool(settings, id, {
			target: input.target,
			url: input.url,
		});
	}
	if (spec.agentId === 'juice-shop') {
		return runJuiceShopTool(settings, id);
	}
	if (spec.agentId === 'sqlmap') {
		return runSqlmapTool(settings, id, {
			url: input.url ?? input.target,
			level: input.level,
			risk: input.risk,
			technique: input.technique,
			forms: input.forms,
			crawl: input.crawl,
			timeoutSec: input.timeoutSec,
			retries: input.retries,
			banner: input.banner,
			currentUser: input.currentUser,
			currentDb: input.currentDb,
			dbs: input.dbs,
		});
	}
	if (spec.agentId === 'browser') {
		return runBrowserTool(settings, id, {
			target: input.target,
			url: input.url,
			query: input.query,
			engine: input.engine,
		});
	}
	if (spec.agentId === 'research') {
		return runResearchTool(settings, id, {
			target: input.target,
			url: input.url,
			query: input.query,
			engine: input.engine,
		});
	}
	if (spec.agentId === 'scrapling') {
		return runScraplingTool(settings, id, {
			target: input.target,
			url: input.url,
			selector: input.selector,
			selectorType: input.selectorType,
			identifier: input.identifier,
			mode: input.mode,
		});
	}
	if (spec.agentId === 'poc') {
		return runPocTool(settings, id, {
			url: input.url ?? input.target,
			method: input.method,
			headers: input.headers,
			body: input.body,
			payload: input.payload,
			actions: input.actions,
		});
	}
	if (spec.agentId === 'semgrep') {
		return runSemgrepTool(settings, id, { filePath: input.filePath });
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
