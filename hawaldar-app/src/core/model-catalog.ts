import type { ListedModel, ListModelsResult } from '../preload/api';
import { MASTRA_PROVIDERS, type ProviderInfo } from './providers';

export type { ListedModel, ListModelsResult };

const TIMEOUT_MS = 20_000;
const LIST_TTL_MS = 60_000;

interface GenericModel {
	id?: string;
	name?: string;
	display_name?: string;
	context_length?: number;
	context_window?: number;
	max_model_len?: number;
	inputTokenLimit?: number;
	pricing?: {
		prompt?: string | number;
		completion?: string | number;
		request?: string | number;
	};
	supported_parameters?: string[];
	reasoning?: {
		supported_efforts?: string[] | null;
		default_effort?: string;
		default_enabled?: boolean;
		supports_max_tokens?: boolean;
		mandatory?: boolean;
	} | null;
	top_provider?: {
		context_length?: number;
	};
}

const listCache = new Map<string, { at: number; result: ListModelsResult }>();
const lastByProvider = new Map<string, ListedModel[]>();

/** Last successful list for a provider (used when sending reasoning). */
export function lookupListedModel(providerId: string, modelId: string): ListedModel | undefined {
	const models = lastByProvider.get(providerId) ?? [];
	return models.find((item) => item.id === modelId)
		?? models.find((item) => modelId.endsWith(`/${item.id}`));
}

/** Fetch chat-capable model ids from the provider’s list API; falls back to the static catalog. */
export async function listProviderModels(
	providerId: string,
	apiKey: string,
	baseUrl: string,
	fresh = false,
): Promise<ListModelsResult> {
	const provider = MASTRA_PROVIDERS.find((item) => item.id === providerId);
	if (!provider) {
		return { provider: providerId, models: [], error: `Unknown provider: ${providerId}` };
	}

	const base = (baseUrl || provider.defaultBaseUrl).replace(/\/$/, '');
	const key = `${providerId}|${base}|${apiKey ? '1' : '0'}`;
	if (!fresh) {
		const hit = listCache.get(key);
		if (hit && Date.now() - hit.at < LIST_TTL_MS) {
			lastByProvider.set(providerId, hit.result.models);
			return hit.result;
		}
	}

	let result: ListModelsResult;
	try {
		const models = await fetchListedModels(provider, apiKey, base);
		if (models.length > 0) {
			result = { provider: providerId, models };
		} else {
			result = {
				provider: providerId,
				models: fallbackModels(provider),
				error: 'Provider returned no models; showing defaults.',
			};
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		result = {
			provider: providerId,
			models: fallbackModels(provider),
			error: message,
		};
	}

	listCache.set(key, { at: Date.now(), result });
	lastByProvider.set(providerId, result.models);
	return result;
}

function fallbackModels(provider: ProviderInfo): ListedModel[] {
	return provider.models.map((id) => ({ id, label: id, source: 'fallback' as const }));
}

async function fetchListedModels(provider: ProviderInfo, apiKey: string, base: string): Promise<ListedModel[]> {
	switch (provider.id) {
		case 'anthropic':
			return listAnthropic(apiKey, base);
		case 'google':
			return listGoogle(apiKey, base);
		case 'ollama':
			return listOllama(base);
		default:
			return listOpenAICompatible(apiKey, base, provider.id);
	}
}

async function listOpenAICompatible(apiKey: string, base: string, providerId: string): Promise<ListedModel[]> {
	const headers: Record<string, string> = { Accept: 'application/json' };
	if (apiKey) {
		headers.Authorization = `Bearer ${apiKey}`;
	}
	if (providerId === 'openrouter') {
		headers['HTTP-Referer'] = 'https://hawaldar.local';
		headers['X-Title'] = 'Hawaldar';
	}

	const url = `${openaiRoot(base)}/models`;
	const json = await getJson(url, headers) as { data?: GenericModel[] };
	const models = (json.data ?? [])
		.filter((item): item is GenericModel & { id: string } => Boolean(item.id))
		.filter((item) => filterChatModelId(item.id, providerId))
		.map((item) => toListedModel(item, providerId, 'api'));
	return sortModels(models);
}

async function listAnthropic(apiKey: string, base: string): Promise<ListedModel[]> {
	if (!apiKey) {
		throw new Error('Anthropic API key is required to list models.');
	}
	const root = base.includes('api.anthropic.com') ? 'https://api.anthropic.com' : base.replace(/\/v1\/?$/, '');
	const json = await getJson(`${root}/v1/models`, {
		Accept: 'application/json',
		'x-api-key': apiKey,
		'anthropic-version': '2023-06-01',
	}) as { data?: GenericModel[] };
	const models = (json.data ?? [])
		.filter((item): item is GenericModel & { id: string } => Boolean(item.id))
		.map((item) => toListedModel(item, 'anthropic', 'api'));
	return sortModels(models);
}

async function listGoogle(apiKey: string, base: string): Promise<ListedModel[]> {
	if (!apiKey) {
		throw new Error('Google API key is required to list models.');
	}
	const root = base.includes('generativelanguage.googleapis.com')
		? 'https://generativelanguage.googleapis.com'
		: base.replace(/\/v1beta\/?$/, '');
	const json = await getJson(`${root}/v1beta/models?key=${encodeURIComponent(apiKey)}&pageSize=100`, {
		Accept: 'application/json',
	}) as { models?: Array<GenericModel & { name?: string; supportedGenerationMethods?: string[] }> };

	const models: ListedModel[] = [];
	for (const model of json.models ?? []) {
		const methods = model.supportedGenerationMethods ?? [];
		if (methods.length > 0 && !methods.includes('generateContent')) {
			continue;
		}
		const id = model.name?.replace(/^models\//, '') || model.id;
		if (!id) {
			continue;
		}
		models.push(toListedModel({ ...model, id }, 'google', 'api'));
	}
	return sortModels(models);
}

async function listOllama(base: string): Promise<ListedModel[]> {
	const host = ollamaHost(base);
	try {
		const json = await getJson(`${host}/api/tags`, { Accept: 'application/json' }) as {
			models?: Array<{ name?: string; model?: string }>;
		};
		const models = (json.models ?? [])
			.map((item) => item.name || item.model)
			.filter((id): id is string => Boolean(id))
			.map((id) => ({ id, label: id, source: 'api' as const }));
		if (models.length > 0) {
			return sortModels(models);
		}
	} catch {
		// Fall through to OpenAI-compatible /v1/models
	}
	return listOpenAICompatible('', `${host}/v1`, 'ollama');
}

function toListedModel(item: GenericModel & { id: string }, providerId: string, source: 'api' | 'fallback'): ListedModel {
	const contextWindow = firstNumber(
		item.context_length,
		item.context_window,
		item.max_model_len,
		item.inputTokenLimit,
		item.top_provider?.context_length,
	);
	const label = (item.name || item.display_name || item.id).trim() || item.id;
	const listed: ListedModel = { id: item.id, label, source };
	if (contextWindow) {
		listed.contextWindow = contextWindow;
	}
	const pricing = listedPricing(item);
	if (pricing.free !== undefined) {
		listed.free = pricing.free;
	}
	if (pricing.priceLabel) {
		listed.priceLabel = pricing.priceLabel;
	}
	if (pricing.promptPerMillion !== undefined) {
		listed.promptPerMillion = pricing.promptPerMillion;
	}
	if (providerId === 'openrouter') {
		listed.supportsReasoning = openRouterReasoning(item);
	} else {
		const reasoning = detectReasoning(item);
		if (reasoning) {
			listed.supportsReasoning = true;
		}
	}
	return listed;
}

function listedPricing(item: GenericModel): {
	free?: boolean;
	priceLabel?: string;
	promptPerMillion?: number;
} {
	if (typeof item.id === 'string' && /:free$/i.test(item.id)) {
		return { free: true };
	}
	if (typeof item.name === 'string' && /\(free\)/i.test(item.name)) {
		return { free: true };
	}

	const prompt = parseUsd(item.pricing?.prompt);
	const completion = parseUsd(item.pricing?.completion);
	const request = parseUsd(item.pricing?.request);

	if (prompt === 0 && completion === 0) {
		return { free: true };
	}

	if (prompt !== undefined && prompt > 0) {
		return {
			free: false,
			promptPerMillion: prompt * 1_000_000,
			priceLabel: formatUsdPerMillion(prompt),
		};
	}

	if (completion !== undefined && completion > 0) {
		return {
			free: false,
			priceLabel: formatUsdPerMillion(completion),
		};
	}

	if (request !== undefined && request > 0) {
		return { free: false, priceLabel: formatUsdAmount(request, '/req') };
	}

	return {};
}

/** OpenRouter quotes USD per token as a decimal string (sometimes `$` prefixed). */
function parseUsd(value: string | number | undefined): number | undefined {
	if (value === undefined || value === null || value === '') {
		return undefined;
	}
	if (typeof value === 'number') {
		return Number.isFinite(value) ? value : undefined;
	}
	const cleaned = String(value).trim().replace(/[$,\s]/g, '');
	if (!cleaned) {
		return undefined;
	}
	const n = Number(cleaned);
	return Number.isFinite(n) ? n : undefined;
}

function formatUsdPerMillion(perToken: number): string {
	return formatUsdAmount(perToken * 1_000_000, '/M');
}

function formatUsdAmount(amount: number, suffix: string): string {
	if (!Number.isFinite(amount) || amount <= 0) {
		return '';
	}
	let decimals = 2;
	if (amount < 0.01) {
		decimals = 3;
	}
	if (amount < 0.001) {
		decimals = 4;
	}
	const rounded = amount.toFixed(decimals).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
	if (!rounded || rounded === '0') {
		return '';
	}
	return `$${rounded}${suffix}`;
}

function openRouterReasoning(item: GenericModel): boolean {
	if (item.reasoning && typeof item.reasoning === 'object') {
		return true;
	}
	return detectReasoning(item);
}

function detectReasoning(item: GenericModel): boolean {
	const params = item.supported_parameters ?? [];
	return params.some((param) => /^(reasoning|include_reasoning|reasoning_effort)$/i.test(param));
}

function firstNumber(...values: Array<number | undefined>): number | undefined {
	for (const value of values) {
		if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
			return value;
		}
	}
	return undefined;
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

function filterChatModelId(id: string, providerId: string): boolean {
	if (providerId === 'openai') {
		return /^(gpt-|o[0-9]|chatgpt-|ft:)/i.test(id)
			&& !/(embedding|whisper|tts|dall-e|moderation|realtime|transcribe|image)/i.test(id);
	}
	if (providerId === 'groq') {
		return !/(whisper|tts|guard)/i.test(id);
	}
	if (providerId === 'xai') {
		return /^grok/i.test(id);
	}
	return true;
}

function sortModels(models: ListedModel[]): ListedModel[] {
	const seen = new Set<string>();
	const unique: ListedModel[] = [];
	for (const model of models) {
		if (seen.has(model.id)) {
			continue;
		}
		seen.add(model.id);
		unique.push(model);
	}
	return unique.sort((a, b) => a.id.localeCompare(b.id));
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
