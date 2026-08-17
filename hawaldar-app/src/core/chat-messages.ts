import { getProvider, MISSING_API_KEY_HINT, OPENROUTER_MISSING_KEY, resolveProviderApiKey } from './providers';
import { restoreTargetPlaceholders } from './policy';
import { currentToolContext } from './tool-context';
import {
	collapseWorkingMemoryInSystemMessage,
	collapseWorkingMemoryText,
	sanitizeWorkingMemoryUpdate,
} from './working-memory';

/** Shown only when chat returned nothing and no provider / key is configured. */
export const ONBOARDING_PROVIDER_HINT = `No reply. ${MISSING_API_KEY_HINT}`;

const TOOL_PART_TYPES = new Set([
	'tool-call',
	'tool-result',
	'tool-invocation',
	'tool-called',
	'tool-use',
	'function_call',
	'function',
	'tool_result',
]);

/** Cohere / OpenRouter strip these; keeping them makes a later `content: ""`. */
const NON_PROVIDER_PART_TYPES = new Set([
	'reasoning',
	'reasoning-delta',
	'redacted-reasoning',
	'thought',
	'step-start',
	'step-end',
	'step-finish',
]);

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
}

function isNonEmptyText(value: unknown): value is string {
	return typeof value === 'string' && value.trim().length > 0;
}

function isToolPartType(type: string): boolean {
	return TOOL_PART_TYPES.has(type) || type.startsWith('tool-') || type.startsWith('tool_');
}

function partHasPayload(part: unknown): boolean {
	if (typeof part === 'string') {
		return part.trim().length > 0;
	}
	const rec = asRecord(part);
	if (!rec) {
		return false;
	}
	const type = String(rec.type ?? '');
	if (NON_PROVIDER_PART_TYPES.has(type)) {
		return false;
	}
	if (isToolPartType(type)) {
		return true;
	}
	if (rec.toolCallId || rec.tool_call_id || rec.toolName || rec.tool_name || (rec.id && (rec.args || rec.input || rec.result || rec.output))) {
		return true;
	}
	if (type === 'file' || type === 'image' || type === 'source' || type === 'source-url' || type === 'source-document') {
		return true;
	}
	if (isNonEmptyText(rec.text) || isNonEmptyText(rec.content)) {
		return true;
	}
	if (Array.isArray(rec.parts) && rec.parts.some(partHasPayload)) {
		return true;
	}
	return false;
}

function contentHasPayload(content: unknown): boolean {
	if (isNonEmptyText(content)) {
		return true;
	}
	if (Array.isArray(content)) {
		return content.some(partHasPayload);
	}
	const rec = asRecord(content);
	if (!rec) {
		return false;
	}
	if (isNonEmptyText(rec.content) || isNonEmptyText(rec.text)) {
		return true;
	}
	if (Array.isArray(rec.parts) && rec.parts.some(partHasPayload)) {
		return true;
	}
	if (Array.isArray(rec.toolInvocations) && rec.toolInvocations.length > 0) {
		return true;
	}
	if (Array.isArray(rec.tool_calls) && rec.tool_calls.length > 0) {
		return true;
	}
	if (Array.isArray(rec.toolCalls) && rec.toolCalls.length > 0) {
		return true;
	}
	return false;
}

/** True when a history / prompt message is legal for Cohere / OpenRouter (text or tool payload). */
export function messageHasSendablePayload(message: unknown): boolean {
	const rec = asRecord(message);
	if (!rec) {
		return isNonEmptyText(message);
	}
	if (Array.isArray(rec.tool_calls) && rec.tool_calls.length > 0) {
		return true;
	}
	if (Array.isArray(rec.toolCalls) && rec.toolCalls.length > 0) {
		return true;
	}
	if (Array.isArray(rec.toolInvocations) && rec.toolInvocations.length > 0) {
		return true;
	}
	const type = String(rec.type ?? '');
	if (type === 'tool-result' || type === 'tool-call' || type === 'tool-invocation') {
		return true;
	}
	if (contentHasPayload(rec.content)) {
		return true;
	}
	if (Array.isArray(rec.parts) && rec.parts.some(partHasPayload)) {
		return true;
	}
	if (isNonEmptyText(rec.text)) {
		return true;
	}
	return false;
}

function collectToolCallIds(message: unknown): string[] {
	const rec = asRecord(message);
	if (!rec) {
		return [];
	}
	const ids: string[] = [];
	const push = (value: unknown) => {
		const id = String(value ?? '').trim();
		if (id) {
			ids.push(id);
		}
	};
	for (const list of [rec.tool_calls, rec.toolCalls, rec.toolInvocations]) {
		if (!Array.isArray(list)) {
			continue;
		}
		for (const item of list) {
			const row = asRecord(item);
			if (row) {
				push(row.id ?? row.toolCallId ?? row.tool_call_id);
			}
		}
	}
	const bags = [rec.content, rec.parts, asRecord(rec.content)?.parts];
	for (const bag of bags) {
		if (!Array.isArray(bag)) {
			continue;
		}
		for (const part of bag) {
			const row = asRecord(part);
			if (!row) {
				continue;
			}
			const type = String(row.type ?? '');
			if (isToolPartType(type) && type.includes('result')) {
				continue;
			}
			if (isToolPartType(type) || row.toolCallId || row.tool_call_id) {
				push(row.toolCallId ?? row.tool_call_id ?? row.id);
			}
			const inv = asRecord(row.toolInvocation);
			if (inv) {
				push(inv.toolCallId ?? inv.tool_call_id ?? inv.id);
			}
		}
	}
	return ids;
}

function collectToolResultIds(message: unknown): string[] {
	const rec = asRecord(message);
	if (!rec) {
		return [];
	}
	const ids: string[] = [];
	const push = (value: unknown) => {
		const id = String(value ?? '').trim();
		if (id) {
			ids.push(id);
		}
	};
	if (String(rec.role ?? '') === 'tool') {
		push(rec.toolCallId ?? rec.tool_call_id ?? rec.id);
	}
	const bags = [rec.content, rec.parts, asRecord(rec.content)?.parts];
	for (const bag of bags) {
		if (!Array.isArray(bag)) {
			continue;
		}
		for (const part of bag) {
			const row = asRecord(part);
			if (!row) {
				continue;
			}
			const type = String(row.type ?? '');
			if (type.includes('result') || type === 'tool-result' || type === 'tool_result') {
				push(row.toolCallId ?? row.tool_call_id ?? row.id);
			}
		}
	}
	return ids;
}

function restoreMessageText(value: string): string {
	return restoreTargetPlaceholders(value, currentToolContext()?.impliedTargets ?? []);
}

const EMPTY_TOOL_RESULT = '(tool returned no output)';

function isBlankText(value: unknown): boolean {
	return typeof value !== 'string' || value.trim().length === 0;
}

/**
 * Cohere rejects `tool_results` entries without `outputs`; OpenRouter builds them
 * from each tool message's content, so an empty output becomes a 400. Mastra's
 * agent-* delegation maps the result to `result.text ?? ''`, and a sub-agent that
 * ends on a tool call has no final text — the main empty-output source.
 */
function fillEmptyToolResultOutput(part: unknown): unknown {
	const rec = asRecord(part);
	if (!rec) {
		return part;
	}
	const type = String(rec.type ?? '');
	if (type === 'tool-result' || type === 'tool_result') {
		const output = asRecord(rec.output);
		if (!output) {
			return { ...rec, output: { type: 'text', value: EMPTY_TOOL_RESULT } };
		}
		const outType = String(output.type ?? '');
		if (outType === 'text' || outType === 'error-text') {
			return isBlankText(output.value) ? { ...rec, output: { ...output, value: EMPTY_TOOL_RESULT } } : part;
		}
		if (outType === 'json' || outType === 'error-json') {
			return output.value === undefined ? { ...rec, output: { ...output, value: null } } : part;
		}
		if (outType === 'content') {
			return !Array.isArray(output.value) || output.value.length === 0
				? { ...rec, output: { type: 'text', value: EMPTY_TOOL_RESULT } }
				: part;
		}
		return part;
	}
	if (type === 'tool-invocation') {
		const inv = asRecord(rec.toolInvocation);
		if (!inv || (inv.state !== 'result' && inv.state !== 'output-denied' && inv.state !== 'output-error')) {
			return part;
		}
		const result = inv.result;
		if (result === undefined || result === null || (typeof result === 'string' && !result.trim())) {
			return { ...rec, toolInvocation: { ...inv, result: EMPTY_TOOL_RESULT } };
		}
		const resultRec = asRecord(result);
		if (resultRec && 'text' in resultRec && isBlankText(resultRec.text)) {
			return { ...rec, toolInvocation: { ...inv, result: { ...resultRec, text: EMPTY_TOOL_RESULT } } };
		}
	}
	return part;
}

function rewriteMessageContent<T>(message: T): T {
	const rec = asRecord(message);
	if (!rec) {
		return message;
	}
	const selfType = String(rec.type ?? '');
	if (selfType === 'tool-result' || selfType === 'tool_result' || selfType === 'tool-invocation') {
		return fillEmptyToolResultOutput(rec) as T;
	}
	const next = { ...rec };
	if (typeof next.content === 'string') {
		next.content = restoreMessageText(next.content).trim();
	} else if (Array.isArray(next.content)) {
		next.content = next.content.map(fillEmptyToolResultOutput).filter(partHasPayload);
	} else {
		const inner = asRecord(next.content);
		if (inner) {
			const copy = { ...inner };
			if (typeof copy.content === 'string') {
				copy.content = restoreMessageText(copy.content).trim();
			}
			if (typeof copy.text === 'string') {
				copy.text = restoreMessageText(copy.text).trim();
			}
			if (Array.isArray(copy.parts)) {
				copy.parts = copy.parts.map(fillEmptyToolResultOutput).filter(partHasPayload);
			}
			next.content = copy;
		}
	}
	if (typeof next.text === 'string') {
		next.text = restoreMessageText(next.text);
	}
	if (Array.isArray(next.parts)) {
		next.parts = next.parts.map(fillEmptyToolResultOutput).filter(partHasPayload);
	}
	const role = String(next.role ?? '');
	if (role === 'tool' && !messageHasSendablePayload(next)) {
		next.content = '(empty)';
	}
	return next as T;
}

function isToolRole(message: unknown): boolean {
	const rec = asRecord(message);
	if (!rec) {
		return false;
	}
	const role = String(rec.role ?? '');
	const type = String(rec.type ?? '');
	return role === 'tool' || type === 'tool-result' || type === 'tool_result';
}

/**
 * Drop empty / reasoning-only / vanished-chat placeholders. Rewrite parts so
 * Cohere never sees `content: ""` after OpenRouter strips reasoning.
 * Repair dangling tool pairs.
 */
export function sanitizeProviderMessages<T>(messages: T[] | undefined | null): T[] {
	if (!Array.isArray(messages) || messages.length === 0) {
		return [];
	}
	const rewritten = messages.map((item) => rewriteMessageContent(item));
	const kept: T[] = [];
	for (const item of rewritten) {
		if (isToolRole(item)) {
			kept.push(item);
			continue;
		}
		if (messageHasSendablePayload(item)) {
			kept.push(item);
			continue;
		}
		const prev = kept[kept.length - 1];
		if (prev && collectToolCallIds(prev).length > 0 && String(asRecord(item)?.role ?? '') === 'assistant') {
			continue;
		}
	}

	const callIds = new Set<string>();
	for (const item of kept) {
		for (const id of collectToolCallIds(item)) {
			callIds.add(id);
		}
	}
	const paired = kept.filter((item) => {
		if (!isToolRole(item)) {
			return true;
		}
		const ids = collectToolResultIds(item);
		if (ids.length === 0) {
			return true;
		}
		return ids.some((id) => callIds.has(id));
	});
	return paired;
}

export function sanitizeRecallResult<T extends { messages?: unknown[] }>(recalled: T): T {
	if (!recalled || !Array.isArray(recalled.messages)) {
		return recalled;
	}
	const messages = sanitizeProviderMessages(recalled.messages);
	if (messages.length === recalled.messages.length) {
		return recalled;
	}
	return { ...recalled, messages };
}

/** Mastra Memory `processors` is deprecated; wrap recall / system-message reads instead. */
export function wrapMemorySanitize(memory: any): any {
	if (!memory || memory.__hawaldarSanitized) {
		return memory;
	}
	if (typeof memory.recall === 'function') {
		const recall = memory.recall.bind(memory);
		memory.recall = async (args: unknown) => sanitizeRecallResult(await recall(args));
	}
	if (typeof memory.getWorkingMemory === 'function') {
		const getWorkingMemory = memory.getWorkingMemory.bind(memory);
		memory.getWorkingMemory = async (args: unknown) => {
			const value = await getWorkingMemory(args);
			if (typeof value !== 'string') {
				return value;
			}
			return collapseWorkingMemoryText(value);
		};
	}
	if (typeof memory.updateWorkingMemory === 'function') {
		const updateWorkingMemory = memory.updateWorkingMemory.bind(memory);
		memory.updateWorkingMemory = async (args: { workingMemory?: string; memory?: string; threadId?: string; resourceId?: string; memoryConfig?: unknown }) => {
			const raw = String(args?.workingMemory ?? args?.memory ?? '');
			// Model may echo the provider's [IP_ADDRESS] token; working memory stores real addresses.
			const restored = restoreTargetPlaceholders(raw, currentToolContext()?.impliedTargets ?? []);
			const next = sanitizeWorkingMemoryUpdate(restored);
			if (next === undefined) {
				return 'Working memory unchanged';
			}
			try {
				const existing = await memory.getWorkingMemory?.({
					threadId: args.threadId,
					resourceId: args.resourceId,
					memoryConfig: args.memoryConfig,
				});
				if (typeof existing === 'string' && existing.trim() === next.trim()) {
					return 'Working memory updated';
				}
			} catch {
				/* compare is best-effort */
			}
			const written = await updateWorkingMemory({ ...args, workingMemory: next });
			// Mastra turns `undefined` tool results into a stream error ("Unknown error"); always return text.
			return typeof written === 'string' && written.trim() ? written : 'Working memory updated';
		};
	}
	if (typeof memory.getSystemMessage === 'function') {
		const getSystemMessage = memory.getSystemMessage.bind(memory);
		memory.getSystemMessage = async (args: unknown) => {
			const value = await getSystemMessage(args);
			if (typeof value === 'string') {
				const trimmed = collapseWorkingMemoryInSystemMessage(value).trim();
				return trimmed ? trimmed : null;
			}
			return value;
		};
	}
	memory.__hawaldarSanitized = true;
	return memory;
}

/** Agent input processor: strip empty history before stream / generate, including each tool step. */
export function createEmptyMessageProcessor(): {
	id: string;
	name: string;
	processInput: (args: { messages: unknown[]; systemMessages?: unknown[] }) => { messages: unknown[]; systemMessages: unknown[] };
	processInputStep: (args: { messages: unknown[]; systemMessages?: unknown[] }) => { messages: unknown[]; systemMessages: unknown[] };
	processLLMRequest: (args: { prompt: unknown[] }) => { prompt: unknown[] } | undefined;
} {
	const clean = (messages: unknown[] | undefined, systemMessages?: unknown[]) => ({
		messages: sanitizeProviderMessages(messages),
		systemMessages: sanitizeProviderMessages(systemMessages),
	});
	return {
		id: 'hawaldar-empty-messages',
		name: 'Drop empty provider messages',
		processInput: ({ messages, systemMessages }) => clean(messages, systemMessages),
		processInputStep: ({ messages, systemMessages }) => clean(messages, systemMessages),
		processLLMRequest: ({ prompt }) => {
			const next = sanitizeProviderMessages(prompt);
			return { prompt: next };
		},
	};
}

export function providerLooksConfigured(settings: {
	hasSelectedProvider?: boolean;
	provider?: string;
	apiKey?: string;
}): boolean {
	if (settings.hasSelectedProvider !== true || !settings.provider) {
		return false;
	}
	if (resolveProviderApiKey(settings.provider, settings.apiKey)) {
		return true;
	}
	const info = getProvider(settings.provider);
	if (info && !info.envVar) {
		return true;
	}
	return settings.provider === 'custom' || settings.provider === 'ollama' || settings.provider === 'lmstudio';
}

export function emptyChatFallback(settings: {
	hasSelectedProvider?: boolean;
	provider?: string;
	apiKey?: string;
}): string {
	if (providerLooksConfigured(settings)) {
		return 'No reply from the model.';
	}
	return ONBOARDING_PROVIDER_HINT;
}

export function isOnboardingProviderHint(text: string): boolean {
	return /set a provider\s*\/\s*API key/i.test(text)
		|| /Settings\s*→\s*Providers?/i.test(text);
}

function parseJson(value: unknown): unknown {
	if (typeof value !== 'string') {
		return value;
	}
	const trimmed = value.trim();
	if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
		return value;
	}
	try {
		return JSON.parse(trimmed);
	} catch {
		return value;
	}
}

function isWeakErrorText(text: string): boolean {
	const trimmed = text.trim();
	return !trimmed
		|| trimmed === '[object Object]'
		|| /^unknown error$/i.test(trimmed)
		|| trimmed === '{}'
		|| trimmed === '[]';
}

function stripIpcInvokePrefix(text: string): string {
	return text
		.replace(/^Error invoking remote method '[^']+':\s*/i, '')
		.replace(/^Error:\s*/i, '')
		.trim();
}

function collectRawMessages(value: unknown, into: string[], depth = 0): void {
	if (depth > 6 || value == null) {
		return;
	}
	if (typeof value === 'string') {
		const parsed = parseJson(value);
		if (parsed !== value) {
			collectRawMessages(parsed, into, depth + 1);
			return;
		}
		const trimmed = value.trim();
		if (trimmed && !into.includes(trimmed)) {
			into.push(trimmed);
		}
		return;
	}
	if (typeof value === 'number' || typeof value === 'boolean') {
		const text = String(value);
		if (!into.includes(text)) {
			into.push(text);
		}
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value.slice(0, 20)) {
			collectRawMessages(item, into, depth + 1);
		}
		return;
	}
	const rec = inspectError(value);
	if (!rec) {
		return;
	}
	if (typeof rec.provider_name === 'string' && rec.provider_name.trim()) {
		const label = rec.provider_name.trim();
		if (!into.includes(label)) {
			into.push(label);
		}
	}
	for (const key of ['raw', 'message', 'text', 'detail', 'errorMessage', 'cause', 'responseBody', 'body', 'data', 'error', 'reason', 'value', 'details', 'issues']) {
		if (key in rec && rec[key] !== value) {
			collectRawMessages(rec[key], into, depth + 1);
		}
	}
	if (rec.metadata && rec.metadata !== value) {
		collectRawMessages(rec.metadata, into, depth + 1);
	}
}

/** Copy enumerable + Error/APICallError fields Mastra often hides from JSON.stringify. */
function inspectError(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== 'object') {
		return undefined;
	}
	const rec = value as Record<string, unknown>;
	const out: Record<string, unknown> = { ...rec };
	for (const key of Object.getOwnPropertyNames(value)) {
		if (key === 'stack') {
			continue;
		}
		try {
			out[key] = rec[key];
		} catch {
			/* getter threw */
		}
	}
	if (value instanceof Error) {
		out.message = value.message;
		out.name = value.name;
		if (value.cause !== undefined) {
			out.cause = value.cause;
		}
	}
	const extra = value as { text?: unknown; details?: unknown; issues?: unknown; id?: unknown };
	if (typeof extra.text === 'string' && extra.text.trim()) {
		out.text = extra.text;
	}
	if (extra.details !== undefined) {
		out.details = extra.details;
	}
	if (extra.issues !== undefined) {
		out.issues = extra.issues;
	}
	if (typeof extra.id === 'string' && extra.id.trim()) {
		out.id = extra.id;
	}
	return out;
}

const SENSITIVE_KEY = /^(api[_-]?key|apiKeyEnc|authorization|bearer|secret|cookie|password|token)$/i;

function safeJson(value: unknown): string {
	const seen = new Set<unknown>();
	try {
		return JSON.stringify(value, (key, item) => {
			if (SENSITIVE_KEY.test(key)) {
				return '[redacted]';
			}
			if (item && typeof item === 'object') {
				if (seen.has(item)) {
					return '[circular]';
				}
				seen.add(item);
			}
			return item;
		}) ?? '';
	} catch {
		return '';
	}
}

function polishErrorText(text: string): string {
	const trimmed = stripIpcInvokePrefix(text);
	if (isWeakErrorText(trimmed)) {
		return 'Unknown error';
	}
	if (/an object could not be cloned/i.test(trimmed)) {
		return 'The main process threw an error that could not be shown. Check the terminal running scripts\\dev.bat.';
	}
	if (/no cookie auth credentials/i.test(trimmed)) {
		return `HTTP 401 · No cookie auth credentials found. ${OPENROUTER_MISSING_KEY}`;
	}
	return trimmed;
}

function extractProviderDetail(error: object): string {
	const rec = inspectError(error) ?? (error as Record<string, unknown>);
	const bits: string[] = [];
	const provider = rec.provider_name ?? rec.provider;
	if (typeof provider === 'string' && provider.trim()) {
		bits.push(provider.trim());
	}
	const nested = asRecord(rec.details);
	const status = rec.statusCode ?? rec.status ?? nested?.status ?? nested?.statusCode;
	if (typeof status === 'number') {
		bits.push(`HTTP ${status}`);
	}
	if (typeof rec.text === 'string' && rec.text.trim() && !isWeakErrorText(rec.text)) {
		bits.push(rec.text.trim());
	}
	const blobs: string[] = [];
	collectRawMessages(rec, blobs);
	const useful = blobs.find((item) => /no cookie auth|invalid message|non-empty content|tool calls|index \d+|missing|api key|401|validation failed/i.test(item) && !isWeakErrorText(item))
		?? blobs.find((item) => item !== 'Provider returned error' && !isWeakErrorText(item) && item.length > 8 && item.length < 800);
	if (useful && !bits.includes(useful)) {
		bits.push(useful);
	}
	return bits.join(' · ');
}

/**
 * Coerce assistant / tool / error payloads to a string.
 * Never returns `[object Object]` (JSON.stringify or error.message instead).
 * Weak / empty input stays `''` here — 'Unknown error' is reserved for formatChatError
 * so a blank tool result never renders as a fake failure.
 */
export function toDisplayText(value: unknown): string {
	const text = coerceDisplayText(value);
	return /^unknown error$/i.test(text.trim()) ? '' : text;
}

function coerceDisplayText(value: unknown): string {
	if (value == null) {
		return '';
	}
	if (typeof value === 'string') {
		return isWeakErrorText(stripIpcInvokePrefix(value)) ? '' : polishErrorText(value);
	}
	if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
		return String(value);
	}
	if (value instanceof Error) {
		return formatChatError(value);
	}
	const rec = asRecord(value);
	if (rec) {
		if (isNonEmptyText(rec.stdout) && !isNonEmptyText(rec.message) && rec.error == null) {
			return rec.stdout;
		}
		if (isNonEmptyText(rec.stderr) && !isNonEmptyText(rec.message)) {
			return rec.stderr;
		}
		return formatChatError(value);
	}
	const fallback = String(value);
	return fallback === '[object Object]' ? '' : fallback;
}

/** Surface Cohere / OpenRouter 400 detail instead of a bare "Provider returned error". */
export function formatChatError(error: unknown): string {
	if (error == null) {
		return 'Unknown error';
	}
	if (typeof error === 'string') {
		const parsed = parseJson(error);
		if (parsed !== error) {
			return formatChatError(parsed);
		}
		return polishErrorText(error);
	}
	if (error instanceof Error) {
		const detail = extractProviderDetail(error);
		const rawMessage = typeof error.message === 'string' ? error.message.trim() : '';
		const base = polishErrorText(rawMessage && !isWeakErrorText(rawMessage) ? rawMessage : (error.name || 'Error'));
		if (!detail) {
			const json = safeJson(inspectError(error) ?? error);
			if (json && json !== '{}' && json !== '[]' && isWeakErrorText(base)) {
				return polishErrorText(json.length > 800 ? `${json.slice(0, 800)}…` : json);
			}
			return base;
		}
		const polished = polishErrorText(detail);
		if (isWeakErrorText(base) || base === 'Error' || base.includes(polished) || polished.includes(base)) {
			return !isWeakErrorText(polished) && polished.length >= base.length ? polished : `${base}\n${polished}`;
		}
		return `${base}\n${polished}`;
	}
	const rec = asRecord(error);
	if (rec) {
		const detail = extractProviderDetail(rec);
		if (detail && !isWeakErrorText(detail)) {
			return polishErrorText(detail);
		}
		if (isNonEmptyText(rec.text) && !isWeakErrorText(rec.text)) {
			return polishErrorText(rec.text);
		}
		if (isNonEmptyText(rec.message) && !isWeakErrorText(rec.message)) {
			return polishErrorText(rec.message);
		}
		if (rec.message && typeof rec.message === 'object') {
			return formatChatError(rec.message);
		}
		if (rec.error && rec.error !== rec) {
			const nested = formatChatError(rec.error);
			if (!isWeakErrorText(nested)) {
				return nested;
			}
		}
		const json = safeJson(inspectError(rec) ?? rec);
		if (json && json !== '{}' && json !== '[]') {
			return polishErrorText(json.length > 800 ? `${json.slice(0, 800)}…` : json);
		}
		if (detail) {
			return polishErrorText(detail);
		}
	}
	return polishErrorText(safeJson(error) || 'Unknown error');
}

function contentLooksEmptyInStorage(raw: unknown): boolean {
	if (raw == null) {
		return true;
	}
	let value: unknown = raw;
	if (typeof raw === 'string') {
		const trimmed = raw.trim();
		if (!trimmed || trimmed === '[]' || trimmed === '{}' || trimmed === 'null') {
			return true;
		}
		try {
			value = JSON.parse(trimmed);
		} catch {
			return !trimmed;
		}
	}
	return !messageHasSendablePayload({ role: 'assistant', content: value });
}

/** Delete persisted empty / reasoning-only hawaldar rows so recall cannot revive them. */
export async function purgeEmptyMastraMessages(databasePath: string): Promise<number> {
	const { createClient } = await import('@libsql/client');
	const { sqliteFileUrl } = await import('./data-home');
	const client = createClient({ url: sqliteFileUrl(databasePath) });
	try {
		const rs = await client.execute(
			`SELECT id, role, content FROM mastra_messages WHERE resourceId = 'hawaldar'`,
		);
		const ids: string[] = [];
		for (const row of rs.rows) {
			const id = String(row.id ?? '').trim();
			if (!id) {
				continue;
			}
			const fake = { role: row.role, content: typeof row.content === 'string' ? tryParseJson(row.content) : row.content };
			if (messageHasSendablePayload(fake) || collectToolCallIds(fake).length > 0 || isToolRole(fake)) {
				continue;
			}
			if (contentLooksEmptyInStorage(row.content) || !messageHasSendablePayload(fake)) {
				ids.push(id);
			}
		}
		for (const id of ids) {
			await client.execute({ sql: 'DELETE FROM mastra_messages WHERE id = ?', args: [id] });
		}
		return ids.length;
	} finally {
		client.close();
	}
}

function tryParseJson(raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch {
		return raw;
	}
}
