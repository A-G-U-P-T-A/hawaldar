import { isToolEnabled, type HawaldarSettings } from '../settings';
import { runBrowserTool, type BrowserToolInput } from './browser';

export type ResearchToolInput = BrowserToolInput;

const TRANSIENT_SEARCH = /ERR_NETWORK_CHANGED|ERR_INTERNET_DISCONNECTED|ERR_CONNECTION_RESET|Timeout \d+ms exceeded|net::ERR_/i;

/** Mastra inputSchema for research tools. Uses the runtime `z` instance. */
export function buildResearchInputSchema(z: any, id: string) {
	const engine = z.enum(['duckduckgo', 'google', 'bing']).optional()
		.describe('Search engine hop only (default duckduckgo). Result links are not auto-visited.');
	if (id === 'research-search') {
		return z.object({
			query: z.string().describe('Docs / RFC / CVE / advisory search. Search engines are a hop; out-of-scope results are listed, not visited.'),
			engine,
		});
	}
	return z.object({
		target: z.string().optional()
			.describe('In-scope or named-target http(s) documentation URL. Same scope rules as browser-open. javascript: refused.'),
		url: z.string().optional(),
	});
}

export async function runResearchTool(
	settings: HawaldarSettings,
	id: string,
	input: ResearchToolInput,
) {
	if (!isToolEnabled(settings, id)) {
		return { ok: false, stdout: '', stderr: `${id} is disabled.`, exitCode: 1 };
	}
	if (id === 'research-search') {
		const result = await runBrowserTool(withEnabled(settings, 'browser-search'), 'browser-search', input);
		if (!result.ok && TRANSIENT_SEARCH.test(result.stderr || '')) {
			const note = String(result.stderr || 'search unavailable').slice(0, 240);
			return {
				ok: true,
				stdout: JSON.stringify({
					action: 'search',
					results: [],
					note: `Search skipped (${note}). Continue from known public docs; do not block the engagement.`,
				}, null, 2),
				stderr: '',
				exitCode: 0,
			};
		}
		return result;
	}
	if (id === 'research-open') {
		return runBrowserTool(withEnabled(settings, 'browser-open'), 'browser-open', input);
	}
	return { ok: false, stdout: '', stderr: `Unknown tool: ${id}`, exitCode: 1 };
}

function withEnabled(settings: HawaldarSettings, extra: string): HawaldarSettings {
	if (settings.enabledTools.includes(extra)) {
		return settings;
	}
	return { ...settings, enabledTools: [...settings.enabledTools, extra] };
}
