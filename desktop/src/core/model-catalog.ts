import { MASTRA_PROVIDERS, type ProviderInfo } from './providers';

export interface ListedModel {
	id: string;
	label: string;
	source: 'api' | 'fallback';
}

export interface ListModelsResult {
	provider: string;
	models: ListedModel[];
	error?: string;
}

const TIMEOUT_MS = 20_000;

/** Fetch chat-capable model ids from the provider’s list API; falls back to the static catalog. */
export async function listProviderModels(
	providerId: string,
	apiKey: string,
	baseUrl: string,
): Promise<ListModelsResult> {
	const provider = MASTRA_PROVIDERS.find((item) => item.id === providerId);
	if (!provider) {
		return { provider: providerId, models: [], error: `Unknown provider: ${providerId}` };
	}

	const base = (baseUrl || provider.defaultBaseUrl).replace(/\/$/, '');

	try {
		const ids = await fetchModelIds(provider, apiKey, base);
		if (ids.length > 0) {
			return {
				provider: providerId,
				models: ids.map((id) => ({ id, label: id, source: 'api' as const })),
			};
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			provider: providerId,
			models: fallbackModels(provider),
			error: message,
		};
	}

	return {
		provider: providerId,
		models: fallbackModels(provider),
		error: 'Provider returned no models; showing defaults.',
	};
}

function fallbackModels(provider: ProviderInfo): ListedModel[] {
	return provider.models.map((id) => ({ id, label: id, source: 'fallback' as const }));
}

async function fetchModelIds(provider: ProviderInfo, apiKey: string, base: string): Promise<string[]> {
	switch (provider.id) {
		case 'anthropic':
			return listAnthropic(apiKey, base);
		case 'google':
			return listGoogle(apiKey, base);
		case 'ollama':
			return listOllama(base);
		case 'openai':
		case 'groq':
		case 'openrouter':
		case 'xai':
		case 'lmstudio':
		case 'custom':
			return listOpenAICompatible(apiKey, base, provider.id);
		default:
			return listOpenAICompatible(apiKey, base, provider.id);
	}
}

async function listOpenAICompatible(apiKey: string, base: string, providerId: string): Promise<string[]> {
	const headers: Record<string, string> = { Accept: 'application/json' };
	if (apiKey) {
		headers.Authorization = `Bearer ${apiKey}`;
	}
	if (providerId === 'openrouter') {
		headers['HTTP-Referer'] = 'https://hawaldar.local';
		headers['X-Title'] = 'Hawaldar';
	}

	const url = `${openaiRoot(base)}/models`;
	const json = await getJson(url, headers) as { data?: Array<{ id?: string }> };
	const ids = (json.data ?? [])
		.map((item) => item.id)
		.filter((id): id is string => Boolean(id));
	return sortIds(filterChatModels(ids, providerId));
}

async function listAnthropic(apiKey: string, base: string): Promise<string[]> {
	if (!apiKey) {
		throw new Error('Anthropic API key is required to list models.');
	}
	const root = base.includes('api.anthropic.com') ? 'https://api.anthropic.com' : base.replace(/\/v1\/?$/, '');
	const json = await getJson(`${root}/v1/models`, {
		Accept: 'application/json',
		'x-api-key': apiKey,
		'anthropic-version': '2023-06-01',
	}) as { data?: Array<{ id?: string }> };
	const ids = (json.data ?? [])
		.map((item) => item.id)
		.filter((id): id is string => Boolean(id));
	return sortIds(ids);
}

async function listGoogle(apiKey: string, base: string): Promise<string[]> {
	if (!apiKey) {
		throw new Error('Google API key is required to list models.');
	}
	const root = base.includes('generativelanguage.googleapis.com')
		? 'https://generativelanguage.googleapis.com'
		: base.replace(/\/v1beta\/?$/, '');
	const json = await getJson(`${root}/v1beta/models?key=${encodeURIComponent(apiKey)}&pageSize=100`, {
		Accept: 'application/json',
	}) as { models?: Array<{ name?: string; supportedGenerationMethods?: string[] }> };

	const ids: string[] = [];
	for (const model of json.models ?? []) {
		const methods = model.supportedGenerationMethods ?? [];
		if (methods.length > 0 && !methods.includes('generateContent')) {
			continue;
		}
		const name = model.name?.replace(/^models\//, '');
		if (name) {
			ids.push(name);
		}
	}
	return sortIds(ids);
}

async function listOllama(base: string): Promise<string[]> {
	const host = ollamaHost(base);
	try {
		const json = await getJson(`${host}/api/tags`, { Accept: 'application/json' }) as {
			models?: Array<{ name?: string; model?: string }>;
		};
		const ids = (json.models ?? [])
			.map((item) => item.name || item.model)
			.filter((id): id is string => Boolean(id));
		if (ids.length > 0) {
			return sortIds(ids);
		}
	} catch {
		// Fall through to OpenAI-compatible /v1/models
	}
	return listOpenAICompatible('', `${host}/v1`, 'ollama');
}

function openaiRoot(base: string): string {
	if (/\/v\d+$/i.test(base)) {
		return base;
	}
	return `${base}/v1`;
}

function ollamaHost(base: string): string {
	try {
		const url = new URL(base.includes('://') ? base : `http://${base}`);
		return `${url.protocol}//${url.host}`;
	} catch {
		return 'http://127.0.0.1:11434';
	}
}

function filterChatModels(ids: string[], providerId: string): string[] {
	if (providerId === 'openai') {
		return ids.filter((id) =>
			/^(gpt-|o[0-9]|chatgpt-|ft:)/i.test(id)
			&& !/(embedding|whisper|tts|dall-e|moderation|realtime|transcribe|image)/i.test(id),
		);
	}
	if (providerId === 'groq') {
		return ids.filter((id) => !/(whisper|tts|guard)/i.test(id));
	}
	if (providerId === 'xai') {
		return ids.filter((id) => /^grok/i.test(id));
	}
	return ids;
}

function sortIds(ids: string[]): string[] {
	return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}

async function getJson(url: string, headers: Record<string, string>): Promise<unknown> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
	try {
		const response = await fetch(url, { method: 'GET', headers, signal: controller.signal });
		if (!response.ok) {
			const body = await response.text().catch(() => '');
			throw new Error(`HTTP ${response.status} listing models${body ? `: ${body.slice(0, 200)}` : ''}`);
		}
		return await response.json();
	} finally {
		clearTimeout(timer);
	}
}
