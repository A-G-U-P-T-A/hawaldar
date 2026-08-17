import { formatChatError } from './chat-messages';
import { parseHitlSuspendPayload, type HitlSuspendPayload } from './hitl';

export type ChatActivityType = 'tool:start' | 'tool:done' | 'text' | 'agent';
export type ChatActivityStatus = 'start' | 'ok' | 'error' | 'text';

export interface ChatActivity {
	type: ChatActivityType;
	name: string;
	detail: string;
	status: ChatActivityStatus;
}

/** Activity / report line: operator-facing URL or host. Container rewrite stays an implementation detail. */
export function formatScanActivityDetail(target: string, _scannedAs?: string, _scannedAsIp?: string): string {
	return (target || '').trim();
}

export function scanMetaFromResult(value: unknown): { target?: string; scannedAs?: string; scannedAsIp?: string } {
	const rec = asRecord(value);
	if (!rec) {
		return {};
	}
	const nested = asRecord(rec.result) ?? asRecord(rec.output) ?? rec;
	const str = (key: string) => {
		const item = nested[key];
		return typeof item === 'string' && item.trim() ? item.trim() : undefined;
	};
	return {
		target: str('target'),
		scannedAs: str('scannedAs') ?? str('containerTarget'),
		scannedAsIp: str('scannedAsIp'),
	};
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
}

const MEMORY_DETAIL_CLIP = 1200;

export function activityDetailFromArgs(args: unknown, toolName?: string): string {
	const rec = asRecord(args);
	if (!rec) {
		return '';
	}
	if (toolName === 'finding-record') {
		const title = typeof rec.title === 'string' ? rec.title.trim() : '';
		const severity = typeof rec.severity === 'string' ? rec.severity.trim().toLowerCase() : '';
		if (title) {
			return severity ? `${severity} · ${title}` : title;
		}
	}
	if (toolName === 'updateWorkingMemory' && typeof rec.memory === 'string') {
		const memory = rec.memory.trim();
		return memory.length > MEMORY_DETAIL_CLIP ? `${memory.slice(0, MEMORY_DETAIL_CLIP)}…` : memory;
	}
	for (const key of ['url', 'target', 'filePath', 'pcapPath', 'workflowId', 'agentId', 'module', 'query', 'address', 'functionName']) {
		const value = rec[key];
		if (typeof value === 'string' && value.trim()) {
			const trimmed = value.trim();
			if (key === 'target') {
				return formatScanActivityDetail(trimmed);
			}
			return trimmed;
		}
	}
	return '';
}

function resultError(payload: Record<string, unknown>): string | undefined {
	if (payload.isError === true || payload.error) {
		const err = payload.error;
		if (typeof err === 'string' && err.trim()) {
			return err.trim();
		}
		if (err && typeof err === 'object' && 'message' in err) {
			return String((err as { message: unknown }).message);
		}
		return 'error';
	}
	const result = asRecord(payload.result) ?? asRecord(payload.output);
	if (!result) {
		return undefined;
	}
	if (result.ok === false) {
		return String(result.stderr || result.detail || result.error || 'failed');
	}
	if (typeof result.exitCode === 'number' && result.exitCode !== 0) {
		return String(result.stderr || `exit ${result.exitCode}`);
	}
	return undefined;
}

export function parseStreamChunk(chunk: unknown): {
	kind: 'text' | 'tool-call' | 'tool-result' | 'tool-suspended' | 'error' | 'other';
	text?: string;
	name?: string;
	detail?: string;
	error?: string;
	runId?: string;
	toolCallId?: string;
	suspend?: HitlSuspendPayload;
} {
	const rec = asRecord(chunk);
	if (!rec) {
		return { kind: 'other' };
	}
	const type = String(rec.type ?? '');
	const payload = asRecord(rec.payload) ?? rec;

	if (type === 'text-delta' || type === 'text') {
		const text = String(payload.text ?? payload.textDelta ?? rec.text ?? rec.textDelta ?? '');
		return text ? { kind: 'text', text } : { kind: 'other' };
	}
	if (type === 'tool-call' || type === 'tool-called') {
		const name = String(payload.toolName ?? payload.name ?? rec.toolName ?? '');
		const args = payload.args ?? payload.input ?? rec.args;
		return name
			? { kind: 'tool-call', name, detail: activityDetailFromArgs(args, name) }
			: { kind: 'other' };
	}
	if (type === 'tool-result') {
		const name = String(payload.toolName ?? payload.name ?? rec.toolName ?? '');
		const error = resultError(payload);
		const meta = scanMetaFromResult(payload);
		const success = formatScanActivityDetail(meta.target ?? '', meta.scannedAs, meta.scannedAsIp);
		return name
			? { kind: 'tool-result', name, detail: error ?? success, error }
			: { kind: 'other' };
	}
	if (type === 'tool-call-suspended' || type === 'tool-call-approval') {
		const name = String(payload.toolName ?? payload.name ?? rec.toolName ?? '');
		const suspend = parseHitlSuspendPayload(payload.suspendPayload ?? payload);
		const runId = String(rec.runId ?? payload.runId ?? '');
		const toolCallId = String(payload.toolCallId ?? rec.toolCallId ?? '');
		return {
			kind: 'tool-suspended',
			name,
			detail: suspend?.title || 'Waiting for approval…',
			runId,
			toolCallId,
			suspend,
		};
	}
	if (type === 'error') {
		const error = formatChatError(payload.error ?? payload.message ?? rec.error ?? rec.message ?? 'stream error');
		return { kind: 'error', name: 'error', error, detail: error };
	}
	return { kind: 'other' };
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
	return Boolean(value && typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function');
}

export interface StreamConsumeResult {
	text: string;
	suspended?: {
		runId: string;
		toolCallId: string;
		toolName: string;
		payload: HitlSuspendPayload;
	};
}

/** Consume Mastra `fullStream` (tool-call / tool-result / text-delta) with textStream fallback. */
export async function consumeAgentStream(
	stream: { fullStream?: unknown; textStream?: unknown; text?: unknown; runId?: unknown },
	onDelta: (text: string) => void,
	onActivity: (event: ChatActivity) => void,
): Promise<StreamConsumeResult> {
	try {
		return await readAgentStream(stream, onDelta, onActivity);
	} catch (error) {
		throw new Error(formatChatError(error));
	}
}

async function readAgentStream(
	stream: { fullStream?: unknown; textStream?: unknown; text?: unknown; runId?: unknown },
	onDelta: (text: string) => void,
	onActivity: (event: ChatActivity) => void,
): Promise<StreamConsumeResult> {
	let text = '';
	let sawText = false;
	let suspended: StreamConsumeResult['suspended'];
	const streamRunId = typeof stream?.runId === 'string' ? stream.runId : '';
	const emitText = (delta: string) => {
		if (!delta) {
			return;
		}
		text += delta;
		onDelta(delta);
		if (!sawText) {
			sawText = true;
			onActivity({ type: 'text', name: 'text', detail: '', status: 'text' });
		}
	};

	if (isAsyncIterable(stream?.fullStream)) {
		for await (const chunk of stream.fullStream) {
			const parsed = parseStreamChunk(chunk);
			if (parsed.kind === 'text' && parsed.text) {
				emitText(parsed.text);
			} else if (parsed.kind === 'tool-call' && parsed.name) {
				onActivity({
					type: 'tool:start',
					name: parsed.name,
					detail: parsed.detail ?? '',
					status: 'start',
				});
			} else if (parsed.kind === 'tool-result' && parsed.name) {
				onActivity({
					type: 'tool:done',
					name: parsed.name,
					detail: parsed.detail ?? parsed.error ?? '',
					status: parsed.error ? 'error' : 'ok',
				});
			} else if (parsed.kind === 'tool-suspended' && parsed.suspend) {
				suspended = {
					runId: parsed.runId || streamRunId,
					toolCallId: parsed.toolCallId || '',
					toolName: parsed.name || '',
					payload: parsed.suspend,
				};
			} else if (parsed.kind === 'error') {
				throw new Error(parsed.error || 'stream error');
			}
		}
		if (text || suspended) {
			return { text, suspended };
		}
	}

	if (isAsyncIterable(stream?.textStream)) {
		for await (const chunk of stream.textStream) {
			emitText(typeof chunk === 'string' ? chunk : String(chunk ?? ''));
		}
		if (text) {
			return { text, suspended };
		}
	}

	if (typeof stream?.text === 'string') {
		emitText(stream.text);
		return { text, suspended };
	}
	if (stream?.text && typeof (stream.text as Promise<string>).then === 'function') {
		const resolved = await (stream.text as Promise<string>);
		if (resolved && !text) {
			emitText(resolved);
		}
	}
	return { text, suspended };
}
