export interface CatalogItem {
	id: string;
	label: string;
	detail?: string;
	pinned?: boolean;
	updatedAt?: number;
	snippet?: string;
}

export interface ChatRequest {
	prompt: string;
	/** Bound Mastra thread. Omit on a welcome draft so the first send creates one. */
	threadId?: string;
	/** First selected slash command (compat with single-tool composers). */
	command?: string;
	/** All selected slash commands, in composer order. */
	commands?: string[];
}

export interface ChatHistoryQuery {
	limit?: number;
	/** Exclusive `createdAt` cursor (ms). Older pages pass the oldest loaded message time. */
	before?: number;
}

export interface ChatHistoryMessage {
	id: string;
	role: 'user' | 'assistant';
	text: string;
	createdAt: number;
}

export interface ChatHistoryPage {
	messages: ChatHistoryMessage[];
	hasMore: boolean;
}

export interface ChatStreamResult {
	requestId: string;
	text: string;
	threadId?: string;
	error?: string;
}

export interface ChatDeltaEvent {
	requestId: string;
	delta: string;
}

export type ChatActivityType = 'tool:start' | 'tool:done' | 'text' | 'agent';
export type ChatActivityStatus = 'start' | 'ok' | 'error' | 'text';

export interface ChatActivityEvent {
	requestId: string;
	type: ChatActivityType;
	name: string;
	detail: string;
	status: ChatActivityStatus;
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
	group?: string;
	groupLabel?: string;
	groupHint?: string;
	webLab?: boolean;
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
	/** Persist OpenRouter (and other) reasoning; not the API key. */
	thinking: boolean;
	/** Delete unpinned sessions older than this many days (by last updated). */
	sessionTtlDays: number;
	/** UI chrome locale. Legal LICENSE text stays English. */
	locale: string;
}

export interface LegalDocumentDTO {
	version: string;
	licenseName: string;
	licenseId: string;
	summary: string[];
	authorizedUse: string[];
	runtime: string[];
	disclaimer: string;
}

export interface LegalStatusDTO {
	accepted: boolean;
	version: string;
	currentVersion: string;
	acceptedAt: number | null;
	document: LegalDocumentDTO;
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
	thinking?: boolean;
	sessionTtlDays?: number;
	locale?: string;
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
	lane?: string;
	laneLabel?: string;
	webLab?: boolean;
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
	contextWindow?: number;
	free?: boolean;
	/** Formatted prompt rate, e.g. `$0.27/M` (USD per 1M prompt tokens). */
	priceLabel?: string;
	/** Numeric USD per 1M prompt tokens, when known. */
	promptPerMillion?: number;
	supportsReasoning?: boolean;
}

export interface ListModelsRequest {
	provider?: string;
	apiKey?: string;
	baseUrl?: string;
	/** Skip the in-process list cache (Settings “Refresh models”). */
	fresh?: boolean;
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

export type SlashCommandKind = 'command' | 'agent' | 'workflow';

export interface SlashCommandDTO {
	cmd: string;
	label: string;
	detail: string;
	insert?: string;
	title?: string;
	kind?: SlashCommandKind;
}

export interface PromptsWrite {
	system?: string;
	orchestrator?: string;
	specialist?: string;
	agents?: Record<string, string>;
	slashCommands?: SlashCommandDTO[];
	welcome?: string;
}

export type WorkflowStepKind = 'tool' | 'agent' | 'workflow';

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

export interface TaskTagDTO {
	id: string;
	title: string;
	createdAt: number;
}

export interface TaskTagWrite {
	id?: string;
	title: string;
}

export interface TaskDTO {
	id: string;
	title: string;
	status: TaskStatus;
	notes: string;
	createdAt: number;
	updatedAt: number;
	order: number;
	listId: string;
	listTitle: string;
	boardId: string;
	position: number;
	tags: TaskTagDTO[];
}

export interface TaskWrite {
	id?: string;
	title?: string;
	status?: TaskStatus;
	notes?: string;
	order?: number;
	listId?: string;
	position?: number;
	tagIds?: string[];
}

export interface TaskBoardInfoDTO {
	id: string;
	title: string;
	createdAt: number;
}

export interface TaskListDTO {
	id: string;
	boardId: string;
	title: string;
	position: number;
	statusKey: TaskStatus | '';
	createdAt: number;
}

export interface TaskListWrite {
	id?: string;
	boardId?: string;
	title: string;
	position?: number;
}

export interface TaskBoardDTO {
	board: TaskBoardInfoDTO;
	lists: TaskListDTO[];
	cards: TaskDTO[];
	tags: TaskTagDTO[];
}

export interface TaskMove {
	id: string;
	listId: string;
	beforeId?: string;
}

export type KnowledgeKind = 'note' | 'task' | 'playbook' | 'rule' | 'chat' | 'memory' | 'doc' | 'rag' | 'chunk' | 'knowledge';

export interface KnowledgeHitDTO {
	id: string;
	docId: string;
	kind: string;
	sourceId: string;
	title: string;
	text: string;
	score: number;
	mode: 'vector' | 'keyword';
}

export interface KnowledgeStatusDTO {
	lanceDir: string;
	vector: boolean;
	embedder: boolean;
	mode: 'vector' | 'keyword';
	docs: number;
	chunks: number;
	dimension: number;
	error?: string;
}

export interface GraphNodeDTO {
	id: string;
	kind: string;
	title: string;
	snippet: string;
	source?: string;
	color: string;
	val?: number;
}

export interface GraphLinkDTO {
	source: string;
	target: string;
	kind: string;
}

export interface KnowledgeGraphDTO {
	nodes: GraphNodeDTO[];
	links: GraphLinkDTO[];
	status: KnowledgeStatusDTO;
}

export type FindingClass = 'injection' | 'xss' | 'ssrf' | 'auth' | 'csrf' | 'ssti' | 'idor' | 'other';
export type FindingSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export type FindingStatus = 'hypothesis' | 'validating' | 'confirmed' | 'unconfirmed' | 'not-exploitable';

export interface FindingDTO {
	id: string;
	title: string;
	vulnClass: FindingClass;
	severity: FindingSeverity;
	status: FindingStatus;
	target: string;
	description: string;
	steps: string[];
	evidence: string;
	impact: string;
	remediation: string;
	references: string[];
	source: string;
	sessionId: string;
	createdAt: number;
	updatedAt: number;
}

export type EngagementPhaseStatus = 'pending' | 'active' | 'done' | 'failed' | 'skipped';

export interface EngagementPhaseDTO {
	id: string;
	label: string;
	status: EngagementPhaseStatus;
	detail: string;
	startedAt: number;
	endedAt: number;
}

export interface EngagementRunDTO {
	runId: string;
	workflowId: string;
	workflowName: string;
	target: string;
	startedAt: number;
	finishedAt: number;
	ok: boolean | undefined;
	phases: EngagementPhaseDTO[];
}

export interface HawaldarAPI {
	chatStream: (req: ChatRequest) => Promise<ChatStreamResult>;
	chatHistory: (sessionId: string, query?: ChatHistoryQuery) => Promise<ChatHistoryPage>;
	onChatDelta: (cb: (ev: ChatDeltaEvent) => void) => () => void;
	onChatActivity: (cb: (ev: ChatActivityEvent) => void) => () => void;
	runWorkflow: (key: string, input: Record<string, unknown>) => Promise<string>;
	listFindings: () => Promise<FindingDTO[]>;
	removeFinding: (id: string) => Promise<void>;
	clearFindings: () => Promise<number>;
	exportFindingsReport: (input?: { title?: string; target?: string }) => Promise<{ path: string; displayPath: string; findings: number }>;
	getEngagementState: () => Promise<EngagementRunDTO | null>;
	onFindingsChanged: (cb: () => void) => () => void;
	onEngagementEvent: (cb: (run: EngagementRunDTO) => void) => () => void;
	getSettings: () => Promise<SettingsDTO>;
	saveSettings: (patch: SettingsWrite) => Promise<SettingsDTO>;
	getLegal: () => Promise<LegalStatusDTO>;
	acceptLegal: () => Promise<LegalStatusDTO>;
	declineLegal: () => Promise<{ ok: boolean }>;
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
	getTaskBoard: (boardId?: string) => Promise<TaskBoardDTO>;
	upsertTaskList: (draft: TaskListWrite) => Promise<TaskListDTO>;
	removeTaskList: (id: string, moveToListId?: string) => Promise<TaskDTO[]>;
	reorderTaskLists: (boardId: string, orderedIds: string[]) => Promise<TaskListDTO[]>;
	listTaskTags: () => Promise<TaskTagDTO[]>;
	upsertTaskTag: (draft: TaskTagWrite) => Promise<TaskTagDTO>;
	removeTaskTag: (id: string) => Promise<void>;
	setTaskTags: (cardId: string, tagIds: string[]) => Promise<TaskDTO>;
	moveTask: (move: TaskMove) => Promise<TaskDTO>;
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
	knowledgeGraph: () => Promise<KnowledgeGraphDTO>;
	knowledgeSearch: (query: string, topK?: number) => Promise<KnowledgeHitDTO[]>;
	knowledgeIngest: (draft: { title: string; text: string; source?: string }) => Promise<{ chunks: number; mode: 'vector' | 'keyword' }>;
	knowledgeReindex: () => Promise<{ docs: number; chunks: number; mode: 'vector' | 'keyword' }>;
	knowledgeStatus: () => Promise<KnowledgeStatusDTO>;
	openExternal: (url: string) => Promise<{ ok: boolean }>;
	onQuitAsk: (cb: (ev: QuitAskEvent) => void) => () => void;
	confirmQuit: () => Promise<{ ok: boolean }>;
	cancelQuit: () => Promise<{ ok: boolean }>;
	onHitlAsk: (cb: (ev: HitlAskEvent) => void) => () => void;
	respondHitl: (requestId: string, approved: boolean) => Promise<{ ok: boolean }>;
	clearHitlApprovals: () => Promise<number>;
}

export interface QuitAskEvent {
	phase: 'ask' | 'stopping';
}

export type HitlKind = 'podman' | 'tool-image' | 'poc-probe';

export interface HitlAskEvent {
	requestId: string;
	kind: HitlKind;
	title: string;
	explanation: string;
	serviceId?: string;
}
