/** Shown when OpenRouter was called without Authorization: Bearer. */
const OPENROUTER_MISSING_KEY =
	'OpenRouter API key missing. Settings → Provider → paste key → Save (applies on the next message). Or set OPENROUTER_API_KEY in hawaldar-app/.env or the repo .env.';

/** Concatenate LLM stream deltas without trimming. `"Hello," + " world"` → `"Hello, world"`. */
export function appendStreamDelta(acc: string, delta: string): string {
	return `${acc ?? ''}${delta ?? ''}`;
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

function polishDisplay(text: string): string {
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

/**
 * Coerce chat / tool / error values so the UI never renders `[object Object]`.
 * Weak / empty input stays `''`; the literal 'Unknown error' is never synthesized here
 * (callers that need an error fallback add it themselves).
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
		return isWeakErrorText(stripIpcInvokePrefix(value)) ? '' : polishDisplay(value);
	}
	if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
		return String(value);
	}
	if (value instanceof Error) {
		const msg = polishDisplay(value.message.trim() || value.name || 'Error');
		const cause = value.cause !== undefined ? toDisplayText(value.cause) : '';
		if (cause && !isWeakErrorText(cause) && !msg.includes(cause)) {
			return isWeakErrorText(msg) ? cause : `${msg}\n${cause}`;
		}
		return msg;
	}
	if (typeof value === 'object') {
		const rec = value as Record<string, unknown>;
		for (const key of ['text', 'message', 'detail', 'error', 'stderr', 'stdout', 'responseBody']) {
			const item = rec[key];
			if (typeof item === 'string' && item.trim() && !isWeakErrorText(item)) {
				return polishDisplay(item);
			}
			if (item && typeof item === 'object' && item !== value) {
				const nested = toDisplayText(item);
				if (nested && !isWeakErrorText(nested)) {
					return nested;
				}
			}
		}
		const details = rec.details && typeof rec.details === 'object' ? rec.details as Record<string, unknown> : undefined;
		const status = rec.statusCode ?? rec.status ?? details?.status ?? details?.statusCode;
		if (typeof status === 'number') {
			const nested = typeof rec.message === 'string' && !isWeakErrorText(rec.message) ? rec.message : '';
			return polishDisplay(nested ? `HTTP ${status} · ${nested}` : `HTTP ${status}`);
		}
		if (Array.isArray(rec.issues) && rec.issues.length) {
			const issueText = rec.issues
				.map((item) => {
					if (item && typeof item === 'object' && 'message' in item && typeof (item as { message?: unknown }).message === 'string') {
						return (item as { message: string }).message;
					}
					return '';
				})
				.filter(Boolean)
				.join('; ');
			if (issueText) {
				return polishDisplay(issueText);
			}
		}
		try {
			const json = JSON.stringify(value);
			if (json && json !== '{}' && json !== '[]' && json !== '[object Object]') {
				return polishDisplay(json.length > 800 ? `${json.slice(0, 800)}…` : json);
			}
		} catch {
			/* circular */
		}
	}
	const fallback = String(value);
	return fallback === '[object Object]' ? '' : polishDisplay(fallback);
}
