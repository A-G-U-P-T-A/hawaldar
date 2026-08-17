/** Concatenate LLM stream deltas without trimming. `"Hello," + " world"` → `"Hello, world"`. */
export function appendStreamDelta(acc: string, delta: string): string {
	return `${acc ?? ''}${delta ?? ''}`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
}

/**
 * Pull incremental text from a Mastra `text-delta` / `text` chunk.
 * Leading and trailing spaces are significant — do not trim.
 */
export function extractStreamTextDelta(chunk: unknown): string | undefined {
	if (typeof chunk === 'string') {
		return chunk;
	}
	const rec = asRecord(chunk);
	if (!rec) {
		return undefined;
	}
	const type = String(rec.type ?? '');
	if (type && type !== 'text-delta' && type !== 'text' && type !== 'text-delta-chunk') {
		return undefined;
	}
	const payload = asRecord(rec.payload) ?? rec;
	const raw = payload.text ?? payload.textDelta ?? rec.text ?? rec.textDelta;
	if (typeof raw === 'string') {
		return raw;
	}
	if (typeof raw === 'number' || typeof raw === 'boolean') {
		return String(raw);
	}
	return undefined;
}

/** Operator wants to continue the in-flight engagement, not start a new greeting. */
export function isResumeIntent(text: string): boolean {
	const t = text.trim().toLowerCase().replace(/[.!?…]+$/g, '').trim();
	if (!t) {
		return false;
	}
	return /^(please\s+)?(retry|continue|try again|try-again|resume|again|keep going|go on)(\s+(it|that|this|the\s+(engagement|playbook|scan|workflow|last step)))?$/.test(t);
}

/** Mastra docs: pass `memory: { thread, resource }` on every generate/stream. */
export function mastraMemoryOptions(
	threadId: string,
	resource: string,
	opts?: { readOnly?: boolean; skipRecall?: boolean },
): {
	thread: string;
	resource: string;
	options?: { readOnly?: true; lastMessages?: number | false; semanticRecall?: false };
} {
	const options: { readOnly?: true; lastMessages?: number | false; semanticRecall?: false } = {};
	if (opts?.readOnly) {
		options.readOnly = true;
	}
	if (opts?.skipRecall) {
		// Resource-scoped semantic recall mixes older failed chats into this turn.
		options.lastMessages = false;
		options.semanticRecall = false;
	}
	return {
		thread: threadId,
		resource,
		...(Object.keys(options).length > 0 ? { options } : {}),
	};
}
