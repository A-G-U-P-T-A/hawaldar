import { contextBridge, ipcRenderer } from 'electron';
import type { ChatActivityEvent, ChatDeltaEvent, ChatHistoryQuery, ChatRequest, EngagementRunDTO, FindingFilterDTO, HawaldarAPI, HitlAskEvent, ListModelsRequest, NoteWrite, PodmanSetupProgress, PromptsWrite, QuitAskEvent, ReportFilterDTO, RuleWrite, SettingsWrite, TaskListWrite, TaskMove, TaskStatus, TaskTagWrite, TaskWrite, WorkflowWrite } from './api';

let lastQuitAsk: QuitAskEvent | null = null;
let lastHitlAsk: HitlAskEvent | null = null;

ipcRenderer.on('quit:ask', (_: Electron.IpcRendererEvent, ev: QuitAskEvent) => {
	lastQuitAsk = ev;
});

const api: HawaldarAPI = {
	chatStream: async (req: ChatRequest) => {
		try {
			return await ipcRenderer.invoke('chat.stream', req);
		} catch (error) {
			const raw = error instanceof Error ? error.message : String(error ?? '');
			const message = raw
				.replace(/^Error invoking remote method '[^']+':\s*/i, '')
				.replace(/^Error:\s*/i, '')
				.trim() || raw.trim() || 'Unknown error';
			return { requestId: '', text: message, error: message };
		}
	},
	chatHistory: (sessionId: string, query?: ChatHistoryQuery) => ipcRenderer.invoke('chat.history', sessionId, query ?? {}),
	onChatDelta: (cb) => {
		const handler = (_: Electron.IpcRendererEvent, ev: ChatDeltaEvent) => cb(ev);
		ipcRenderer.on('chat.delta', handler);
		return () => ipcRenderer.removeListener('chat.delta', handler);
	},
	onChatActivity: (cb) => {
		const handler = (_: Electron.IpcRendererEvent, ev: ChatActivityEvent) => cb(ev);
		ipcRenderer.on('chat.activity', handler);
		return () => ipcRenderer.removeListener('chat.activity', handler);
	},
	runWorkflow: (key, input) => ipcRenderer.invoke('workflow.run', key, input),
	listFindings: (filter?: FindingFilterDTO) => ipcRenderer.invoke('findings.list', filter ?? {}),
	removeFinding: (id) => ipcRenderer.invoke('findings.remove', id),
	clearFindings: () => ipcRenderer.invoke('findings.clear'),
	exportFindingsReport: (input) => ipcRenderer.invoke('findings.export', input ?? {}),
	informFinding: (id) => ipcRenderer.invoke('findings.inform', id),
	retestFinding: (id) => ipcRenderer.invoke('findings.retest', id),
	listReports: (filter?: ReportFilterDTO) => ipcRenderer.invoke('reports.list', filter ?? {}),
	createReport: (input) => ipcRenderer.invoke('reports.create', input ?? {}),
	readReport: (id) => ipcRenderer.invoke('reports.read', id),
	removeReport: (id) => ipcRenderer.invoke('reports.remove', id),
	getEngagementState: () => ipcRenderer.invoke('engagement.get'),
	onFindingsChanged: (cb) => {
		const handler = () => cb();
		ipcRenderer.on('findings.changed', handler);
		return () => ipcRenderer.removeListener('findings.changed', handler);
	},
	onReportsChanged: (cb) => {
		const handler = () => cb();
		ipcRenderer.on('reports.changed', handler);
		return () => ipcRenderer.removeListener('reports.changed', handler);
	},
	onEngagementEvent: (cb) => {
		const handler = (_: Electron.IpcRendererEvent, run: EngagementRunDTO) => cb(run);
		ipcRenderer.on('engagement.event', handler);
		return () => ipcRenderer.removeListener('engagement.event', handler);
	},
	getSettings: () => ipcRenderer.invoke('settings.read'),
	saveSettings: (patch: SettingsWrite) => ipcRenderer.invoke('settings.write', patch),
	getLegal: () => ipcRenderer.invoke('legal.read'),
	acceptLegal: () => ipcRenderer.invoke('legal.accept'),
	declineLegal: () => ipcRenderer.invoke('legal.decline'),
	getPrompts: () => ipcRenderer.invoke('prompts.read'),
	savePrompts: (patch: PromptsWrite) => ipcRenderer.invoke('prompts.write', patch),
	listSlashCommands: () => ipcRenderer.invoke('prompts.slashCommands'),
	listPlaybookWorkflows: () => ipcRenderer.invoke('playbook.workflows.list'),
	upsertWorkflow: (draft: WorkflowWrite) => ipcRenderer.invoke('playbook.workflows.upsert', draft),
	setWorkflowEnabled: (id, enabled) => ipcRenderer.invoke('playbook.workflows.enabled', id, enabled),
	removeWorkflow: (id) => ipcRenderer.invoke('playbook.workflows.remove', id),
	listRules: () => ipcRenderer.invoke('playbook.rules.list'),
	upsertRule: (draft: RuleWrite) => ipcRenderer.invoke('playbook.rules.upsert', draft),
	setRuleEnabled: (id, enabled) => ipcRenderer.invoke('playbook.rules.enabled', id, enabled),
	removeRule: (id) => ipcRenderer.invoke('playbook.rules.remove', id),
	listNotes: () => ipcRenderer.invoke('notes.list'),
	getNote: (id) => ipcRenderer.invoke('notes.get', id),
	upsertNote: (draft: NoteWrite) => ipcRenderer.invoke('notes.upsert', draft),
	removeNote: (id) => ipcRenderer.invoke('notes.remove', id),
	listTasks: () => ipcRenderer.invoke('tasks.list'),
	upsertTask: (draft: TaskWrite) => ipcRenderer.invoke('tasks.upsert', draft),
	setTaskStatus: (id, status: TaskStatus) => ipcRenderer.invoke('tasks.status', id, status),
	removeTask: (id) => ipcRenderer.invoke('tasks.remove', id),
	getTaskBoard: (boardId) => ipcRenderer.invoke('tasks.board', boardId),
	upsertTaskList: (draft: TaskListWrite) => ipcRenderer.invoke('tasks.list.upsert', draft),
	removeTaskList: (id, moveToListId) => ipcRenderer.invoke('tasks.list.remove', id, moveToListId),
	reorderTaskLists: (boardId, orderedIds) => ipcRenderer.invoke('tasks.list.reorder', boardId, orderedIds),
	listTaskTags: () => ipcRenderer.invoke('tasks.tags.list'),
	upsertTaskTag: (draft: TaskTagWrite) => ipcRenderer.invoke('tasks.tags.upsert', draft),
	removeTaskTag: (id) => ipcRenderer.invoke('tasks.tags.remove', id),
	setTaskTags: (cardId, tagIds) => ipcRenderer.invoke('tasks.card.tags', cardId, tagIds),
	moveTask: (move: TaskMove) => ipcRenderer.invoke('tasks.card.move', move),
	testPodman: (podmanPath) => ipcRenderer.invoke('podman.test', podmanPath),
	getPodmanStatus: () => ipcRenderer.invoke('podman.status'),
	getRuntimeState: () => ipcRenderer.invoke('runtimeState.get'),
	locatePodman: () => ipcRenderer.invoke('podman.locate'),
	browsePodman: () => ipcRenderer.invoke('podman.browse'),
	setPodmanPath: (podmanPath) => ipcRenderer.invoke('podman.setPath', podmanPath),
	setPodmanService: (serviceId, started) => ipcRenderer.invoke('podman.service', { serviceId, started }),
	setPodmanMachine: (action, name) => ipcRenderer.invoke('podman.machine', { action, name }),
	stopPodmanContainer: (nameOrId) => ipcRenderer.invoke('podman.stopContainer', nameOrId),
	setAutoStartMachine: (enabled) => ipcRenderer.invoke('podman.autoStartMachine', enabled),
	setContainerEngine: (engine) => ipcRenderer.invoke('podman.setEngine', engine),
	setupPodman: () => ipcRenderer.invoke('podman.setup'),
	onPodmanSetupProgress: (cb) => {
		const handler = (_: Electron.IpcRendererEvent, ev: PodmanSetupProgress) => cb(ev);
		ipcRenderer.on('podman.setup.progress', handler);
		return () => ipcRenderer.removeListener('podman.setup.progress', handler);
	},
	checkReadiness: () => ipcRenderer.invoke('tools.readiness'),
	listProviderCatalog: () => ipcRenderer.invoke('providers.catalog'),
	listModels: (req?: ListModelsRequest) => ipcRenderer.invoke('providers.listModels', req ?? {}),
	listAgents: () => ipcRenderer.invoke('catalog.agents'),
	listTools: () => ipcRenderer.invoke('catalog.tools'),
	listWorkflows: () => ipcRenderer.invoke('catalog.workflows'),
	listProviders: () => ipcRenderer.invoke('catalog.providers'),
	listThreads: () => ipcRenderer.invoke('catalog.threads'),
	listTraces: () => ipcRenderer.invoke('catalog.traces'),
	listLogs: () => ipcRenderer.invoke('catalog.logs'),
	getStatus: () => ipcRenderer.invoke('catalog.status'),
	createThread: () => ipcRenderer.invoke('threads.create'),
	renameThread: (id, title) => ipcRenderer.invoke('threads.rename', id, title),
	setThreadPinned: (id, pinned) => ipcRenderer.invoke('threads.setPinned', id, pinned),
	deleteThread: (id) => ipcRenderer.invoke('threads.delete', id),
	setActiveThread: (id) => ipcRenderer.invoke('threads.setActive', id),
	reloadRuntime: () => ipcRenderer.invoke('runtime.reload'),
	knowledgeGraph: () => ipcRenderer.invoke('knowledge.graph'),
	knowledgeSearch: (query, topK) => ipcRenderer.invoke('knowledge.search', query, topK),
	knowledgeIngest: (draft) => ipcRenderer.invoke('knowledge.ingest', draft),
	knowledgeReindex: () => ipcRenderer.invoke('knowledge.reindex'),
	knowledgeStatus: () => ipcRenderer.invoke('knowledge.status'),
	openExternal: (url) => ipcRenderer.invoke('shell.openExternal', url),
	onQuitAsk: (cb) => {
		const handler = (_: Electron.IpcRendererEvent, ev: QuitAskEvent) => {
			lastQuitAsk = ev;
			cb(ev);
		};
		if (lastQuitAsk) {
			cb(lastQuitAsk);
		}
		ipcRenderer.on('quit:ask', handler);
		return () => ipcRenderer.removeListener('quit:ask', handler);
	},
	confirmQuit: () => ipcRenderer.invoke('quit.confirm'),
	cancelQuit: () => {
		lastQuitAsk = null;
		return ipcRenderer.invoke('quit.cancel');
	},
	onHitlAsk: (cb) => {
		const handler = (_: Electron.IpcRendererEvent, ev: HitlAskEvent) => {
			lastHitlAsk = ev;
			cb(ev);
		};
		if (lastHitlAsk) {
			cb(lastHitlAsk);
		}
		ipcRenderer.on('hitl.ask', handler);
		return () => ipcRenderer.removeListener('hitl.ask', handler);
	},
	respondHitl: (requestId, approved) => {
		lastHitlAsk = null;
		return ipcRenderer.invoke('hitl.respond', { requestId, approved });
	},
	clearHitlApprovals: () => ipcRenderer.invoke('hitl.approvals.clear'),
};

contextBridge.exposeInMainWorld('hawaldar', api);
