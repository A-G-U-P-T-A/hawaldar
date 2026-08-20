import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadMastra, type MastraModules } from './load-mastra';
import { ensureDataHome } from './data-home';
import { loadDotenvFiles } from './env-files';
import { WORKING_MEMORY_TEMPLATE, sanitizeWorkingMemoryUpdate } from './working-memory';
import { EngagementTracker, type EngagementRun } from './engagement-tracker';
import { ApprovalsStore } from './approvals-store';
import { FindingsStore, type FindingFilter, type FindingRecord } from './findings-store';
import { NotesStore } from './notes-store';
import { ReportsStore, type ReportFilter } from './reports-store';
import { buildKnowledgeGraph, formatRagContext, KnowledgeStore, tryCreateRouterEmbedder } from './knowledge';
import {
	engagementAgentPrompt,
	isEngagementWorkflow,
	isEmptyPlaybookOutput,
	isMissingToolHallucination,
	isPocPlaybookAgent,
	pocFallbackJob,
	gateReportingNarrative,
	resolveWorkflowRef,
	sanitizePlaybookAgentOutput,
	WORKFLOW_SLASH_ALIASES,
	adaptWorkflowSteps,
	clipThreadEvidence,
	groupIndependentSteps,
	playbookSqlmapOptions,
	playbookStepUrl,
} from './engagement';
import { type EngagementCheckpoint } from './engagement-checkpoint';
import {
	evaluatePlaybookRules,
	PlaybookStore,
	workflowHasExploitStep,
	type WorkflowRecord,
	type WorkflowStep,
} from './playbook-store';
import {
	extractCanonicalTarget,
	fillImpliedToolTarget,
	focusedPortForLocalScan,
	restoreTargetPlaceholders,
	skipReasonForTool,
} from './policy';
import { currentToolContext, toolExecContext } from './tool-context';
import { coerceToolArgs, formatFindingsChatTable, wrapToolInputSchema } from './tool-args';
import { lookupListedModel } from './model-catalog';
import {
	applyProviderEnv,
	MASTRA_PROVIDERS,
	MISSING_API_KEY_HINT,
	mastraCustomModelUrl,
	missingProviderApiKeyError,
	openRouterRequestHeaders,
	resolveProviderApiKey,
	routerModelId,
} from './providers';
import { PromptsStore, type SlashCommandDef } from './prompts';
import { SessionMetaStore, clipSnippet, isPlaceholderSessionTitle, titleFromFirstPrompt, toEpochMs } from './session-meta';
import { SettingsStore, type HawaldarSettings } from './settings';
import { TaskStore } from './tasks-store';
import { AGENT_ROLES, catalogToolsForAgent, EXCLUDED_MCP_TOOLS, isKnowledgeTool, isServiceControlTool, KNOWLEDGE_TOOL_IDS, SERVICE_CONTROL_TOOL_IDS, TOOL_CATALOG, toPublicTool } from './tools/catalog';
import { consumeAgentStream, type ChatActivity } from './chat-activity';
import { createEmptyMessageProcessor, formatChatError, providerLooksConfigured, purgeEmptyMastraMessages, sanitizeProviderMessages, toDisplayText, wrapMemorySanitize } from './chat-messages';
import { isResumeIntent, mastraMemoryOptions } from './stream-text';
import { definedToolResult, type HitlAsk } from './hitl';
import { executeTool, type ExecuteToolOptions } from './tools/index';
import { buildBrowserInputSchema } from './tools/browser';
import { buildFindingInputSchema, isFindingTool, persistFindingsPdf } from './tools/findings';
import { appendRetestEvidence, asProbeRunResult, evaluateRetest, mergeRetestRequest, resolveRetestTool, retestToolInput } from './tools/finding-retest';
import { buildMetasploitInputSchema } from './tools/metasploit';
import { buildPocInputSchema } from './tools/poc';
import { buildResearchInputSchema } from './tools/research';
import { buildServiceControlInputSchema } from './tools/services';
import { buildSqlmapInputSchema } from './tools/sqlmap';
import { buildZapInputSchema } from './tools/zap';
import { buildJuiceShopInputSchema } from './tools/juice-shop';
import { buildTsharkInputSchema } from './tools/tshark';
import { buildDnsInputSchema } from './tools/dns';
import { buildNmapInputSchema } from './tools/nmap';
import { buildScraplingInputSchema } from './tools/scrapling';
import { buildSemgrepInputSchema } from './tools/semgrep';
import { buildKnowledgeInputSchema } from './tools/knowledge';
import { WorkbenchExporter } from './workbench-exporter';

export const RESOURCE = 'hawaldar';

export interface MemoryThread {
	id: string;
	title: string;
	resource: string;
	createdAt: number;
	updatedAt: number;
	pinned: boolean;
	snippet: string;
}

export interface ThreadHistoryMessage {
	id: string;
	role: 'user' | 'assistant';
	text: string;
	createdAt: number;
}

export interface ThreadHistoryPage {
	messages: ThreadHistoryMessage[];
	hasMore: boolean;
}

export class HawaldarRuntime {
	readonly dataDir = path.join(os.homedir(), '.hawaldar');
	readonly databasePath = path.join(this.dataDir, 'mastra.db');
	readonly exporter = new WorkbenchExporter();
	readonly prompts: PromptsStore;
	readonly playbooks: PlaybookStore;
	readonly notes: NotesStore;
	readonly tasks: TaskStore;
	readonly sessions: SessionMetaStore;
	readonly findings: FindingsStore;
	readonly reports: ReportsStore;
	readonly approvals: ApprovalsStore;
	readonly engagement = new EngagementTracker();
	knowledge: KnowledgeStore | undefined;
	mastra: any;
	private memory: any;
	private settings!: HawaldarSettings;
	private mods: MastraModules | undefined;
	private impliedTargets: string[] = [];
	private impliedTargetDepth = 0;
	private peekedMissingActivity = new Set<string>();
	private activitySink?: (event: ChatActivity) => void;
	private hitlAsk?: (req: HitlAsk) => Promise<boolean>;
	readonly ready: Promise<void>;
	activeThreadId: string | undefined;

	constructor(private readonly store: SettingsStore) {
		ensureDataHome(this.dataDir);
		fs.mkdirSync(this.store.cacheDir, { recursive: true });
		this.prompts = new PromptsStore(this.store.extensionPath, this.dataDir);
		this.playbooks = new PlaybookStore(this.dataDir);
		this.notes = new NotesStore(this.dataDir);
		this.tasks = new TaskStore(this.dataDir);
		this.sessions = new SessionMetaStore(this.dataDir);
		this.findings = new FindingsStore(this.dataDir);
		this.reports = new ReportsStore(this.dataDir);
		this.approvals = new ApprovalsStore(this.dataDir);
		this.ready = this.boot();
	}

	private async boot(): Promise<void> {
		await Promise.all([this.playbooks.ready, this.notes.ready, this.tasks.ready, this.sessions.ready, this.approvals.ready]);
		await this.findings.ready;
		await this.reports.ready;
		await this.reload();
	}

	get traces() {
		return this.exporter.traces;
	}

	get logs() {
		return this.exporter.logs;
	}

	async reload(): Promise<void> {
		loadDotenvFiles([this.store.extensionPath, path.dirname(this.store.extensionPath)]);
		this.settings = await this.store.read();
		await this.playbooks.refresh();
		applyProviderEnv(this.settings.provider, this.settings.apiKey, this.settings.baseUrl);
		this.mods = this.mods ?? await loadMastra();
		try {
			if (!this.knowledge) {
				this.knowledge = await KnowledgeStore.open(this.dataDir, this.mods, this.settings);
			} else {
				await this.knowledge.configureEmbedder(this.settings, this.mods);
			}
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			this.exporter.pushLog('warn', `Knowledge store unavailable: ${detail}`);
		}
		this.mastra = this.build(this.mods);
		const workflows = this.playbooks.listWorkflows().filter((item) => item.enabled).length;
		const kn = this.knowledge ? await this.knowledge.snapshot() : undefined;
		this.exporter.pushLog('info', `Mastra ready · ${this.modelId()} · ${TOOL_CATALOG.length} tools · ${workflows} workflows · knowledge ${kn?.mode ?? 'off'}`);
		void this.syncKnowledgeSources().catch((error) => {
			this.exporter.pushLog('warn', `Knowledge sync failed: ${error instanceof Error ? error.message : String(error)}`);
		});
	}

	modelId(): string {
		return routerModelId(this.settings.provider, this.settings.model);
	}

	listAgents() {
		return AGENT_ROLES;
	}

	listWorkflows() {
		return this.playbooks.listWorkflows().map((item) => ({
			id: item.id,
			key: item.key,
			name: item.name,
			enabled: item.enabled,
			builtin: item.builtin,
			steps: item.steps,
		}));
	}

	slashCommands(): SlashCommandDef[] {
		const base = this.prompts.slashCommands();
		const workflows = this.playbooks.listWorkflows();
		const disabled = new Set(workflows.filter((item) => !item.enabled).map((item) => item.id));
		const out: SlashCommandDef[] = [];
		for (const item of base) {
			if (disabled.has(item.cmd)) {
				continue;
			}
			out.push(item);
		}
		const reserved = new Set(out.map((item) => item.cmd));
		for (const workflow of workflows) {
			if (!workflow.enabled || reserved.has(workflow.id)) {
				continue;
			}
			out.push({
				cmd: workflow.id,
				label: `/${workflow.id}`,
				title: workflow.name,
				detail: 'Workflow',
				insert: `/${workflow.id} `,
				kind: 'workflow',
			});
			reserved.add(workflow.id);
		}
		for (const alias of WORKFLOW_SLASH_ALIASES) {
			if (reserved.has(alias.cmd)) {
				continue;
			}
			const target = workflows.find((item) => item.id === alias.workflowId);
			if (!target || !target.enabled) {
				continue;
			}
			out.push({
				cmd: alias.cmd,
				label: `/${alias.cmd}`,
				title: target.name,
				detail: alias.detail,
				insert: `/${alias.cmd} `,
				kind: 'workflow',
			});
			reserved.add(alias.cmd);
		}
		return out;
	}

	listTools() {
		const builtin = TOOL_CATALOG.map((tool) => toPublicTool(tool, {
			enabled: this.settings.enabledTools.includes(tool.id),
			image: this.settings.toolImages[tool.agentId] || tool.image,
		}));
		const custom = this.settings.customTools.map((tool) => ({
			id: tool.id,
			agentId: tool.agentId,
			title: tool.title,
			kind: tool.kind,
			image: this.settings.toolImages[tool.agentId] || tool.image,
			enabled: tool.enabled && this.settings.enabledTools.includes(tool.id),
			timeoutMs: tool.timeoutMs,
			description: tool.description,
			source: 'custom',
		}));
		return [...builtin, ...custom];
	}

	listProviders() {
		const selected = this.settings.hasSelectedProvider === true;
		return MASTRA_PROVIDERS.map((item) => ({
			...item,
			active: selected && item.id === this.settings.provider,
			configured: selected && item.id === this.settings.provider
				? Boolean(this.providerApiKey() || !item.envVar)
				: Boolean(item.envVar && process.env[item.envVar]),
			modelCount: item.models.length,
		}));
	}

	async listThreads(): Promise<MemoryThread[]> {
		await this.ready;
		const listed = this.memory?.listThreads
			? await this.memory.listThreads({ filter: { resourceId: RESOURCE }, perPage: false })
			: [];
		const threads = Array.isArray(listed) ? listed : listed.threads ?? [];
		const meta = await this.sessions.list();
		const byId = new Map(meta.map((row) => [row.id, row]));
		const mapped: MemoryThread[] = threads.map((thread: any) => {
			const id = String(thread.id);
			const extra = byId.get(id);
			const createdAt = firstEpoch(thread.createdAt, thread.created_at, extra?.createdAt);
			const mastraUpdated = firstEpoch(thread.updatedAt, thread.updated_at);
			const extraUpdated = toEpochMs(extra?.updatedAt);
			return {
				id,
				title: extra?.title || String(thread.title || 'Untitled'),
				resource: String(thread.resourceId || thread.resource || RESOURCE),
				createdAt,
				updatedAt: pickThreadUpdatedAt(extraUpdated, mastraUpdated, createdAt),
				pinned: isPinnedFlag(extra?.pinned),
				snippet: extra?.snippet || '',
			};
		});
		const seen = new Set(mapped.map((item) => item.id));
		for (const extra of meta) {
			if (seen.has(extra.id)) {
				continue;
			}
			mapped.push({
				id: extra.id,
				title: extra.title || 'Untitled',
				resource: RESOURCE,
				createdAt: extra.createdAt || extra.updatedAt,
				updatedAt: extra.updatedAt,
				pinned: extra.pinned,
				snippet: extra.snippet,
			});
		}
		const needsBackfill = mapped.filter((item) => {
			const extra = byId.get(item.id);
			if (item.updatedAt <= 0 && !this.peekedMissingActivity.has(item.id)) {
				return true;
			}
			return !extra || extra.updatedAt <= 0;
		});
		if (needsBackfill.length > 0) {
			await mapLimit(needsBackfill, 8, async (item) => {
				if (item.updatedAt <= 0) {
					this.peekedMissingActivity.add(item.id);
					const peeked = await peekLastActivityFrom(this.memory, item.id);
					item.updatedAt = Math.max(item.updatedAt, peeked.at);
					item.snippet = item.snippet || peeked.snippet;
					if (item.createdAt <= 0 && peeked.at > 0) {
						item.createdAt = peeked.at;
					}
				}
				if (item.updatedAt <= 0) {
					return;
				}
				if (isPlaceholderSessionTitle(item.title) && item.snippet) {
					const named = titleFromFirstPrompt(item.snippet);
					if (named) {
						item.title = named;
					}
				}
				await this.sessions.upsert({
					id: item.id,
					title: item.title,
					pinned: item.pinned,
					snippet: item.snippet,
					createdAt: item.createdAt,
					updatedAt: item.updatedAt,
				});
			});
		}
		for (const item of mapped) {
			if (!isPlaceholderSessionTitle(item.title)) {
				continue;
			}
			const named = titleFromFirstPrompt(item.snippet);
			if (!named) {
				continue;
			}
			item.title = named;
			void this.sessions.upsert({
				id: item.id,
				title: named,
				pinned: item.pinned,
				snippet: item.snippet,
				createdAt: item.createdAt,
				updatedAt: item.updatedAt,
			});
			void tryUpdateMastraTitle(this.memory, item.id, named);
		}
		return mapped.sort((a, b) => {
			if (a.pinned !== b.pinned) {
				return a.pinned ? -1 : 1;
			}
			return b.updatedAt - a.updatedAt;
		});
	}

	async createThread(title = 'New thread'): Promise<MemoryThread> {
		await this.ready;
		const thread = await this.memory.createThread({ resourceId: RESOURCE, title, metadata: { product: 'hawaldar' } });
		const now = Date.now();
		const createdAt = toEpochMs(thread.createdAt) || now;
		const updatedAt = Math.max(toEpochMs(thread.updatedAt), createdAt, now);
		const created: MemoryThread = {
			id: String(thread.id),
			title: String(thread.title || title),
			resource: RESOURCE,
			createdAt,
			updatedAt,
			pinned: false,
			snippet: '',
		};
		await this.sessions.upsert({
			id: created.id,
			title: created.title,
			pinned: false,
			createdAt,
			updatedAt,
			touch: true,
		});
		this.activeThreadId = created.id;
		return created;
	}

	async renameThread(threadId: string, title: string): Promise<MemoryThread | undefined> {
		await this.ready;
		const next = title.trim();
		if (!next) {
			throw new Error('Session title is required.');
		}
		if (next.length > 120) {
			throw new Error('Session title is too long.');
		}
		const current = (await this.listThreads()).find((item) => item.id === threadId);
		if (!current) {
			throw new Error('Unknown session.');
		}
		await this.sessions.upsert({ id: threadId, title: next, pinned: current.pinned, touch: true });
		await tryUpdateMastraTitle(this.memory, threadId, next);
		return { ...current, title: next, updatedAt: Date.now() };
	}

	async setThreadPinned(threadId: string, pinned: boolean): Promise<MemoryThread | undefined> {
		await this.ready;
		const current = (await this.listThreads()).find((item) => item.id === threadId);
		if (!current) {
			throw new Error('Unknown session.');
		}
		await this.sessions.upsert({ id: threadId, title: current.title, pinned, touch: true });
		return { ...current, pinned, updatedAt: Date.now() };
	}

	async deleteThread(threadId: string): Promise<void> {
		await this.ready;
		if (typeof this.memory.deleteThread === 'function') {
			await this.memory.deleteThread(threadId);
		} else if (typeof this.memory.deleteThreadById === 'function') {
			await this.memory.deleteThreadById({ threadId });
		}
		await this.sessions.remove(threadId);
		if (this.activeThreadId === threadId) {
			this.activeThreadId = undefined;
		}
	}

	async ensureThread(): Promise<MemoryThread> {
		const threads = await this.listThreads();
		if (this.activeThreadId) {
			const found = threads.find((t) => t.id === this.activeThreadId);
			if (found) {
				return found;
			}
		}
		const created = threads[0] ?? await this.createThread();
		this.activeThreadId = created.id;
		return created;
	}

	/** Bound chats reuse `threadId`. Welcome / first send creates a new Mastra + session_meta row. */
	async beginChat(threadId?: string): Promise<MemoryThread> {
		const id = String(threadId || '').trim();
		if (id) {
			this.setActiveThread(id);
			const threads = await this.listThreads();
			const found = threads.find((item) => item.id === id);
			if (found) {
				return found;
			}
			const extra = await this.sessions.get(id);
			if (extra) {
				return {
					id,
					title: extra.title || 'Untitled',
					resource: RESOURCE,
					createdAt: extra.createdAt || extra.updatedAt,
					updatedAt: extra.updatedAt,
					pinned: extra.pinned,
					snippet: extra.snippet,
				};
			}
		}
		return this.createThread();
	}

	setActiveThread(threadId: string): void {
		this.activeThreadId = threadId;
	}

	async touchThread(threadId: string, snippet?: string): Promise<void> {
		const id = String(threadId || '').trim();
		if (!id) {
			return;
		}
		await this.ready;
		await this.sessions.touch(id, snippet);
		if (snippet) {
			await this.ensureThreadTitle(id, snippet);
		}
	}

	private async ensureThreadTitle(threadId: string, prompt?: string): Promise<void> {
		const extra = await this.sessions.get(threadId);
		if (extra && !isPlaceholderSessionTitle(extra.title)) {
			return;
		}
		let title = '';
		if (this.memory?.recall) {
			try {
				const recalled = await this.memory.recall({
					threadId,
					resourceId: RESOURCE,
					perPage: 20,
					page: 0,
				});
				const users = (Array.isArray(recalled?.messages) ? recalled.messages : [])
					.map((item: unknown) => toHistoryMessage(item))
					.filter((item: ThreadHistoryMessage | undefined): item is ThreadHistoryMessage => item?.role === 'user' && Boolean(item.text));
				users.sort((a: ThreadHistoryMessage, b: ThreadHistoryMessage) => a.createdAt - b.createdAt);
				title = titleFromFirstPrompt(users[0]?.text || '');
			} catch {
				/* first user line is optional */
			}
		}
		if (!title) {
			title = titleFromFirstPrompt(prompt || extra?.snippet || '');
		}
		if (!title) {
			return;
		}
		await this.sessions.upsert({
			id: threadId,
			title,
			pinned: extra?.pinned,
			snippet: extra?.snippet,
			createdAt: extra?.createdAt,
			updatedAt: extra?.updatedAt,
		});
		await tryUpdateMastraTitle(this.memory, threadId, title);
	}

	async purgeStaleThreads(): Promise<{ deleted: string[]; ttlDays: number }> {
		await this.ready;
		const settings = await this.store.read();
		this.settings = settings;
		const ttlDays = settings.sessionTtlDays;
		const cutoff = Date.now() - ttlDays * 24 * 60 * 60 * 1000;
		const threads = await this.listThreads();
		const deleted: string[] = [];
		for (const thread of threads) {
			if (thread.pinned || thread.updatedAt <= 0 || thread.updatedAt >= cutoff) {
				continue;
			}
			await this.deleteThread(thread.id);
			deleted.push(thread.id);
		}
		if (deleted.length > 0) {
			this.exporter.pushLog('info', `Purged ${deleted.length} session(s) older than ${ttlDays} days`);
		}
		return { deleted, ttlDays };
	}

	async listThreadHistory(
		threadId: string,
		opts: { limit?: number; before?: number; beforeId?: string } = {},
	): Promise<ThreadHistoryPage> {
		await this.ready;
		const id = String(threadId || '').trim();
		if (!id || !this.memory?.recall) {
			return { messages: [], hasMore: false };
		}
		const limit = Math.max(1, Math.min(Math.floor(opts.limit ?? 2), 100));
		const before = typeof opts.before === 'number' && opts.before > 0 ? opts.before : undefined;
		const beforeId = typeof opts.beforeId === 'string' && opts.beforeId.trim() ? opts.beforeId.trim() : undefined;
		const batchSize = Math.min(Math.max(limit * 4, 16), 80);

		let displayable: ThreadHistoryMessage[] = [];
		let cursor = before;
		let storageHasMore = false;

		for (let page = 0; page < 8 && displayable.length < limit; page += 1) {
			let recalled: { messages?: unknown[]; hasMore?: boolean };
			try {
				recalled = await this.memory.recall({
					threadId: id,
					resourceId: RESOURCE,
					perPage: batchSize,
					page: 0,
					filter: cursor != null
						? { dateRange: { end: new Date(cursor), endExclusive: true } }
						: undefined,
				});
			} catch {
				return { messages: [], hasMore: false };
			}

			const raw = Array.isArray(recalled.messages) ? recalled.messages : [];
			storageHasMore = Boolean(recalled.hasMore);
			const seen = new Set(displayable.map((item) => item.id));
			const mapped = raw
				.map((item) => toHistoryMessage(item))
				.filter((item): item is ThreadHistoryMessage => {
					if (!item) {
						return false;
					}
					if (beforeId && item.id === beforeId) {
						return false;
					}
					return !seen.has(item.id);
				});
			displayable = [...mapped, ...displayable];

			if (raw.length === 0) {
				storageHasMore = false;
				break;
			}
			const oldestRawAt = toMs((raw[0] as { createdAt?: unknown }).createdAt);
			if (cursor != null && oldestRawAt >= cursor) {
				break;
			}
			cursor = oldestRawAt;
			if (!recalled.hasMore) {
				storageHasMore = false;
				break;
			}
		}

		const extra = displayable.length > limit;
		return {
			messages: displayable.slice(-limit),
			hasMore: extra || storageHasMore,
		};
	}

	emitActivity(event: ChatActivity): void {
		this.activitySink?.({
			...event,
			detail: event.detail ? toDisplayText(event.detail) : '',
			name: toDisplayText(event.name) || String(event.name || 'tool'),
		});
	}

	async withActivity<T>(sink: (event: ChatActivity) => void, fn: () => Promise<T>): Promise<T> {
		const prev = this.activitySink;
		this.activitySink = sink;
		try {
			return await fn();
		} finally {
			this.activitySink = prev;
		}
	}

	async withHitl<T>(ask: (req: HitlAsk) => Promise<boolean>, fn: () => Promise<T>): Promise<T> {
		const prev = this.hitlAsk;
		let chain = Promise.resolve();
		this.hitlAsk = (req) => {
			const run = chain.then(() => ask(req));
			chain = run.then(() => undefined, () => undefined);
			return run;
		};
		try {
			return await fn();
		} finally {
			this.hitlAsk = prev;
		}
	}

	private toolExecOptions(extra?: Partial<ExecuteToolOptions>): ExecuteToolOptions {
		return {
			rules: this.playbooks.listRules(),
			impliedTargets: currentToolContext()?.impliedTargets ?? this.impliedTargets,
			persist: (patch) => this.persistServicePatch(patch),
			persistEnginePath: async (podmanPath) => {
				this.settings = await this.store.write({ podmanPath });
			},
			onActivity: (event) => this.emitActivity(event),
			askHitl: this.hitlAsk ? (req) => this.hitlAsk!(req) : undefined,
			knowledge: this.knowledge,
			findings: this.findings,
			reports: this.reports,
			approvals: this.approvals,
			sessionId: this.activeThreadId,
			runId: this.engagement.current()?.runId,
			...extra,
		};
	}

	private async chatTitleFor(sessionId?: string): Promise<string> {
		const id = String(sessionId || this.activeThreadId || '').trim();
		if (!id) {
			return '';
		}
		try {
			const meta = await this.sessions.get(id);
			const title = String(meta?.title || '').trim();
			if (isPlaceholderSessionTitle(title)) {
				return '';
			}
			return title;
		} catch {
			return '';
		}
	}

	private agentMemory(threadId: string, readOnly?: boolean, skipRecall?: boolean) {
		return mastraMemoryOptions(threadId, RESOURCE, { readOnly, skipRecall });
	}

	private providerApiKey(): string {
		return resolveProviderApiKey(this.settings.provider, this.settings.apiKey);
	}

	async streamAgent(
		agentId: string,
		prompt: string,
		threadId: string,
		onDelta: (text: string) => void,
		opts?: { readOnlyMemory?: boolean; skipResume?: boolean; maxSteps?: number },
	): Promise<string> {
		await this.ready;
		await this.touchThread(threadId, prompt);
		this.setActiveThread(threadId);
		loadDotenvFiles([this.store.extensionPath, path.dirname(this.store.extensionPath)]);
		const settings = await this.store.read();
		this.settings = settings;
		applyProviderEnv(this.settings.provider, this.settings.apiKey, this.settings.baseUrl);
		this.assertProviderCredentials();
		if (!opts?.readOnlyMemory && !opts?.skipResume && isResumeIntent(prompt)) {
			const resumed = await this.tryResumeEngagement(threadId);
			if (resumed != null) {
				onDelta(resumed);
				return resumed;
			}
		}
		const { formatEngagementScopeContext, resolveImpliedTargets } = await import('./policy');
		const implied = resolveImpliedTargets(prompt, settings.scope);
		this.impliedTargets = implied.targets;
		this.impliedTargetDepth += 1;
		const restoredPrompt = restoreTargetPlaceholders(prompt, implied.targets);
		const scopeContext = restoreTargetPlaceholders(formatEngagementScopeContext(settings.scope, implied), implied.targets);
		const skipRag = agentId === 'reporting' || agentId === 'validation';
		const ragHits = skipRag || !this.knowledge
			? []
			: await this.knowledge.search(restoredPrompt, { topK: 8, threadId }).catch(() => []);
		const ragContext = skipRag ? '' : formatRagContext(ragHits, threadId);
		const role = AGENT_ROLES.find((item) => item.id === agentId);
		const instructions = restoreTargetPlaceholders(`${this.prompts.instructionsFor(
			agentId,
			role?.name ?? agentId,
			role?.role ?? '',
		)}\n\n${scopeContext}${ragContext ? `\n\n${ragContext}` : ''}`, implied.targets);
		const context = sanitizeProviderMessages([
			{ role: 'system' as const, content: scopeContext },
			...(ragContext ? [{ role: 'system' as const, content: ragContext }] : []),
		]);
		return toolExecContext.run({ impliedTargets: implied.targets, readOnlyMemory: opts?.readOnlyMemory, lastProbes: [] }, async () => {
		try {
			this.emitActivity({
				type: 'agent',
				name: agentId,
				detail: agentId,
				status: 'ok',
			});
			const agent = this.mastra.getAgentById(agentId);
			const streamOptions = {
				maxSteps: opts?.maxSteps ?? 8,
				memory: this.agentMemory(threadId, opts?.readOnlyMemory, skipRag),
				instructions,
				context,
				...this.reasoningStreamOptions(),
				delegation: {
					messageFilter: ({ messages }: { messages: unknown[] }) => sanitizeProviderMessages(messages),
					onDelegationStart: async (context: { primitiveId: string }) => {
						this.exporter.pushLog('info', `delegate → ${context.primitiveId}`);
						this.emitActivity({
							type: 'tool:start',
							name: context.primitiveId,
							detail: `delegate → ${context.primitiveId}`,
							status: 'start',
						});
						this.emitActivity({
							type: 'tool:done',
							name: context.primitiveId,
							detail: `delegate → ${context.primitiveId}`,
							status: 'ok',
						});
						return { proceed: true };
					},
					// Mastra maps the delegation tool result to `result.text ?? ''`; a
					// sub-agent that ends on a tool call has no final text, and the
					// empty string becomes a Cohere tool_results-without-outputs 400.
					onDelegationComplete: async (context: {
						primitiveId: string;
						result?: { text?: string; subAgentToolResults?: unknown[] };
					}) => {
						const text = context.result?.text ?? '';
						if (text.trim()) {
							return undefined;
						}
						const calls = Array.isArray(context.result?.subAgentToolResults)
							? context.result.subAgentToolResults.length
							: 0;
						this.exporter.pushLog('warn', `delegate → ${context.primitiveId} returned no summary text`);
						return {
							resultText: `[${context.primitiveId}] finished with no summary text (${calls} tool call${calls === 1 ? '' : 's'} ran). Treat the sub-agent tool outputs as the evidence.`,
						};
					},
				},
			};
			let stream = await agent.stream(restoredPrompt, streamOptions);
			let collected = '';
			const result = await consumeAgentStream(stream, onDelta, (event) => this.emitActivity(event));
			collected += result.text;
			if (!result.suspended) {
				if (!opts?.readOnlyMemory) {
					void this.ingestChatTurn(threadId, restoredPrompt, collected);
				}
				await this.touchThread(threadId, collected || restoredPrompt);
				return collected;
			}
			this.exporter.pushLog('warn', `Ignoring Mastra suspend (${result.suspended.toolName || result.suspended.payload.kind}); approval is IPC-only.`);
			const fallback = collected || 'Operator approval uses the in-app dialog. The model suspend/resume path is disabled so Approve cannot crash the app. Retry the probe if it did not run.';
			if (!opts?.readOnlyMemory) {
				void this.ingestChatTurn(threadId, restoredPrompt, fallback);
			}
			await this.touchThread(threadId, fallback);
			return fallback;
		} catch (error) {
			throw new Error(formatChatError(error));
		} finally {
			this.impliedTargetDepth = Math.max(0, this.impliedTargetDepth - 1);
			if (this.impliedTargetDepth === 0) {
				this.impliedTargets = [];
			}
		}
		});
	}

	async runSpecialistsParallel(
		jobs: Array<{ agentId: string; prompt: string }>,
		threadId: string,
		mode: 'parallel' | 'sequential' = 'parallel',
	): Promise<Array<{ agentId: string; text: string; error?: string }>> {
		const seen = new Set<string>();
		const work = jobs
			.map((job) => ({
				agentId: String(job.agentId || '').trim(),
				prompt: String(job.prompt || '').trim(),
			}))
			.filter((job) => {
				if (!job.agentId || job.agentId === 'orchestrator' || !job.prompt || seen.has(job.agentId)) {
					return false;
				}
				seen.add(job.agentId);
				return AGENT_ROLES.some((role) => role.id === job.agentId);
			})
			.slice(0, 6);
		const runOne = async (job: { agentId: string; prompt: string }) => {
			try {
				const text = await this.streamAgent(job.agentId, job.prompt, threadId, () => {}, { readOnlyMemory: true, maxSteps: 8 });
				return { agentId: job.agentId, text };
			} catch (error) {
				return {
					agentId: job.agentId,
					text: '',
					error: formatChatError(error),
				};
			}
		};
		if (mode === 'sequential') {
			const out: Array<{ agentId: string; text: string; error?: string }> = [];
			for (const job of work) {
				out.push(await runOne(job));
			}
			return out;
		}
		return Promise.all(work.map((job) => runOne(job)));
	}

	async tryResumeEngagement(threadId: string): Promise<string | undefined> {
		await this.ready;
		this.setActiveThread(threadId);
		const checkpoint = await this.sessions.getEngagement(threadId);
		if (!checkpoint || checkpoint.status === 'done' || !checkpoint.workflowId) {
			return undefined;
		}
		const def = this.playbooks.getWorkflow(checkpoint.workflowId);
		if (!def?.enabled) {
			return undefined;
		}
		const input: Record<string, unknown> = {
			...checkpoint.input,
			target: checkpoint.target || checkpoint.input.target,
			message: checkpoint.input.message || checkpoint.target,
		};
		await this.persistThreadMessages(threadId, [{ role: 'user', content: 'retry' }]);
		return this.runWorkflow(def.id, input, {
			threadId,
			resume: {
				skipStepIds: checkpoint.completedStepIds || [],
				retryStepId: checkpoint.failedStepId,
			},
			skipPersistUser: true,
		});
	}

	async runWorkflow(
		workflowKey: string,
		input: Record<string, unknown>,
		opts?: {
			threadId?: string;
			resume?: { skipStepIds: string[]; retryStepId?: string };
			skipPersistUser?: boolean;
		},
	): Promise<string> {
		await this.ready;
		const def = this.playbooks.getWorkflow(workflowKey);
		if (!def) {
			throw new Error(`Unknown workflow: ${workflowKey}`);
		}
		if (!def.enabled) {
			throw new Error(`Workflow ${def.id} is disabled.`);
		}
		if (workflowHasExploitStep(def.steps)) {
			throw new Error(`Workflow ${def.id} contains a refused exploit step. Proof runs through the sanctioned poc-* validators.`);
		}
		if (opts?.threadId) {
			this.setActiveThread(opts.threadId);
		}
		const thread = await this.ensureThread();
		const hint = String(input.message || input.target || input.filePath || input.pcapPath || def.name);
		await this.touchThread(thread.id, hint);
		loadDotenvFiles([this.store.extensionPath, path.dirname(this.store.extensionPath)]);
		const settings = await this.store.read();
		this.settings = settings;
		applyProviderEnv(this.settings.provider, this.settings.apiKey, this.settings.baseUrl);
		const decision = evaluatePlaybookRules(this.playbooks.listRules(), def, settings);
		if (!decision.ok) {
			throw new Error(decision.reason);
		}
		const userLine = `/${def.id} ${hint}`.trim();
		if (!opts?.skipPersistUser) {
			await this.persistThreadMessages(thread.id, [{ role: 'user', content: userLine }]);
		}
		await this.syncEngagementWorkingMemory(thread.id, {
			target: String(input.target || hint),
			workflowId: def.id,
			status: 'running',
			lastStep: opts?.resume?.retryStepId,
		});
		this.emitActivity({
			type: 'agent',
			name: def.id,
			detail: opts?.resume ? `resume ${def.name}` : def.name,
			status: 'ok',
		});
		const run = () => this.runSequentialSteps(def, input, [], '', {
			threadId: thread.id,
			skipStepIds: opts?.resume?.skipStepIds,
			retryStepId: opts?.resume?.retryStepId,
		});
		try {
			const output = decision.maxTimeoutMs ? await withDeadline(run(), decision.maxTimeoutMs) : await run();
			await this.persistThreadMessages(thread.id, [{ role: 'assistant', content: output || '(empty workflow)' }]);
			return output;
		} catch (error) {
			const message = formatChatError(error);
			await this.persistThreadMessages(thread.id, [{ role: 'assistant', content: message }]);
			throw error;
		}
	}

	async runSequentialSteps(
		def: WorkflowRecord,
		input: Record<string, unknown>,
		stack: string[] = [],
		priorEvidence = '',
		resume?: { threadId?: string; skipStepIds?: string[]; retryStepId?: string },
	): Promise<string> {
		if (stack.includes(def.id)) {
			return `Skipped nested ${def.id} (cycle).`;
		}
		if (stack.length > 4) {
			return 'Workflow nesting exceeded.';
		}
		if (workflowHasExploitStep(def.steps)) {
			return `Refused: ${def.id} contains an exploit step. Proof runs through the sanctioned poc-* validators (HITL-gated, non-destructive).`;
		}
		const settings = await this.store.read();
		const decision = evaluatePlaybookRules(this.playbooks.listRules(), def, settings);
		if (!decision.ok) {
			return `Rule denied: ${decision.reason}`;
		}
		const { evaluateScope, resolveImpliedTargets } = await import('./policy');
		const blob = String(input.message || input.target || '');
		const implied = resolveImpliedTargets(blob, settings.scope);
		const canonical = extractCanonicalTarget(blob, settings.scope);
		const workflowTarget = canonical?.display || fillImpliedToolTarget(
			'httpx',
			typeof input.target === 'string' ? input.target : undefined,
			implied.targets,
			settings.scope,
		);
		if (workflowTarget) {
			const scope = evaluateScope(settings.scope, workflowTarget);
			if (!scope.allow) {
				return `Policy denied: ${scope.reason}`;
			}
		}
		const stepInput: Record<string, unknown> = {
			...input,
			target: workflowTarget || input.target,
			message: input.message || blob,
			portRange: typeof input.portRange === 'string'
				? input.portRange
				: (canonical?.port ? String(canonical.port) : undefined),
		};
		const nextStack = [...stack, def.id];
		let prior = priorEvidence;
		const threadId = resume?.threadId || this.activeThreadId || '';
		if (stack.length === 0 && threadId && !prior.trim()) {
			prior = await this.recallPlaybookPrior(threadId, String(stepInput.message || ''));
		}
		const skip = new Set(resume?.skipStepIds || []);
		const retryStepId = resume?.retryStepId;
		const track = stack.length === 0
			? this.engagement.begin(
				def,
				String(workflowTarget || input.target || input.message || def.name),
				new Map(this.playbooks.listWorkflows().map((item) => [item.id, item.name])),
			)
			: undefined;
		const adapted = adaptWorkflowSteps(def.id, def.steps, typeof stepInput.target === 'string' ? stepInput.target : blob);
		const completedStepIds = adapted.filter((step) => skip.has(step.id) && step.id !== retryStepId).map((step) => step.id);
		const writeCheckpoint = async (status: EngagementCheckpoint['status'], failedStepId?: string) => {
			if (stack.length > 0 || !threadId) {
				return;
			}
			await this.sessions.setEngagement(threadId, {
				workflowId: def.id,
				workflowName: def.name,
				target: String(workflowTarget || input.target || input.message || ''),
				input: stepInput,
				completedStepIds: [...completedStepIds],
				failedStepId,
				status,
				updatedAt: Date.now(),
			});
		};
		if (stack.length === 0 && threadId) {
			await writeCheckpoint('running', retryStepId);
			await this.syncEngagementWorkingMemory(threadId, {
				target: String(workflowTarget || input.target || ''),
				workflowId: def.id,
				status: 'running',
				lastStep: retryStepId,
			});
		}
		const nestedResume = resume ? { threadId, skipStepIds: resume.skipStepIds, retryStepId: resume.retryStepId } : { threadId };
		const runStep = async (step: WorkflowStep): Promise<string> => {
			if (skip.has(step.id) && step.id !== retryStepId) {
				track?.phaseDone(step.id, 'already completed');
				return `## ${step.id}\nAlready completed earlier in this engagement.`;
			}
			track?.phaseStart(step.id);
			try {
				const output = await this.runWorkflowStep(def, step, stepInput, workflowTarget, implied.targets, settings, nextStack, prior, nestedResume);
				track?.phaseDone(step.id);
				if (!completedStepIds.includes(step.id)) {
					completedStepIds.push(step.id);
				}
				await writeCheckpoint('running');
				if (threadId) {
					await this.syncEngagementWorkingMemory(threadId, {
						target: String(workflowTarget || input.target || ''),
						workflowId: def.id,
						status: 'running',
						lastStep: step.id,
					});
				}
				return output;
			} catch (error) {
				const detail = formatChatError(error);
				track?.phaseFailed(step.id, detail);
				this.exporter.pushLog('warn', `playbook ${def.id} step ${step.id}: ${detail}`);
				if (!completedStepIds.includes(step.id)) {
					completedStepIds.push(step.id);
				}
				if (isEngagementWorkflow(def.id) || nextStack.includes('full-engagement')) {
					await writeCheckpoint('running');
					if (threadId) {
						await this.syncEngagementWorkingMemory(threadId, {
							target: String(workflowTarget || input.target || ''),
							workflowId: def.id,
							status: 'running',
							lastStep: step.id,
							openQuestion: detail,
						});
					}
					return `## ${step.id}\n${detail}`;
				}
				await writeCheckpoint('failed', step.id);
				if (threadId) {
					await this.syncEngagementWorkingMemory(threadId, {
						target: String(workflowTarget || input.target || ''),
						workflowId: def.id,
						status: 'failed',
						lastStep: step.id,
						openQuestion: detail,
					});
				}
				throw error;
			}
		};
		let ok = true;
		try {
			const parts: string[] = [];
			for (const batch of groupIndependentSteps(adapted)) {
				const pocBatch = batch.length > 1 && batch.every((step) => step.kind === 'agent' && isPocPlaybookAgent(step.id));
				const rows = pocBatch
					? await this.runPocAgentsParallel(def, batch, stepInput, workflowTarget, implied.targets, settings, prior, threadId)
					: batch.length === 1
						? [await runStep(batch[0])]
						: await Promise.all(batch.map((step) => runStep(step)));
				parts.push(...rows);
				prior = [prior, ...rows].filter(Boolean).join('\n\n').slice(-16_000);
			}
			await writeCheckpoint('done');
			if (threadId) {
				await this.syncEngagementWorkingMemory(threadId, {
					target: String(workflowTarget || input.target || ''),
					workflowId: def.id,
					status: 'done',
					lastStep: completedStepIds[completedStepIds.length - 1],
				});
			}
			return parts.join('\n\n') || '(empty workflow)';
		} catch (error) {
			ok = false;
			throw error;
		} finally {
			track?.finish(ok);
		}
	}

	private async runWorkflowStep(
		def: WorkflowRecord,
		step: WorkflowStep,
		input: Record<string, unknown>,
		workflowTarget: string | undefined,
		impliedTargets: string[],
		settings: HawaldarSettings,
		nextStack: string[],
		prior: string,
		resume?: { threadId?: string; skipStepIds?: string[]; retryStepId?: string },
	): Promise<string> {
			if (step.kind === 'workflow') {
				const child = this.playbooks.getWorkflow(step.id);
				if (!child) {
					return `## workflow:${step.id}\nUnknown workflow.`;
				}
				if (!child.enabled) {
					return `## workflow:${step.id}\nDisabled.`;
				}
				const nested = await this.runSequentialSteps(child, {
					...input,
					message: String(input.message || input.target || child.name),
				}, nextStack, prior, resume);
				return `## workflow:${child.id}\n${nested}`;
			}
			if (step.kind === 'tool') {
				const skip = skipReasonForTool(step.id, typeof input.target === 'string' ? input.target : workflowTarget, impliedTargets);
				if (skip) {
					return `## ${step.id}\n${skip}`;
				}
				const focusedPort = focusedPortForLocalScan(
					step.id,
					typeof input.target === 'string' ? input.target : workflowTarget,
					impliedTargets,
				);
				const stepTarget = typeof input.target === 'string' ? input.target : workflowTarget;
				const probeUrl = playbookStepUrl(
					step.id,
					stepTarget,
					typeof input.url === 'string' ? input.url : undefined,
				);
				const sqlmap = step.id === 'sqlmap-scan' ? playbookSqlmapOptions(stepTarget) : undefined;
				try {
					const result = await executeTool(settings, step.id, {
						target: fillImpliedToolTarget(
							step.id,
							typeof input.target === 'string' ? input.target : workflowTarget,
							impliedTargets,
							settings.scope,
						),
						url: fillImpliedToolTarget(
							step.id,
							probeUrl || (typeof input.url === 'string' ? input.url : (typeof input.target === 'string' ? input.target : workflowTarget)),
							impliedTargets,
							settings.scope,
						),
						filePath: typeof input.filePath === 'string' ? input.filePath : undefined,
						pcapPath: typeof input.pcapPath === 'string' ? input.pcapPath : undefined,
						functionName: typeof input.functionName === 'string' ? input.functionName : undefined,
						address: typeof input.address === 'string' ? input.address : undefined,
						topPorts: typeof input.topPorts === 'number' ? input.topPorts : undefined,
						portRange: typeof input.portRange === 'string'
							? input.portRange
							: (focusedPort ? String(focusedPort) : undefined),
						scanType: typeof input.scanType === 'string' ? input.scanType : undefined,
						streamIndex: typeof input.streamIndex === 'number' ? input.streamIndex : undefined,
						streamProto: input.streamProto === 'udp' ? 'udp' : input.streamProto === 'tcp' ? 'tcp' : undefined,
						limit: typeof input.limit === 'number' ? input.limit : undefined,
						query: typeof input.query === 'string' ? input.query : undefined,
						module: typeof input.module === 'string' ? input.module : undefined,
						port: typeof input.port === 'number' ? input.port : focusedPort,
						engine: typeof input.engine === 'string' ? input.engine : undefined,
						types: Array.isArray(input.types) ? input.types.filter((item): item is string => typeof item === 'string') : undefined,
						nameserver: typeof input.nameserver === 'string' ? input.nameserver : undefined,
						level: sqlmap?.level ?? (typeof input.level === 'number' ? input.level : undefined),
						risk: sqlmap?.risk ?? (typeof input.risk === 'number' ? input.risk : undefined),
						forms: sqlmap?.forms ?? (typeof input.forms === 'boolean' ? input.forms : undefined),
						technique: typeof input.technique === 'string' ? input.technique : undefined,
					}, this.toolExecOptions({
						workflow: def,
						impliedTargets,
						chatTitle: await this.chatTitleFor(resume?.threadId || this.activeThreadId),
					}));
					return `## ${step.id}\n${toolOutputText(result)}`;
				} catch (error) {
					const detail = formatChatError(error);
					this.exporter.pushLog('warn', `playbook ${def.id} tool ${step.id}: ${detail}`);
					return `## ${step.id}\n${detail}`;
				}
			}
			const threadId = resume?.threadId || (await this.ensureThread()).id;
			const message = engagementAgentPrompt({
				workflowId: def.id,
				agentId: step.id,
				target: typeof input.target === 'string' ? input.target : workflowTarget,
				message: typeof input.message === 'string' ? input.message : undefined,
				filePath: typeof input.filePath === 'string' ? input.filePath : undefined,
				prior,
			});
			const maxSteps = isPocPlaybookAgent(step.id) || step.id === 'reporting' || step.id === 'validation' ? 8 : 4;
			try {
				let text = await this.streamAgent(step.id, message, threadId, () => {}, {
					skipResume: true,
					readOnlyMemory: true,
					maxSteps,
				});
				let output = sanitizePlaybookAgentOutput(text || '', step.id);
				if (isEmptyPlaybookOutput(output) && isPocPlaybookAgent(step.id)) {
					this.exporter.pushLog('warn', `playbook ${def.id} agent ${step.id} returned empty — retrying once`);
					text = await this.streamAgent(step.id, `${message}\n\nYour previous turn returned no tool calls. Call the bounded probe now.`, threadId, () => {}, {
						skipResume: true,
						readOnlyMemory: true,
						maxSteps,
					});
					output = sanitizePlaybookAgentOutput(text || '', step.id);
				}
				if (isEmptyPlaybookOutput(output) && isPocPlaybookAgent(step.id)) {
					output = await this.runPocFallback(step.id, typeof input.target === 'string' ? input.target : workflowTarget, settings, impliedTargets, prior);
				}
				if (step.id === 'reporting') {
					const findings = await this.findings.list({ sessionId: threadId });
					const table = formatFindingsChatTable(findings);
					const exportNote = findings.length
						? `finding-export wrote the PDF artifact under ~/.hawaldar/workspace/reports. The table above is this chat's findings store.`
						: '';
					output = gateReportingNarrative(output, prior, table, exportNote);
				}
				return `## agent:${step.id}\n${output}`;
			} catch (error) {
				const detail = formatChatError(error);
				this.exporter.pushLog('warn', `playbook ${def.id} agent ${step.id}: ${detail}`);
				if (isMissingToolHallucination(detail)) {
					return `## agent:${step.id}\n${sanitizePlaybookAgentOutput(detail, step.id)}`;
				}
				return `## agent:${step.id}\n${detail}`;
			}
	}

	private async runPocAgentsParallel(
		def: WorkflowRecord,
		batch: WorkflowStep[],
		input: Record<string, unknown>,
		workflowTarget: string | undefined,
		impliedTargets: string[],
		settings: HawaldarSettings,
		prior: string,
		threadId: string,
	): Promise<string[]> {
		const jobs = batch.map((step) => ({
			agentId: step.id,
			prompt: engagementAgentPrompt({
				workflowId: def.id,
				agentId: step.id,
				target: typeof input.target === 'string' ? input.target : workflowTarget,
				message: typeof input.message === 'string' ? input.message : undefined,
				filePath: typeof input.filePath === 'string' ? input.filePath : undefined,
				prior,
			}),
		}));
		let results = await this.runSpecialistsParallel(jobs, threadId, 'parallel');
		const empty = results.filter((row) => isEmptyPlaybookOutput(row.text) && !row.error);
		if (empty.length > 0) {
			this.exporter.pushLog('warn', `poc-validate empty agents retry: ${empty.map((row) => row.agentId).join(', ')}`);
			const retried = await this.runSpecialistsParallel(
				empty.map((row) => ({
					agentId: row.agentId,
					prompt: `${jobs.find((job) => job.agentId === row.agentId)?.prompt || ''}\n\nYour previous turn returned no tool calls. Call the bounded probe now.`,
				})),
				threadId,
				'parallel',
			);
			results = results.map((row) => retried.find((item) => item.agentId === row.agentId) ?? row);
		}
		const out: string[] = [];
		for (const row of results) {
			let text = sanitizePlaybookAgentOutput(row.error || row.text || '', row.agentId);
			if (isEmptyPlaybookOutput(text)) {
				text = await this.runPocFallback(
					row.agentId,
					typeof input.target === 'string' ? input.target : workflowTarget,
					settings,
					impliedTargets,
					prior,
				);
			}
			out.push(`## agent:${row.agentId}\n${text}`);
		}
		return out;
	}

	private async runPocFallback(
		agentId: string,
		target: string | undefined,
		settings: HawaldarSettings,
		impliedTargets: string[],
		prior: string,
	): Promise<string> {
		if (agentId === 'poc-ssrf') {
			const hypotheses = await this.findings.list({ vulnClass: 'ssrf', status: 'hypothesis' });
			if (hypotheses.length === 0) {
				return 'No SSRF hypothesis in this run. No probe invented.';
			}
		}
		const job = pocFallbackJob(agentId, target);
		if (!job) {
			return '(empty)';
		}
		this.exporter.pushLog('warn', `poc fallback: ${agentId} → ${job.toolId} ${job.method || ''} ${job.url}`);
		try {
			const result = await executeTool(settings, job.toolId, {
				url: job.url,
				target: job.url,
				method: job.method,
				body: job.body,
				payload: job.payload,
			}, this.toolExecOptions({ impliedTargets, sourceAgentId: agentId }));
			const stdout = toolOutputText(result);
			const sqlmapNote = /## sqlmap-scan\b/i.test(prior) ? 'sqlmap-scan already ran this turn (cite that output).' : '';
			await this.findings.upsert({
				title: agentId === 'poc-injection'
					? 'Injection probe: POST /rest/user/login'
					: agentId === 'poc-xss'
						? 'XSS canary on search'
						: 'Auth probe: GET /rest/admin',
				vulnClass: agentId === 'poc-injection' ? 'injection' : agentId === 'poc-xss' ? 'xss' : 'auth',
				severity: 'info',
				status: 'not-exploitable',
				target: job.url,
				steps: [`${job.method || 'GET'} ${job.url}`],
				evidence: [sqlmapNote, stdout].filter(Boolean).join('\n\n').slice(0, 8_000),
				request: { method: job.method, url: job.url, body: job.body, tool: job.toolId },
				source: agentId,
			}).catch(() => undefined);
			return `Runtime ran ${job.toolId} after empty LLM turn.\n${stdout}`;
		} catch (error) {
			return `Fallback ${job.toolId} failed: ${formatChatError(error)}`;
		}
	}

	onEngagement(listener: (run: EngagementRun) => void): () => void {
		return this.engagement.onChange(listener);
	}

	engagementState(): EngagementRun | undefined {
		return this.engagement.current();
	}

	onFindingsChanged(listener: () => void): () => void {
		return this.findings.onChange(listener);
	}

	onReportsChanged(listener: () => void): () => void {
		return this.reports.onChange(listener);
	}

	async listFindings(filter?: FindingFilter) {
		await this.ready;
		return this.findings.list(filter);
	}

	async removeFinding(id: string): Promise<void> {
		await this.ready;
		await this.findings.remove(id);
	}

	async clearFindings(): Promise<number> {
		await this.ready;
		return this.findings.clear();
	}

	async clearHitlApprovals(): Promise<number> {
		await this.ready;
		return this.approvals.clear();
	}

	async exportFindingsReport(input?: {
		title?: string;
		target?: string;
		sessionId?: string;
		runId?: string;
		query?: string;
	}) {
		await this.ready;
		const implied = this.impliedTargets;
		const target = restoreTargetPlaceholders(input?.target?.trim() || implied[0] || '', implied);
		const sessionId = input?.sessionId?.trim() || '';
		const runId = input?.runId?.trim() || this.engagement.current()?.runId || '';
		const rows = await this.findings.list({
			sessionId: sessionId || undefined,
			runId: runId || undefined,
			target: target || undefined,
			query: input?.query,
		});
		const chatTitle = await this.chatTitleFor(sessionId);
		const saved = await persistFindingsPdf({
			store: this.findings,
			reports: this.reports,
			findings: rows,
			title: input?.title?.trim() || 'Engagement report',
			target,
			sessionId,
			chatTitle,
			runId,
			query: input?.query || target,
			implied,
		});
		return { ...saved, table: formatFindingsChatTable(rows) };
	}

	async listReports(filter?: ReportFilter) {
		await this.ready;
		return this.reports.list(filter);
	}

	async readReport(id: string): Promise<Uint8Array> {
		await this.ready;
		return this.reports.readBytes(id);
	}

	async removeReport(id: string): Promise<void> {
		await this.ready;
		await this.reports.remove(id);
	}

	async createFindingsReport(filter: {
		title?: string;
		target?: string;
		sessionId?: string;
		runId?: string;
		query?: string;
	} = {}) {
		return this.exportFindingsReport(filter);
	}

	async informFinding(id: string): Promise<FindingRecord> {
		await this.ready;
		const existing = await this.findings.get(id);
		if (!existing) {
			throw new Error(`Unknown finding: ${id}`);
		}
		const allowed = existing.status === 'confirmed'
			|| (existing.status === 'unconfirmed' && Boolean(existing.evidence));
		if (!allowed) {
			throw new Error('Inform is available after a confirmed finding (or unconfirmed with evidence).');
		}
		return this.findings.upsert({
			id: existing.id,
			status: 'informed',
			informedAt: Date.now(),
		});
	}

	async retestFinding(id: string) {
		await this.ready;
		const existing = await this.findings.get(id);
		if (!existing) {
			throw new Error(`Unknown finding: ${id}`);
		}
		const tool = resolveRetestTool(existing);
		const input = retestToolInput(existing);
		if (!tool || !input) {
			throw new Error('This finding has no stored poc-request / poc-act / poc-xss-canary / sqlmap-scan to replay.');
		}
		const settings = await this.store.read();
		this.settings = settings;
		const impliedTargets = [existing.target, existing.request?.url].filter((item): item is string => Boolean(item));
		const result = asProbeRunResult(await toolExecContext.run({ impliedTargets, lastProbes: [] }, () => executeTool(settings, tool, input, this.toolExecOptions({
			sourceAgentId: 'retest',
			sessionId: existing.sessionId || this.activeThreadId,
			runId: this.engagement.current()?.runId || existing.runId,
			impliedTargets,
		}))));
		const judged = evaluateRetest(existing, result);
		if (judged.verdict === 'aborted') {
			return {
				ok: false,
				verdict: judged.verdict,
				reason: judged.reason,
				id: existing.id,
				status: existing.status,
				offerReport: false,
			};
		}
		const evidence = appendRetestEvidence(existing.evidence, String(result.stdout || judged.reason), judged.verdict);
		const status = judged.verdict === 'fixed'
			? 'fixed' as const
			: (existing.status === 'informed' ? 'informed' as const : 'confirmed' as const);
		const record = await this.findings.upsert({
			id: existing.id,
			status,
			evidence,
			request: mergeRetestRequest(existing.request, String(result.stdout || '')),
			sessionId: existing.sessionId,
			runId: existing.runId,
		});
		return {
			ok: true,
			verdict: judged.verdict,
			reason: judged.reason,
			id: record.id,
			status: record.status,
			offerReport: judged.verdict === 'fixed',
		};
	}

	snapshot() {
		return {
			product: 'hawaldar',
			runtime: 'mastra',
			model: this.modelId(),
			provider: this.settings.provider,
			hasSelectedProvider: this.settings.hasSelectedProvider,
			baseUrl: this.settings.baseUrl,
			storage: this.databasePath,
			playbooks: this.playbooks.databasePath,
			notes: this.notes.notesDir,
			tasks: this.tasks.databasePath,
			findings: this.findings.databasePath,
			scope: this.settings.scope,
			agents: this.listAgents(),
			workflows: this.listWorkflows(),
			tools: this.listTools().map((tool) => ({ id: tool.id, source: tool.source, agentId: tool.agentId, enabled: tool.enabled })),
			excluded: EXCLUDED_MCP_TOOLS,
			knowledge: this.knowledge ? {
				path: this.knowledge.lanceDir,
				mode: this.knowledge.mode,
				vector: Boolean(this.knowledge.vectorStore),
			} : undefined,
			logs: this.logs.slice(-12),
			traces: this.traces.slice(-12),
		};
	}

	async knowledgeGraph() {
		await this.ready;
		if (!this.knowledge) {
			throw new Error('Knowledge store is not ready.');
		}
		return buildKnowledgeGraph({
			notes: this.notes,
			tasks: this.tasks,
			sessions: this.sessions,
			knowledge: this.knowledge,
			memory: this.memory,
		});
	}

	async knowledgeSearch(query: string, topK?: number) {
		await this.ready;
		if (!this.knowledge) {
			return [];
		}
		return this.knowledge.search(query, { topK, threadId: this.activeThreadId });
	}

	async knowledgeIngest(input: { title: string; text: string; source?: string }) {
		await this.ready;
		if (!this.knowledge) {
			throw new Error('Knowledge store is not ready.');
		}
		const { slugifyName } = await import('./data-home');
		return this.knowledge.ingestText({
			kind: 'doc',
			sourceId: slugifyName(input.source || input.title, 'doc'),
			title: input.title,
			text: input.text,
		});
	}

	async reindexKnowledge(): Promise<{ docs: number; chunks: number; mode: 'vector' | 'keyword' }> {
		await this.ready;
		await this.syncKnowledgeSources(true);
		const counts = await this.knowledge!.counts();
		return { ...counts, mode: this.knowledge!.mode };
	}

	async ingestNote(id: string): Promise<void> {
		if (!this.knowledge) {
			return;
		}
		const note = await this.notes.get(id);
		await this.knowledge.ingestText({
			kind: 'note',
			sourceId: note.id,
			title: note.title,
			text: note.body,
			updatedAt: note.updatedAt,
		});
	}

	async ingestTask(id: string): Promise<void> {
		if (!this.knowledge) {
			return;
		}
		const task = await this.tasks.list().then((rows) => rows.find((row) => row.id === id));
		if (!task) {
			return;
		}
		await this.knowledge.ingestText({
			kind: 'task',
			sourceId: task.id,
			title: task.title,
			text: `${task.listTitle || task.status}\n${task.notes}`.trim(),
			updatedAt: task.updatedAt,
		});
	}

	private async recallPlaybookPrior(threadId: string, message: string): Promise<string> {
		const chunks: string[] = [];
		const pasted = clipThreadEvidence(message, 3_000);
		if (pasted && !/^https?:\/\/\S+$/i.test(pasted) && pasted.length > 80) {
			chunks.push(pasted);
		}
		if (this.memory?.recall) {
			try {
				const recalled = await this.memory.recall({
					threadId,
					resourceId: RESOURCE,
					perPage: 12,
					page: 0,
				});
				const raw = Array.isArray(recalled?.messages) ? recalled.messages : [];
				const lines: string[] = [];
				for (const item of raw.slice(-8)) {
					const mapped = toHistoryMessage(item);
					if (!mapped?.text) {
						continue;
					}
					const role = mapped.role === 'user' ? 'User' : 'Assistant';
					lines.push(`${role}: ${clipThreadEvidence(mapped.text, 500)}`);
				}
				if (lines.length > 0) {
					chunks.push(lines.join('\n'));
				}
			} catch {
				/* thread recall is best-effort */
			}
		}
		return chunks.join('\n\n').slice(-8_000);
	}

	private async persistThreadMessages(
		threadId: string,
		rows: Array<{ role: 'user' | 'assistant'; content: string }>,
	): Promise<void> {
		const id = String(threadId || '').trim();
		if (!id || !this.memory || rows.length === 0) {
			return;
		}
		const messages = rows
			.map((row) => {
				const content = String(row.content || '').trim();
				if (!content) {
					return undefined;
				}
				return {
					id: randomUUID(),
					role: row.role,
					type: 'text' as const,
					createdAt: new Date(),
					threadId: id,
					resourceId: RESOURCE,
					content,
				};
			})
			.filter((item): item is NonNullable<typeof item> => Boolean(item));
		if (messages.length === 0) {
			return;
		}
		try {
			if (typeof this.memory.saveMessages === 'function') {
				await this.memory.saveMessages({ messages });
				return;
			}
			if (typeof this.memory.addMessage === 'function') {
				for (const item of messages) {
					await this.memory.addMessage(item);
				}
			}
		} catch (error) {
			this.exporter.pushLog('warn', `Memory save skipped: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private async syncEngagementWorkingMemory(threadId: string, facts: {
		target: string;
		workflowId: string;
		status: string;
		lastStep?: string;
		openQuestion?: string;
	}): Promise<void> {
		if (!this.memory || typeof this.memory.updateWorkingMemory !== 'function') {
			return;
		}
		const filled = sanitizeWorkingMemoryUpdate([
			'# Engagement',
			`- Targets: ${facts.target || ''}`,
			`- Scope notes: playbook ${facts.workflowId} (${facts.status})`,
			'- Findings:',
			`- Open questions: ${facts.openQuestion || ''}`,
			`- Last tools: ${facts.lastStep || ''}`,
		].join('\n'));
		if (!filled) {
			return;
		}
		try {
			await this.memory.updateWorkingMemory({
				threadId,
				resourceId: RESOURCE,
				workingMemory: filled,
			});
		} catch (error) {
			this.exporter.pushLog('warn', `Working memory update skipped: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private async ingestChatTurn(threadId: string, prompt: string, reply: string): Promise<void> {
		if (!this.knowledge) {
			return;
		}
		const session = await this.sessions.get(threadId);
		const title = chatRagTitle(session?.title || 'Chat', threadId);
		const history = await this.listThreadHistory(threadId, { limit: 80 });
		const transcript = formatChatTranscript(history.messages);
		const fallback = `User: ${prompt.trim()}\n\nAssistant: ${clipSnippet(reply, 2400)}`;
		await this.knowledge.ingestText({
			kind: 'chat',
			sourceId: threadId,
			title,
			text: transcript || fallback,
		});
	}

	private async ingestSessionHistory(sessionId: string, title: string, snippet?: string, updatedAt?: number): Promise<void> {
		if (!this.knowledge) {
			return;
		}
		const history = await this.listThreadHistory(sessionId, { limit: 80 });
		const transcript = formatChatTranscript(history.messages);
		const text = transcript || snippet || '';
		if (!text.trim()) {
			return;
		}
		await this.knowledge.ingestText({
			kind: 'chat',
			sourceId: sessionId,
			title: chatRagTitle(title || 'Chat', sessionId),
			text,
			updatedAt,
		});
	}

	private async syncKnowledgeSources(force = false): Promise<void> {
		if (!this.knowledge) {
			return;
		}
		const counts = await this.knowledge.counts();
		if (!force && counts.docs > 0) {
			await this.knowledge.ingestKnowledgeDir();
			await this.ingestPlaybooks();
			return;
		}
		for (const note of await this.notes.list()) {
			await this.ingestNote(note.id);
		}
		for (const task of await this.tasks.list()) {
			await this.ingestTask(task.id);
		}
		for (const session of await this.sessions.list()) {
			await this.ingestSessionHistory(session.id, session.title || 'Chat', session.snippet, session.updatedAt);
		}
		await this.ingestPlaybooks();
		await this.knowledge.ingestKnowledgeDir();
	}

	private async ingestPlaybooks(): Promise<void> {
		if (!this.knowledge) {
			return;
		}
		for (const workflow of this.playbooks.listWorkflows()) {
			const text = `${workflow.name}\n${workflow.steps.map((step) => `${step.kind}:${step.id}`).join(' → ')}`;
			await this.knowledge.ingestText({
				kind: 'playbook',
				sourceId: workflow.id,
				title: workflow.name,
				text,
				updatedAt: workflow.updatedAt,
			});
		}
		for (const rule of this.playbooks.listRules()) {
			await this.knowledge.ingestText({
				kind: 'rule',
				sourceId: rule.id,
				title: rule.name,
				text: `${rule.kind} ${JSON.stringify(rule.definition)}`,
				updatedAt: rule.updatedAt,
			});
		}
	}

	private assertProviderCredentials(): void {
		const apiKey = this.providerApiKey();
		if (this.settings.provider === 'openrouter' && !apiKey) {
			throw missingProviderApiKeyError('openrouter');
		}
		if (providerLooksConfigured({ ...this.settings, apiKey })) {
			return;
		}
		if (!this.settings.hasSelectedProvider || !this.settings.provider) {
			throw new Error(`No provider selected. ${MISSING_API_KEY_HINT}`);
		}
		throw missingProviderApiKeyError(this.settings.provider);
	}

	private modelConfig() {
		const extraBody = this.reasoningExtraBody();
		const provider = this.settings.provider;
		const apiKey = this.providerApiKey();
		const baseUrl = (this.settings.baseUrl || '').replace(/\/+$/, '');
		const local = ['custom', 'ollama', 'lmstudio'].includes(provider)
			|| baseUrl.includes('127.0.0.1') || baseUrl.includes('localhost');
		// Never pass OpenRouter's own URL: Mastra then skips the OpenRouter gateway
		// and calls openai-compatible with no Authorization → HTTP 401 cookie-auth.
		const url = mastraCustomModelUrl(provider, baseUrl, local);
		const headers = provider === 'openrouter' && apiKey ? openRouterRequestHeaders(apiKey) : undefined;
		const identity = provider === 'openrouter'
			? { providerId: 'openrouter', modelId: this.settings.model }
			: { id: this.modelId() };
		if (local || apiKey || url) {
			return {
				...identity,
				...(url ? { url } : {}),
				...(apiKey || local ? { apiKey: apiKey || 'local' } : {}),
				...(headers ? { headers } : {}),
				...(extraBody ? { extraBody } : {}),
			};
		}
		return extraBody ? { ...identity, extraBody } : (identity as { id?: string }).id ?? this.modelId();
	}

	/** OpenRouter `reasoning: { effort }` when Thinking is on and the model supports it. */
	private reasoningExtraBody(): { reasoning: { effort: string } } | undefined {
		if (!this.settings.thinking) {
			return undefined;
		}
		const meta = lookupListedModel(this.settings.provider, this.settings.model);
		const supported = meta?.supportsReasoning === true
			|| (meta === undefined && this.settings.provider === 'openrouter');
		if (!supported) {
			return undefined;
		}
		return { reasoning: { effort: 'medium' } };
	}

	private async persistServicePatch(
		patch: Partial<Pick<HawaldarSettings, 'startedServices' | 'toolImages'>>,
	): Promise<HawaldarSettings> {
		const next = await this.store.write(patch);
		this.settings = next;
		return next;
	}

	private buildMemory(mods: MastraModules, store: unknown): any {
		const created = this.knowledge?.embedder.ready
			? (this.knowledge.embedder.router
				? { instance: this.knowledge.embedder.router, error: this.knowledge.embedder.error }
				: tryCreateRouterEmbedder(this.settings, mods))
			: {};
		if (created.error) {
			this.exporter.pushLog('warn', `Memory embedder skipped: ${created.error}`);
		}
		const memoryEmbedder = created.instance;
		const memoryVector = memoryEmbedder
			? (this.knowledge?.vectorStore
				?? (mods.LibSQLVector
					? new mods.LibSQLVector({ id: 'hawaldar-memory-vector', url: `file:${this.databasePath}` })
					: false))
			: false;
		const workingMemory = {
			enabled: true,
			scope: 'thread' as const,
			template: WORKING_MEMORY_TEMPLATE,
		};
		const baseOptions = {
			lastMessages: 40,
			generateTitle: true,
			workingMemory,
		};
		try {
			return new mods.Memory({
				storage: store,
				vector: memoryVector || false,
				embedder: memoryEmbedder,
				options: {
					...baseOptions,
					semanticRecall: memoryVector && memoryEmbedder
						? { topK: 6, messageRange: 2, scope: 'resource' }
						: false,
				},
			});
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			this.exporter.pushLog('warn', `Memory started without semantic recall: ${detail}`);
			return new mods.Memory({
				storage: store,
				vector: false,
				embedder: undefined,
				options: {
					...baseOptions,
					semanticRecall: false,
				},
			});
		}
	}

	private reasoningStreamOptions(): { providerOptions?: Record<string, Record<string, unknown>> } {
		const extraBody = this.reasoningExtraBody();
		if (!extraBody) {
			return {};
		}
		const provider = this.settings.provider;
		const providerOptions: Record<string, Record<string, unknown>> = {
			openai: extraBody,
		};
		if (provider === 'openrouter') {
			providerOptions.openrouter = extraBody;
		}
		return { providerOptions };
	}

	private build(mods: MastraModules): any {
		const store = new mods.LibSQLStore({ id: 'hawaldar-storage', url: `file:${this.databasePath}` });
		this.memory = wrapMemorySanitize(this.buildMemory(mods, store));
		void purgeEmptyMastraMessages(this.databasePath).then((deleted) => {
			if (deleted > 0) {
				this.exporter.pushLog('info', `Purged ${deleted} empty memory message(s)`);
			}
		}).catch((error) => {
			this.exporter.pushLog('warn', `Empty-message purge skipped: ${error instanceof Error ? error.message : String(error)}`);
		});
		const model = () => this.modelConfig();
		const { z, createTool, createStep, createWorkflow, Agent, Mastra, PinoLogger, Observability, MastraStorageExporter, SensitiveDataFilter } = mods;
		const inputProcessors = [createEmptyMessageProcessor()];
		const tools: Record<string, unknown> = {
			list_threads: createTool({
				id: 'list_threads',
				description: 'List Mastra memory threads',
				inputSchema: z.object({}),
				execute: async () => ({ threads: await this.listThreads() }),
			}),
			runtime_status: createTool({
				id: 'runtime_status',
				description: 'Mastra runtime, tools, scope, refused tools',
				inputSchema: z.object({}),
				execute: async () => this.snapshot(),
			}),
			run_workflow: createTool({
				id: 'run_workflow',
				description: 'Orchestrator only. Run a persisted Hawaldar engagement workflow by id: pre-recon, recon-surface, web-recon, source-review, vuln-detect, poc-validate, validate, report, correlate-report, full-engagement (aliases: full-recon, analyze, poc, prove). Call this tool as run_workflow (lowercase, underscore) — never RUN WORKFLOW. Slash /full-engagement is executed by the runtime; this tool is for free chat. PoC validation is HITL-gated and non-destructive; exploit tooling stays refused. Policy and rules apply.',
				inputSchema: z.object({
					workflowId: z.string(),
					target: z.string().optional(),
					filePath: z.string().optional(),
					pcapPath: z.string().optional(),
					message: z.string().optional(),
				}),
				execute: async (input: { workflowId: string; target?: string; filePath?: string; pcapPath?: string; message?: string }) => {
					const def = this.playbooks.getWorkflow(resolveWorkflowRef(input.workflowId));
					if (!def) {
						throw new Error(`Unknown workflow: ${input.workflowId}`);
					}
					if (!def.enabled) {
						throw new Error(`Workflow ${def.id} is disabled.`);
					}
					const blob = String(input.message || input.target || '');
					const canonical = extractCanonicalTarget(blob);
					return { output: await this.runSequentialSteps(def, {
						...input,
						target: canonical?.display || input.target,
						message: input.message || blob,
					}, [], '', { threadId: this.activeThreadId }) };
				},
			}),
			run_specialists: createTool({
				id: 'run_specialists',
				description: 'Run independent specialists in parallel (default) or sequentially when a later step needs an earlier result. Do not include orchestrator.',
				inputSchema: z.object({
					jobs: z.array(z.object({
						agentId: z.string().describe('Specialist id such as nmap, dns, research, browser, scrapling.'),
						prompt: z.string().describe('Focused ask for that specialist.'),
					})).min(1).max(6),
					mode: z.enum(['parallel', 'sequential']).optional(),
				}),
				execute: async (input: { jobs: Array<{ agentId: string; prompt: string }>; mode?: 'parallel' | 'sequential' }) => {
					const thread = await this.ensureThread();
					const results = await this.runSpecialistsParallel(input.jobs, thread.id, input.mode ?? 'parallel');
					return { mode: input.mode ?? 'parallel', results };
				},
			}),
		};
		const toolInputSchema = z.object({
			target: z.string().optional(),
			filePath: z.string().optional(),
			pcapPath: z.string().optional(),
			functionName: z.string().optional(),
			address: z.string().optional(),
			topPorts: z.number().optional(),
			portRange: z.string().optional(),
			scanType: z.string().optional(),
			streamIndex: z.number().optional(),
			streamProto: z.enum(['tcp', 'udp']).optional(),
			limit: z.number().optional(),
			query: z.string().optional(),
			module: z.string().optional(),
			port: z.number().optional(),
			url: z.string().optional(),
			engine: z.string().optional(),
			types: z.array(z.string()).optional(),
			nameserver: z.string().optional(),
			selector: z.string().optional(),
			selectorType: z.string().optional(),
			identifier: z.string().optional(),
			mode: z.string().optional(),
		});
		const runCatalogTool = async (id: string, input: Record<string, unknown>, context: unknown) => {
			try {
				const result = await executeTool(
					await this.store.read(),
					id,
					input,
					this.toolExecOptions({
						hitlContext: context as ExecuteToolOptions['hitlContext'],
						sourceAgentId: TOOL_CATALOG.find((tool) => tool.id === id)?.agentId,
						chatTitle: await this.chatTitleFor(),
					}),
				);
				return result ?? definedToolResult('Waiting for operator approval.');
			} catch (error) {
				return definedToolResult(formatChatError(error), { exitCode: 1 });
			}
		};
		for (const spec of TOOL_CATALOG) {
			tools[spec.id] = createTool({
				id: spec.id,
				description: `${spec.description} Built-in Hawaldar tool. Policy + Podman only.`,
				inputSchema: wrapToolInputSchema(z, spec.id, isKnowledgeTool(spec.id)
					? buildKnowledgeInputSchema(z, spec.id)
					: isFindingTool(spec.id)
						? buildFindingInputSchema(z, spec.id)
						: isServiceControlTool(spec.id)
						? buildServiceControlInputSchema(z)
						: spec.agentId === 'nmap'
							? buildNmapInputSchema(z, spec.id)
							: spec.agentId === 'dns'
								? buildDnsInputSchema(z, spec.id)
								: spec.agentId === 'tshark'
									? buildTsharkInputSchema(z, spec.id)
								: spec.agentId === 'metasploit'
									? buildMetasploitInputSchema(z, spec.id)
									: spec.agentId === 'zap'
										? buildZapInputSchema(z, spec.id)
										: spec.agentId === 'juice-shop'
											? buildJuiceShopInputSchema(z)
											: spec.agentId === 'sqlmap'
											? buildSqlmapInputSchema(z, spec.id)
											: spec.agentId === 'browser'
											? buildBrowserInputSchema(z, spec.id)
											: spec.agentId === 'research'
												? buildResearchInputSchema(z, spec.id)
												: spec.agentId === 'scrapling'
													? buildScraplingInputSchema(z, spec.id)
													: spec.agentId === 'semgrep'
														? buildSemgrepInputSchema(z, spec.id)
														: spec.agentId === 'poc'
															? buildPocInputSchema(z, spec.id)
															: toolInputSchema),
				execute: async (input: Record<string, unknown>, context: unknown) => runCatalogTool(spec.id, coerceToolArgs(spec.id, input), context),
			});
		}
		for (const custom of this.settings.customTools) {
			if (!custom.enabled) {
				continue;
			}
			tools[custom.id] = createTool({
				id: custom.id,
				description: `${custom.description} Custom Podman tool (${custom.kind}). Policy + Podman only.`,
				inputSchema: wrapToolInputSchema(z, custom.id, toolInputSchema),
				execute: async (input: Record<string, unknown>, context: unknown) => runCatalogTool(custom.id, coerceToolArgs(custom.id, input), context),
			});
		}

		const specialists: Record<string, unknown> = {};
		const buildSpecialist = (role: (typeof AGENT_ROLES)[number], extraAgents?: Record<string, unknown>) => {
			const owned = [
				...catalogToolsForAgent(role.id),
				...this.settings.customTools.filter((tool) => tool.enabled && tool.agentId === role.id),
			];
			const agentTools: Record<string, unknown> = { runtime_status: tools.runtime_status };
			for (const spec of owned) {
				agentTools[spec.id] = tools[spec.id];
			}
			for (const id of SERVICE_CONTROL_TOOL_IDS) {
				if (tools[id]) {
					agentTools[id] = tools[id];
				}
			}
			for (const id of KNOWLEDGE_TOOL_IDS) {
				if (role.id === 'reporting' || role.id === 'validation') {
					continue;
				}
				if (tools[id]) {
					agentTools[id] = tools[id];
				}
			}
			specialists[role.id] = new Agent({
				id: role.id,
				name: role.name,
				description: role.role,
				instructions: this.prompts.instructionsFor(role.id, role.name, role.role),
				model,
				memory: this.memory,
				tools: agentTools,
				inputProcessors,
				...(extraAgents && Object.keys(extraAgents).length > 0 ? { agents: extraAgents } : {}),
			});
		};
		const researchRole = AGENT_ROLES.find((item) => item.id === 'research');
		if (researchRole) {
			buildSpecialist(researchRole);
		}
		for (const role of AGENT_ROLES) {
			if (role.id === 'orchestrator' || role.id === 'research') {
				continue;
			}
			buildSpecialist(role, specialists.research ? { research: specialists.research } : undefined);
		}

		const orchestrator = new Agent({
			id: 'orchestrator',
			name: 'Orchestrator',
			description: 'Supervisor. Runs engagement playbooks (full-engagement) and delegates to specialists.',
			instructions: this.prompts.instructionsFor(
				'orchestrator',
				'Orchestrator',
				'Supervisor. Delegates to specialists.',
			),
			model,
			memory: this.memory,
			tools,
			agents: specialists,
			inputProcessors,
		});

		const job = z.object({
			target: z.string().optional(),
			filePath: z.string().optional(),
			pcapPath: z.string().optional(),
			message: z.string().optional(),
		});
		const bundle = z.object({
			target: z.string().optional(),
			filePath: z.string().optional(),
			pcapPath: z.string().optional(),
			message: z.string().optional(),
			allowed: z.boolean(),
			reason: z.string(),
			output: z.string().optional(),
		});

		const gate = createStep({
			id: 'gate',
			inputSchema: job,
			outputSchema: bundle,
			execute: async ({ inputData }: { inputData: { target?: string; message?: string; filePath?: string; pcapPath?: string } }) => {
				const settings = await this.store.read();
				if (inputData.filePath || inputData.pcapPath) {
					return { ...inputData, allowed: true, reason: 'local file analysis' };
				}
				const blob = String(inputData.message || inputData.target || '');
				const canonical = extractCanonicalTarget(blob);
				if (canonical) {
					const { evaluateScope } = await import('./policy');
					const decision = evaluateScope(settings.scope, canonical.host);
					return { ...inputData, target: canonical.display, allowed: decision.allow, reason: decision.reason };
				}
				if (!inputData.target || /\s/.test(inputData.target)) {
					return { ...inputData, allowed: true, reason: 'implied target or workspace SAST' };
				}
				const { evaluateScope } = await import('./policy');
				const decision = evaluateScope(settings.scope, inputData.target);
				return { ...inputData, allowed: decision.allow, reason: decision.reason };
			},
		});
		const workflows: Record<string, unknown> = {};
		for (const def of this.playbooks.listWorkflows()) {
			if (!def.enabled || !def.key) {
				continue;
			}
			const runStored = createStep({
				id: `playbook-${def.id}`,
				inputSchema: bundle,
				outputSchema: z.object({ output: z.string() }),
				execute: async ({ inputData }: { inputData: { target?: string; filePath?: string; pcapPath?: string; message?: string; reason: string; allowed: boolean } }) => {
					if (!inputData.allowed) {
						return { output: `Policy denied: ${inputData.reason}` };
					}
					const current = this.playbooks.getWorkflow(def.id);
					if (!current || !current.enabled) {
						return { output: `Workflow ${def.id} is unavailable.` };
					}
					return { output: await this.runSequentialSteps(current, inputData) };
				},
			});
			workflows[def.key] = createWorkflow({
				id: def.id,
				inputSchema: job,
				outputSchema: z.object({ output: z.string() }),
			}).then(gate).then(runStored).commit();
		}

		const fanNmap = createStep({
			id: 'fanout-nmap',
			inputSchema: bundle,
			outputSchema: z.object({ output: z.string() }),
			execute: async ({ inputData }: { inputData: { allowed: boolean; reason: string; target?: string } }) => {
				if (!inputData.allowed) {
					return { output: `Policy denied: ${inputData.reason}` };
				}
				const result = await executeTool(await this.store.read(), 'quick-scan', { target: inputData.target }, this.toolExecOptions());
				return { output: toolOutputText(result) };
			},
		});
		const fanDns = createStep({
			id: 'fanout-dns',
			inputSchema: bundle,
			outputSchema: z.object({ output: z.string() }),
			execute: async ({ inputData }: { inputData: { allowed: boolean; reason: string; target?: string } }) => {
				if (!inputData.allowed) {
					return { output: `Policy denied: ${inputData.reason}` };
				}
				const result = await executeTool(await this.store.read(), 'dns-resolve', { target: inputData.target }, this.toolExecOptions());
				return { output: toolOutputText(result) };
			},
		});
		const fanCombine = createStep({
			id: 'fanout-combine',
			inputSchema: z.object({
				'fanout-nmap': z.object({ output: z.string() }),
				'fanout-dns': z.object({ output: z.string() }),
			}),
			outputSchema: z.object({ output: z.string() }),
			execute: async ({ inputData }: { inputData: { 'fanout-nmap'?: { output: string }; 'fanout-dns'?: { output: string } } }) => ({
				output: `## nmap\n${inputData['fanout-nmap']?.output ?? ''}\n\n## dns\n${inputData['fanout-dns']?.output ?? ''}`,
			}),
		});
		try {
			const gated = createWorkflow({
				id: 'parallel-recon',
				inputSchema: job,
				outputSchema: z.object({ output: z.string() }),
			}).then(gate);
			if (typeof gated.parallel === 'function') {
				workflows.parallelRecon = gated.parallel([fanNmap, fanDns]).then(fanCombine).commit();
			}
		} catch {
			/* workflow .parallel() unavailable in this Mastra build */
		}

		return new Mastra({
			agents: { orchestrator, ...specialists },
			workflows,
			storage: store,
			logger: new PinoLogger({ name: 'Hawaldar', level: 'info' }),
			observability: new Observability({
				configs: {
					default: {
						serviceName: 'hawaldar',
						exporters: [new MastraStorageExporter({ strategy: 'realtime' }), this.exporter],
						spanOutputProcessors: [new SensitiveDataFilter()],
						logging: { enabled: true, level: 'info' },
					},
				},
			}),
		});
	}
}

function chatRagTitle(title: string, threadId: string): string {
	const slice = threadId.slice(0, 8);
	const name = title.trim() || 'Chat';
	return `Chat · ${name} · ${slice}`;
}

function formatChatTranscript(messages: ThreadHistoryMessage[]): string {
	if (messages.length === 0) {
		return '';
	}
	return messages.map((item) => {
		const role = item.role === 'user' ? 'User' : 'Assistant';
		const text = item.text.length > 4_000 ? `${item.text.slice(0, 4_000)}…` : item.text;
		return `${role}: ${text}`;
	}).join('\n\n');
}

function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`Workflow exceeded max timeout (${ms}ms)`)), ms);
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

async function tryUpdateMastraTitle(memory: any, threadId: string, title: string): Promise<void> {
	if (!memory) {
		return;
	}
	try {
		if (typeof memory.updateThread === 'function') {
			await memory.updateThread({ id: threadId, title });
			return;
		}
		if (typeof memory.saveThread === 'function') {
			await memory.saveThread({ thread: { id: threadId, title } });
		}
	} catch {
		/* sqlite session_meta is the persisted title */
	}
}

function toHistoryMessage(raw: unknown): ThreadHistoryMessage | undefined {
	if (!raw || typeof raw !== 'object') {
		return undefined;
	}
	const row = raw as { id?: unknown; role?: unknown; createdAt?: unknown; content?: unknown };
	const role = row.role;
	if (role !== 'user' && role !== 'assistant') {
		return undefined;
	}
	const text = extractMessageText(row.content);
	const id = String(row.id ?? '').trim();
	if (!id || !text) {
		return undefined;
	}
	return { id, role, text, createdAt: toMs(row.createdAt) };
}

function extractMessageText(content: unknown): string {
	if (typeof content === 'string') {
		return content.trim();
	}
	if (!content || typeof content !== 'object') {
		return toDisplayText(content).trim();
	}
	const value = content as { content?: unknown; parts?: unknown; text?: unknown };
	const parts = Array.isArray(value.parts) ? value.parts : Array.isArray(content) ? content : [];
	const chunks: string[] = [];
	for (const part of parts) {
		if (typeof part === 'string' && part.trim()) {
			chunks.push(part);
			continue;
		}
		if (!part || typeof part !== 'object') {
			continue;
		}
		const item = part as { type?: unknown; text?: unknown };
		if (item.type === 'text' || item.text != null) {
			const text = toDisplayText(item.text).trim();
			if (text) {
				chunks.push(text);
			}
		}
	}
	const fromParts = chunks.join('\n').trim();
	if (fromParts) {
		return fromParts;
	}
	if (typeof value.content === 'string') {
		return value.content.trim();
	}
	if (value.content && typeof value.content === 'object') {
		return extractMessageText(value.content);
	}
	return toDisplayText(value.text).trim();
}

async function peekLastActivityFrom(memory: any, threadId: string): Promise<{ at: number; snippet: string }> {
	if (!memory?.recall) {
		return { at: 0, snippet: '' };
	}
	try {
		const recalled = await memory.recall({
			threadId,
			resourceId: RESOURCE,
			perPage: 8,
			page: 0,
		});
		const raw = Array.isArray(recalled?.messages) ? recalled.messages : [];
		let at = 0;
		let snippet = '';
		for (const item of raw) {
			const mapped = toHistoryMessage(item);
			if (!mapped) {
				continue;
			}
			const when = toEpochMs((item as { createdAt?: unknown }).createdAt);
			if (when >= at) {
				at = when;
				snippet = mapped.text;
			}
		}
		return { at, snippet: clipSnippet(snippet) };
	} catch {
		return { at: 0, snippet: '' };
	}
}

function isPinnedFlag(value: unknown): boolean {
	return value === true || value === 1 || value === '1';
}

function firstEpoch(...values: unknown[]): number {
	let best = 0;
	for (const value of values) {
		const at = toEpochMs(value);
		if (at > best) {
			best = at;
		}
	}
	return best;
}

function pickThreadUpdatedAt(...values: number[]): number {
	return firstEpoch(...values);
}

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
	for (let i = 0; i < items.length; i += limit) {
		await Promise.all(items.slice(i, i + limit).map((item) => fn(item)));
	}
}

function toMs(value: unknown): number {
	return toEpochMs(value) || Date.now();
}

function toolOutputText(result: unknown): string {
	if (result && typeof result === 'object' && ('stdout' in result || 'stderr' in result)) {
		const rec = result as { stdout?: unknown; stderr?: unknown };
		return toDisplayText(rec.stdout) || toDisplayText(rec.stderr);
	}
	return 'user declined';
}

