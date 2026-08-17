import { evaluateScope, parseTargetRef, restoreTargetPlaceholders } from '../policy';

export function scopedHost(scope: readonly string[], raw: string): { host: string; url: string; port?: number } {
	const restored = restoreTargetPlaceholders(raw);
	const ref = parseTargetRef(restored);
	if (!ref?.host) {
		throw new Error('Invalid target.');
	}
	const decision = evaluateScope(scope, ref.host);
	if (!decision.allow) {
		throw new Error(decision.reason);
	}
	const url = ref.url || `${ref.local ? 'http' : 'https'}://${ref.host}${ref.port ? `:${ref.port}` : ''}`;
	return { host: ref.host, url, port: ref.port };
}
