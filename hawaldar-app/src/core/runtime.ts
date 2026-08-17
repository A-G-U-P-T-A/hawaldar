import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadMastra, type MastraModules } from './load-mastra';
import { ensureDataHome } from './data-home';
import { WORKING_MEMORY_TEMPLATE } from './working-memory';
import { EngagementTracker, type EngagementRun } from './engagement-tracker';
import { ApprovalsStore } from './approvals-store';
import { FindingsStore, type FindingFilter } from './findings-store';
import { NotesStore } from './notes-store';
import { buildKnowledgeGraph, formatRagContext, KnowledgeStore, tryCreateRouterEmbedder } from './knowledge';
import {
	engagementAgentPrompt,
	resolveWorkflowRef,
	SEQUENTIAL_AGENTS,
	WORKFLOW_SLASH_ALIASES,
	adaptWorkflowSteps,
} from './engagement';
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
import { lookupListedModel } from './model-catalog';
import { applyProviderEnv, MASTRA_PROVIDERS, routerModelId } from './providers';
import { PromptsStore, type SlashCommandDef } from './prompts';
import { SessionMetaStore, clipSnippet, isPlaceholderSessionTitle, titleFromFirstPrompt, toEpochMs } from './session-meta';
import { SettingsStore, type HawaldarSettings } from './settings';
import { TaskStore } from './tasks-store';
import { AGENT_ROLES, catalogToolsForAgent, EXCLUDED_MCP_TOOLS, isKnowledgeTool, isServiceControlTool, KNOWLEDGE_TOOL_IDS, SERVICE_CONTROL_TOOL_IDS, TOOL_CATALOG, toPublicTool } from './tools/catalog';
import { consumeAgentStream, type ChatActivity } from './chat-activity';
import { createEmptyMessageProcessor, formatChatError, purgeEmptyMastraMessages, sanitizeProviderMessages, wrapMemorySanitize } from './chat-messages';
import { hitlToolSchemas, type HitlAsk } from './hitl';
import { executeTool, type ExecuteToolOptions } from './tools/index';
import { buildBrowserInputSchema } from './tools/browser';
import { buildFindingInputSchema, isFindingTool, renderFindingsReport, saveReportArtifact } from './tools/findings';
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
	readonly approvals: ApprovalsStore;
	readonly engagement = new EngagementTracker();
	knowledge: KnowledgeStore | undefined;
	mastra: any;
	private memory: any;
	private settings!: HawaldarSettings;
	private mods: MastraModules | undefined;
	private impliedTargets: string[] = [];
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
		this.approvals = new ApprovalsStore(this.dataDir);
		this.ready = this.boot();
	}

	private async boot(): Promise<void> {
		await Promise.all([this.playbooks.ready, this.notes.ready, this.tasks.ready, this.sessions.ready, this.findings.ready, this.approvals.ready]);
		await this.reload();
	}

	get traces() {
		return this.exporter.traces;
	}

	get logs() {
		return this.exporter.logs;
	}

	async reload(): Promise<void> {
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
				? Boolean(this.settings.apiKey || !item.envVar)
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
		opts: { limit?: number; before?: number } = {},
	): Promise<ThreadHistoryPage> {
		await this.ready;
		const id = String(threadId || '').trim();
		if (!id || !this.memory?.recall) {
			return { messages: [], hasMore: false };
		}
		const limit = Math.max(1, Math.min(Math.floor(opts.limit ?? 2), 100));
		const before = typeof opts.before === 'number' && opts.before > 0 ? opts.before : undefined;
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
		this.activitySink?.(event);
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
			approvals: this.approvals,
			...extra,
		};
	}

	async streamAgent(
		agentId: string,
		prompt: string,
		threadId: string,
		onDelta: (text: string) => void,
		opts?: { readOnlyMemory?: boolean },
	): Promise<string> {
		await this.ready;
		await this.touchThread(threadId, prompt);
		const settings = await this.store.read();
		this.settings = settings;
		const { formatEngagementScopeContext, resolveImpliedTargets } = await import('./policy');
		const implied = resolveImpliedTargets(prompt, settings.scope);
		this.impliedTargets = implied.targets;
		const restoredPrompt = restoreTargetPlaceholders(prompt, implied.targets);
		const scopeContext = restoreTargetPlaceholders(formatEngagementScopeContext(settings.scope, implied), implied.targets);
		const ragHits = this.knowledge
			? await this.knowledge.search(restoredPrompt, { topK: 8, threadId }).catch(() => [])
			: [];
		const ragContext = formatRagContext(ragHits);
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
		return toolExecContext.run({ impliedTargets: implied.targets, readOnlyMemory: opts?.readOnlyMemory }, async () => {
		try {
			this.emitActivity({
				type: 'agent',
				name: agentId,
				detail: agentId,
				status: 'ok',
			});
			const agent = this.mastra.getAgentById(agentId);
			const streamOptions = {
				maxSteps: 10,
				memory: {
					thread: { id: threadId },
					resource: RESOURCE,
					...(opts?.readOnlyMemory ? { options: { readOnly: true } } : {}),
				},
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
				},
			};
			let stream = await agent.stream(restoredPrompt, streamOptions);
			let collected = '';
			for (;;) {
				const result = await consumeAgentStream(stream, onDelta, (event) => this.emitActivity(event));
				collected += result.text;
				if (!result.suspended) {
					if (!opts?.readOnlyMemory) {
						void this.ingestChatTurn(threadId, restoredPrompt, collected);
					}
					await this.touchThread(threadId, collected || restoredPrompt);
					return collected;
				}
				const pending = result.suspended;
				let runId = pending.runId || String(stream.runId ?? '');
				if (!runId && typeof agent.listSuspendedRuns === 'function') {
					const listed = await agent.listSuspendedRuns({ threadId, resourceId: RESOURCE });
					runId = String(listed?.runs?.[0]?.runId ?? '');
				}
				const waitName = pending.payload.kind === 'podman'
					? 'podman'
					: (pending.payload.serviceId || pending.toolName || 'image');
				this.emitActivity({
					type: 'tool:start',
					name: waitName,
					detail: pending.payload.title || 'Waiting for approval…',
					status: 'start',
				});
				const approved = this.hitlAsk ? await this.hitlAsk(pending.payload) : false;
				this.emitActivity({
					type: 'tool:done',
					name: waitName,
					detail: approved ? 'Approved' : 'user declined',
					status: approved ? 'ok' : 'error',
				});
				if (!runId) {
					return collected || (approved ? '' : 'user declined');
				}
				stream = await agent.resumeStream(
					{
						approved,
						kind: pending.payload.kind,
						serviceId: pending.payload.serviceId,
					},
					{
						runId,
						toolCallId: pending.toolCallId || undefined,
						memory: { thread: { id: threadId }, resource: RESOURCE },
						...this.reasoningStreamOptions(),
					},
				);
			}
		} catch (error) {
			throw new Error(formatChatError(error), { cause: error });
		} finally {
			this.impliedTargets = [];
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
				const text = await this.streamAgent(job.agentId, job.prompt, threadId, () => {}, { readOnlyMemory: true });
				return { agentId: job.agentId, text };
			} catch (error) {
				return {
					agentId: job.agentId,
					text: '',
					error: error instanceof Error ? error.message : String(error),
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

	async runWorkflow(workflowKey: string, input: Record<string, unknown>): Promise<string> {
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
		const thread = await this.ensureThread();
		const hint = String(input.message || input.target || input.filePath || input.pcapPath || def.name);
		await this.touchThread(thread.id, hint);
		const settings = await this.store.read();
		const decision = evaluatePlaybookRules(this.playbooks.listRules(), def, settings);
		if (!decision.ok) {
			throw new Error(decision.reason);
		}
		const run = async () => {
			const workflow = this.mastra.getWorkflow(def.key)
				?? this.mastra.getWorkflowById?.(def.key)
				?? this.mastra.getWorkflowById?.(def.id);
			if (workflow) {
				const created = await workflow.createRun();
				const result = await created.start({ inputData: input });
				if (result.status === 'failed') {
					throw new Error(String(result.error ?? 'workflow failed'));
				}
				return JSON.stringify(result.result ?? result, null, 2);
			}
			return this.runSequentialSteps(def, input);
		};
		return decision.maxTimeoutMs ? withDeadline(run(), decision.maxTimeoutMs) : run();
	}

	async runSequentialSteps(
		def: WorkflowRecord,
		input: Record<string, unknown>,
		stack: string[] = [],
		priorEvidence = '',
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
		const track = stack.length === 0
			? this.engagement.begin(
				def,
				String(workflowTarget || input.target || input.message || def.name),
				new Map(this.playbooks.listWorkflows().map((item) => [item.id, item.name])),
			)
			: undefined;
		const adapted = adaptWorkflowSteps(def.id, def.steps, typeof stepInput.target === 'string' ? stepInput.target : blob);
		const runStep = async (step: WorkflowStep): Promise<string> => {
			track?.phaseStart(step.id);
			try {
				const output = await this.runWorkflowStep(def, step, stepInput, workflowTarget, implied.targets, settings, nextStack, prior);
				track?.phaseDone(step.id);
				return output;
			} catch (error) {
				track?.phaseFailed(step.id, error instanceof Error ? error.message : String(error));
				throw error;
			}
		};
		let ok = true;
		try {
			const parts: string[] = [];
			for (const batch of groupIndependentSteps(adapted)) {
				const rows = batch.length === 1
					? [await runStep(batch[0])]
					: await Promise.all(batch.map((step) => runStep(step)));
				parts.push(...rows);
				prior = [prior, ...rows].filter(Boolean).join('\n\n').slice(-16_000);
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
				}, nextStack, prior);
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
				const result = await executeTool(settings, step.id, {
					target: fillImpliedToolTarget(
						step.id,
						typeof input.target === 'string' ? input.target : workflowTarget,
						impliedTargets,
						settings.scope,
					),
					url: fillImpliedToolTarget(
						step.id,
						typeof input.url === 'string' ? input.url : (typeof input.target === 'string' ? input.target : workflowTarget),
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
				}, this.toolExecOptions({
					workflow: def,
					impliedTargets,
				}));
				return `## ${step.id}\n${toolOutputText(result)}`;
			}
			const thread = await this.ensureThread();
			const message = engagementAgentPrompt({
				workflowId: def.id,
				agentId: step.id,
				target: typeof input.target === 'string' ? input.target : workflowTarget,
				message: typeof input.message === 'string' ? input.message : undefined,
				filePath: typeof input.filePath === 'string' ? input.filePath : undefined,
				prior,
			});
			const text = await this.streamAgent(step.id, message, thread.id, () => {});
			return `## agent:${step.id}\n${text || '(empty)'}`;
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

	async exportFindingsReport(input?: { title?: string; target?: string }) {
		await this.ready;
		const rows = await this.findings.list();
		const markdown = renderFindingsReport(rows, {
			title: input?.title?.trim() || 'Engagement report',
			target: input?.target?.trim() || this.impliedTargets[0] || '',
		});
		const saved = saveReportArtifact(markdown, input?.target?.trim() || this.impliedTargets[0] || '');
		return { ...saved, findings: rows.length };
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

	private async ingestChatTurn(threadId: string, prompt: string, reply: string): Promise<void> {
		if (!this.knowledge) {
			return;
		}
		const title = (await this.sessions.get(threadId))?.title || 'Chat';
		const text = `User: ${prompt.trim()}\n\nAssistant: ${clipSnippet(reply, 2400)}`;
		await this.knowledge.ingestText({
			kind: 'chat',
			sourceId: threadId,
			title,
			text,
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
			if (!session.snippet) {
				continue;
			}
			await this.knowledge.ingestText({
				kind: 'chat',
				sourceId: session.id,
				title: session.title || 'Chat',
				text: session.snippet,
				updatedAt: session.updatedAt,
			});
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

	private modelConfig() {
		const id = this.modelId();
		const extraBody = this.reasoningExtraBody();
		const local = ['custom', 'ollama', 'lmstudio'].includes(this.settings.provider)
			|| this.settings.baseUrl.includes('127.0.0.1') || this.settings.baseUrl.includes('localhost');
		if (local || this.settings.apiKey || this.settings.baseUrl) {
			return {
				id,
				url: this.settings.baseUrl || undefined,
				apiKey: this.settings.apiKey || undefined,
				...(extraBody ? { extraBody } : {}),
			};
		}
		return extraBody ? { id, extraBody } : id;
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
			scope: 'thread',
			template: WORKING_MEMORY_TEMPLATE,
		};
		const baseOptions = {
			lastMessages: 40,
			// Mastra-generated titles are a fallback only; session_meta titles (first prompt / rename) win in listThreads.
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
		const model = this.modelConfig();
		const { z, createTool, createStep, createWorkflow, Agent, Mastra, PinoLogger, Observability, MastraStorageExporter, SensitiveDataFilter } = mods;
		const inputProcessors = [createEmptyMessageProcessor()];
		const hitl = hitlToolSchemas(z);
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
				description: 'Run a persisted Hawaldar engagement workflow by id: pre-recon, recon-surface, web-recon, source-review, vuln-detect, poc-validate, validate, report, correlate-report, full-engagement (aliases: full-recon, analyze, poc, prove). PoC validation is HITL-gated and non-destructive; exploit tooling stays refused. Policy and rules apply.',
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
					}) };
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
		for (const spec of TOOL_CATALOG) {
			tools[spec.id] = createTool({
				id: spec.id,
				description: `${spec.description} Built-in Hawaldar tool. Policy + Podman only.`,
				inputSchema: isKnowledgeTool(spec.id)
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
															: toolInputSchema,
				suspendSchema: hitl.suspendSchema,
				resumeSchema: hitl.resumeSchema,
				execute: async (input: Record<string, unknown>, context: unknown) => executeTool(
					await this.store.read(),
					spec.id,
					input,
					this.toolExecOptions({ hitlContext: context as ExecuteToolOptions['hitlContext'] }),
				),
			});
		}
		for (const custom of this.settings.customTools) {
			if (!custom.enabled) {
				continue;
			}
			tools[custom.id] = createTool({
				id: custom.id,
				description: `${custom.description} Custom Podman tool (${custom.kind}). Policy + Podman only.`,
				inputSchema: toolInputSchema,
				suspendSchema: hitl.suspendSchema,
				resumeSchema: hitl.resumeSchema,
				execute: async (input: Record<string, unknown>, context: unknown) => executeTool(
					await this.store.read(),
					custom.id,
					input,
					this.toolExecOptions({ hitlContext: context as ExecuteToolOptions['hitlContext'] }),
				),
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

function groupIndependentSteps(steps: WorkflowStep[]): WorkflowStep[][] {
	const batches: WorkflowStep[][] = [];
	let current: WorkflowStep[] = [];
	let kind: WorkflowStep['kind'] | undefined;
	const flush = () => {
		if (current.length > 0) {
			batches.push(current);
		}
		current = [];
		kind = undefined;
	};
	const stepAgent = (step: WorkflowStep): string => {
		if (step.kind === 'agent') {
			return step.id;
		}
		return TOOL_CATALOG.find((tool) => tool.id === step.id)?.agentId ?? step.id;
	};
	for (const step of steps) {
		if (step.kind === 'workflow' || (step.kind === 'agent' && SEQUENTIAL_AGENTS.has(step.id))) {
			flush();
			batches.push([step]);
			continue;
		}
		if (kind && kind !== step.kind) {
			flush();
		}
		if (step.kind === 'tool' && current.some((item) => stepAgent(item) === stepAgent(step))) {
			flush();
		}
		kind = step.kind;
		current.push(step);
	}
	flush();
	return batches;
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
		return '';
	}
	const value = content as { content?: unknown; parts?: unknown };
	const parts = Array.isArray(value.parts) ? value.parts : Array.isArray(content) ? content : [];
	const chunks: string[] = [];
	for (const part of parts) {
		if (!part || typeof part !== 'object') {
			continue;
		}
		const item = part as { type?: unknown; text?: unknown };
		if (item.type === 'text' && typeof item.text === 'string') {
			chunks.push(item.text);
		}
	}
	const fromParts = chunks.join('\n').trim();
	if (fromParts) {
		return fromParts;
	}
	if (typeof value.content === 'string') {
		return value.content.trim();
	}
	return '';
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
		const rec = result as { stdout?: string; stderr?: string };
		return String(rec.stdout || rec.stderr || '');
	}
	return 'user declined';
}
