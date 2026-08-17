import type { MastraModules } from '../load-mastra';
import type { HawaldarSettings } from '../settings';
import { mastraCustomModelUrl, openRouterRequestHeaders, resolveProviderApiKey } from '../providers';

export interface EmbedderHandle {
	ready: boolean;
	dimension: number;
	modelId: string;
	/** Mastra ModelRouterEmbeddingModel instance, if construction succeeded. */
	router?: unknown;
	error?: string;
	embed(texts: string[]): Promise<number[][] | null>;
}

/** Constructor args for `@mastra/core` ModelRouterEmbeddingModel (`providerId` + `modelId`, not a 3-segment `id`). */
export interface EmbedderRouterConfig {
	providerId: string;
	modelId: string;
	url?: string;
	apiKey?: string;
	headers?: Record<string, string>;
}

interface EmbedPlan {
	router: EmbedderRouterConfig;
	http: { url: string; apiKey: string; model: string };
	dimension: number;
	/** Two-segment Mastra-safe id (`provider/model`). */
	modelId: string;
}

const BATCH = 16;

export function createEmbedder(settings: HawaldarSettings, mods: MastraModules): EmbedderHandle {
	const plan = embeddingPlan(settings);
	if (!plan) {
		return {
			ready: false,
			dimension: 0,
			modelId: '',
			embed: async () => null,
		};
	}

	const created = tryCreateRouterEmbedder(settings, mods);
	return {
		ready: true,
		dimension: plan.dimension,
		modelId: plan.modelId,
		router: created.instance,
		error: created.error,
		async embed(texts: string[]): Promise<number[][] | null> {
			const clean = texts.map((item) => item.replace(/\s+/g, ' ').trim()).filter(Boolean);
			if (clean.length === 0) {
				return [];
			}
			const out: number[][] = [];
			for (let i = 0; i < clean.length; i += BATCH) {
				const slice = clean.slice(i, i + BATCH);
				const batch = await embedBatch(slice, created.instance, plan);
				if (!batch) {
					return null;
				}
				out.push(...batch);
			}
			return out;
		},
	};
}

/** Build a ModelRouterEmbeddingModel without throwing. OpenRouter uses `{ providerId, modelId }` so `openai/` stays in the API model, not the router `id`. */
export function tryCreateRouterEmbedder(
	settings: HawaldarSettings,
	mods: MastraModules,
): { instance?: unknown; error?: string } {
	const plan = embeddingPlan(settings);
	if (!plan || !mods.ModelRouterEmbeddingModel) {
		return {};
	}
	try {
		return { instance: new mods.ModelRouterEmbeddingModel(plan.router) };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

export function embeddingPlan(settings: HawaldarSettings): EmbedPlan | null {
	const provider = settings.provider;
	const key = resolveProviderApiKey(provider, settings.apiKey);
	const local = isLocalProvider(provider);
	if (!key && !local) {
		return null;
	}
	const base = (settings.baseUrl || defaultBase(provider)).replace(/\/+$/, '');
	if (provider === 'openai') {
		return {
			modelId: 'openai/text-embedding-3-small',
			dimension: 1536,
			router: {
				providerId: 'openai',
				modelId: 'text-embedding-3-small',
				url: settings.baseUrl || undefined,
				apiKey: key || undefined,
			},
			http: { url: `${base}/embeddings`, apiKey: key, model: 'text-embedding-3-small' },
		};
	}
	if (provider === 'openrouter') {
		const custom = mastraCustomModelUrl(provider, base, false);
		return {
			modelId: 'openrouter/text-embedding-3-small',
			dimension: 1536,
			router: {
				providerId: 'openrouter',
				modelId: 'openai/text-embedding-3-small',
				...(custom ? { url: custom } : {}),
				apiKey: key || undefined,
				headers: openRouterRequestHeaders(key),
			},
			http: { url: `${base}/embeddings`, apiKey: key, model: 'openai/text-embedding-3-small' },
		};
	}
	if (provider === 'google') {
		return {
			modelId: 'google/gemini-embedding-001',
			dimension: 768,
			router: {
				providerId: 'google',
				modelId: 'gemini-embedding-001',
				apiKey: key || undefined,
			},
			http: { url: `${base}/embeddings`, apiKey: key, model: 'gemini-embedding-001' },
		};
	}
	if (provider === 'ollama') {
		return {
			modelId: 'ollama/nomic-embed-text',
			dimension: 768,
			router: {
				providerId: 'ollama',
				modelId: 'nomic-embed-text',
				url: base,
				apiKey: key || 'ollama',
			},
			http: { url: `${base}/embeddings`, apiKey: key || 'ollama', model: 'nomic-embed-text' },
		};
	}
	if (local) {
		return {
			modelId: 'openai/text-embedding-3-small',
			dimension: 1536,
			router: {
				providerId: 'openai',
				modelId: 'text-embedding-3-small',
				url: base,
				apiKey: key || 'local',
			},
			http: { url: `${base}/embeddings`, apiKey: key || 'local', model: 'text-embedding-3-small' },
		};
	}
	if (key) {
		return {
			modelId: 'openai/text-embedding-3-small',
			dimension: 1536,
			router: {
				providerId: 'openai',
				modelId: 'text-embedding-3-small',
				url: base,
				apiKey: key,
			},
			http: { url: `${base}/embeddings`, apiKey: key, model: 'text-embedding-3-small' },
		};
	}
	return null;
}

async function embedBatch(texts: string[], router: unknown, plan: EmbedPlan): Promise<number[][] | null> {
	if (router && typeof (router as { doEmbed?: unknown }).doEmbed === 'function') {
		try {
			const result = await (router as { doEmbed: (args: { values: string[] }) => Promise<{ embeddings?: number[][] }> }).doEmbed({ values: texts });
			if (Array.isArray(result?.embeddings) && result.embeddings.length === texts.length) {
				return result.embeddings;
			}
		} catch {
			/* fall through to HTTP */
		}
	}
	if (!plan.http) {
		return null;
	}
	try {
		const res = await fetch(plan.http.url, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				...(plan.router.providerId === 'openrouter'
					? openRouterRequestHeaders(plan.http.apiKey)
					: { authorization: `Bearer ${plan.http.apiKey}` }),
			},
			body: JSON.stringify({ model: plan.http.model, input: texts }),
		});
		if (!res.ok) {
			return null;
		}
		const body = await res.json() as { data?: Array<{ embedding?: number[] }> };
		const vectors = (body.data ?? []).map((row) => row.embedding).filter((row): row is number[] => Array.isArray(row));
		return vectors.length === texts.length ? vectors : null;
	} catch {
		return null;
	}
}

function isLocalProvider(provider: string): boolean {
	return provider === 'ollama' || provider === 'lmstudio' || provider === 'custom';
}

function defaultBase(provider: string): string {
	if (provider === 'openai') {
		return 'https://api.openai.com/v1';
	}
	if (provider === 'openrouter') {
		return 'https://openrouter.ai/api/v1';
	}
	if (provider === 'google') {
		return 'https://generativelanguage.googleapis.com/v1beta/openai';
	}
	if (provider === 'ollama') {
		return 'http://127.0.0.1:11434/v1';
	}
	return 'http://127.0.0.1:1234/v1';
}
