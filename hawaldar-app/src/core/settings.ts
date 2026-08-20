import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { safeStorage } from 'electron';
import { ensureDataHome } from './data-home';
import { looksLikeDockerBin, resolveDockerPath } from './sandbox/host-info';
import { resolvePodmanPath } from './sandbox/podman-path';
import { ensureWorkspace } from './sandbox/workspace';
import { ProviderPrefsStore } from './provider-prefs';
import { getProvider, MASTRA_PROVIDERS } from './providers';
import { builtinToolIds, defaultEnabled, defaultImages, hydrateToolImages, mergeEnabledTools, resolveCatalogServiceImage, SERVICE_IMAGE_ALIAS, TOOL_CATALOG } from './tools/catalog';
import type { CustomToolDef } from './tools/custom';
import { validateCustomTool } from './tools/custom';

export interface HawaldarSettings {
	provider: string;
	model: string;
	baseUrl: string;
	apiKey: string;
	podmanPath: string;
	scope: string[];
	toolImages: Record<string, string>;
	enabledTools: string[];
	customTools: CustomToolDef[];
	/** Agent ids whose Podman backends are armed. Empty by default — nothing starts until toggled. */
	startedServices: string[];
	/** If true, starting a tool service may also start the Podman machine. Default false. */
	autoStartMachine: boolean;
	/** OCI engine. Docker is an alternative when already installed. */
	containerEngine: 'podman' | 'docker';
	/** True only after the user saves a provider in Settings. */
	hasSelectedProvider: boolean;
	/** Reasoning / thinking extra_body. Stored in settings + sqlite prefs, not the API key. */
	thinking: boolean;
	/** Delete unpinned sessions older than this many days (by last updated). */
	sessionTtlDays: number;
	/** In-app legal agreement version last accepted (empty if never). */
	legalVersion: string;
	/** Unix ms when the current legal version was accepted. */
	legalAcceptedAt: number | null;
	/** UI locale (chrome only). Legal LICENSE text stays English. */
	locale: string;
	/** Persisted chrome theme. Default dark. */
	theme: 'dark' | 'light';
	extensionPath: string;
	cacheDir: string;
}

export interface SettingsPatch {
	provider?: string;
	model?: string;
	baseUrl?: string;
	apiKey?: string;
	podmanPath?: string;
	scope?: string[];
	scopeText?: string;
	toolImages?: Record<string, string>;
	enabledTools?: string[];
	customTools?: CustomToolDef[];
	startedServices?: string[];
	autoStartMachine?: boolean;
	containerEngine?: 'podman' | 'docker';
	thinking?: boolean;
	sessionTtlDays?: number;
	locale?: string;
	theme?: 'dark' | 'light';
}

interface PersistedSettings {
	provider: string;
	model: string;
	baseUrl: string;
	podmanPath: string;
	scope: string[];
	toolImages: Record<string, string>;
	enabledTools: string[];
	/** Catalog ids already hydrated into enabledTools. Missing ids default on (opt-out). */
	knownBuiltinTools: string[];
	customTools: CustomToolDef[];
	startedServices: string[];
	autoStartMachine: boolean;
	containerEngine: 'podman' | 'docker';
	apiKeyEnc?: string;
	/** Last time provider / model / baseUrl were written to settings.json. */
	providerUpdatedAt?: number;
	hasSelectedProvider?: boolean;
	thinking?: boolean;
	sessionTtlDays?: number;
	legalVersion?: string;
	legalAcceptedAt?: number;
	locale?: string;
	theme?: 'dark' | 'light';
}

export class SettingsStore {
	readonly dataDir = path.join(os.homedir(), '.hawaldar');
	readonly settingsPath = path.join(this.dataDir, 'settings.json');
	readonly cacheDir = path.join(this.dataDir, 'cache');
	readonly extensionPath: string;
	private readonly prefs: ProviderPrefsStore;

	constructor(extensionPath: string) {
		this.extensionPath = extensionPath;
		ensureDataHome(this.dataDir);
		fs.mkdirSync(this.cacheDir, { recursive: true });
		ensureWorkspace();
		this.prefs = new ProviderPrefsStore(this.dataDir);
	}

	async read(): Promise<HawaldarSettings> {
		const raw = await this.resolvePersisted();
		const containerEngine = raw.containerEngine === 'docker' ? 'docker' : 'podman';
		const podmanPath = this.hydrateEnginePath(raw.podmanPath, containerEngine);
		const selected = raw.hasSelectedProvider === true && chosenProvider(raw.provider, raw.model);
		return {
			provider: selected ? raw.provider : '',
			model: selected ? raw.model : '',
			baseUrl: selected ? raw.baseUrl.replace(/\/$/, '') : '',
			apiKey: this.decryptKey(raw.apiKeyEnc),
			podmanPath,
			scope: raw.scope,
			toolImages: hydrateToolImages(raw.toolImages),
			enabledTools: raw.enabledTools,
			customTools: raw.customTools,
			startedServices: raw.startedServices,
			autoStartMachine: raw.autoStartMachine,
			containerEngine,
			hasSelectedProvider: selected,
			thinking: raw.thinking === true,
			sessionTtlDays: normalizeSessionTtlDays(raw.sessionTtlDays),
			legalVersion: raw.legalVersion || '',
			legalAcceptedAt: raw.legalAcceptedAt || null,
			locale: normalizeLocale(raw.locale),
			theme: normalizeTheme(raw.theme),
			extensionPath: this.extensionPath,
			cacheDir: this.cacheDir,
		};
	}

	async write(patch: SettingsPatch): Promise<HawaldarSettings> {
		const current = await this.resolvePersisted();
		const providerChanged = patch.provider !== undefined
			|| patch.model !== undefined
			|| patch.baseUrl !== undefined;
		const nextProvider = patch.provider ?? current.provider;
		const nextModel = patch.model ?? current.model;
		const hasSelectedProvider = patch.provider !== undefined
			? chosenProvider(nextProvider, nextModel)
			: current.hasSelectedProvider === true && chosenProvider(current.provider, current.model);
		const thinking = patch.thinking !== undefined ? Boolean(patch.thinking) : current.thinking === true;
		const customTools = patch.customTools !== undefined
			? this.normalizeCustomTools(patch.customTools)
			: current.customTools;
		const enabled = mergeEnabledTools(
			patch.enabledTools ?? current.enabledTools,
			patch.enabledTools !== undefined ? builtinToolIds() : current.knownBuiltinTools,
			customTools.map((tool) => tool.id),
		);
		const next: PersistedSettings = {
			provider: nextProvider,
			model: nextModel,
			baseUrl: (patch.baseUrl ?? current.baseUrl).replace(/\/$/, ''),
			providerUpdatedAt: providerChanged ? Date.now() : current.providerUpdatedAt,
			hasSelectedProvider,
			thinking,
			sessionTtlDays: patch.sessionTtlDays !== undefined
				? normalizeSessionTtlDays(patch.sessionTtlDays)
				: normalizeSessionTtlDays(current.sessionTtlDays),
			podmanPath: patch.podmanPath ?? current.podmanPath,
			scope: patch.scopeText !== undefined
				? patch.scopeText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
				: (patch.scope ?? current.scope),
			toolImages: patch.toolImages !== undefined
				? hydrateToolImages(patch.toolImages)
				: current.toolImages,
			enabledTools: enabled.enabledTools,
			knownBuiltinTools: enabled.knownBuiltinTools,
			customTools,
			startedServices: patch.startedServices ?? current.startedServices,
			autoStartMachine: patch.autoStartMachine ?? current.autoStartMachine,
			containerEngine: patch.containerEngine === 'docker'
				? 'docker'
				: patch.containerEngine === 'podman'
					? 'podman'
					: (current.containerEngine === 'docker' ? 'docker' : 'podman'),
			legalVersion: current.legalVersion,
			legalAcceptedAt: current.legalAcceptedAt,
			locale: patch.locale !== undefined ? normalizeLocale(patch.locale) : normalizeLocale(current.locale),
			theme: patch.theme !== undefined ? normalizeTheme(patch.theme) : normalizeTheme(current.theme),
			apiKeyEnc: current.apiKeyEnc,
		};
		if (patch.apiKey !== undefined && patch.apiKey !== '') {
			next.apiKeyEnc = this.encryptKey(patch.apiKey);
		}
		fs.writeFileSync(this.settingsPath, JSON.stringify(next, null, 2), 'utf8');
		if (hasSelectedProvider && chosenProvider(next.provider, next.model)) {
			await this.prefs.upsert({
				provider: next.provider,
				model: next.model,
				baseUrl: next.baseUrl,
				enabled: next.provider,
				hasSelected: true,
				updatedAt: next.providerUpdatedAt ?? Date.now(),
				thinking: next.thinking === true,
			});
		}
		return this.read();
	}

	async acceptLegal(version: string): Promise<HawaldarSettings> {
		const current = await this.resolvePersisted();
		const next: PersistedSettings = {
			...current,
			legalVersion: version.trim(),
			legalAcceptedAt: Date.now(),
		};
		this.writeJsonFile(next);
		return this.read();
	}

	/** Persist the real executable for the selected engine when found. */
	private hydrateEnginePath(current: string, engine: 'podman' | 'docker'): string {
		const next = engine === 'docker'
			? (resolveDockerPath(current).path || (looksLikeDockerBin(current) ? current : 'docker'))
			: (resolvePodmanPath(current).path || (looksLikeDockerBin(current) ? 'podman' : current));
		if (next !== current) {
			try {
				const persisted = this.loadPersisted();
				persisted.podmanPath = next;
				persisted.containerEngine = engine;
				fs.writeFileSync(this.settingsPath, JSON.stringify(persisted, null, 2), 'utf8');
			} catch {
				// Keep using the resolved path in-memory even if persist fails.
			}
		}
		return next;
	}

	private async resolvePersisted(): Promise<PersistedSettings> {
		const json = this.loadPersisted();
		const jsonChosen = json.hasSelectedProvider === true && chosenProvider(json.provider, json.model);
		if (!jsonChosen) {
			return { ...json, hasSelectedProvider: false, thinking: json.thinking === true };
		}
		const db = await this.prefs.get();
		const dbChosen = Boolean(db && db.hasSelected && chosenProvider(db.enabled || db.provider, db.model));
		const jsonTs = json.providerUpdatedAt ?? 0;
		if (!db || !dbChosen || jsonTs >= db.updatedAt) {
			await this.prefs.upsert({
				provider: json.provider,
				model: json.model,
				baseUrl: json.baseUrl,
				enabled: json.provider,
				hasSelected: true,
				updatedAt: jsonTs || Date.now(),
				thinking: json.thinking === true,
			});
			return { ...json, hasSelectedProvider: true, thinking: json.thinking === true };
		}
		const hydrated: PersistedSettings = {
			...json,
			provider: db.enabled || db.provider || json.provider,
			model: db.model || json.model,
			baseUrl: db.baseUrl || json.baseUrl,
			providerUpdatedAt: db.updatedAt,
			hasSelectedProvider: true,
			thinking: db.thinking === true,
		};
		if (
			json.provider !== hydrated.provider
			|| json.model !== hydrated.model
			|| json.baseUrl !== hydrated.baseUrl
		) {
			this.writeJsonFile(hydrated);
		}
		return hydrated;
	}

	private writeJsonFile(next: PersistedSettings): void {
		try {
			fs.writeFileSync(this.settingsPath, JSON.stringify(next, null, 2), 'utf8');
		} catch {
			// In-memory settings still apply if the file cannot be rewritten.
		}
	}

	private loadPersisted(): PersistedSettings {
		if (!fs.existsSync(this.settingsPath)) {
			return defaultPersisted();
		}
		try {
			const parsed = JSON.parse(fs.readFileSync(this.settingsPath, 'utf8')) as Partial<PersistedSettings>;
			const provider = parsed.provider && getProvider(parsed.provider) ? parsed.provider : '';
			const customTools = this.normalizeCustomTools(parsed.customTools || []);
			const toolImages = hydrateToolImages(parsed.toolImages);
			const enabled = mergeEnabledTools(
				Array.isArray(parsed.enabledTools) ? parsed.enabledTools : defaultEnabled(),
				Array.isArray(parsed.knownBuiltinTools) ? parsed.knownBuiltinTools : undefined,
				customTools.map((tool) => tool.id),
			);
			const next: PersistedSettings = {
				provider,
				model: typeof parsed.model === 'string' ? parsed.model.trim() : '',
				baseUrl: typeof parsed.baseUrl === 'string' ? parsed.baseUrl : '',
				podmanPath: parsed.podmanPath || 'podman',
				scope: Array.isArray(parsed.scope) ? parsed.scope : [],
				toolImages,
				enabledTools: enabled.enabledTools,
				knownBuiltinTools: enabled.knownBuiltinTools,
				customTools,
				startedServices: Array.isArray(parsed.startedServices) ? parsed.startedServices.map(String) : [],
				autoStartMachine: Boolean(parsed.autoStartMachine),
				containerEngine: parsed.containerEngine === 'docker' ? 'docker' : 'podman',
				apiKeyEnc: parsed.apiKeyEnc,
				providerUpdatedAt: Number(parsed.providerUpdatedAt) || undefined,
				hasSelectedProvider: parsed.hasSelectedProvider === true,
				thinking: parsed.thinking === true,
				sessionTtlDays: normalizeSessionTtlDays(parsed.sessionTtlDays),
				legalVersion: typeof parsed.legalVersion === 'string' ? parsed.legalVersion.trim() : '',
				legalAcceptedAt: Number(parsed.legalAcceptedAt) || undefined,
				locale: normalizeLocale(parsed.locale),
				theme: normalizeTheme(parsed.theme),
			};
			if (enabled.changed || !sameToolImages(parsed.toolImages, toolImages)) {
				this.writeJsonFile(next);
			}
			return next;
		} catch {
			return defaultPersisted();
		}
	}

	private normalizeCustomTools(raw: unknown): CustomToolDef[] {
		if (!Array.isArray(raw)) {
			return [];
		}
		const out: CustomToolDef[] = [];
		const seen = new Set<string>();
		for (const item of raw) {
			const checked = validateCustomTool((item || {}) as Partial<CustomToolDef>);
			if (!checked.ok || seen.has(checked.tool.id) || TOOL_CATALOG.some((t) => t.id === checked.tool.id)) {
				continue;
			}
			seen.add(checked.tool.id);
			out.push(checked.tool);
		}
		return out;
	}

	private encryptKey(apiKey: string): string {
		if (safeStorage.isEncryptionAvailable()) {
			return safeStorage.encryptString(apiKey).toString('base64');
		}
		return Buffer.from(apiKey, 'utf8').toString('base64');
	}

	private decryptKey(enc?: string): string {
		if (!enc) {
			return '';
		}
		try {
			const buf = Buffer.from(enc, 'base64');
			if (safeStorage.isEncryptionAvailable()) {
				return safeStorage.decryptString(buf);
			}
			return buf.toString('utf8');
		} catch {
			return '';
		}
	}
}

export function isToolEnabled(settings: HawaldarSettings, id: string): boolean {
	return settings.enabledTools.includes(id);
}

export function imageFor(settings: HawaldarSettings, agentId: string): string {
	const pinned = settings.toolImages[agentId]?.trim()
		|| settings.toolImages[SERVICE_IMAGE_ALIAS[agentId] || '']?.trim();
	const fallback = TOOL_CATALOG.find((tool) => tool.agentId === agentId)?.image || '';
	return resolveCatalogServiceImage(agentId, pinned, fallback);
}

export function providerCatalog() {
	return MASTRA_PROVIDERS;
}

function chosenProvider(provider: string | undefined, model: string | undefined): boolean {
	const id = (provider || '').trim();
	const mid = (model || '').trim();
	return Boolean(id && mid && getProvider(id));
}

export const DEFAULT_SESSION_TTL_DAYS = 365;

export function normalizeSessionTtlDays(value: unknown): number {
	const n = Math.floor(Number(value));
	if (!Number.isFinite(n)) {
		return DEFAULT_SESSION_TTL_DAYS;
	}
	return Math.min(3650, Math.max(30, n));
}

function defaultPersisted(): PersistedSettings {
	return {
		provider: '',
		model: '',
		baseUrl: '',
		podmanPath: 'podman',
		scope: [],
		toolImages: defaultImages(),
		enabledTools: defaultEnabled(),
		knownBuiltinTools: builtinToolIds(),
		customTools: [],
		startedServices: [],
		autoStartMachine: false,
		containerEngine: 'podman',
		hasSelectedProvider: false,
		thinking: false,
		sessionTtlDays: DEFAULT_SESSION_TTL_DAYS,
		legalVersion: '',
		legalAcceptedAt: undefined,
		locale: 'en',
		theme: 'dark',
	};
}

const UI_LOCALES = ['en', 'es', 'hi', 'de', 'ja'] as const;

export function normalizeLocale(value: unknown): string {
	const next = typeof value === 'string' ? value.trim() : '';
	return (UI_LOCALES as readonly string[]).includes(next) ? next : 'en';
}

export function normalizeTheme(value: unknown): 'dark' | 'light' {
	return value === 'light' ? 'light' : 'dark';
}

function sameToolImages(stored: Record<string, string> | undefined, hydrated: Record<string, string>): boolean {
	if (!stored) {
		return false;
	}
	const keys = new Set([...Object.keys(stored), ...Object.keys(hydrated)]);
	for (const key of keys) {
		const left = stored[key]?.trim() || '';
		const right = hydrated[key]?.trim() || '';
		if (left !== right) {
			return false;
		}
	}
	return true;
}
