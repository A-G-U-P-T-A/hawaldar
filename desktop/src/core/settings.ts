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
import { defaultEnabled, defaultImages, TOOL_CATALOG } from './tools/catalog';
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
}

interface PersistedSettings {
	provider: string;
	model: string;
	baseUrl: string;
	podmanPath: string;
	scope: string[];
	toolImages: Record<string, string>;
	enabledTools: string[];
	customTools: CustomToolDef[];
	startedServices: string[];
	autoStartMachine: boolean;
	containerEngine: 'podman' | 'docker';
	apiKeyEnc?: string;
	/** Last time provider / model / baseUrl were written to settings.json. */
	providerUpdatedAt?: number;
	hasSelectedProvider?: boolean;
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
		return {
			provider: raw.provider,
			model: raw.model,
			baseUrl: raw.baseUrl.replace(/\/$/, ''),
			apiKey: this.decryptKey(raw.apiKeyEnc),
			podmanPath,
			scope: raw.scope,
			toolImages: { ...defaultImages(), ...raw.toolImages },
			enabledTools: raw.enabledTools.length > 0 ? raw.enabledTools : defaultEnabled(),
			customTools: raw.customTools,
			startedServices: raw.startedServices,
			autoStartMachine: raw.autoStartMachine,
			containerEngine,
			hasSelectedProvider: raw.hasSelectedProvider === true,
			extensionPath: this.extensionPath,
			cacheDir: this.cacheDir,
		};
	}

	async write(patch: SettingsPatch): Promise<HawaldarSettings> {
		const current = await this.resolvePersisted();
		const providerChanged = patch.provider !== undefined
			|| patch.model !== undefined
			|| patch.baseUrl !== undefined;
		const hasSelectedProvider = patch.provider !== undefined
			? true
			: current.hasSelectedProvider === true;
		const next: PersistedSettings = {
			provider: patch.provider ?? current.provider,
			model: patch.model ?? current.model,
			baseUrl: (patch.baseUrl ?? current.baseUrl).replace(/\/$/, ''),
			providerUpdatedAt: providerChanged ? Date.now() : current.providerUpdatedAt,
			hasSelectedProvider,
			podmanPath: patch.podmanPath ?? current.podmanPath,
			scope: patch.scopeText !== undefined
				? patch.scopeText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
				: (patch.scope ?? current.scope),
			toolImages: patch.toolImages ?? current.toolImages,
			enabledTools: patch.enabledTools ?? current.enabledTools,
			customTools: patch.customTools !== undefined
				? this.normalizeCustomTools(patch.customTools)
				: current.customTools,
			startedServices: patch.startedServices ?? current.startedServices,
			autoStartMachine: patch.autoStartMachine ?? current.autoStartMachine,
			containerEngine: patch.containerEngine === 'docker'
				? 'docker'
				: patch.containerEngine === 'podman'
					? 'podman'
					: (current.containerEngine === 'docker' ? 'docker' : 'podman'),
			apiKeyEnc: current.apiKeyEnc,
		};
		if (patch.apiKey !== undefined && patch.apiKey !== '') {
			next.apiKeyEnc = this.encryptKey(patch.apiKey);
		}
		fs.writeFileSync(this.settingsPath, JSON.stringify(next, null, 2), 'utf8');
		if (hasSelectedProvider) {
			await this.prefs.upsert({
				provider: next.provider,
				model: next.model,
				baseUrl: next.baseUrl,
				enabled: next.provider,
				hasSelected: true,
				updatedAt: next.providerUpdatedAt ?? Date.now(),
			});
		}
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
		const db = await this.prefs.get();
		if (!db) {
			return { ...json, hasSelectedProvider: false };
		}
		const selected = db.hasSelected === true && Boolean(db.enabled || db.provider);
		const jsonTs = json.providerUpdatedAt ?? 0;
		const jsonKnown = Boolean(json.provider && getProvider(json.provider));
		if (jsonKnown && json.hasSelectedProvider === true && jsonTs > db.updatedAt) {
			await this.prefs.upsert({
				provider: json.provider,
				model: json.model,
				baseUrl: json.baseUrl,
				enabled: json.provider,
				hasSelected: true,
				updatedAt: jsonTs,
			});
			return { ...json, hasSelectedProvider: true };
		}
		const hydrated: PersistedSettings = {
			...json,
			provider: db.enabled || db.provider || json.provider,
			model: db.model || json.model,
			baseUrl: db.baseUrl || json.baseUrl,
			providerUpdatedAt: db.updatedAt,
			hasSelectedProvider: selected,
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
			const provider = parsed.provider && getProvider(parsed.provider) ? parsed.provider : 'openai';
			return {
				provider,
				model: parsed.model || 'gpt-4.1',
				baseUrl: parsed.baseUrl || 'https://api.openai.com/v1',
				podmanPath: parsed.podmanPath || 'podman',
				scope: Array.isArray(parsed.scope) ? parsed.scope : [],
				toolImages: parsed.toolImages || defaultImages(),
				enabledTools: Array.isArray(parsed.enabledTools) ? parsed.enabledTools : defaultEnabled(),
				customTools: this.normalizeCustomTools(parsed.customTools || []),
				startedServices: Array.isArray(parsed.startedServices) ? parsed.startedServices.map(String) : [],
				autoStartMachine: Boolean(parsed.autoStartMachine),
				containerEngine: parsed.containerEngine === 'docker' ? 'docker' : 'podman',
				apiKeyEnc: parsed.apiKeyEnc,
				providerUpdatedAt: Number(parsed.providerUpdatedAt) || undefined,
				hasSelectedProvider: parsed.hasSelectedProvider === true,
			};
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
	return settings.toolImages[agentId] || TOOL_CATALOG.find((tool) => tool.agentId === agentId)?.image || '';
}

export function providerCatalog() {
	return MASTRA_PROVIDERS;
}

function defaultPersisted(): PersistedSettings {
	return {
		provider: 'openai',
		model: 'gpt-4.1',
		baseUrl: 'https://api.openai.com/v1',
		podmanPath: 'podman',
		scope: [],
		toolImages: defaultImages(),
		enabledTools: defaultEnabled(),
		customTools: [],
		startedServices: [],
		autoStartMachine: false,
		containerEngine: 'podman',
		hasSelectedProvider: false,
	};
}
