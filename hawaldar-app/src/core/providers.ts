export interface ProviderInfo {
	id: string;
	label: string;
	envVar: string;
	defaultBaseUrl: string;
	models: string[];
	/** How models are listed from the network. */
	listKind: 'openai' | 'anthropic' | 'google' | 'ollama';
}

export const MASTRA_PROVIDERS: ProviderInfo[] = [
	{ id: 'openai', label: 'OpenAI', envVar: 'OPENAI_API_KEY', defaultBaseUrl: 'https://api.openai.com/v1', listKind: 'openai', models: ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4o', 'o4-mini', 'o3-mini'] },
	{ id: 'anthropic', label: 'Anthropic', envVar: 'ANTHROPIC_API_KEY', defaultBaseUrl: 'https://api.anthropic.com', listKind: 'anthropic', models: ['claude-sonnet-4-6', 'claude-opus-4-6', 'claude-haiku-4-5'] },
	{ id: 'google', label: 'Google', envVar: 'GOOGLE_GENERATIVE_AI_API_KEY', defaultBaseUrl: 'https://generativelanguage.googleapis.com', listKind: 'google', models: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash'] },
	{ id: 'groq', label: 'Groq', envVar: 'GROQ_API_KEY', defaultBaseUrl: 'https://api.groq.com/openai/v1', listKind: 'openai', models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768'] },
	{ id: 'openrouter', label: 'OpenRouter', envVar: 'OPENROUTER_API_KEY', defaultBaseUrl: 'https://openrouter.ai/api/v1', listKind: 'openai', models: ['anthropic/claude-sonnet-4-6', 'openai/gpt-4.1', 'google/gemini-2.5-flash'] },
	{ id: 'xai', label: 'xAI', envVar: 'XAI_API_KEY', defaultBaseUrl: 'https://api.x.ai/v1', listKind: 'openai', models: ['grok-4', 'grok-3', 'grok-3-mini'] },
	{ id: 'ollama', label: 'Ollama', envVar: '', defaultBaseUrl: 'http://127.0.0.1:11434/v1', listKind: 'ollama', models: ['llama3.2', 'llama3.1', 'mistral', 'qwen2.5'] },
	{ id: 'lmstudio', label: 'LM Studio', envVar: '', defaultBaseUrl: 'http://127.0.0.1:1234/v1', listKind: 'openai', models: ['local'] },
	{ id: 'custom', label: 'OpenAI-compatible', envVar: 'OPENAI_API_KEY', defaultBaseUrl: 'http://127.0.0.1:11434/v1', listKind: 'openai', models: ['local'] },
];

export const MISSING_API_KEY_HINT = 'Set an API key in Settings → Providers.';

export const OPENROUTER_MISSING_KEY =
	'OpenRouter API key missing. Settings → Provider → paste key → Save (applies on the next message). Or set OPENROUTER_API_KEY in hawaldar-app/.env or the repo .env.';

/** OpenRouter app attribution. Authorization is added separately when a key exists. */
export const OPENROUTER_APP_HEADERS: Record<string, string> = {
	'HTTP-Referer': 'https://hawaldar.local',
	'X-Title': 'Hawaldar',
};

export function getProvider(id: string): ProviderInfo | undefined {
	return MASTRA_PROVIDERS.find((item) => item.id === id);
}

export function providerEnvVar(id: string): string {
	return getProvider(id)?.envVar ?? 'OPENAI_API_KEY';
}

/** Cloud providers that must send a Bearer key (not Ollama / LM Studio). */
export function providerNeedsApiKey(provider: string): boolean {
	return Boolean(getProvider(provider)?.envVar);
}

export function isDefaultProviderUrl(provider: string, baseUrl: string): boolean {
	const expected = (getProvider(provider)?.defaultBaseUrl || '').replace(/\/+$/, '');
	const actual = (baseUrl || '').replace(/\/+$/, '');
	return Boolean(expected) && actual === expected;
}

/** True for OpenRouter's public API host. Passing this as Mastra `url` skips Bearer auth. */
export function isOpenRouterGatewayUrl(baseUrl: string): boolean {
	const actual = (baseUrl || '').trim();
	if (!actual) {
		return false;
	}
	if (isDefaultProviderUrl('openrouter', actual)) {
		return true;
	}
	try {
		const host = new URL(actual.includes('://') ? actual : `https://${actual}`).hostname.replace(/^www\./, '');
		return host === 'openrouter.ai';
	} catch {
		return /openrouter\.ai/i.test(actual);
	}
}

/**
 * URL to put on Mastra's model config. Omit OpenRouter's own host so Mastra uses
 * the OpenRouter gateway (Authorization: Bearer) instead of openai-compatible.
 */
export function mastraCustomModelUrl(provider: string, baseUrl: string, local: boolean): string | undefined {
	const trimmed = (baseUrl || '').replace(/\/+$/, '').trim();
	if (!trimmed) {
		return undefined;
	}
	if (provider === 'openrouter' && isOpenRouterGatewayUrl(trimmed)) {
		return undefined;
	}
	if (!local && isDefaultProviderUrl(provider, trimmed)) {
		return undefined;
	}
	return trimmed;
}

/** OpenRouter chat/embeddings headers. Never log the returned Authorization value. */
export function openRouterRequestHeaders(apiKey: string): Record<string, string> {
	const headers: Record<string, string> = { ...OPENROUTER_APP_HEADERS };
	const key = apiKey.trim();
	if (key) {
		headers.Authorization = `Bearer ${key}`;
	}
	return headers;
}

export function missingProviderApiKeyError(provider?: string): Error {
	if (provider === 'openrouter') {
		return new Error(OPENROUTER_MISSING_KEY);
	}
	const label = getProvider(provider || '')?.label || 'This provider';
	return new Error(`${label} needs an API key. ${MISSING_API_KEY_HINT}`);
}

/** Settings key wins; otherwise OPENROUTER_API_KEY / the provider env var. */
export function resolveProviderApiKey(provider: string, settingsKey?: string): string {
	const fromSettings = (settingsKey || '').trim();
	if (fromSettings) {
		return fromSettings;
	}
	const envVar = providerEnvVar(provider);
	if (envVar) {
		const fromEnv = (process.env[envVar] || '').trim();
		if (fromEnv) {
			return fromEnv;
		}
	}
	if (provider === 'openrouter') {
		return (process.env.OPENROUTER_API_KEY || '').trim();
	}
	return '';
}

export function applyProviderEnv(provider: string, apiKey: string, baseUrl: string): void {
	const key = resolveProviderApiKey(provider, apiKey);
	if (key) {
		const envVar = providerEnvVar(provider);
		if (envVar) {
			process.env[envVar] = key;
		}
		if (provider === 'openrouter') {
			process.env.OPENROUTER_API_KEY = key;
		} else {
			process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || key;
		}
	}
	const trimmedBase = (baseUrl || '').replace(/\/+$/, '');
	// OpenRouter's own host on OPENAI_BASE_URL makes clients skip Bearer auth.
	if (provider === 'openrouter' && (!trimmedBase || isOpenRouterGatewayUrl(trimmedBase))) {
		delete process.env.OPENAI_BASE_URL;
		delete process.env.OPENAI_API_BASE;
		return;
	}
	if (trimmedBase) {
		process.env.OPENAI_BASE_URL = trimmedBase;
		process.env.OPENAI_API_BASE = trimmedBase;
	}
}

export function routerModelId(provider: string, model: string): string {
	if (provider === 'custom' || provider === 'lmstudio') {
		return `openai/${model}`;
	}
	if (provider === 'ollama') {
		return `ollama/${model}`;
	}
	return `${provider}/${model}`;
}
