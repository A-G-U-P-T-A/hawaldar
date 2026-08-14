import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { CustomToolDTO, ListedModel, PodmanSetupProgress, PodmanStatusDTO, PromptsDTO, ProviderOption, ReadinessCheckDTO, RuntimeStateDTO, SettingsDTO } from '../../preload/api';
import Dropdown from './Dropdown';
import { dockerIsAvailable, hostCardLine, setupCtaDetail, WORKSPACE_DISPLAY_FALLBACK } from './hostCopy';
import PodmanSetupSteps from './PodmanSetupSteps';
import NotesSettings from './NotesSettings';
import RulesSettings from './RulesSettings';
import RuntimeActions from './RuntimeActions';
import { machineControlName, resolveRuntimeView } from './runtimeView';
import TasksSettings from './TasksSettings';
import { TOOL_CATALOG, EXCLUDED_MCP_TOOLS } from './toolMeta';
import WorkflowsSettings from './WorkflowsSettings';

export type SettingsCategory = 'provider' | 'scope' | 'runtime' | 'tools' | 'workflows' | 'rules' | 'notes' | 'tasks' | 'prompts' | 'readiness';

interface Props {
	onSaved: () => void;
	onClose: () => void;
	initialCategory?: SettingsCategory;
}
type ToolsSub = 'builtin' | 'custom';

const CATEGORIES: Array<{ id: SettingsCategory; label: string }> = [
	{ id: 'provider', label: 'Provider' },
	{ id: 'scope', label: 'Scope' },
	{ id: 'runtime', label: 'Runtime' },
	{ id: 'tools', label: 'Tools' },
	{ id: 'workflows', label: 'Workflows' },
	{ id: 'rules', label: 'Rules' },
	{ id: 'notes', label: 'Notes' },
	{ id: 'tasks', label: 'Tasks' },
	{ id: 'prompts', label: 'Prompts' },
	{ id: 'readiness', label: 'Readiness' },
];

const EMPTY_CUSTOM: CustomToolDTO = {
	id: '',
	title: '',
	kind: 'host',
	agentId: 'custom',
	image: 'docker.io/instrumentisto/nmap:latest',
	command: 'nmap',
	argsTemplate: ['-sn', '{{target}}'],
	network: 'target',
	timeoutMs: 120_000,
	description: '',
	enabled: true,
};

const EMPTY_PROMPTS: PromptsDTO = {
	system: '',
	orchestrator: '',
	specialist: '',
	agents: {},
	slashCommands: [],
	welcome: '',
};

export default function Settings({ onSaved, onClose, initialCategory = 'provider' }: Props) {
	const [category, setCategory] = useState<SettingsCategory>(initialCategory);
	const [toolsSub, setToolsSub] = useState<ToolsSub>('builtin');
	const [form, setForm] = useState<SettingsDTO | null>(null);
	const [prompts, setPrompts] = useState<PromptsDTO>(EMPTY_PROMPTS);
	const [providers, setProviders] = useState<ProviderOption[]>([]);
	const [apiKey, setApiKey] = useState('');
	const [scopeText, setScopeText] = useState('');
	const [podmanOut, setPodmanOut] = useState('');
	const [setupBusy, setSetupBusy] = useState(false);
	const [setupProgress, setSetupProgress] = useState<PodmanSetupProgress | null>(null);
	const [runtimeStatus, setRuntimeStatus] = useState<PodmanStatusDTO | null>(null);
	const [runtimeCached, setRuntimeCached] = useState<RuntimeStateDTO | null>(null);
	const [runtimeBusy, setRuntimeBusy] = useState<string | null>(null);
	const setupBusyRef = useRef(false);
	const [models, setModels] = useState<ListedModel[]>([]);
	const [modelsStatus, setModelsStatus] = useState('');
	const [modelsLoading, setModelsLoading] = useState(false);
	const [saving, setSaving] = useState(false);
	const [customModel, setCustomModel] = useState(false);
	const [draft, setDraft] = useState<CustomToolDTO>({ ...EMPTY_CUSTOM });
	const [argsText, setArgsText] = useState('-sn\n{{target}}');
	const [customError, setCustomError] = useState('');
	const [readiness, setReadiness] = useState<ReadinessCheckDTO[]>([]);
	const [readinessBusy, setReadinessBusy] = useState(false);
	const [readinessError, setReadinessError] = useState('');

	const refreshModels = useCallback(async (
		provider: string,
		baseUrl: string,
		keyOverride?: string,
		currentModel?: string,
	) => {
		setModelsLoading(true);
		setModelsStatus('Fetching models…');
		try {
			const result = await window.hawaldar.listModels({
				provider,
				baseUrl,
				apiKey: keyOverride || undefined,
			});
			setModels(result.models);
			if (result.error) {
				setModelsStatus(result.error);
			} else {
				const src = result.models[0]?.source === 'api' ? 'live API' : 'defaults';
				setModelsStatus(`${result.models.length} models (${src})`);
			}
			if (currentModel && result.models.length > 0 && !result.models.some((m) => m.id === currentModel)) {
				setCustomModel(true);
			} else if (currentModel && result.models.some((m) => m.id === currentModel)) {
				setCustomModel(false);
			}
		} catch (error) {
			setModelsStatus(error instanceof Error ? error.message : String(error));
		} finally {
			setModelsLoading(false);
		}
	}, []);

	const applyRuntimeStatus = (next: PodmanStatusDTO) => {
		setRuntimeStatus(next);
		if (next.persisted) {
			setRuntimeCached(next.persisted);
		}
		setForm((prev) => prev
			? {
				...prev,
				podmanPath: next.resolvedPath,
				containerEngine: next.engine,
				alternatives: next.alternatives,
				host: next.host,
			}
			: prev);
	};

	useEffect(() => {
		setCategory(initialCategory);
	}, [initialCategory]);

	useEffect(() => {
		void (async () => {
			const [s, catalog, promptConfig, cached] = await Promise.all([
				window.hawaldar.getSettings(),
				window.hawaldar.listProviderCatalog(),
				window.hawaldar.getPrompts(),
				window.hawaldar.getRuntimeState(),
			]);
			setForm(s);
			setProviders(catalog);
			setPrompts(promptConfig);
			setScopeText(s.scope.join('\n'));
			setRuntimeCached(cached);
			await refreshModels(s.provider, s.baseUrl, undefined, s.model);
			const live = await window.hawaldar.getPodmanStatus();
			applyRuntimeStatus(live);
		})();
	}, [refreshModels]);

	useEffect(() => {
		setupBusyRef.current = setupBusy;
	}, [setupBusy]);

	useEffect(() => {
		return window.hawaldar.onPodmanSetupProgress((ev) => {
			if (!setupBusyRef.current && ev.step === 'ready' && !ev.failed) {
				return;
			}
			setSetupProgress(ev);
		});
	}, []);

	const selectedProvider = form ? providers.find((p) => p.id === form.provider) : undefined;
	const categoryLabel = CATEGORIES.find((item) => item.id === category)?.label || 'Settings';

	const onProviderChange = (providerId: string) => {
		if (!form) return;
		const next = providers.find((p) => p.id === providerId);
		const baseUrl = next?.defaultBaseUrl || form.baseUrl;
		const defaultModel = next?.models[0] || form.model;
		setForm({ ...form, provider: providerId, baseUrl, model: defaultModel });
		setCustomModel(false);
		void refreshModels(providerId, baseUrl, apiKey || undefined, defaultModel);
	};

	const toggleTool = (id: string) => {
		setForm((prev) => {
			if (!prev) return prev;
			const enabled = prev.enabledTools.includes(id)
				? prev.enabledTools.filter((t) => t !== id)
				: [...prev.enabledTools, id];
			return { ...prev, enabledTools: enabled };
		});
	};

	const setImage = (agentId: string, image: string) => {
		setForm((prev) => prev ? { ...prev, toolImages: { ...prev.toolImages, [agentId]: image } } : prev);
	};

	const setCustomImage = (id: string, image: string) => {
		setForm((prev) => prev
			? { ...prev, customTools: prev.customTools.map((tool) => tool.id === id ? { ...tool, image } : tool) }
			: prev);
	};

	const addCustomTool = () => {
		if (!form) return;
		const argsTemplate = argsText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
		const candidate: CustomToolDTO = {
			...draft,
			id: draft.id.trim().toLowerCase(),
			title: draft.title.trim() || draft.id.trim(),
			description: draft.description.trim() || draft.title.trim() || draft.id.trim(),
			argsTemplate,
			network: draft.kind === 'host' ? 'target' : 'none',
		};
		if (!candidate.id) {
			setCustomError('Tool id is required.');
			return;
		}
		if (TOOL_CATALOG.some((t) => t.id === candidate.id) || form.customTools.some((t) => t.id === candidate.id)) {
			setCustomError('Tool id already exists.');
			return;
		}
		if (argsTemplate.length === 0) {
			setCustomError('Add at least one arg line (use {{target}} / {{filePath}} / {{pcapPath}}).');
			return;
		}
		setForm({
			...form,
			customTools: [...form.customTools, candidate],
			enabledTools: form.enabledTools.includes(candidate.id)
				? form.enabledTools
				: [...form.enabledTools, candidate.id],
		});
		setDraft({ ...EMPTY_CUSTOM });
		setArgsText('-sn\n{{target}}');
		setCustomError('');
	};

	const removeCustomTool = (id: string) => {
		if (!form) return;
		setForm({
			...form,
			customTools: form.customTools.filter((t) => t.id !== id),
			enabledTools: form.enabledTools.filter((t) => t !== id),
		});
	};

	const runReadiness = async () => {
		if (!form) return;
		setReadinessBusy(true);
		setReadinessError('');
		try {
			await window.hawaldar.saveSettings({
				podmanPath: form.podmanPath,
				toolImages: form.toolImages,
				customTools: form.customTools,
				enabledTools: form.enabledTools,
				containerEngine: form.containerEngine,
			});
			const checks = await window.hawaldar.checkReadiness();
			setReadiness(checks);
		} catch (error) {
			setReadinessError(error instanceof Error ? error.message : String(error));
		} finally {
			setReadinessBusy(false);
		}
	};

	const save = async () => {
		if (!form) return;
		setSaving(true);
		try {
			await window.hawaldar.saveSettings({
				provider: form.provider,
				model: form.model,
				baseUrl: form.baseUrl,
				apiKey: apiKey || undefined,
				podmanPath: form.podmanPath,
				scopeText,
				enabledTools: form.enabledTools,
				toolImages: form.toolImages,
				customTools: form.customTools,
				containerEngine: form.containerEngine,
			});
			await window.hawaldar.savePrompts({
				system: prompts.system,
				orchestrator: prompts.orchestrator,
				specialist: prompts.specialist,
				welcome: prompts.welcome,
				agents: prompts.agents,
				slashCommands: prompts.slashCommands,
			});
			onSaved();
		} finally {
			setSaving(false);
		}
	};

	const widgetFoot = (extra?: ReactNode) => (
		<div className="widget-foot">
			{extra}
			<button type="button" className="btn btn-primary" disabled={!form || saving} onClick={() => void save()}>
				{saving ? 'Saving…' : 'Save'}
			</button>
			<button type="button" className="btn" onClick={onClose}>Cancel</button>
		</div>
	);

	const nav = (
		<nav className="settings-nav" aria-label="Settings categories">
			<div className="settings-nav-label">Settings</div>
			{CATEGORIES.map((item) => (
				<button
					key={item.id}
					type="button"
					className={`settings-nav-item${category === item.id ? ' active' : ''}`}
					onClick={() => setCategory(item.id)}
				>
					{item.label}
				</button>
			))}
		</nav>
	);

	if (!form) {
		return (
			<div className="settings-layout">
				{nav}
				<div className="settings-main">
					<div className="settings-main-head">
						<h1 className="settings-main-title">Settings</h1>
						<button type="button" className="btn" onClick={onClose}>Back to chat</button>
					</div>
					<div className="settings-main-body">
						<section className="widget">
							<p className="widget-help">Loading settings…</p>
						</section>
					</div>
				</div>
			</div>
		);
	}

	const dockerDetected = dockerIsAvailable(form.alternatives);

	let body: ReactNode = null;

	if (category === 'provider') {
		body = (
			<section className="widget">
				<div className="widget-head">
					<h2 className="widget-title">Provider &amp; model</h2>
				</div>
				<p className="widget-help">
					{selectedProvider
						? `${selectedProvider.envVar ? selectedProvider.envVar : 'No API key'} · ${selectedProvider.listKind}`
						: 'Provider, model, and API credentials.'}
					{' '}Enabled provider is restored from <code>~/.hawaldar/hawaldar.db</code>. API keys stay in settings.json.
				</p>
				<div className="form-grid">
					<div className="field">
						<label htmlFor="settings-provider">Provider</label>
						<Dropdown
							prefer="down"
							searchable
							searchPlaceholder="Search providers…"
							ariaLabel="Provider"
							value={form.provider}
							options={providers.map((p) => ({
								value: p.id,
								label: p.id === form.provider ? `${p.label} · active` : p.label,
								detail: p.envVar || p.defaultBaseUrl,
							}))}
							onChange={onProviderChange}
						/>
					</div>
					<div className="field">
						<label htmlFor="settings-model">Model</label>
						{customModel || models.length === 0 ? (
							<input
								id="settings-model"
								value={form.model}
								onChange={(e) => setForm({ ...form, model: e.target.value })}
								placeholder="model id"
							/>
						) : (
							<Dropdown
								prefer="down"
								searchable
								searchPlaceholder="Search models…"
								ariaLabel="Model"
								value={form.model}
								options={[
									...models.map((m) => ({
										value: m.id,
										label: m.id,
										detail: m.source === 'api' ? 'from API' : 'fallback',
									})),
									{ value: '__custom__', label: 'Custom model id…' },
								]}
								onChange={(next) => {
									if (next === '__custom__') {
										setCustomModel(true);
										return;
									}
									setForm({ ...form, model: next });
								}}
							/>
						)}
						{customModel && models.length > 0 && (
							<button
								type="button"
								className="btn-text"
								onClick={() => {
									setCustomModel(false);
									if (!models.some((m) => m.id === form.model) && models[0]) {
										setForm({ ...form, model: models[0].id });
									}
								}}
							>
								Back to listed models
							</button>
						)}
					</div>
					<div className="field">
						<label htmlFor="settings-apikey">API key {form.hasApiKey ? '(saved — leave blank to keep)' : ''}</label>
						<input
							id="settings-apikey"
							type="password"
							value={apiKey}
							placeholder={form.hasApiKey ? '••••••••' : selectedProvider?.envVar || 'API key'}
							onChange={(e) => setApiKey(e.target.value)}
						/>
					</div>
					<div className="field">
						<label htmlFor="settings-baseurl">API base URL</label>
						<input
							id="settings-baseurl"
							className="mono-input"
							value={form.baseUrl}
							onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
							onBlur={() => void refreshModels(form.provider, form.baseUrl, apiKey || undefined, form.model)}
						/>
					</div>
				</div>
				{widgetFoot(
					<>
						<span className="widget-status">{modelsStatus}</span>
						<button
							type="button"
							className="btn"
							disabled={modelsLoading}
							onClick={() => void refreshModels(form.provider, form.baseUrl, apiKey || undefined, form.model)}
						>
							{modelsLoading ? 'Listing…' : 'Refresh models'}
						</button>
					</>,
				)}
			</section>
		);
	} else if (category === 'scope') {
		body = (
			<section className="widget">
				<div className="widget-head">
					<h2 className="widget-title">Engagement scope</h2>
				</div>
				<p className="widget-help">One host, domain, or CIDR per line. Prefix ! to deny.</p>
				<textarea
					className="mono-input"
					rows={12}
					value={scopeText}
					onChange={(e) => setScopeText(e.target.value)}
					spellCheck={false}
				/>
				{widgetFoot()}
			</section>
		);
	} else if (category === 'runtime') {
		const runtimeView = resolveRuntimeView({
			live: runtimeStatus,
			cached: runtimeCached,
			setupBusy,
			setupProgress,
		});
		const runtimeBusyAny = setupBusy || Boolean(runtimeBusy);
		const runSetup = async () => {
			setSetupBusy(true);
			setSetupProgress({ step: 'locating', message: 'Starting setup…' });
			setPodmanOut('');
			try {
				if (form.containerEngine === 'docker' && !dockerDetected) {
					applyRuntimeStatus(await window.hawaldar.setContainerEngine('podman'));
				}
				const result = await window.hawaldar.setupPodman();
				applyRuntimeStatus(result.status);
				setPodmanOut(result.ok ? `✓ ${result.detail}` : result.detail);
				setSetupProgress(result.ok
					? null
					: { step: result.step, message: result.detail, failed: true });
			} catch (error) {
				const text = error instanceof Error ? error.message : String(error);
				setPodmanOut(text);
				setSetupProgress({ step: 'installing', message: text, failed: true });
			} finally {
				setSetupBusy(false);
			}
		};
		const runMachine = async (action: 'start' | 'stop' | 'restart') => {
			setRuntimeBusy(action);
			setPodmanOut('');
			try {
				const result = await window.hawaldar.setPodmanMachine(
					action,
					machineControlName(runtimeStatus, runtimeCached),
				);
				applyRuntimeStatus(result.status);
				setPodmanOut(result.ok ? `✓ ${result.detail}` : result.detail);
				setSetupProgress(null);
			} catch (error) {
				setPodmanOut(error instanceof Error ? error.message : String(error));
			} finally {
				setRuntimeBusy(null);
			}
		};
		body = (
			<section className="widget">
				<div className="widget-head">
					<h2 className="widget-title">Container runtime</h2>
					<div className="widget-actions">
						{form.containerEngine !== 'docker' && dockerDetected && (
							<button
								type="button"
								className="btn-text"
								disabled={runtimeBusyAny}
								onClick={async () => {
									applyRuntimeStatus(await window.hawaldar.setContainerEngine('docker'));
									setPodmanOut('✓ Using Docker');
								}}
							>
								Use Docker
							</button>
						)}
						{form.containerEngine === 'docker' && (
							<button
								type="button"
								className="btn-text"
								disabled={runtimeBusyAny}
								onClick={async () => {
									applyRuntimeStatus(await window.hawaldar.setContainerEngine('podman'));
									setPodmanOut('✓ Using Podman');
								}}
							>
								Use Podman
							</button>
						)}
					</div>
				</div>
				<div className="kv-list">
					<div className="kv-row">
						<span className="kv-label">Host</span>
						<span className="kv-value">{hostCardLine(form.host)}</span>
					</div>
					<div className="kv-row">
						<span className="kv-label">Workspace</span>
						<span className="kv-value mono">{runtimeStatus?.workspace.displayPath ?? WORKSPACE_DISPLAY_FALLBACK}</span>
					</div>
					{runtimeView.machineLine && (
						<div className="kv-row">
							<span className="kv-label">Machine</span>
							<span className="kv-value">{runtimeView.machineLine}</span>
						</div>
					)}
				</div>
				{runtimeView.showStepper && <PodmanSetupSteps progress={setupProgress} />}
				{runtimeView.setupHint && (
					<p className="widget-help">{setupCtaDetail(form.host, form.containerEngine === 'docker' && !dockerDetected)}</p>
				)}
				{podmanOut && (
					<p className={`widget-help${podmanOut.startsWith('✓') ? '' : ' widget-error'}`}>{podmanOut}</p>
				)}
				{runtimeView.phase !== 'setup' && (
					<details className="runtime-advanced">
						<summary>Advanced</summary>
						<div className="field">
							<label htmlFor="settings-engine-path">
								{form.containerEngine === 'docker' ? 'Docker path' : 'Podman path'}
							</label>
							<input
								id="settings-engine-path"
								className="mono-input"
								value={form.podmanPath}
								onChange={(e) => setForm({ ...form, podmanPath: e.target.value })}
								disabled={runtimeBusyAny}
							/>
						</div>
						<div className="widget-foot">
							<button
								type="button"
								className="btn"
								disabled={runtimeBusyAny}
								onClick={async () => {
									const result = await window.hawaldar.testPodman(form.podmanPath);
									setPodmanOut(result.text);
									if (result.path) {
										setForm({
											...form,
											podmanPath: result.path,
											containerEngine: /docker(\.exe)?$/i.test(result.path) ? 'docker' : form.containerEngine,
										});
									}
								}}
							>
								Test
							</button>
							<button
								type="button"
								className="btn"
								disabled={runtimeBusyAny}
								onClick={async () => {
									const next = await window.hawaldar.locatePodman();
									applyRuntimeStatus(next);
									setPodmanOut(next.availability === 'not_installed'
										? 'Not set up yet — use Set up Podman.'
										: `Found ${next.resolvedPath}${next.version ? ` · ${next.version}` : ''}`);
								}}
							>
								Locate
							</button>
							<button
								type="button"
								className="btn"
								disabled={runtimeBusyAny}
								onClick={async () => {
									const result = await window.hawaldar.browsePodman();
									if (result.canceled || !result.path) {
										return;
									}
									if (result.status) {
										applyRuntimeStatus(result.status);
									} else {
										setForm({
											...form,
											podmanPath: result.path,
											containerEngine: /docker(\.exe)?$/i.test(result.path) ? 'docker' : form.containerEngine,
										});
									}
									setPodmanOut(result.path);
								}}
							>
								Browse
							</button>
						</div>
					</details>
				)}
				{runtimeView.phase === 'setup' && !runtimeView.showSetup
					? null
					: widgetFoot(
						<RuntimeActions
							view={runtimeView}
							busy={runtimeBusyAny}
							busyKey={setupBusy ? 'setup' : runtimeBusy}
							setupLabel={form.containerEngine === 'docker' && !dockerDetected
								? 'Set up Podman instead'
								: form.containerEngine === 'docker'
									? 'Check Docker'
									: 'Set up Podman'}
							onSetup={() => void runSetup()}
							onStart={() => void runMachine('start')}
							onStop={() => void runMachine('stop')}
							onRestart={() => void runMachine('restart')}
						/>,
					)}
			</section>
		);
	} else if (category === 'tools' && toolsSub === 'builtin') {
		body = (
			<section className="widget">
				<div className="widget-head">
					<h2 className="widget-title">Built-in tools</h2>
				</div>
				<p className="widget-help">Enable tools and override the agent image. Hawaldar tools run in Podman images.</p>
				<div className="table-wrap">
					<table className="data-table tools-table">
						<colgroup>
							<col className="col-check" />
							<col className="col-tool" />
							<col className="col-agent" />
							<col className="col-source" />
							<col />
						</colgroup>
						<thead>
							<tr>
								<th scope="col">Enable</th>
								<th scope="col">Tool</th>
								<th scope="col">Agent</th>
								<th scope="col">Source</th>
								<th scope="col">Image</th>
							</tr>
						</thead>
						<tbody>
							{TOOL_CATALOG.map((tool) => (
								<tr key={tool.id}>
									<td className="col-check">
										<input
											type="checkbox"
											checked={form.enabledTools.includes(tool.id)}
											onChange={() => toggleTool(tool.id)}
											aria-label={`Enable ${tool.id}`}
										/>
									</td>
									<td className="col-nowrap" title={tool.id}>
										<span>{tool.title || tool.id}</span>
									</td>
									<td className="col-nowrap mono" title={tool.agentId}>{tool.agentId}</td>
									<td className="col-nowrap" title={tool.source || 'Built-in'}>{tool.source || 'Built-in'}</td>
									<td>
										<input
											className="mono-input"
											value={form.toolImages[tool.agentId] || tool.image}
											onChange={(e) => setImage(tool.agentId, e.target.value)}
											spellCheck={false}
											aria-label={`${tool.agentId} image`}
										/>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
				<h3 className="widget-sub">Refused</h3>
				<div className="table-wrap">
					<table className="data-table refused-table">
						<colgroup>
							<col className="col-source" />
							<col />
						</colgroup>
						<thead>
							<tr>
								<th scope="col">Tool</th>
								<th scope="col">Reason</th>
							</tr>
						</thead>
						<tbody>
							{EXCLUDED_MCP_TOOLS.map((item) => (
								<tr key={item.id}>
									<td className="col-nowrap mono">{item.id}</td>
									<td>{item.reason}</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
				{widgetFoot()}
			</section>
		);
	} else if (category === 'tools') {
		body = (
			<section className="widget">
				<div className="widget-head">
					<h2 className="widget-title">Custom tools</h2>
				</div>
				<p className="widget-help">
					Fixed command and args. Placeholders: {'{{target}}'}, {'{{filePath}}'}, {'{{pcapPath}}'}.
				</p>
				<div className="table-wrap">
					<table className="data-table tools-table custom-tools-table">
						<colgroup>
							<col className="col-check" />
							<col className="col-tool" />
							<col className="col-agent" />
							<col className="col-source" />
							<col />
							<col className="col-action" />
						</colgroup>
						<thead>
							<tr>
								<th scope="col">Enable</th>
								<th scope="col">Tool</th>
								<th scope="col">Agent</th>
								<th scope="col">Source</th>
								<th scope="col">Image</th>
								<th scope="col" />
							</tr>
						</thead>
						<tbody>
							{form.customTools.length === 0 && (
								<tr>
									<td colSpan={6} className="table-empty">No custom tools yet.</td>
								</tr>
							)}
							{form.customTools.map((tool) => (
								<tr key={tool.id}>
									<td className="col-check">
										<input
											type="checkbox"
											checked={form.enabledTools.includes(tool.id)}
											onChange={() => toggleTool(tool.id)}
											aria-label={`Enable ${tool.id}`}
										/>
									</td>
									<td className="col-nowrap" title={tool.id}>{tool.title || tool.id}</td>
									<td className="col-nowrap mono">{tool.agentId}</td>
									<td className="col-nowrap mono">{tool.command} · {tool.kind}</td>
									<td>
										<input
											className="mono-input"
											value={tool.image}
											onChange={(e) => setCustomImage(tool.id, e.target.value)}
											spellCheck={false}
											aria-label={`${tool.id} image`}
										/>
									</td>
									<td className="col-action">
										<button type="button" className="btn" onClick={() => removeCustomTool(tool.id)}>
											Remove
										</button>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
				<h3 className="widget-sub">Add tool</h3>
				<div className="form-grid">
					<div className="field">
						<label htmlFor="custom-id">Id</label>
						<input
							id="custom-id"
							className="mono-input"
							placeholder="my-ping"
							value={draft.id}
							onChange={(e) => setDraft({ ...draft, id: e.target.value })}
						/>
					</div>
					<div className="field">
						<label htmlFor="custom-title">Title</label>
						<input
							id="custom-title"
							placeholder="Title"
							value={draft.title}
							onChange={(e) => setDraft({ ...draft, title: e.target.value })}
						/>
					</div>
					<div className="field">
						<label>Kind</label>
						<Dropdown
							prefer="down"
							ariaLabel="Tool kind"
							value={draft.kind}
							options={[
								{ value: 'host', label: 'host' },
								{ value: 'file', label: 'file' },
								{ value: 'pcap', label: 'pcap' },
							]}
							onChange={(kindRaw) => {
								const kind = kindRaw as CustomToolDTO['kind'];
								setDraft({
									...draft,
									kind,
									network: kind === 'host' ? 'target' : 'none',
									argsTemplate: kind === 'host'
										? ['-sn', '{{target}}']
										: kind === 'pcap'
											? ['-r', '{{pcapPath}}']
											: ['{{filePath}}'],
								});
								setArgsText(
									kind === 'host'
										? '-sn\n{{target}}'
										: kind === 'pcap'
											? '-r\n{{pcapPath}}'
											: '{{filePath}}',
								);
							}}
						/>
					</div>
					<div className="field">
						<label htmlFor="custom-agent">Agent</label>
						<input
							id="custom-agent"
							className="mono-input"
							placeholder="nmap, custom, …"
							value={draft.agentId}
							onChange={(e) => setDraft({ ...draft, agentId: e.target.value })}
						/>
					</div>
					<div className="field">
						<label htmlFor="custom-image">Image</label>
						<input
							id="custom-image"
							className="mono-input"
							placeholder="image"
							value={draft.image}
							onChange={(e) => setDraft({ ...draft, image: e.target.value })}
							spellCheck={false}
						/>
					</div>
					<div className="field">
						<label htmlFor="custom-command">Command</label>
						<input
							id="custom-command"
							className="mono-input"
							placeholder="command"
							value={draft.command}
							onChange={(e) => setDraft({ ...draft, command: e.target.value })}
						/>
					</div>
					<div className="field span-2">
						<label htmlFor="custom-args">Args (one per line)</label>
						<textarea
							id="custom-args"
							className="mono-input"
							rows={4}
							value={argsText}
							onChange={(e) => setArgsText(e.target.value)}
							spellCheck={false}
						/>
					</div>
					<div className="field span-2">
						<label htmlFor="custom-desc">Description</label>
						<input
							id="custom-desc"
							value={draft.description}
							onChange={(e) => setDraft({ ...draft, description: e.target.value })}
							placeholder="What this tool does"
						/>
					</div>
				</div>
				{customError && <p className="widget-help widget-error">{customError}</p>}
				{widgetFoot(
					<button type="button" className="btn" onClick={addCustomTool}>Add custom tool</button>,
				)}
			</section>
		);
	} else if (category === 'workflows') {
		body = <WorkflowsSettings />;
	} else if (category === 'rules') {
		body = <RulesSettings />;
	} else if (category === 'notes') {
		body = <NotesSettings />;
	} else if (category === 'tasks') {
		body = <TasksSettings />;
	} else if (category === 'prompts') {
		body = (
			<section className="widget">
				<div className="widget-head">
					<h2 className="widget-title">Prompts</h2>
				</div>
				<p className="widget-help">
					Stored in <code>~/.hawaldar/prompts.json</code>. Templates: <code>{'{{system}}'}</code>, <code>{'{{name}}'}</code>, <code>{'{{role}}'}</code>.
				</p>
				<div className="field">
					<label htmlFor="prompt-system">Base system</label>
					<textarea
						id="prompt-system"
						rows={7}
						value={prompts.system}
						onChange={(e) => setPrompts({ ...prompts, system: e.target.value })}
					/>
				</div>
				<div className="form-grid">
					<div className="field">
						<label htmlFor="prompt-orch">Orchestrator template</label>
						<textarea
							id="prompt-orch"
							rows={5}
							value={prompts.orchestrator}
							onChange={(e) => setPrompts({ ...prompts, orchestrator: e.target.value })}
						/>
					</div>
					<div className="field">
						<label htmlFor="prompt-spec">Specialist template</label>
						<textarea
							id="prompt-spec"
							rows={5}
							value={prompts.specialist}
							onChange={(e) => setPrompts({ ...prompts, specialist: e.target.value })}
						/>
					</div>
				</div>
				<div className="field">
					<label htmlFor="prompt-welcome">Welcome text</label>
					<textarea
						id="prompt-welcome"
						rows={3}
						value={prompts.welcome}
						onChange={(e) => setPrompts({ ...prompts, welcome: e.target.value })}
					/>
				</div>
				{widgetFoot()}
			</section>
		);
	} else {
		body = (
			<section className="widget">
				<div className="widget-head">
					<h2 className="widget-title">Readiness</h2>
				</div>
				<p className="widget-help">Engine, local images, and a short version probe per agent.</p>
				{readinessError && <p className="widget-help widget-error">{readinessError}</p>}
				<div className="table-wrap">
					<table className="data-table readiness-table">
						<colgroup>
							<col className="col-check" />
							<col className="col-tool" />
							<col />
						</colgroup>
						<thead>
							<tr>
								<th scope="col">Ok</th>
								<th scope="col">Check</th>
								<th scope="col">Detail</th>
							</tr>
						</thead>
						<tbody>
							{readiness.length === 0 && (
								<tr>
									<td colSpan={3} className="table-empty">No checks yet.</td>
								</tr>
							)}
							{readiness.map((item) => (
								<tr key={item.id} className={item.ok ? 'ok' : 'bad'}>
									<td className="col-check">
										<span className="readiness-mark">{item.ok ? '✓' : '✗'}</span>
									</td>
									<td className="col-nowrap">{item.label}</td>
									<td className="mono readiness-detail-cell">{item.detail}</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
				{widgetFoot(
					<button type="button" className="btn" disabled={readinessBusy} onClick={() => void runReadiness()}>
						{readinessBusy ? 'Probing…' : 'Check readiness'}
					</button>,
				)}
			</section>
		);
	}

	return (
		<div className="settings-layout">
			{nav}
			<div className="settings-main">
				<div className="settings-main-head">
					<div className="settings-main-heading">
						<h1 className="settings-main-title">{categoryLabel}</h1>
						{category === 'tools' && (
							<div className="settings-subnav" role="tablist" aria-label="Tools">
								<button
									type="button"
									role="tab"
									aria-selected={toolsSub === 'builtin'}
									className={toolsSub === 'builtin' ? 'active' : ''}
									onClick={() => setToolsSub('builtin')}
								>
									Built-in
								</button>
								<button
									type="button"
									role="tab"
									aria-selected={toolsSub === 'custom'}
									className={toolsSub === 'custom' ? 'active' : ''}
									onClick={() => setToolsSub('custom')}
								>
									Custom
								</button>
							</div>
						)}
					</div>
					<button type="button" className="btn" onClick={onClose}>Back to chat</button>
				</div>
				<div className="settings-main-body">
					{body}
				</div>
			</div>
		</div>
	);
}
