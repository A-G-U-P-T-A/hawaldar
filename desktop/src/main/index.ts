import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HawaldarRuntime } from '../core/runtime';
import { SettingsStore } from '../core/settings';
import { collectHostInfo, looksLikeDockerBin } from '../core/sandbox/host-info';
import { podmanVersion } from '../core/sandbox/podman';
import { bootstrapPodmanMachine, startPodmanMachine, stopPodmanMachine, stopContainer, teardownRuntimeOnQuit } from '../core/sandbox/podman-control';
import {
	engineBin,
	listEngineAlternatives,
	podmanInstallHint,
	resolveEnginePath,
} from '../core/sandbox/podman-path';
import { setupPodmanRuntime } from '../core/sandbox/podman-provision';
import { persistRuntimeFromStatus, readRuntimeState } from '../core/sandbox/runtime-state';
import { buildPodmanStatus, startToolService, stopToolService } from '../core/sandbox/podman-services';
import { AGENT_ROLES } from '../core/tools/catalog';
import { checkToolReadiness } from '../core/tools/readiness';
import { MASTRA_PROVIDERS } from '../core/providers';
import { listProviderModels } from '../core/model-catalog';
import type { ChatRequest, ListModelsRequest, NoteWrite, PromptsWrite, RuleWrite, SettingsWrite, TaskStatus, TaskWrite, WorkflowWrite } from '../preload/api';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function resourcesRoot(): string {
	if (app.isPackaged) {
		return path.join(process.resourcesPath, 'resources');
	}
	return path.join(app.getAppPath(), 'resources');
}

function brandIconPath(): string {
	return path.join(resourcesRoot(), 'brand', 'hawaldar.png');
}

if (process.platform === 'win32') {
	app.setAppUserModelId('com.hawaldar.desktop');
}

let mainWindow: BrowserWindow | null = null;
let store: SettingsStore;
let runtime: HawaldarRuntime;

type QuitPhase = 'idle' | 'asking' | 'tearing-down' | 'confirmed';
let quitPhase: QuitPhase = 'idle';

const SPECIALISTS = new Set(AGENT_ROLES.map((item) => item.id).filter((id) => id !== 'orchestrator'));
const EXCLUSIVE_COMMANDS = new Set([
	'status',
	'memory',
	'agents',
	'tools',
	'readiness',
	'traces',
	'clear',
]);

function chatCommands(req: ChatRequest): string[] {
	const raw = Array.isArray(req.commands) && req.commands.length > 0
		? req.commands
		: (req.command ? [req.command] : []);
	const out: string[] = [];
	const seen = new Set<string>();
	for (const item of raw) {
		const cmd = String(item ?? '').trim().toLowerCase();
		if (!cmd || seen.has(cmd)) continue;
		seen.add(cmd);
		out.push(cmd);
	}
	return out;
}

function withSelectedTools(prompt: string, commands: string[]): string {
	if (commands.length <= 1) {
		return prompt;
	}
	const listed = commands.join(', ');
	return `The operator selected these slash tools: ${listed}. Prefer those specialists and gated tools only.\n\n${prompt}`;
}

function sendQuitAsk(phase: 'ask' | 'stopping'): void {
	if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
		mainWindow.webContents.send('quit:ask', { phase });
	}
}

function rendererCanShowQuitCard(): boolean {
	return Boolean(
		mainWindow
		&& !mainWindow.isDestroyed()
		&& !mainWindow.webContents.isDestroyed()
		&& !mainWindow.webContents.isLoadingMainFrame(),
	);
}

function requestQuitConfirm(): void {
	if (quitPhase === 'confirmed') {
		return;
	}
	if (quitPhase === 'tearing-down') {
		sendQuitAsk('stopping');
		return;
	}
	if (quitPhase === 'asking') {
		sendQuitAsk('ask');
		return;
	}
	quitPhase = 'asking';
	if (rendererCanShowQuitCard()) {
		sendQuitAsk('ask');
		return;
	}
	void nativeQuitFallback();
}

async function nativeQuitFallback(): Promise<void> {
	const opts = {
		type: 'question' as const,
		buttons: ['Cancel', 'Exit'],
		defaultId: 0,
		cancelId: 0,
		title: 'Hawaldar',
		message: 'Are you sure you want to exit?',
		detail: 'Machines and the container runtime will be stopped.',
		icon: brandIconPath(),
		noLink: true,
	};
	const result = mainWindow && !mainWindow.isDestroyed()
		? await dialog.showMessageBox(mainWindow, opts)
		: await dialog.showMessageBox(opts);
	if (result.response !== 1) {
		if (quitPhase === 'asking') {
			quitPhase = 'idle';
		}
		return;
	}
	await beginQuitTeardown();
}

async function stopPodmanOnQuit(): Promise<void> {
	try {
		const settings = await store.read();
		const engine = settings.containerEngine === 'docker' ? 'docker' : 'podman';
		const bin = engineBin(engine, settings.podmanPath);
		await teardownRuntimeOnQuit({ engine, bin, timeoutMs: 45_000 });
	} catch {
		// Best-effort: still quit.
	}
}

async function beginQuitTeardown(): Promise<void> {
	if (quitPhase === 'tearing-down' || quitPhase === 'confirmed') {
		return;
	}
	quitPhase = 'tearing-down';
	sendQuitAsk('stopping');
	await stopPodmanOnQuit();
	quitPhase = 'confirmed';
	app.exit(0);
}

function createWindow(): void {
	mainWindow = new BrowserWindow({
		width: 1280,
		height: 840,
		minWidth: 960,
		minHeight: 640,
		title: 'Hawaldar',
		icon: brandIconPath(),
		backgroundColor: '#1e1e1e',
		autoHideMenuBar: true,
		titleBarStyle: 'hidden',
		titleBarOverlay: {
			color: '#1e1e1e',
			symbolColor: '#cccccc',
			height: 36,
		},
		webPreferences: {
			preload: path.join(__dirname, '../preload/index.mjs'),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: false,
		},
	});

	if (process.env.ELECTRON_RENDERER_URL) {
		void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
	} else {
		void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
	}

	mainWindow.on('close', (event) => {
		if (quitPhase === 'confirmed') {
			return;
		}
		event.preventDefault();
		requestQuitConfirm();
	});

	mainWindow.on('closed', () => {
		mainWindow = null;
	});
}

function registerIpc(): void {
	ipcMain.handle('chat.stream', async (event, req: ChatRequest) => {
		await runtime.ready;
		const requestId = randomUUID();
		const thread = await runtime.ensureThread();
		const prompt = (req.prompt || '').trim();
		const commands = chatCommands(req);
		const command = commands[0] ?? req.command;
		const singleCommand = commands.length <= 1;

		const sendDelta = (delta: string) => {
			event.sender.send('chat.delta', { requestId, delta });
		};

		try {
			if (singleCommand && command && EXCLUSIVE_COMMANDS.has(command)) {
				if (command === 'status') {
					const snap = runtime.snapshot();
					const text = [
						'**Hawaldar · Mastra**',
						'',
						`- Model: \`${snap.model}\``,
						`- Provider: ${snap.provider}`,
						`- Tools: ${snap.tools.filter((item) => item.enabled).map((item) => item.id).join(', ')}`,
						`- Thread: \`${thread.id}\``,
						`- Policy: recon only. Podman only. No host shell.`,
					].join('\n');
					sendDelta(text);
					return { requestId, text };
				}
				if (command === 'memory') {
					const threads = await runtime.listThreads();
					const text = threads.length
						? threads.map((item) => `- ${item.title} (\`${item.id.slice(0, 8)}\`)`).join('\n')
						: 'No memory threads yet.';
					sendDelta(text);
					return { requestId, text };
				}
				if (command === 'agents') {
					const text = runtime.listAgents().map((item) => `- **${item.name}** (\`${item.id}\`) — ${item.role}`).join('\n');
					sendDelta(text);
					return { requestId, text };
				}
				if (command === 'tools') {
					const text = runtime.listTools().map((item) => {
						const name = item.title || item.id;
						const src = item.source || item.agentId;
						return `- **${name}** (\`${item.id}\`) · ${src}${item.enabled ? '' : ' · off'}`;
					}).join('\n');
					sendDelta(text);
					return { requestId, text };
				}
				if (command === 'readiness') {
					const settings = await store.read();
					const checks = await checkToolReadiness(settings, settings.customTools);
					const text = checks.map((item) => `- ${item.ok ? '✓' : '✗'} **${item.label}** — ${item.detail}`).join('\n');
					sendDelta(text);
					return { requestId, text };
				}
				if (command === 'traces') {
					const traces = runtime.traces.slice(-20).reverse();
					const text = traces.length
						? traces.map((item) => `- ${item.name}: ${item.detail}`).join('\n')
						: 'No traces yet.';
					sendDelta(text);
					return { requestId, text };
				}
				if (command === 'clear') {
					const created = await runtime.createThread();
					const text = `Started a new Mastra thread: **${created.title}**`;
					sendDelta(text);
					return { requestId, text };
				}
			}
			if (singleCommand && (command === 'workflow' || (command && !SPECIALISTS.has(command) && runtime.playbooks.getWorkflow(command)))) {
				const listed = runtime.listWorkflows().filter((item) => item.enabled);
				if (command === 'workflow' && !prompt) {
					const text = listed.length
						? listed.map((item) => `- **${item.name}** (\`/${item.id}\`)`).join('\n')
						: 'No enabled workflows. Add one in Settings → Workflows.';
					sendDelta(text);
					return { requestId, text };
				}
				let workflowKey = command === 'workflow' ? '' : command;
				let target = prompt;
				if (command === 'workflow') {
					const [maybeId, ...rest] = prompt.split(/\s+/);
					const named = runtime.playbooks.getWorkflow(maybeId);
					if (named) {
						workflowKey = named.key;
						target = rest.join(' ');
					} else {
						workflowKey = listed[0]?.key || 'authorizedRecon';
					}
				}
				const looksFile = /[\\/]/.test(target) || /\.(pcap|pcapng|exe|dll|so|bin)$/i.test(target);
				const input = looksFile && /\.pcap/i.test(target)
					? { pcapPath: target, message: target }
					: looksFile
						? { filePath: target, message: target }
						: { target, message: target || 'Inspect engagement state' };
				const output = await runtime.runWorkflow(workflowKey, input);
				const text = '```\n' + output + '\n```';
				sendDelta(text);
				return { requestId, text };
			}

			if (!prompt) {
				const cmds = runtime.slashCommands().slice(0, 8).map((item) => item.label).join(', ');
				const text = `Ask the Orchestrator, or use a slash command (${cmds}, …).`;
				sendDelta(text);
				return { requestId, text };
			}

			const specialists = commands.filter((item) => SPECIALISTS.has(item));
			const agentId = specialists.length === 1 && singleCommand ? specialists[0] : 'orchestrator';
			const text = await runtime.streamAgent(agentId, withSelectedTools(prompt, commands), thread.id, sendDelta);
			if (!text.trim()) {
				const fallback = 'No reply. Open **Settings** and set a provider / API key.';
				sendDelta(fallback);
				return { requestId, text: fallback };
			}
			return { requestId, text };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			sendDelta(message);
			return { requestId, text: message, error: message };
		}
	});

	ipcMain.handle('workflow.run', async (_e, key: string, input: Record<string, unknown>) => {
		await runtime.ready;
		return runtime.runWorkflow(key, input);
	});

	const settingsDto = async () => {
		const s = await store.read();
		const host = collectHostInfo();
		return {
			provider: s.provider,
			model: s.model,
			baseUrl: s.baseUrl,
			apiKey: '',
			podmanPath: s.podmanPath,
			scope: s.scope,
			toolImages: s.toolImages,
			enabledTools: s.enabledTools,
			customTools: s.customTools,
			startedServices: s.startedServices,
			autoStartMachine: s.autoStartMachine,
			containerEngine: s.containerEngine === 'docker' ? 'docker' as const : 'podman' as const,
			host: {
				os: host.os,
				osLabel: host.osLabel,
				arch: host.arch,
				cpus: host.cpus,
				memoryGiB: host.memoryGiB,
				needsLinuxVm: host.needsLinuxVm,
				virtHint: host.virtHint,
			},
			alternatives: listEngineAlternatives(s.containerEngine, s.podmanPath),
			hasApiKey: Boolean(s.apiKey),
			hasSelectedProvider: s.hasSelectedProvider === true,
		};
	};

	ipcMain.handle('settings.read', async () => settingsDto());

	ipcMain.handle('settings.write', async (_e, patch: SettingsWrite) => {
		await store.write(patch);
		await runtime.reload();
		return settingsDto();
	});

	ipcMain.handle('podman.test', async (_e, podmanPath: string) => {
		const settings = await store.read();
		const looksDocker = looksLikeDockerBin(podmanPath || '') || settings.containerEngine === 'docker';
		const engine: 'podman' | 'docker' = looksDocker ? 'docker' : 'podman';
		const resolved = resolveEnginePath(engine, podmanPath || (looksDocker ? 'docker' : 'podman'));
		if (!resolved.path) {
			return {
				ok: false,
				path: podmanPath || (looksDocker ? 'docker' : 'podman'),
				text: `${resolved.error || (looksDocker ? 'Docker not found.' : 'Podman not found.')}\n${podmanInstallHint()}`,
			};
		}
		if (resolved.path !== podmanPath || (looksDocker && settings.containerEngine !== 'docker')) {
			await store.write({
				podmanPath: resolved.path,
				containerEngine: looksDocker ? 'docker' : 'podman',
			});
		}
		try {
			const result = await podmanVersion(resolved.path);
			const version = result.stdout.trim() || result.stderr || `exit ${result.exitCode}`;
			const ok = result.exitCode === 0 && !result.timedOut;
			return {
				ok,
				path: resolved.path,
				text: resolved.path === podmanPath ? version : `Using ${resolved.path}\n${version}`,
			};
		} catch (error) {
			return {
				ok: false,
				path: resolved.path,
				text: error instanceof Error ? error.message : String(error),
			};
		}
	});

	const livePodmanStatus = async (extras?: { lastSetupOk?: boolean; lastError?: string }) => {
		const status = await buildPodmanStatus(await store.read());
		try {
			const persisted = await persistRuntimeFromStatus(status, extras);
			return { ...status, persisted };
		} catch {
			const persisted = await readRuntimeState().catch(() => null);
			return { ...status, persisted };
		}
	};

	ipcMain.handle('runtimeState.get', async () => readRuntimeState());

	ipcMain.handle('podman.locate', async () => {
		const settings = await store.read();
		const engine = settings.containerEngine === 'docker' ? 'docker' : 'podman';
		const resolved = resolveEnginePath(engine, settings.podmanPath);
		if (resolved.path && resolved.path !== settings.podmanPath) {
			await store.write({ podmanPath: resolved.path });
		}
		return livePodmanStatus();
	});

	ipcMain.handle('podman.browse', async () => {
		const browseOpts = {
			title: process.platform === 'win32' ? 'Locate podman.exe or docker.exe' : 'Locate podman or docker',
			properties: ['openFile'] as Array<'openFile'>,
			filters: process.platform === 'win32'
				? [
					{ name: 'Container CLI', extensions: ['exe'] },
					{ name: 'All files', extensions: ['*'] },
				]
				: undefined,
		};
		const result = mainWindow
			? await dialog.showOpenDialog(mainWindow, browseOpts)
			: await dialog.showOpenDialog(browseOpts);
		if (result.canceled || !result.filePaths[0]) {
			return { canceled: true as const };
		}
		const chosen = result.filePaths[0];
		await store.write({
			podmanPath: chosen,
			containerEngine: looksLikeDockerBin(chosen) ? 'docker' : 'podman',
		});
		return {
			canceled: false as const,
			path: chosen,
			status: await livePodmanStatus(),
		};
	});

	ipcMain.handle('podman.setPath', async (_e, podmanPath: string) => {
		const trimmed = podmanPath.trim();
		const patch: SettingsWrite = { podmanPath: trimmed };
		if (looksLikeDockerBin(trimmed)) {
			patch.containerEngine = 'docker';
		} else if (/podman(\.exe)?$/i.test(trimmed)) {
			patch.containerEngine = 'podman';
		}
		await store.write(patch);
		return livePodmanStatus();
	});

	ipcMain.handle('podman.status', async () => livePodmanStatus());

	ipcMain.handle('podman.service', async (_e, req: { serviceId: string; started: boolean }) => {
		const settings = await store.read();
		const result = req.started
			? await startToolService(settings, req.serviceId)
			: await stopToolService(settings, req.serviceId);
		const patch: { startedServices?: string[]; toolImages?: Record<string, string> } = {};
		if (result.settings.startedServices) {
			patch.startedServices = result.settings.startedServices;
		}
		if ('toolImages' in result.settings && result.settings.toolImages) {
			patch.toolImages = result.settings.toolImages as Record<string, string>;
		}
		if (patch.startedServices || patch.toolImages) {
			await store.write(patch);
			await runtime.reload();
		}
		const status = await livePodmanStatus({ lastError: result.ok ? '' : result.detail });
		return { ok: result.ok, detail: result.detail, status };
	});

	ipcMain.handle('podman.machine', async (_e, req: { action: 'start' | 'stop' | 'init' | 'restart'; name?: string }) => {
		const settings = await store.read();
		const engine = settings.containerEngine === 'docker' ? 'docker' : 'podman';
		const bin = engineBin(engine, settings.podmanPath);
		let result: { ok: boolean; detail: string };
		if (req.action === 'init') {
			result = await bootstrapPodmanMachine(bin);
		} else if (req.action === 'start') {
			result = await startPodmanMachine(bin, req.name);
		} else if (req.action === 'restart') {
			const stopped = await stopPodmanMachine(bin, req.name);
			if (!stopped.ok) {
				result = stopped;
			} else {
				result = await startPodmanMachine(bin, req.name);
			}
		} else {
			result = await stopPodmanMachine(bin, req.name);
		}
		const status = await livePodmanStatus({
			lastSetupOk: result.ok && req.action !== 'stop' ? true : undefined,
			lastError: result.ok ? '' : result.detail,
		});
		return { ok: result.ok, detail: result.detail, status };
	});

	ipcMain.handle('podman.stopContainer', async (_e, nameOrId: string) => {
		const settings = await store.read();
		const engine = settings.containerEngine === 'docker' ? 'docker' : 'podman';
		const result = await stopContainer(engineBin(engine, settings.podmanPath), nameOrId);
		const status = await livePodmanStatus();
		return { ok: result.ok, detail: result.detail, status };
	});

	ipcMain.handle('podman.autoStartMachine', async (_e, enabled: boolean) => {
		await store.write({ autoStartMachine: Boolean(enabled) });
		return livePodmanStatus();
	});

	ipcMain.handle('podman.setEngine', async (_e, engine: 'podman' | 'docker') => {
		const next = engine === 'docker' ? 'docker' : 'podman';
		const settings = await store.read();
		const resolved = resolveEnginePath(next, settings.podmanPath);
		await store.write({
			containerEngine: next,
			podmanPath: resolved.path || (next === 'docker' ? 'docker' : 'podman'),
		});
		return livePodmanStatus();
	});

	ipcMain.handle('podman.setup', async () => {
		const settings = await store.read();
		const result = await setupPodmanRuntime({
			preferredPath: settings.podmanPath,
			engine: settings.containerEngine,
			persistPath: async (podmanPath) => {
				await store.write({
					podmanPath,
					containerEngine: settings.containerEngine === 'docker' ? 'docker' : 'podman',
				});
			},
			onProgress: (progress) => {
				mainWindow?.webContents.send('podman.setup.progress', progress);
			},
		});
		const status = await livePodmanStatus({
			lastSetupOk: result.ok,
			lastError: result.ok ? '' : result.detail,
		});
		return {
			ok: result.ok,
			detail: result.detail,
			step: result.step,
			status,
		};
	});

	ipcMain.handle('tools.readiness', async () => {
		const settings = await store.read();
		return checkToolReadiness(settings, settings.customTools);
	});

	ipcMain.handle('prompts.read', async () => runtime.prompts.read());

	ipcMain.handle('prompts.write', async (_e, patch: PromptsWrite) => {
		const next = runtime.prompts.write(patch);
		await runtime.reload();
		return next;
	});

	ipcMain.handle('prompts.slashCommands', async () => {
		await runtime.ready;
		return runtime.slashCommands();
	});

	ipcMain.handle('playbook.workflows.list', async () => {
		await runtime.ready;
		return runtime.playbooks.listWorkflows();
	});

	ipcMain.handle('playbook.workflows.upsert', async (_e, draft: WorkflowWrite) => {
		await runtime.ready;
		const settings = await store.read();
		const row = await runtime.playbooks.upsertWorkflow(draft, settings);
		await runtime.reload();
		return row;
	});

	ipcMain.handle('playbook.workflows.enabled', async (_e, id: string, enabled: boolean) => {
		await runtime.ready;
		const row = await runtime.playbooks.setWorkflowEnabled(id, enabled);
		await runtime.reload();
		return row;
	});

	ipcMain.handle('playbook.workflows.remove', async (_e, id: string) => {
		await runtime.ready;
		await runtime.playbooks.removeWorkflow(id);
		await runtime.reload();
	});

	ipcMain.handle('playbook.rules.list', async () => {
		await runtime.ready;
		return runtime.playbooks.listRules();
	});

	ipcMain.handle('playbook.rules.upsert', async (_e, draft: RuleWrite) => {
		await runtime.ready;
		const row = await runtime.playbooks.upsertRule(draft);
		await runtime.reload();
		return row;
	});

	ipcMain.handle('playbook.rules.enabled', async (_e, id: string, enabled: boolean) => {
		await runtime.ready;
		const row = await runtime.playbooks.setRuleEnabled(id, enabled);
		await runtime.reload();
		return row;
	});

	ipcMain.handle('playbook.rules.remove', async (_e, id: string) => {
		await runtime.ready;
		await runtime.playbooks.removeRule(id);
		await runtime.reload();
	});

	ipcMain.handle('notes.list', async () => {
		await runtime.ready;
		return runtime.notes.list();
	});

	ipcMain.handle('notes.get', async (_e, id: string) => {
		await runtime.ready;
		return runtime.notes.get(id);
	});

	ipcMain.handle('notes.upsert', async (_e, draft: NoteWrite) => {
		await runtime.ready;
		return runtime.notes.upsert(draft);
	});

	ipcMain.handle('notes.remove', async (_e, id: string) => {
		await runtime.ready;
		await runtime.notes.remove(id);
	});

	ipcMain.handle('tasks.list', async () => {
		await runtime.ready;
		return runtime.tasks.list();
	});

	ipcMain.handle('tasks.upsert', async (_e, draft: TaskWrite) => {
		await runtime.ready;
		return runtime.tasks.upsert(draft);
	});

	ipcMain.handle('tasks.status', async (_e, id: string, status: TaskStatus) => {
		await runtime.ready;
		return runtime.tasks.setStatus(id, status);
	});

	ipcMain.handle('tasks.remove', async (_e, id: string) => {
		await runtime.ready;
		await runtime.tasks.remove(id);
	});

	ipcMain.handle('providers.catalog', async () => {
		return MASTRA_PROVIDERS.map((item) => ({
			id: item.id,
			label: item.label,
			envVar: item.envVar,
			defaultBaseUrl: item.defaultBaseUrl,
			models: item.models,
			listKind: item.listKind,
		}));
	});

	ipcMain.handle('providers.listModels', async (_e, req: ListModelsRequest = {}) => {
		const settings = await store.read();
		const provider = req.provider || settings.provider;
		const apiKey = req.apiKey !== undefined && req.apiKey !== '' ? req.apiKey : settings.apiKey;
		const baseUrl = req.baseUrl !== undefined && req.baseUrl !== '' ? req.baseUrl : settings.baseUrl;
		return listProviderModels(provider, apiKey, baseUrl);
	});

	ipcMain.handle('catalog.agents', async () => {
		await runtime.ready;
		return runtime.listAgents().map((item) => ({ id: item.id, label: item.name, detail: item.role }));
	});

	ipcMain.handle('catalog.tools', async () => {
		await runtime.ready;
		return runtime.listTools().map((item) => ({
			id: item.id,
			label: item.enabled ? (item.title || item.id) : `${item.title || item.id} · off`,
			detail: item.source || item.agentId,
		}));
	});

	ipcMain.handle('catalog.workflows', async () => {
		await runtime.ready;
		return runtime.listWorkflows().map((item) => ({
			id: item.key,
			label: item.enabled ? item.name : `${item.name} · off`,
			detail: item.id,
		}));
	});

	ipcMain.handle('catalog.providers', async () => {
		await runtime.ready;
		return runtime.listProviders().map((item) => ({
			id: item.id,
			label: item.active ? `${item.label} · active` : item.label,
			detail: item.configured
				? `${item.envVar || item.defaultBaseUrl} · ${item.models.length} default models`
				: 'not configured',
		}));
	});

	ipcMain.handle('catalog.threads', async () => {
		await runtime.ready;
		const threads = await runtime.listThreads();
		return threads.map((item) => ({
			id: item.id,
			label: item.title,
			detail: item.id === runtime.activeThreadId ? 'active' : item.id.slice(0, 8),
			pinned: item.pinned,
		}));
	});

	ipcMain.handle('catalog.traces', async () => {
		await runtime.ready;
		return runtime.traces.slice().reverse().slice(0, 40).map((item) => ({
			id: item.id,
			label: item.name,
			detail: `${item.type} ${item.detail}`.trim(),
		}));
	});

	ipcMain.handle('catalog.logs', async () => {
		await runtime.ready;
		return runtime.logs.slice().reverse().slice(0, 40).map((item, index) => ({
			id: `${item.at}-${index}`,
			label: item.level,
			detail: item.message,
		}));
	});

	ipcMain.handle('catalog.status', async () => {
		await runtime.ready;
		return runtime.snapshot();
	});

	ipcMain.handle('threads.create', async () => {
		const thread = await runtime.createThread();
		return { id: thread.id, label: thread.title, detail: 'active', pinned: false };
	});

	ipcMain.handle('threads.rename', async (_e, id: string, title: string) => {
		const thread = await runtime.renameThread(id, title);
		if (!thread) {
			throw new Error('Unknown session.');
		}
		return {
			id: thread.id,
			label: thread.title,
			detail: thread.id === runtime.activeThreadId ? 'active' : thread.id.slice(0, 8),
			pinned: thread.pinned,
		};
	});

	ipcMain.handle('threads.setPinned', async (_e, id: string, pinned: boolean) => {
		const thread = await runtime.setThreadPinned(id, Boolean(pinned));
		if (!thread) {
			throw new Error('Unknown session.');
		}
		return {
			id: thread.id,
			label: thread.title,
			detail: thread.id === runtime.activeThreadId ? 'active' : thread.id.slice(0, 8),
			pinned: thread.pinned,
		};
	});

	ipcMain.handle('threads.delete', async (_e, id: string) => {
		await runtime.deleteThread(id);
	});

	ipcMain.handle('threads.setActive', async (_e, id: string) => {
		runtime.setActiveThread(id);
	});

	ipcMain.handle('runtime.reload', async () => {
		await runtime.reload();
	});

	ipcMain.handle('quit.confirm', async () => {
		void beginQuitTeardown();
		return { ok: true as const };
	});

	ipcMain.handle('quit.cancel', async () => {
		if (quitPhase === 'tearing-down' || quitPhase === 'confirmed') {
			return { ok: false as const };
		}
		quitPhase = 'idle';
		return { ok: true as const };
	});
}

app.whenReady().then(() => {
	if (process.platform === 'darwin') {
		app.dock?.setIcon(brandIconPath());
	}
	store = new SettingsStore(resourcesRoot());
	runtime = new HawaldarRuntime(store);
	registerIpc();
	createWindow();

	app.on('activate', () => {
		if (BrowserWindow.getAllWindows().length === 0) {
			createWindow();
		}
	});
});

app.on('before-quit', (event) => {
	if (quitPhase === 'confirmed') {
		return;
	}
	event.preventDefault();
	requestQuitConfirm();
});

app.on('window-all-closed', () => {
	if (process.platform !== 'darwin' && quitPhase === 'confirmed') {
		app.quit();
	}
});
