import { contextBridge, ipcRenderer } from 'electron';
import type { ChatDeltaEvent, ChatRequest, HawaldarAPI, ListModelsRequest, NoteWrite, PodmanSetupProgress, PromptsWrite, QuitAskEvent, RuleWrite, SettingsWrite, TaskStatus, TaskWrite, WorkflowWrite } from './api';

let lastQuitAsk: QuitAskEvent | null = null;

ipcRenderer.on('quit:ask', (_: Electron.IpcRendererEvent, ev: QuitAskEvent) => {
	lastQuitAsk = ev;
});

const api: HawaldarAPI = {
	chatStream: (req: ChatRequest) => ipcRenderer.invoke('chat.stream', req),
	onChatDelta: (cb) => {
		const handler = (_: Electron.IpcRendererEvent, ev: ChatDeltaEvent) => cb(ev);
		ipcRenderer.on('chat.delta', handler);
		return () => ipcRenderer.removeListener('chat.delta', handler);
	},
	runWorkflow: (key, input) => ipcRenderer.invoke('workflow.run', key, input),
	getSettings: () => ipcRenderer.invoke('settings.read'),
	saveSettings: (patch: SettingsWrite) => ipcRenderer.invoke('settings.write', patch),
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
};

contextBridge.exposeInMainWorld('hawaldar', api);
