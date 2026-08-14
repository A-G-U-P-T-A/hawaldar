import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadMastra, type MastraModules } from './load-mastra';
import { ensureDataHome } from './data-home';
import { NotesStore } from './notes-store';
import {
	evaluatePlaybookRules,
	PlaybookStore,
	type WorkflowRecord,
} from './playbook-store';
import { applyProviderEnv, MASTRA_PROVIDERS, routerModelId } from './providers';
import { PromptsStore, type SlashCommandDef } from './prompts';
import { SessionMetaStore } from './session-meta';
import { SettingsStore, type HawaldarSettings } from './settings';
import { TaskStore } from './tasks-store';
import { AGENT_ROLES, EXCLUDED_MCP_TOOLS, TOOL_CATALOG, toPublicTool } from './tools/catalog';
import { executeTool } from './tools/index';
import { buildTsharkInputSchema } from './tools/tshark';
import { buildNmapInputSchema } from './tools/nmap';
import { WorkbenchExporter } from './workbench-exporter';

export const RESOURCE = 'hawaldar';

export interface MemoryThread {
	id: string;
	title: string;
	resource: string;
	createdAt: number;
	updatedAt: number;
	pinned: boolean;
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
	mastra: any;
	private memory: any;
	private settings!: HawaldarSettings;
	private mods: MastraModules | undefined;
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
		this.ready = this.boot();
	}

	private async boot(): Promise<void> {
		await Promise.all([this.playbooks.ready, this.notes.ready, this.tasks.ready, this.sessions.ready]);
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
		this.mastra = this.build(this.mods);
		const workflows = this.playbooks.listWorkflows().filter((item) => item.enabled).length;
		this.exporter.pushLog('info', `Mastra ready · ${this.modelId()} · ${TOOL_CATALOG.length} tools · ${workflows} workflows`);
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
		const seen = new Set(base.map((item) => item.cmd));
		const extras: SlashCommandDef[] = [];
		for (const workflow of this.playbooks.listWorkflows()) {
			if (!workflow.enabled || seen.has(workflow.id)) {
				continue;
			}
			extras.push({
				cmd: workflow.id,
				label: `/${workflow.id}`,
				detail: workflow.name,
				insert: `/${workflow.id} `,
			});
			seen.add(workflow.id);
		}
		return [...base, ...extras];
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
		return MASTRA_PROVIDERS.map((item) => ({
			...item,
			active: item.id === this.settings.provider,
			configured: item.id === this.settings.provider
				? Boolean(this.settings.apiKey || !item.envVar)
				: Boolean(item.envVar && process.env[item.envVar]),
			modelCount: item.models.length,
		}));
	}

	async listThreads(): Promise<MemoryThread[]> {
		await this.ready;
		if (!this.memory?.listThreads) {
			return [];
		}
		const listed = await this.memory.listThreads({ filter: { resourceId: RESOURCE }, perPage: false });
		const threads = Array.isArray(listed) ? listed : listed.threads ?? [];
		const meta = await this.sessions.list();
		const byId = new Map(meta.map((row) => [row.id, row]));
		return threads.map((thread: any) => {
			const id = String(thread.id);
			const extra = byId.get(id);
			return {
				id,
				title: extra?.title || String(thread.title || 'Untitled'),
				resource: String(thread.resourceId || thread.resource || RESOURCE),
				createdAt: toMs(thread.createdAt),
				updatedAt: toMs(thread.updatedAt ?? thread.createdAt),
				pinned: extra?.pinned === true,
			};
		}).sort((a: MemoryThread, b: MemoryThread) => {
			if (a.pinned !== b.pinned) {
				return a.pinned ? -1 : 1;
			}
			return b.updatedAt - a.updatedAt;
		});
	}

	async createThread(title = 'New thread'): Promise<MemoryThread> {
		await this.ready;
		const thread = await this.memory.createThread({ resourceId: RESOURCE, title, metadata: { product: 'hawaldar' } });
		const created = {
			id: String(thread.id),
			title: String(thread.title || title),
			resource: RESOURCE,
			createdAt: toMs(thread.createdAt),
			updatedAt: toMs(thread.updatedAt ?? thread.createdAt),
			pinned: false,
		};
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
		await this.sessions.upsert({ id: threadId, title: next, pinned: current.pinned });
		await tryUpdateMastraTitle(this.memory, threadId, next);
		return { ...current, title: next, updatedAt: Date.now() };
	}

	async setThreadPinned(threadId: string, pinned: boolean): Promise<MemoryThread | undefined> {
		await this.ready;
		const current = (await this.listThreads()).find((item) => item.id === threadId);
		if (!current) {
			throw new Error('Unknown session.');
		}
		await this.sessions.upsert({ id: threadId, title: current.title, pinned });
		return { ...current, pinned };
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

	setActiveThread(threadId: string): void {
		this.activeThreadId = threadId;
	}

	async streamAgent(agentId: string, prompt: string, threadId: string, onDelta: (text: string) => void): Promise<string> {
		await this.ready;
		const agent = this.mastra.getAgentById(agentId);
		const stream = await agent.stream(prompt, {
			maxSteps: 10,
			memory: { thread: { id: threadId }, resource: RESOURCE },
			delegation: {
				onDelegationStart: async (context: { primitiveId: string }) => {
					this.exporter.pushLog('info', `delegate → ${context.primitiveId}`);
					return { proceed: true };
				},
			},
		});
		let text = '';
		const readable = stream.textStream;
		if (readable && typeof readable[Symbol.asyncIterator] === 'function') {
			for await (const chunk of readable as AsyncIterable<string>) {
				text += chunk;
				onDelta(chunk);
			}
		} else if (typeof stream.text === 'string') {
			text = stream.text;
			onDelta(text);
		} else if (stream.text && typeof stream.text.then === 'function') {
			text = await stream.text;
			onDelta(text);
		}
		return text;
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

	async runSequentialSteps(def: WorkflowRecord, input: Record<string, unknown>): Promise<string> {
		const settings = await this.store.read();
		const decision = evaluatePlaybookRules(this.playbooks.listRules(), def, settings);
		if (!decision.ok) {
			return `Rule denied: ${decision.reason}`;
		}
		if (typeof input.target === 'string' && input.target.trim()) {
			const { evaluateScope } = await import('./policy');
			const scope = evaluateScope(settings.scope, input.target);
			if (!scope.allow) {
				return `Policy denied: ${scope.reason}`;
			}
		}
		const parts: string[] = [];
		for (const step of def.steps) {
			if (step.kind === 'tool') {
				const result = await executeTool(settings, step.id, {
					target: typeof input.target === 'string' ? input.target : undefined,
					filePath: typeof input.filePath === 'string' ? input.filePath : undefined,
					pcapPath: typeof input.pcapPath === 'string' ? input.pcapPath : undefined,
					functionName: typeof input.functionName === 'string' ? input.functionName : undefined,
					address: typeof input.address === 'string' ? input.address : undefined,
					topPorts: typeof input.topPorts === 'number' ? input.topPorts : undefined,
					portRange: typeof input.portRange === 'string' ? input.portRange : undefined,
					scanType: typeof input.scanType === 'string' ? input.scanType : undefined,
					streamIndex: typeof input.streamIndex === 'number' ? input.streamIndex : undefined,
					streamProto: input.streamProto === 'udp' ? 'udp' : input.streamProto === 'tcp' ? 'tcp' : undefined,
					limit: typeof input.limit === 'number' ? input.limit : undefined,
				}, { rules: this.playbooks.listRules(), workflow: def });
				parts.push(`## ${step.id}\n${result.stdout || result.stderr}`);
			} else {
				const thread = await this.ensureThread();
				const message = String(input.message || input.target || input.filePath || input.pcapPath || def.name);
				const text = await this.streamAgent(step.id, message, thread.id, () => {});
				parts.push(`## agent:${step.id}\n${text || '(empty)'}`);
			}
		}
		return parts.join('\n\n') || '(empty workflow)';
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
			scope: this.settings.scope,
			agents: this.listAgents(),
			workflows: this.listWorkflows(),
			tools: this.listTools().map((tool) => ({ id: tool.id, source: tool.source, agentId: tool.agentId, enabled: tool.enabled })),
			excluded: EXCLUDED_MCP_TOOLS,
			logs: this.logs.slice(-12),
			traces: this.traces.slice(-12),
		};
	}

	private modelConfig() {
		const id = this.modelId();
		const local = ['custom', 'ollama', 'lmstudio'].includes(this.settings.provider)
			|| this.settings.baseUrl.includes('127.0.0.1') || this.settings.baseUrl.includes('localhost');
		if (local || this.settings.apiKey || this.settings.baseUrl) {
			return { id, url: this.settings.baseUrl || undefined, apiKey: this.settings.apiKey || undefined };
		}
		return id;
	}

	private build(mods: MastraModules): any {
		const store = new mods.LibSQLStore({ id: 'hawaldar-storage', url: `file:${this.databasePath}` });
		this.memory = new mods.Memory({ storage: store, options: { lastMessages: 40, generateTitle: true } });
		const model = this.modelConfig();
		const { z, createTool, createStep, createWorkflow, Agent, Mastra, PinoLogger, Observability, MastraStorageExporter, SensitiveDataFilter } = mods;
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
				description: 'Run a persisted Hawaldar workflow by id (tool/agent steps). Policy and rules apply.',
				inputSchema: z.object({
					workflowId: z.string(),
					target: z.string().optional(),
					filePath: z.string().optional(),
					pcapPath: z.string().optional(),
					message: z.string().optional(),
				}),
				execute: async (input: { workflowId: string; target?: string; filePath?: string; pcapPath?: string; message?: string }) => {
					const def = this.playbooks.getWorkflow(input.workflowId);
					if (!def) {
						throw new Error(`Unknown workflow: ${input.workflowId}`);
					}
					if (!def.enabled) {
						throw new Error(`Workflow ${def.id} is disabled.`);
					}
					return { output: await this.runSequentialSteps(def, input) };
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
		});
		for (const spec of TOOL_CATALOG) {
			tools[spec.id] = createTool({
				id: spec.id,
				description: `${spec.description} Built-in Hawaldar tool. Policy + Podman only.`,
				inputSchema: spec.agentId === 'nmap'
					? buildNmapInputSchema(z, spec.id)
					: spec.agentId === 'tshark'
						? buildTsharkInputSchema(z, spec.id)
						: toolInputSchema,
				execute: async (input: Record<string, unknown>) => executeTool(
					await this.store.read(),
					spec.id,
					input,
					{ rules: this.playbooks.listRules() },
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
				execute: async (input: Record<string, unknown>) => executeTool(
					await this.store.read(),
					custom.id,
					input,
					{ rules: this.playbooks.listRules() },
				),
			});
		}

		const specialists: Record<string, unknown> = {};
		for (const role of AGENT_ROLES) {
			if (role.id === 'orchestrator') {
				continue;
			}
			const owned = [
				...TOOL_CATALOG.filter((tool) => tool.agentId === role.id),
				...this.settings.customTools.filter((tool) => tool.enabled && tool.agentId === role.id),
			];
			const agentTools: Record<string, unknown> = { runtime_status: tools.runtime_status };
			for (const spec of owned) {
				agentTools[spec.id] = tools[spec.id];
			}
			specialists[role.id] = new Agent({
				id: role.id,
				name: role.name,
				description: role.role,
				instructions: this.prompts.instructionsFor(role.id, role.name, role.role),
				model,
				memory: this.memory,
				tools: agentTools,
			});
		}

		const orchestrator = new Agent({
			id: 'orchestrator',
			name: 'Orchestrator',
			description: 'Supervisor. Delegates to nmap, tshark, ghidra, and the other specialists.',
			instructions: this.prompts.instructionsFor(
				'orchestrator',
				'Orchestrator',
				'Supervisor. Delegates to specialists.',
			),
			model,
			memory: this.memory,
			tools,
			agents: specialists,
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
				if (!inputData.target) {
					return { ...inputData, allowed: false, reason: 'target is required' };
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

function toMs(value: unknown): number {
	if (typeof value === 'number') {
		return value;
	}
	if (value instanceof Date) {
		return value.getTime();
	}
	if (typeof value === 'string') {
		const parsed = Date.parse(value);
		return Number.isNaN(parsed) ? Date.now() : parsed;
	}
	return Date.now();
}
