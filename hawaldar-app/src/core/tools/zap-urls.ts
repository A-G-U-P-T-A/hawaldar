const LOOPBACK_SCAN_HOSTS = [
	'127.0.0.1',
	'localhost',
	'::1',
	'host.containers.internal',
	'host.docker.internal',
];

export function zapHostsEquivalent(left: string, right: string): boolean {
	const a = left.trim().toLowerCase();
	const b = right.trim().toLowerCase();
	if (a === b) {
		return true;
	}
	const loop = new Set(LOOPBACK_SCAN_HOSTS.map((host) => host.toLowerCase()));
	return loop.has(a) && loop.has(b);
}

function stripHash(href: string): string {
	try {
		const parsed = new URL(href);
		parsed.hash = '';
		return parsed.toString();
	} catch {
		return href.split('#')[0] || href;
	}
}

function withTrailingSlash(href: string): string {
	try {
		const parsed = new URL(stripHash(href));
		if (!parsed.pathname.endsWith('/')) {
			parsed.pathname = `${parsed.pathname}/`;
		}
		return parsed.toString();
	} catch {
		return href.endsWith('/') ? href : `${href}/`;
	}
}

function originSlash(href: string): string {
	try {
		const parsed = new URL(stripHash(href));
		return `${parsed.protocol}//${parsed.host}/`;
	} catch {
		return href;
	}
}

/** Operator URL + container rewrite + slash variants so ascan hits the tree node ZAP actually stored. */
export function zapScanUrlCandidates(scanUrl: string, originalUrl: string): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	const push = (raw: string) => {
		for (const item of [stripHash(raw), withTrailingSlash(raw), originSlash(raw)]) {
			if (!item || seen.has(item)) {
				continue;
			}
			seen.add(item);
			out.push(item);
		}
	};
	push(scanUrl);
	push(originalUrl);
	for (const host of LOOPBACK_SCAN_HOSTS) {
		for (const base of [scanUrl, originalUrl]) {
			try {
				const parsed = new URL(stripHash(base));
				if (!zapHostsEquivalent(parsed.hostname, host)) {
					continue;
				}
				parsed.hostname = host;
				push(parsed.toString());
			} catch {
				/* skip */
			}
		}
	}
	return out;
}

export function pickZapTreeUrl(treeUrls: string[], scanUrl: string, originalUrl: string): string | undefined {
	const candidates = zapScanUrlCandidates(scanUrl, originalUrl);
	const normalized = treeUrls.map((item) => stripHash(item));
	for (const want of candidates) {
		const found = normalized.find((item) => item === want
			|| withTrailingSlash(item) === withTrailingSlash(want)
			|| originSlash(item) === originSlash(want));
		if (found) {
			return found;
		}
	}
	try {
		const scanHost = new URL(scanUrl).hostname;
		const origHost = new URL(originalUrl).hostname;
		return normalized.find((item) => {
			try {
				const host = new URL(item).hostname;
				return zapHostsEquivalent(host, scanHost) || zapHostsEquivalent(host, origHost);
			} catch {
				return false;
			}
		});
	} catch {
		return undefined;
	}
}

export function isZapUrlNotFound(json: Record<string, unknown>, httpOk: boolean): boolean {
	if (httpOk && json.scan != null && String(json.scan) !== '') {
		return false;
	}
	return /url_not_found|URL Not Found in the Scan Tree/i.test(JSON.stringify(json));
}

export { withTrailingSlash };
