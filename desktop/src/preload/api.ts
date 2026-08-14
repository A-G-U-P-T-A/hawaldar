export interface CatalogItem {
	id: string;
	label: string;
	detail?: string;
	pinned?: boolean;
}

export interface ChatRequest {
	prompt: string;
	/** First selected slash command (compat with single-tool composers). */
	command?: string;
	/** All selected slash commands, in composer order. */
	commands?: string[];
}

export interface ChatDeltaEvent {
	requestId: string;
	delta: string;
}

export interface ChatDoneEvent {
	requestId: string;
	text: string;
	error?: string;
}

export interface CustomToolDTO {
	id: string;
	title: string;
	kind: 'host' | 'file' | 'pcap';
	agentId: string;
	image: string;
	command: string;
	argsTemplate: string[];
	network: 'none' | 'target';
	timeoutMs: number;
	description: string;
	enabled: boolean;
}

export interface ReadinessCheckDTO {
	id: string;
	label: string;
	ok: boolean;
	detail: string;
}

export interface HostInfoDTO {
	os: 'windows' | 'macos' | 'linux' | 'other';
	osLabel: string;
	arch: string;
	cpus: number;
	memoryGiB: number;
	needsLinuxVm: boolean;
	virtHint: string;
}

export interface EngineAlternativeDTO {
	engine: 'podman' | 'docker';
	path?: string;
	available: boolean;
}

export interface SettingsDTO {
	provider: string;
	model: string;
	baseUrl: string;
	apiKey: string;
	podmanPath: string;
	scope: string[];
	toolImages: Record<string, string>;
	enabledTools: string[];
	customTools: CustomToolDTO[];
	startedServices: string[];
	autoStartMachine: boolean;
	containerEngine: 'podman' | 'docker';
	host: HostInfoDTO;
	alternatives: EngineAlternativeDTO[];
	hasApiKey: boolean;
	hasSelectedProvider: boolean;
}

export interface SettingsWrite {
	provider?: string;
	model?: string;
	baseUrl?: string;
	apiKey?: string;
	podmanPath?: string;
	scopeText?: string;
	toolImages?: Record<string, string>;
	enabledTools?: string[];
	customTools?: CustomToolDTO[];
	startedServices?: string[];
	autoStartMachine?: boolean;
	containerEngine?: 'podman' | 'docker';
}

export interface PodmanMachineDTO {
	name: string;
	running: boolean;
	starting?: boolean;
	lastUp?: string;
	cpus?: number;
	memoryMiB?: number;
}

export interface PodmanContainerDTO {
	id: string;
	name: string;
	image: string;
	status: string;
	state: string;
	created: string;
	hawaldar: boolean;
}

export interface PodmanServiceDTO {
	id: string;
	label: string;
	image: string;
	started: boolean;
	imagePresent: boolean;
	detail: string;
}

export type PodmanAvailability = 'ok' | 'not_installed' | 'machine_stopped' | 'no_machine' | 'error';

export type PodmanSetupStep = 'locating' | 'installing' | 'starting_machine' | 'ready';

export interface PodmanSetupProgress {
	step: PodmanSetupStep;
	message: string;
	detail?: string;
	failed?: boolean;
}

export interface PodmanSetupResult {
	ok: boolean;
	detail: string;
	step: PodmanSetupStep;
	status: PodmanStatusDTO;
}

export interface RuntimeStateDTO {
	engine: 'podman' | 'docker';
	resolvedPath: string;
	machineName: string;
	machineRunning: boolean;
	lastSetupOk: boolean;
	lastError: string;
	updatedAt: number;
}

export interface PodmanStatusDTO {
	ok: boolean;
	availability: PodmanAvailability;
	version: string;
	error?: string;
	hint?: string;
	resolvedPath: string;
	engine: 'podman' | 'docker';
	host: HostInfoDTO;
	alternatives: EngineAlternativeDTO[];
	machines: PodmanMachineDTO[];
	containers: PodmanContainerDTO[];
	services: PodmanServiceDTO[];
	autoStartMachine: boolean;
	canInitMachine: boolean;
	workspace: {
		hostPath: string;
		displayPath: string;
		containerPath: string;
	};
	persisted: RuntimeStateDTO | null;
}

export interface PodmanTestResult {
	ok: boolean;
	path: string;
	text: string;
}

export interface ProviderOption {
	id: string;
	label: string;
	envVar: string;
	defaultBaseUrl: string;
	models: string[];
	listKind: string;
}

export interface ListedModel {
	id: string;
	label: string;
	source: 'api' | 'fallback';
}

export interface ListModelsRequest {
	provider?: string;
	apiKey?: string;
	baseUrl?: string;
}

export interface ListModelsResult {
	provider: string;
	models: ListedModel[];
	error?: string;
}

export interface PromptsDTO {
	system: string;
	orchestrator: string;
	specialist: string;
	agents: Record<string, string>;
	slashCommands: SlashCommandDTO[];
	welcome: string;
}

export interface SlashCommandDTO {
	cmd: string;
	label: string;
	detail: string;
	insert?: string;
}

export interface PromptsWrite {
	system?: string;
	orchestrator?: string;
	specialist?: string;
	agents?: Record<string, string>;
	slashCommands?: SlashCommandDTO[];
	welcome?: string;
}

export type WorkflowStepKind = 'tool' | 'agent';

export interface WorkflowStepDTO {
	kind: WorkflowStepKind;
	id: string;
}

export interface WorkflowDTO {
	id: string;
	key: string;
	name: string;
	steps: WorkflowStepDTO[];
	enabled: boolean;
	builtin: boolean;
	updatedAt: number;
}

export interface WorkflowWrite {
	id?: string;
	name: string;
	steps: WorkflowStepDTO[];
	enabled?: boolean;
}

export type RuleKind = 'require_service' | 'max_timeout' | 'allowed_tools' | 'blocked_tools';

export interface RuleDefinitionDTO {
	workflowId?: string;
	serviceId?: string;
	timeoutMs?: number;
	toolIds?: string[];
}

export interface RuleDTO {
	id: string;
	name: string;
	kind: RuleKind;
	definition: RuleDefinitionDTO;
	enabled: boolean;
	updatedAt: number;
}

export interface RuleWrite {
	id?: string;
	name: string;
	kind: RuleKind;
	definition: RuleDefinitionDTO;
	enabled?: boolean;
}

export interface NoteSummaryDTO {
	id: string;
	title: string;
	path: string;
	updatedAt: number;
}

export interface NoteDTO extends NoteSummaryDTO {
	body: string;
}

export interface NoteWrite {
	id?: string;
	title: string;
	body: string;
}

export type TaskStatus = 'open' | 'doing' | 'done';

export interface TaskDTO {
	id: string;
	title: string;
	status: TaskStatus;
	notes: string;
	createdAt: number;
	updatedAt: number;
	order: number;
}

export interface TaskWrite {
	id?: string;
	title?: string;
	status?: TaskStatus;
	notes?: string;
	order?: number;
}

export interface HawaldarAPI {
	chatStream: (req: ChatRequest) => Promise<{ requestId: string; text: string }>;
	onChatDelta: (cb: (ev: ChatDeltaEvent) => void) => () => void;
	runWorkflow: (key: string, input: Record<string, unknown>) => Promise<string>;
	getSettings: () => Promise<SettingsDTO>;
	saveSettings: (patch: SettingsWrite) => Promise<SettingsDTO>;
	getPrompts: () => Promise<PromptsDTO>;
	savePrompts: (patch: PromptsWrite) => Promise<PromptsDTO>;
	listSlashCommands: () => Promise<SlashCommandDTO[]>;
	listPlaybookWorkflows: () => Promise<WorkflowDTO[]>;
	upsertWorkflow: (draft: WorkflowWrite) => Promise<WorkflowDTO>;
	setWorkflowEnabled: (id: string, enabled: boolean) => Promise<WorkflowDTO>;
	removeWorkflow: (id: string) => Promise<void>;
	listRules: () => Promise<RuleDTO[]>;
	upsertRule: (draft: RuleWrite) => Promise<RuleDTO>;
	setRuleEnabled: (id: string, enabled: boolean) => Promise<RuleDTO>;
	removeRule: (id: string) => Promise<void>;
	listNotes: () => Promise<NoteSummaryDTO[]>;
	getNote: (id: string) => Promise<NoteDTO>;
	upsertNote: (draft: NoteWrite) => Promise<NoteDTO>;
	removeNote: (id: string) => Promise<void>;
	listTasks: () => Promise<TaskDTO[]>;
	upsertTask: (draft: TaskWrite) => Promise<TaskDTO>;
	setTaskStatus: (id: string, status: TaskStatus) => Promise<TaskDTO>;
	removeTask: (id: string) => Promise<void>;
	testPodman: (podmanPath: string) => Promise<PodmanTestResult>;
	getPodmanStatus: () => Promise<PodmanStatusDTO>;
	getRuntimeState: () => Promise<RuntimeStateDTO | null>;
	locatePodman: () => Promise<PodmanStatusDTO>;
	browsePodman: () => Promise<{ canceled: boolean; path?: string; status?: PodmanStatusDTO }>;
	setPodmanPath: (podmanPath: string) => Promise<PodmanStatusDTO>;
	setPodmanService: (serviceId: string, started: boolean) => Promise<{ ok: boolean; detail: string; status: PodmanStatusDTO }>;
	setPodmanMachine: (action: 'start' | 'stop' | 'init' | 'restart', name?: string) => Promise<{ ok: boolean; detail: string; status: PodmanStatusDTO }>;
	stopPodmanContainer: (nameOrId: string) => Promise<{ ok: boolean; detail: string; status: PodmanStatusDTO }>;
	setAutoStartMachine: (enabled: boolean) => Promise<PodmanStatusDTO>;
	setContainerEngine: (engine: 'podman' | 'docker') => Promise<PodmanStatusDTO>;
	setupPodman: () => Promise<PodmanSetupResult>;
	onPodmanSetupProgress: (cb: (ev: PodmanSetupProgress) => void) => () => void;
	checkReadiness: () => Promise<ReadinessCheckDTO[]>;
	listProviderCatalog: () => Promise<ProviderOption[]>;
	listModels: (req?: ListModelsRequest) => Promise<ListModelsResult>;
	listAgents: () => Promise<CatalogItem[]>;
	listTools: () => Promise<CatalogItem[]>;
	listWorkflows: () => Promise<CatalogItem[]>;
	listProviders: () => Promise<CatalogItem[]>;
	listThreads: () => Promise<CatalogItem[]>;
	listTraces: () => Promise<CatalogItem[]>;
	listLogs: () => Promise<CatalogItem[]>;
	getStatus: () => Promise<Record<string, unknown>>;
	createThread: () => Promise<CatalogItem>;
	renameThread: (id: string, title: string) => Promise<CatalogItem>;
	setThreadPinned: (id: string, pinned: boolean) => Promise<CatalogItem>;
	deleteThread: (id: string) => Promise<void>;
	setActiveThread: (id: string) => Promise<void>;
	reloadRuntime: () => Promise<void>;
	onQuitAsk: (cb: (ev: QuitAskEvent) => void) => () => void;
	confirmQuit: () => Promise<{ ok: boolean }>;
	cancelQuit: () => Promise<{ ok: boolean }>;
}

export interface QuitAskEvent {
	phase: 'ask' | 'stopping';
}
