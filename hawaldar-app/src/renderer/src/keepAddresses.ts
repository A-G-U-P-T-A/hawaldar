const REDACTED_IP = /\[IP_ADDRESS\]/gi;

/** Do not treat loopback or the scanned host-gateway as secrets. */
export function isKeptScanAddress(value: string): boolean {
	const v = value.trim().toLowerCase();
	if (!v) return false;
	if (v === '127.0.0.1' || v === '::1' || v === 'localhost') return true;
	if (v === 'host.containers.internal' || v === 'host.docker.internal') return true;
	if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v)) return true;
	if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v)) return true;
	if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(v)) return true;
	if (/^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(v)) return true;
	return false;
}

/**
 * Restore the provider's `[IP_ADDRESS]` token for operator-visible text.
 * Loopback / RFC1918 scan targets are never secrets. With no known address the
 * token can only be the local scan target, so fall back to 127.0.0.1 and keep
 * any scheme/port the model wrote (`http://[IP_ADDRESS]:3000` → `http://127.0.0.1:3000`).
 * Mirrors core `restoreTargetPlaceholders`.
 */
export function restoreRedactedAddresses(text: string, keep: string[] = []): string {
	if (!/\[IP_ADDRESS\]/i.test(text)) {
		return text;
	}
	const addresses = keep.filter((item) => item.trim() && isKeptScanAddress(item));
	if (!addresses.length) {
		return text
			.replace(/https?:\/\/\[IP_ADDRESS\](?::(\d+))?/gi, (_m, port: string | undefined) => {
				return `http://127.0.0.1${port ? `:${port}` : ''}`;
			})
			.replace(REDACTED_IP, '127.0.0.1');
	}
	let i = 0;
	return text.replace(REDACTED_IP, () => addresses[Math.min(i++, addresses.length - 1)] ?? addresses[0]);
}
