import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { BrowserWindow } from 'electron';

const LOAD_ATTEMPTS = 5;
const LOAD_BACKOFF_MS = 400;
const HTTP_POLL_MS = 400;
const HTTP_POLL_TIMEOUT_MS = 30_000;
const LOAD_ATTEMPT_TIMEOUT_MS = 15_000;

const RETRYABLE_CODES = new Set([-2, -3, -7, -21, -101, -102, -106, -118, -324]);
const RETRYABLE_NAMES =
	/ERR_FAILED|ERR_ABORTED|ERR_TIMED_OUT|ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET|ERR_CONNECTION_TIMED_OUT|ERR_EMPTY_RESPONSE|ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED/;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function failureText(error: unknown, desc?: string): string {
	const err = error as { code?: string | number; errno?: number; message?: string } | undefined;
	return [desc, err?.code, err?.errno, err?.message, error instanceof Error ? '' : error]
		.filter((item) => item != null && item !== '')
		.join(' ');
}

function failureCode(error: unknown, code?: number): number | undefined {
	if (typeof code === 'number') {
		return code;
	}
	const err = error as { errno?: number; errorCode?: number } | undefined;
	if (typeof err?.errno === 'number') {
		return err.errno;
	}
	if (typeof err?.errorCode === 'number') {
		return err.errorCode;
	}
	const text = error instanceof Error ? error.message : String(error ?? '');
	const match = text.match(/\((-?\d+)\)/);
	return match ? Number(match[1]) : undefined;
}

export function isRetryableLoadFailure(error: unknown, code?: number, desc?: string): boolean {
	const numeric = failureCode(error, code);
	if (typeof numeric === 'number' && RETRYABLE_CODES.has(numeric)) {
		return true;
	}
	return RETRYABLE_NAMES.test(failureText(error, desc));
}

function isHttpRendererUrl(url: string): boolean {
	try {
		const parsed = new URL(url);
		return parsed.protocol === 'http:' || parsed.protocol === 'https:';
	} catch {
		return /^https?:\/\//i.test(url);
	}
}

export async function waitForHttpOk(
	url: string,
	opts?: { timeoutMs?: number; intervalMs?: number },
): Promise<boolean> {
	const timeoutMs = opts?.timeoutMs ?? HTTP_POLL_TIMEOUT_MS;
	const intervalMs = opts?.intervalMs ?? HTTP_POLL_MS;
	const deadline = Date.now() + timeoutMs;
	let n = 0;
	while (Date.now() < deadline) {
		n += 1;
		try {
			const res = await fetch(url, {
				method: 'GET',
				redirect: 'manual',
				signal: AbortSignal.timeout(2_000),
				headers: { accept: 'text/html' },
			});
			if (res.status >= 200 && res.status < 400) {
				console.log(`[hawaldar] renderer HTTP ${res.status} (${n} poll${n === 1 ? '' : 's'})`);
				return true;
			}
			if (n === 1 || n % 5 === 0) {
				console.log(`[hawaldar] renderer poll ${n} HTTP ${res.status}`);
			}
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			if (n === 1 || n % 5 === 0) {
				console.log(`[hawaldar] renderer poll ${n} ${msg}`);
			}
		}
		await sleep(intervalMs);
	}
	console.warn(`[hawaldar] renderer HTTP not ready after ${timeoutMs}ms`);
	return false;
}

async function runOnSplash(win: BrowserWindow, script: string): Promise<void> {
	if (win.isDestroyed() || win.webContents.isDestroyed()) {
		return;
	}
	const current = win.webContents.getURL();
	if (!current.startsWith('file:')) {
		return;
	}
	try {
		await win.webContents.executeJavaScript(script, true);
	} catch {
		// Navigated away from splash.
	}
}

async function setSplashStatus(win: BrowserWindow, text: string): Promise<void> {
	await runOnSplash(
		win,
		`typeof window.__hwSplashStatus === 'function' && window.__hwSplashStatus(${JSON.stringify(text)})`,
	);
}

async function hideSplashMark(win: BrowserWindow): Promise<void> {
	await runOnSplash(win, `typeof window.__hwSplashHideMark === 'function' && window.__hwSplashHideMark()`);
}

export async function loadSplashFile(
	win: BrowserWindow,
	splashHtml: string,
	brandPath: string,
	theme: 'dark' | 'light' = 'dark',
): Promise<boolean> {
	if (!splashHtml || !existsSync(splashHtml) || win.isDestroyed()) {
		return false;
	}
	const query: Record<string, string> = { theme };
	if (brandPath && existsSync(brandPath)) {
		query.brand = pathToFileURL(brandPath).href;
	}
	console.log('[hawaldar] loadFile splash', splashHtml);
	try {
		await win.loadFile(splashHtml, { query });
		return true;
	} catch (error) {
		console.error('[hawaldar] splash loadFile failed', error);
		return false;
	}
}

function loadUrlOnce(win: BrowserWindow, url: string, timeoutMs: number): Promise<void> {
	return new Promise((resolve, reject) => {
		const wc = win.webContents;
		let settled = false;
		const cleanup = (): void => {
			wc.removeListener('did-finish-load', onFinish);
			wc.removeListener('did-fail-load', onFail);
			clearTimeout(timer);
		};
		const done = (error?: Error): void => {
			if (settled) {
				return;
			}
			settled = true;
			cleanup();
			if (error) {
				reject(error);
			} else {
				resolve();
			}
		};
		const onFinish = (): void => {
			const current = wc.getURL();
			if (url.startsWith('http') && current.startsWith('file:')) {
				return;
			}
			done();
		};
		const onFail = (
			_event: unknown,
			code: number,
			desc: string,
			failedUrl: string,
			isMainFrame: boolean,
		): void => {
			if (!isMainFrame) {
				return;
			}
			if (failedUrl && !failedUrl.startsWith(url) && failedUrl !== url) {
				return;
			}
			const err = new Error(`${desc} (${code}) loading '${failedUrl || url}'`);
			(err as Error & { errno?: number }).errno = code;
			done(err);
		};
		const timer = setTimeout(() => {
			done(new Error(`ERR_FAILED (-2) loading '${url}' (timeout)`));
		}, timeoutMs);
		wc.on('did-finish-load', onFinish);
		wc.on('did-fail-load', onFail);
		void win.loadURL(url).then(() => done()).catch((error) => {
			done(error instanceof Error ? error : new Error(String(error)));
		});
	});
}

export async function loadUrlWithRetry(
	win: BrowserWindow,
	url: string,
	attempts = LOAD_ATTEMPTS,
	beforeAttempt?: (n: number) => Promise<void>,
): Promise<void> {
	let lastError: unknown;
	for (let n = 1; n <= attempts; n++) {
		if (win.isDestroyed()) {
			return;
		}
		if (n === 1) {
			console.log('[hawaldar] loadURL', url);
			if (beforeAttempt) {
				await beforeAttempt(n);
			}
		} else {
			console.log(`[hawaldar] loadURL retry ${n}`);
			if (beforeAttempt) {
				await beforeAttempt(n);
			}
			await sleep(LOAD_BACKOFF_MS * 2 ** (n - 2));
		}
		try {
			if (n > 1 && !win.isDestroyed()) {
				win.webContents.stop();
			}
			await loadUrlOnce(win, url, LOAD_ATTEMPT_TIMEOUT_MS);
			return;
		} catch (error) {
			lastError = error;
			const retryable = isRetryableLoadFailure(error);
			console.warn(`[hawaldar] loadURL attempt ${n} failed`, error);
			if (!retryable || n === attempts) {
				break;
			}
		}
	}
	console.error('[hawaldar] loadURL failed', lastError);
	throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function bootRendererWindow(
	win: BrowserWindow,
	opts: {
		rendererUrl?: string;
		indexHtml: string;
		splashHtml: string;
		brandPath: string;
		theme: 'dark' | 'light';
	},
): Promise<void> {
	const splashOk = await loadSplashFile(win, opts.splashHtml, opts.brandPath, opts.theme);
	const rendererUrl = opts.rendererUrl?.trim();
	if (rendererUrl) {
		if (splashOk) {
			await setSplashStatus(win, 'Waiting for the renderer…');
		}
		if (isHttpRendererUrl(rendererUrl)) {
			const ready = await waitForHttpOk(rendererUrl);
			if (!ready) {
				console.warn('[hawaldar] renderer HTTP not ready; loading anyway');
			}
		}
		try {
			await loadUrlWithRetry(win, rendererUrl, LOAD_ATTEMPTS, async (n) => {
				if (n === 1) {
					await setSplashStatus(win, 'Loading workspace…');
					await hideSplashMark(win);
					return;
				}
				if (splashOk) {
					await loadSplashFile(win, opts.splashHtml, opts.brandPath, opts.theme);
					await setSplashStatus(win, `Retrying renderer (${n}/${LOAD_ATTEMPTS})…`);
				}
			});
		} catch {
			if (splashOk && !win.isDestroyed()) {
				await loadSplashFile(win, opts.splashHtml, opts.brandPath, opts.theme);
				await setSplashStatus(win, 'Renderer failed to load. Check the terminal.');
			}
		}
		return;
	}

	console.log('[hawaldar] loadFile', opts.indexHtml);
	try {
		await win.loadFile(opts.indexHtml);
	} catch (error) {
		console.error('[hawaldar] loadFile failed', error);
		if (splashOk) {
			await loadSplashFile(win, opts.splashHtml, opts.brandPath, opts.theme);
			await setSplashStatus(win, 'Workspace failed to load. Check the terminal.');
		}
	}
}
