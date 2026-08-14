import { evaluateScope } from '../policy';

export function scopedHost(scope: readonly string[], raw: string): { host: string; url: string } {
	let host = raw.trim();
	if (host.includes('://')) {
		const parsed = new URL(host);
		if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
			throw new Error('Only http/https URLs are allowed.');
		}
		host = parsed.hostname;
	}
	const decision = evaluateScope(scope, host);
	if (!decision.allow) {
		throw new Error(decision.reason);
	}
	return { host, url: `https://${host}` };
}
