import { getProvider } from './providers';
import { restoreTargetPlaceholders } from './policy';
import { currentToolContext } from './tool-context';
import {
	collapseWorkingMemoryInSystemMessage,
	collapseWorkingMemoryText,
	sanitizeWorkingMemoryUpdate,
} from './working-memory';

/** Shown only when chat returned nothing and no provider / key is configured. */
export const ONBOARDING_PROVIDER_HINT = 'No reply. Open **Settings** and set a provider / API key.';

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

function rewriteMessageContent<T>(message: T): T {
	const rec = asRecord(message);
	if (!rec) {
		return message;
	}
	const next = { ...rec };
	if (typeof next.content === 'string') {
		next.content = restoreMessageText(next.content).trim();
	} else if (Array.isArray(next.content)) {
		next.content = next.content.filter(partHasPayload);
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
				copy.parts = copy.parts.filter(partHasPayload);
			}
			next.content = copy;
		}
	}
	if (typeof next.text === 'string') {
		next.text = restoreMessageText(next.text);
	}
	if (Array.isArray(next.parts)) {
		next.parts = next.parts.filter(partHasPayload);
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
			const next = sanitizeWorkingMemoryUpdate(String(args?.workingMemory ?? args?.memory ?? ''));
			if (next === undefined) {
				return;
			}
			try {
				const existing = await memory.getWorkingMemory?.({
					threadId: args.threadId,
					resourceId: args.resourceId,
					memoryConfig: args.memoryConfig,
				});
				if (typeof existing === 'string' && existing.trim() === next.trim()) {
					return;
				}
			} catch {
				/* compare is best-effort */
			}
			return updateWorkingMemory({ ...args, workingMemory: next });
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
	if (settings.apiKey) {
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
	return /set a provider\s*\/\s*API key/i.test(text);
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
	const rec = asRecord(value);
	if (!rec) {
		return;
	}
	if (typeof rec.provider_name === 'string' && rec.provider_name.trim()) {
		const label = rec.provider_name.trim();
		if (!into.includes(label)) {
			into.push(label);
		}
	}
	for (const key of ['raw', 'message', 'detail', 'errorMessage', 'cause']) {
		if (key in rec) {
			collectRawMessages(rec[key], into, depth + 1);
		}
	}
	if (rec.error && rec.error !== rec) {
		collectRawMessages(rec.error, into, depth + 1);
	}
	if (rec.metadata) {
		collectRawMessages(rec.metadata, into, depth + 1);
	}
	if (rec.data) {
		collectRawMessages(rec.data, into, depth + 1);
	}
}

function extractProviderDetail(error: object): string {
	const rec = error as Record<string, unknown>;
	const bits: string[] = [];
	const provider = rec.provider_name ?? rec.provider;
	if (typeof provider === 'string' && provider.trim()) {
		bits.push(provider.trim());
	}
	const status = rec.statusCode ?? rec.status;
	if (typeof status === 'number') {
		bits.push(`HTTP ${status}`);
	}
	const blobs: string[] = [];
	collectRawMessages(rec.responseBody, blobs);
	collectRawMessages(rec.data, blobs);
	collectRawMessages(rec.cause, blobs);
	collectRawMessages(rec.metadata, blobs);
	const useful = blobs.find((item) => /invalid message|non-empty content|tool calls|index \d+/i.test(item))
		?? blobs.find((item) => item !== 'Provider returned error' && item.length > 8 && item.length < 500);
	if (useful) {
		bits.push(useful);
	}
	return bits.join(' · ');
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
		return error.trim() || 'Unknown error';
	}
	if (error instanceof Error) {
		const detail = extractProviderDetail(error);
		const base = (error.message || error.name).trim() || 'Error';
		if (!detail) {
			return base;
		}
		if (base.includes(detail) || detail.includes(base)) {
			return detail.length >= base.length ? detail : `${base}\n${detail}`;
		}
		return `${base}\n${detail}`;
	}
	const rec = asRecord(error);
	if (rec) {
		const detail = extractProviderDetail(rec);
		if (detail) {
			return detail;
		}
		if (isNonEmptyText(rec.message)) {
			return rec.message.trim();
		}
	}
	return String(error);
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
