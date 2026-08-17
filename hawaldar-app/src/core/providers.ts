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

export function getProvider(id: string): ProviderInfo | undefined {
	return MASTRA_PROVIDERS.find((item) => item.id === id);
}

export function providerEnvVar(id: string): string {
	return getProvider(id)?.envVar ?? 'OPENAI_API_KEY';
}

export function applyProviderEnv(provider: string, apiKey: string, baseUrl: string): void {
	if (apiKey) {
		const envVar = providerEnvVar(provider);
		if (envVar) {
			process.env[envVar] = apiKey;
		}
		process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || apiKey;
	}
	if (baseUrl) {
		process.env.OPENAI_BASE_URL = baseUrl;
		process.env.OPENAI_API_BASE = baseUrl;
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
