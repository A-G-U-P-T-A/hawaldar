/**
 * Allowlist for BrowserWindow navigations. Report/PDF/markdown links must not
 * replace the Hawaldar renderer (Juice Shop on :3000 is the usual trap).
 *
 * Chromium's PDF MimeHandler is a chrome-extension guest that streams the
 * embedder's blob: iframe. Predicate tweaks on isMainFrame === false do not
 * survive Electron's event wiring (will-navigate omits/hardcodes isMainFrame,
 * guests have no hostWebContents at web-contents-created). The report viewer
 * must not use that plugin; this guard still must not cancel renderer-origin
 * blob: or chrome-extension: if something else loads them.
 */

export interface AppNavigationOptions {
	/** Dev Vite origin (`http://127.0.0.1:5173`) or the last good renderer URL. */
	rendererUrl?: string;
	isMainFrame?: boolean;
}

export interface AppNavigationEvent {
	url: string;
	isMainFrame?: boolean;
	rendererUrl?: string;
	/** MimeHandler / webview / guest WebContents — never apply the window allowlist. */
	isGuestContents?: boolean;
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export function isExternalHref(url: string): boolean {
	return /^(https?:|mailto:)/i.test(String(url || '').trim());
}

export function isRendererOriginBlob(url: string, rendererUrl?: string): boolean {
	const inner = blobInnerUrl(url);
	if (!inner) {
		return false;
	}
	if (inner.protocol !== 'http:' && inner.protocol !== 'https:') {
		return false;
	}
	return isAllowedRendererHttp(inner, rendererUrl);
}

/**
 * Decision used by the main-process guard. Keep this in core so tests can
 * cover Electron event shapes without launching Chromium.
 */
export function shouldPreventAppNavigation(event: AppNavigationEvent): boolean {
	if (event.isGuestContents) {
		return false;
	}
	return !isAllowedAppNavigation(event.url, {
		rendererUrl: event.rendererUrl,
		isMainFrame: event.isMainFrame,
	});
}

export function isAllowedAppNavigation(url: string, opts: AppNavigationOptions = {}): boolean {
	const href = String(url || '').trim();
	if (!href) {
		return false;
	}
	if (/^blob:/i.test(href)) {
		// Renderer-origin blobs must load even when Electron reports main-frame
		// (will-navigate used to pass true for every event) or omits isMainFrame.
		if (isRendererOriginBlob(href, opts.rendererUrl)) {
			return true;
		}
		return opts.isMainFrame !== true;
	}
	let parsed: URL;
	try {
		parsed = new URL(href);
	} catch {
		return false;
	}
	const protocol = parsed.protocol.toLowerCase();
	if (protocol === 'about:') {
		return parsed.pathname === 'blank' || href === 'about:blank';
	}
	if (protocol === 'devtools:') {
		return true;
	}
	if (protocol === 'file:') {
		return true;
	}
	if (protocol === 'app:' || protocol === 'hawaldar:') {
		return true;
	}
	if (protocol === 'chrome:' || protocol === 'chrome-extension:') {
		// PDF MimeHandler guest main frame is chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai.
		return true;
	}
	if (protocol === 'http:' || protocol === 'https:') {
		return isAllowedRendererHttp(parsed, opts.rendererUrl);
	}
	return false;
}

function blobInnerUrl(href: string): URL | null {
	const raw = String(href || '').trim();
	if (!/^blob:/i.test(raw)) {
		return null;
	}
	try {
		return new URL(raw.slice(raw.indexOf(':') + 1));
	} catch {
		return null;
	}
}

function isAllowedRendererHttp(parsed: URL, rendererUrl?: string): boolean {
	const configured = String(rendererUrl || '').trim();
	if (configured) {
		try {
			const home = new URL(configured);
			if (home.protocol === 'http:' || home.protocol === 'https:') {
				return sameOrigin(parsed, home);
			}
			if (home.protocol === 'file:') {
				return false;
			}
		} catch {
			// Ignore unparsable renderer URLs; fall through to the default Vite port.
		}
	}
	const host = parsed.hostname.toLowerCase();
	if (!LOOPBACK.has(host)) {
		return false;
	}
	const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
	return port === '5173';
}

function sameOrigin(a: URL, b: URL): boolean {
	return a.protocol === b.protocol
		&& a.hostname.toLowerCase() === b.hostname.toLowerCase()
		&& originPort(a) === originPort(b);
}

function originPort(url: URL): string {
	if (url.port) {
		return url.port;
	}
	return url.protocol === 'https:' ? '443' : '80';
}
