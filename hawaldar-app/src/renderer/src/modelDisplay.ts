import type { ListedModel } from '../../preload/api';
import type { DropdownOption } from './Dropdown';

/** Drop redundant provider prefixes: `openrouter/anthropic/claude-sonnet-4-6` → `claude-sonnet-4-6`. */
export function shortModelId(provider: string, model: string): string {
	let id = (model || '').trim();
	if (!id) {
		return '';
	}
	if (provider && id.startsWith(`${provider}/`)) {
		id = id.slice(provider.length + 1);
	}
	const parts = id.split('/').filter(Boolean);
	return parts[parts.length - 1] || id;
}

/** Tooltip / accessible full label without a duplicated provider prefix. */
export function fullModelTitle(providerLabel: string, provider: string, model: string): string {
	let id = (model || '').trim();
	if (provider && id.startsWith(`${provider}/`)) {
		id = id.slice(provider.length + 1);
	}
	if (providerLabel && id) {
		return `${providerLabel} · ${id}`;
	}
	return providerLabel || id;
}

export function formatContextWindow(n?: number): string {
	if (!n || n <= 0) {
		return '';
	}
	if (n >= 1_000_000) {
		const m = n / 1_000_000;
		return Number.isInteger(m) ? `${m}m` : `${m.toFixed(1).replace(/\.0$/, '')}m`;
	}
	if (n >= 1000) {
		const k = n / 1000;
		return Number.isInteger(k) ? `${k}k` : `${Math.round(k)}k`;
	}
	return String(n);
}

const BARE_CURRENCY = /^\s*\$\s*(?:\/M)?\s*$/i;

/** `$0.27/M` from USD per 1M prompt tokens. Empty when the rate is missing or not a real amount. */
export function formatPromptRatePerMillion(perMillion: number): string {
	if (!Number.isFinite(perMillion) || perMillion <= 0) {
		return '';
	}
	let decimals = 2;
	if (perMillion < 0.01) {
		decimals = 3;
	}
	if (perMillion < 0.001) {
		decimals = 4;
	}
	const rounded = perMillion.toFixed(decimals).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
	if (!rounded || rounded === '0') {
		return '';
	}
	return `$${rounded}/M`;
}

/** Reject empty, lone `$`, `$/M`, and the word “paid”. */
export function usablePriceLabel(raw?: string): string | undefined {
	const text = (raw || '').trim();
	if (!text || BARE_CURRENCY.test(text) || /^paid$/i.test(text)) {
		return undefined;
	}
	return text;
}

/** Paid badge text: `priceLabel`, else format `promptPerMillion`. */
export function paidPriceLabel(model: ListedModel): string | undefined {
	const labeled = usablePriceLabel(model.priceLabel);
	if (labeled) {
		return labeled;
	}
	if (typeof model.promptPerMillion === 'number') {
		return usablePriceLabel(formatPromptRatePerMillion(model.promptPerMillion));
	}
	return undefined;
}

/** Picker meta for search/tooltip: `164k · free` or `1m · $1.25/M`. */
export function modelMetaLine(model: ListedModel): string {
	const parts: string[] = [];
	const ctx = formatContextWindow(model.contextWindow);
	if (ctx) {
		parts.push(ctx);
	}
	if (isListedFree(model)) {
		parts.push('free');
	} else {
		const price = paidPriceLabel(model);
		if (price) {
			parts.push(price);
		}
	}
	return parts.join(' · ');
}

/** True when the list API marked the row free (`:free`, zero price, or `free === true`). */
export function isListedFree(model: ListedModel): boolean {
	if (model.free === true) {
		return true;
	}
	if (/:free$/i.test(model.id) || /\(free\)/i.test(model.label)) {
		return true;
	}
	return model.promptPerMillion === 0;
}

export function findListedModel(models: ListedModel[], modelId: string, routerId?: string): ListedModel | undefined {
	return models.find((item) => (
		item.id === modelId
		|| (routerId && (item.id === routerId || routerId.endsWith(`/${item.id}`)))
		|| modelId.endsWith(`/${item.id}`)
	));
}

export function modelPickerOption(model: ListedModel): DropdownOption {
	const ctx = formatContextWindow(model.contextWindow);
	const price = isListedFree(model) ? undefined : paidPriceLabel(model);
	const badge = isListedFree(model)
		? { text: 'free' as const, tone: 'free' as const }
		: price
			? { text: price, tone: 'paid' as const }
			: undefined;
	return {
		value: model.id,
		label: model.label || model.id,
		detail: ctx || (model.source === 'fallback' ? 'fallback' : undefined),
		badge,
		inline: true,
	};
}
