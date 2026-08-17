/**
 * Contained browser recon. Runs only inside localhost/hawaldar/browser:min.
 * Policy allow-list is enforced again here; the host already gated the start URL.
 * No cookies, no password values, no operator JS, no downloads.
 */
import { chromium } from 'playwright-core';
import { access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';

const SECRET_QUERY = /^(?:token|access_token|auth|authorization|key|api[_-]?key|password|passwd|secret|session|sid|jwt|cookie)$/i;
const SEARCH_HOSTS = new Set([
	'google.com',
	'www.google.com',
	'duckduckgo.com',
	'www.duckduckgo.com',
	'html.duckduckgo.com',
	'bing.com',
	'www.bing.com',
]);

function parseArgs(argv) {
	const out = {
		action: '',
		url: '',
		query: '',
		engine: 'duckduckgo',
		allowedHosts: [],
		searchHop: false,
		method: 'GET',
		headers: {},
		body: '',
		payload: '',
		actions: [],
		navTimeout: 60_000,
	};
	for (let i = 0; i < argv.length; i += 1) {
		const key = argv[i];
		const next = argv[i + 1];
		if (key === '--action') {
			out.action = String(next || '');
			i += 1;
		} else if (key === '--url') {
			out.url = String(next || '');
			i += 1;
		} else if (key === '--query') {
			out.query = String(next || '');
			i += 1;
		} else if (key === '--engine') {
			out.engine = String(next || 'duckduckgo');
			i += 1;
		} else if (key === '--method') {
			out.method = String(next || 'GET').toUpperCase();
			i += 1;
		} else if (key === '--headers') {
			try {
				const parsed = JSON.parse(String(next || '{}'));
				out.headers = parsed && typeof parsed === 'object' ? parsed : {};
			} catch {
				out.headers = {};
			}
			i += 1;
		} else if (key === '--body') {
			out.body = String(next || '');
			i += 1;
		} else if (key === '--payload') {
			out.payload = String(next || '');
			i += 1;
		} else if (key === '--actions') {
			try {
				const parsed = JSON.parse(String(next || '[]'));
				out.actions = Array.isArray(parsed) ? parsed : [];
			} catch {
				out.actions = [];
			}
			i += 1;
		} else if (key === '--allowed-hosts') {
			try {
				const parsed = JSON.parse(String(next || '[]'));
				out.allowedHosts = Array.isArray(parsed) ? parsed.map((item) => String(item).toLowerCase()) : [];
			} catch {
				out.allowedHosts = [];
			}
			i += 1;
		} else if (key === '--search-hop') {
			out.searchHop = true;
		} else if (key === '--nav-timeout') {
			const ms = Number(next);
			if (Number.isFinite(ms) && ms >= 5_000 && ms <= 120_000) {
				out.navTimeout = ms;
			}
			i += 1;
		}
	}
	return out;
}

function hostOf(raw) {
	try {
		return new URL(raw).hostname.toLowerCase();
	} catch {
		return '';
	}
}

function hostAllowed(raw, allowed, searchHop) {
	let parsed;
	try {
		parsed = new URL(raw);
	} catch {
		return false;
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		return false;
	}
	const host = parsed.hostname.toLowerCase();
	if (searchHop && SEARCH_HOSTS.has(host)) {
		return true;
	}
	return allowed.some((rule) => host === rule || host.endsWith(`.${rule}`));
}

function redactUrl(raw) {
	try {
		const parsed = new URL(raw);
		parsed.username = '';
		parsed.password = '';
		for (const key of [...parsed.searchParams.keys()]) {
			if (SECRET_QUERY.test(key)) {
				parsed.searchParams.set(key, 'REDACTED');
			}
		}
		return parsed.toString();
	} catch {
		return raw.slice(0, 240);
	}
}

function unwrapSearchHref(href, base) {
	try {
		const parsed = new URL(href, base);
		if (parsed.hostname.includes('duckduckgo.com')) {
			const uddg = parsed.searchParams.get('uddg');
			if (uddg) {
				return new URL(uddg).toString();
			}
		}
		if (parsed.hostname.includes('google.com') && parsed.pathname === '/url') {
			const q = parsed.searchParams.get('q') || parsed.searchParams.get('url');
			if (q && /^https?:/i.test(q)) {
				return new URL(q).toString();
			}
		}
		if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
			return parsed.toString();
		}
	} catch {
		// ignore
	}
	return '';
}

async function chromiumPath() {
	const pinned = process.env.CHROMIUM_PATH;
	const candidates = [pinned, '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean);
	for (const item of candidates) {
		try {
			await access(item, fsConstants.X_OK);
			return item;
		} catch {
			// try next
		}
	}
	throw new Error('Chromium binary not found in the browser image.');
}

function fail(reason, extra = {}) {
	return { ok: false, error: reason, ...extra };
}

async function withPage(job, fn) {
	const executablePath = await chromiumPath();
	const browser = await chromium.launch({
		executablePath,
		headless: true,
		args: [
			'--no-sandbox',
			'--disable-dev-shm-usage',
			'--disable-gpu',
			'--disable-extensions',
			'--disable-background-networking',
			'--disable-sync',
			'--disable-translate',
			'--no-first-run',
			'--disable-default-apps',
			'--disable-popup-blocking',
			'--disable-features=DownloadBubble,TranslateUI',
		],
	});
	const context = await browser.newContext({
		acceptDownloads: false,
		javaScriptEnabled: true,
		ignoreHTTPSErrors: true,
		viewport: { width: 1280, height: 720 },
	});
	const page = await context.newPage();
	const consoleEvents = [];
	const networkEvents = [];
	page.on('console', (msg) => {
		const type = msg.type();
		if (type === 'error' || type === 'warning') {
			consoleEvents.push({ type, text: String(msg.text() || '').slice(0, 500) });
		}
	});
	page.on('pageerror', (error) => {
		consoleEvents.push({ type: 'error', text: String(error?.message || error).slice(0, 500) });
	});
	page.on('requestfailed', (request) => {
		networkEvents.push({
			kind: 'failed',
			method: request.method(),
			url: redactUrl(request.url()),
			status: 0,
			resourceType: request.resourceType(),
			failure: request.failure()?.errorText || 'failed',
		});
	});
	page.on('response', (response) => {
		const status = response.status();
		if (status >= 400) {
			networkEvents.push({
				kind: 'http-error',
				method: response.request().method(),
				url: redactUrl(response.url()),
				status,
				resourceType: response.request().resourceType(),
			});
		}
	});
	page.on('download', (download) => {
		void download.cancel().catch(() => undefined);
	});
	page.on('framenavigated', (frame) => {
		if (frame !== page.mainFrame()) {
			return;
		}
		const href = frame.url();
		if (!href || href === 'about:blank') {
			return;
		}
		if (!hostAllowed(href, job.allowedHosts, job.searchHop)) {
			void page.close().catch(() => undefined);
		}
	});
	try {
		return await fn(page, { consoleEvents, networkEvents });
	} finally {
		await context.close().catch(() => undefined);
		await browser.close().catch(() => undefined);
	}
}

function isNetworkChanged(error) {
	const message = error instanceof Error ? error.message : String(error);
	return /ERR_NETWORK_CHANGED|ERR_INTERNET_DISCONNECTED|ERR_CONNECTION_RESET/i.test(message);
}

async function gotoAllowed(page, job) {
	if (!job.url) {
		return fail('URL is required.');
	}
	if (!hostAllowed(job.url, job.allowedHosts, job.searchHop)) {
		return fail(`Navigation refused: ${redactUrl(job.url)} is not on the allow-list.`);
	}
	const timeout = Number(job.navTimeout) > 0 ? Number(job.navTimeout) : 60_000;
	const attempt = () => page.goto(job.url, { waitUntil: 'domcontentloaded', timeout });
	let response;
	try {
		response = await attempt();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (/closed|Target page/i.test(message)) {
			return fail('Navigation aborted: redirect left the allow-list.');
		}
		if (isNetworkChanged(error)) {
			try {
				response = await attempt();
			} catch (retryError) {
				const retryMessage = retryError instanceof Error ? retryError.message : String(retryError);
				if (/closed|Target page/i.test(retryMessage)) {
					return fail('Navigation aborted: redirect left the allow-list.');
				}
				return fail(retryMessage);
			}
		} else {
			return fail(message);
		}
	}
	const finalUrl = page.url();
	if (!hostAllowed(finalUrl, job.allowedHosts, job.searchHop)) {
		return fail(`Redirect refused: ${redactUrl(finalUrl)} is not on the allow-list.`, { url: redactUrl(finalUrl) });
	}
	return { ok: true, status: response?.status() ?? 0, url: finalUrl };
}

async function visibleExcerpt(page) {
	return page.evaluate(() => {
		for (const el of document.querySelectorAll('input[type="password"], input[type="hidden"]')) {
			if ('value' in el) {
				el.value = '';
			}
			el.setAttribute('value', '');
		}
		const text = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
		return {
			title: document.title || '',
			excerpt: text.slice(0, 4000),
			passwordFields: document.querySelectorAll('input[type="password"]').length,
		};
	});
}

function flattenA11y(node, depth, lines) {
	if (!node || lines.length >= 200 || depth > 8) {
		return;
	}
	const role = node.role || 'node';
	const name = String(node.name || '').replace(/\s+/g, ' ').trim();
	if (name || ['heading', 'link', 'button', 'textbox', 'navigation', 'main'].includes(role)) {
		lines.push(`${'  '.repeat(depth)}${role}${name ? `: ${name.slice(0, 160)}` : ''}`);
	}
	for (const child of node.children || []) {
		flattenA11y(child, depth + 1, lines);
	}
}

async function collectLinks(page, job) {
	const raw = await page.$$eval('a[href]', (anchors) => anchors.slice(0, 200).map((a) => ({
		href: a.getAttribute('href') || '',
		text: (a.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160),
	})));
	const origin = new URL(page.url()).origin;
	const out = [];
	const seen = new Set();
	for (const item of raw) {
		const href = unwrapSearchHref(item.href, page.url());
		if (!href || seen.has(href)) {
			continue;
		}
		seen.add(href);
		const allowed = hostAllowed(href, job.allowedHosts, false);
		let sameOrigin = false;
		try {
			sameOrigin = new URL(href).origin === origin;
		} catch {
			sameOrigin = false;
		}
		if (!allowed && !sameOrigin) {
			continue;
		}
		if (!allowed) {
			continue;
		}
		out.push({ title: item.text, url: redactUrl(href), sameOrigin });
		if (out.length >= 80) {
			break;
		}
	}
	return out;
}

async function collectSearchResults(page, job) {
	const raw = await page.$$eval('a[href]', (anchors) => anchors.slice(0, 300).map((a) => ({
		href: a.getAttribute('href') || '',
		text: (a.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160),
		snippet: (a.closest('li, article, .result, .g, .b_algo')?.textContent || '')
			.replace(/\s+/g, ' ')
			.trim()
			.slice(0, 240),
	})));
	const results = [];
	const seen = new Set();
	for (const item of raw) {
		const href = unwrapSearchHref(item.href, page.url());
		if (!href || seen.has(href)) {
			continue;
		}
		const host = hostOf(href);
		if (!host || SEARCH_HOSTS.has(host)) {
			continue;
		}
		seen.add(href);
		results.push({
			title: item.text || host,
			url: href,
			snippet: item.snippet,
			host,
		});
		if (results.length >= 12) {
			break;
		}
	}
	return results;
}

function decodeHtml(value) {
	return String(value || '')
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/<[^>]+>/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

function parseSearchHtml(html, base) {
	const results = [];
	const seen = new Set();
	const re = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
	let match;
	while ((match = re.exec(html)) && results.length < 12) {
		const href = unwrapSearchHref(decodeHtml(match[1]), base);
		if (!href || seen.has(href)) {
			continue;
		}
		const host = hostOf(href);
		if (!host || SEARCH_HOSTS.has(host)) {
			continue;
		}
		seen.add(href);
		results.push({
			title: decodeHtml(match[2]) || host,
			url: href,
			snippet: '',
			host,
		});
	}
	return results;
}

async function fetchOnce(url, timeoutMs) {
	const ac = new AbortController();
	const timer = setTimeout(() => ac.abort(), timeoutMs);
	try {
		const res = await fetch(url, {
			signal: ac.signal,
			redirect: 'follow',
			headers: {
				accept: 'text/html,application/xhtml+xml',
				'user-agent': 'Mozilla/5.0 (compatible; HawaldarResearch/1.0)',
			},
		});
		const html = await res.text();
		return { ok: res.ok, status: res.status, html };
	} finally {
		clearTimeout(timer);
	}
}

async function fetchSearch(job) {
	if (!job.url) {
		return fail('URL is required.');
	}
	if (!hostAllowed(job.url, job.allowedHosts, job.searchHop)) {
		return fail(`Navigation refused: ${redactUrl(job.url)} is not on the allow-list.`);
	}
	const timeout = Math.min(Number(job.navTimeout) || 15_000, 20_000);
	let fetched;
	try {
		fetched = await fetchOnce(job.url, timeout);
	} catch (error) {
		if (!isNetworkChanged(error)) {
			return fail(error instanceof Error ? error.message : String(error));
		}
		try {
			fetched = await fetchOnce(job.url, timeout);
		} catch (retryError) {
			return fail(retryError instanceof Error ? retryError.message : String(retryError));
		}
	}
	const results = parseSearchHtml(fetched.html, job.url);
	return {
		ok: true,
		action: 'search',
		engine: job.engine,
		query: job.query,
		title: 'search',
		url: redactUrl(job.url),
		status: fetched.status,
		results,
		via: 'fetch',
	};
}

/** In-container guard copy (host enforces too). PoC probes stay read-only at the SQL level. */
const DESTRUCTIVE_SQL = /\b(drop\s+table|truncate\s+table|delete\s+from|alter\s+table|update\s+[\w."`]+\s+set|insert\s+into\b|xp_cmdshell|into\s+(?:out|dump)file|load_file\s*\(|shutdown\b)/i;
/** Canary proofs may not exfiltrate. window.__hwPocFired markers only. */
const XSS_EXFIL = /document\.cookie|document\.domain|localstorage|sessionstorage|indexeddb|fetch\s*\(|xmlhttprequest|sendbeacon|websocket|eventsource|window\.open|(?:top\.|window\.)?location(?:\.href)?\s*=|location\.(?:assign|replace|href)|import\s*\(|postmessage\s*\(/i;
const SAFE_RESPONSE_HEADERS = new Set([
	'content-type', 'content-length', 'server', 'x-powered-by', 'location', 'date',
	'cache-control', 'www-authenticate', 'x-frame-options', 'content-security-policy',
]);

function redactHeaders(headers) {
	const out = {};
	for (const [key, value] of Object.entries(headers || {})) {
		const lower = key.toLowerCase();
		if (lower === 'set-cookie') {
			out['set-cookie'] = '[set]';
			continue;
		}
		if (SECRET_QUERY.test(lower) || /^(authorization|proxy-authorization|x-api-key|x-auth-token)$/i.test(lower)) {
			out[key] = 'REDACTED';
			continue;
		}
		if (SAFE_RESPONSE_HEADERS.has(lower)) {
			out[key] = String(value).slice(0, 200);
		}
	}
	return out;
}

async function runRequest(page, job) {
	if (!hostAllowed(job.url, job.allowedHosts, false)) {
		return fail(`Request refused: ${redactUrl(job.url)} is not on the allow-list.`);
	}
	if (DESTRUCTIVE_SQL.test(job.url) || (job.body && DESTRUCTIVE_SQL.test(job.body))) {
		return fail('Destructive SQL refused (read-only proofs only).');
	}
	const allowedMethods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'HEAD', 'OPTIONS']);
	if (!allowedMethods.has(job.method)) {
		return fail(`Method ${job.method} refused.`);
	}
	const request = page.context().request;
	const started = Date.now();
	let current = job.url;
	let response;
	for (let hop = 0; hop <= 3; hop += 1) {
		try {
			response = await request.fetch(current, {
				method: job.method,
				headers: job.headers,
				data: job.body || undefined,
				maxRedirects: 0,
				timeout: 20_000,
			});
		} catch (error) {
			return fail(error instanceof Error ? error.message : String(error));
		}
		const status = response.status();
		if (![301, 302, 303, 307, 308].includes(status)) {
			break;
		}
		const location = response.headers().location;
		if (!location) {
			break;
		}
		let next;
		try {
			next = new URL(location, current).toString();
		} catch {
			break;
		}
		if (!hostAllowed(next, job.allowedHosts, false)) {
			return fail(`Redirect refused: ${redactUrl(next)} is not on the allow-list.`, { status });
		}
		current = next;
		if (hop === 2) {
			return fail('Too many redirects.');
		}
	}
	const durationMs = Date.now() - started;
	const headers = redactHeaders(response.headers());
	let bodyText = '';
	try {
		bodyText = await response.text();
	} catch {
		bodyText = '';
	}
	const excerpt = bodyText.replace(/\s+/g, ' ').trim().slice(0, 4_000);
	return {
		ok: true,
		action: 'request',
		request: {
			method: job.method,
			url: redactUrl(job.url),
			headers: redactHeaders(job.headers),
			bodyBytes: job.body ? job.body.length : 0,
		},
		status: response.status(),
		finalUrl: redactUrl(current),
		headers,
		bodyExcerpt: excerpt,
		bodyBytes: bodyText.length,
		durationMs,
	};
}

async function runAct(page, job, logs) {
	if (!job.actions.length) {
		return fail('actions are required.');
	}
	if (job.actions.length > 10) {
		return fail('Too many actions (max 10).');
	}
	const steps = [];
	const nav = await gotoAllowed(page, job);
	if (!nav.ok) {
		return nav;
	}
	steps.push({ op: 'goto', url: redactUrl(job.url), ok: true, status: nav.status });
	for (const [index, step] of job.actions.entries()) {
		try {
			const op = String(step?.op || '');
			if (op === 'goto') {
				const target = String(step.value || '');
				if (!hostAllowed(target, job.allowedHosts, false)) {
					steps.push({ op, ok: false, detail: 'refused: off allow-list' });
					break;
				}
				const resp = await page.goto(target, { waitUntil: 'domcontentloaded', timeout: Number(job.navTimeout) || 60_000 });
				const finalUrl = page.url();
				if (!hostAllowed(finalUrl, job.allowedHosts, false)) {
					steps.push({ op, ok: false, detail: 'redirect left the allow-list' });
					break;
				}
				steps.push({ op, url: redactUrl(target), ok: true, status: resp?.status() ?? 0, finalUrl: redactUrl(finalUrl) });
			} else if (op === 'fill') {
				const locator = page.locator(String(step.selector || '')).first();
				const type = await locator.getAttribute('type', { timeout: 8_000 }).catch(() => '');
				if (String(type || '').toLowerCase() === 'file') {
					steps.push({ op, selector: step.selector, ok: false, detail: 'file inputs are refused' });
					break;
				}
				await locator.fill(String(step.value ?? ''), { timeout: 8_000 });
				steps.push({ op, selector: step.selector, ok: true, detail: String(type || '').toLowerCase() === 'password' ? '[password set]' : '[set]' });
			} else if (op === 'click') {
				await page.locator(String(step.selector || '')).first().click({ timeout: 8_000 });
				await page.waitForLoadState('domcontentloaded', { timeout: 8_000 }).catch(() => undefined);
				const landed = page.url();
				if (landed && !hostAllowed(landed, job.allowedHosts, false)) {
					steps.push({ op, selector: step.selector, ok: false, detail: 'navigation left the allow-list' });
					break;
				}
				steps.push({ op, selector: step.selector, ok: true, url: redactUrl(landed) });
			} else if (op === 'submit') {
				const selector = step.selector ? String(step.selector) : 'form';
				await page.locator(selector).first().evaluate((el) => {
					const form = el instanceof HTMLFormElement ? el : el.closest('form');
					if (form) {
						form.requestSubmit();
					}
				});
				await page.waitForLoadState('domcontentloaded', { timeout: 8_000 }).catch(() => undefined);
				const landed = page.url();
				if (landed && !hostAllowed(landed, job.allowedHosts, false)) {
					steps.push({ op, selector: step.selector, ok: false, detail: 'navigation left the allow-list' });
					break;
				}
				steps.push({ op, selector: step.selector, ok: true, url: redactUrl(landed) });
			} else if (op === 'wait') {
				const ms = Math.min(Math.max(Number(step.ms) || 800, 100), 4_000);
				await page.waitForTimeout(ms);
				steps.push({ op, ok: true, ms });
			} else if (op === 'extract') {
				const selector = step.selector ? String(step.selector) : 'body';
				const text = await page.locator(selector).first().innerText({ timeout: 8_000 }).catch(() => '');
				steps.push({ op, selector, ok: true, text: String(text || '').replace(/\s+/g, ' ').trim().slice(0, 2_000) });
			} else {
				steps.push({ op: op || 'unknown', ok: false, detail: `step ${index + 1}: unknown op` });
				break;
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			steps.push({ op: String(step?.op || ''), ok: false, detail: message.slice(0, 200) });
			break;
		}
	}
	const visible = await visibleExcerpt(page).catch(() => ({ title: '', excerpt: '', passwordFields: 0 }));
	return {
		ok: true,
		action: 'act',
		steps,
		finalUrl: redactUrl(page.url()),
		title: visible.title,
		excerpt: visible.excerpt,
		passwordFields: visible.passwordFields,
		consoleEvents: logs.consoleEvents.slice(0, 20),
		networkEvents: logs.networkEvents.slice(0, 20),
	};
}

async function runXssCanary(context, page, job, logs) {
	if (!hostAllowed(job.url, job.allowedHosts, false)) {
		return fail(`Navigation refused: ${redactUrl(job.url)} is not on the allow-list.`);
	}
	let decoded = job.url;
	try {
		decoded = decodeURIComponent(job.url);
	} catch {
		// keep raw
	}
	if (XSS_EXFIL.test(job.payload) || XSS_EXFIL.test(decoded)) {
		return fail('Payload refused: exfiltration, storage access, and navigation are not allowed. Prove execution with window.__hwPocFired.');
	}
	await context.addInitScript(() => {
		window.__hwPocFired = 0;
		window.__hwPocMarks = [];
	});
	const nav = await gotoAllowed(page, job);
	if (!nav.ok) {
		return nav;
	}
	await page.waitForTimeout(1_500);
	const marks = await page.evaluate(() => ({
		fired: Number(window.__hwPocFired) || 0,
		marks: Array.isArray(window.__hwPocMarks) ? window.__hwPocMarks.slice(0, 10) : [],
	})).catch(() => ({ fired: 0, marks: [] }));
	const echo = await page.evaluate((payload) => {
		const html = document.body ? document.body.innerHTML : '';
		const idx = payload ? html.indexOf(payload) : -1;
		if (idx < 0) {
			return { found: false };
		}
		const start = Math.max(0, idx - 100);
		return {
			found: true,
			context: html.slice(start, idx + payload.length + 100).replace(/\s+/g, ' ').slice(0, 400),
		};
	}, job.payload).catch(() => ({ found: false }));
	return {
		ok: true,
		action: 'xss-canary',
		url: redactUrl(page.url()),
		status: nav.status,
		title: await page.title(),
		payloadBytes: job.payload.length,
		fired: marks.fired,
		marks: marks.marks,
		echo,
		consoleEvents: logs.consoleEvents.slice(0, 20),
	};
}

async function run(job) {
	if (job.action === 'close') {
		return { ok: true, action: 'close', note: 'No persistent browser session. Each visit is ephemeral --rm.' };
	}
	if (!job.allowedHosts.length && !job.searchHop) {
		return fail('Allow-list is empty.');
	}
	if (job.action === 'search') {
		const fetched = await fetchSearch(job);
		if (fetched.ok && Array.isArray(fetched.results) && fetched.results.length > 0) {
			return fetched;
		}
		const viaPlaywright = await withPage(job, async (page) => {
			const nav = await gotoAllowed(page, { ...job, navTimeout: Math.min(Number(job.navTimeout) || 20_000, 20_000) });
			if (!nav.ok) {
				return nav;
			}
			const results = await collectSearchResults(page, job);
			return {
				ok: true,
				action: 'search',
				engine: job.engine,
				query: job.query,
				title: await page.title(),
				url: redactUrl(page.url()),
				status: nav.status,
				results,
				via: 'playwright',
			};
		});
		if (viaPlaywright.ok && Array.isArray(viaPlaywright.results) && viaPlaywright.results.length > 0) {
			return viaPlaywright;
		}
		if (fetched.ok) {
			return fetched;
		}
		return viaPlaywright;
	}
	return withPage(job, async (page, logs) => {
		if (job.action === 'request') {
			return runRequest(page, job);
		}
		if (job.action === 'act') {
			return runAct(page, job, logs);
		}
		if (job.action === 'xss-canary') {
			return runXssCanary(page.context(), page, job, logs);
		}
		const nav = await gotoAllowed(page, job);
		if (!nav.ok) {
			return nav;
		}
		if (job.action === 'open') {
			const visible = await visibleExcerpt(page);
			return {
				ok: true,
				action: 'open',
				title: visible.title,
				url: redactUrl(page.url()),
				status: nav.status,
				excerpt: visible.excerpt,
				passwordFields: visible.passwordFields,
			};
		}
		if (job.action === 'snapshot') {
			const tree = await page.accessibility.snapshot();
			const lines = [];
			flattenA11y(tree, 0, lines);
			const visible = await visibleExcerpt(page);
			return {
				ok: true,
				action: 'snapshot',
				title: visible.title,
				url: redactUrl(page.url()),
				status: nav.status,
				outline: lines.join('\n').slice(0, 8_000),
			};
		}
		if (job.action === 'console') {
			await page.waitForTimeout(800);
			return {
				ok: true,
				action: 'console',
				title: await page.title(),
				url: redactUrl(page.url()),
				status: nav.status,
				events: logs.consoleEvents.slice(0, 50),
			};
		}
		if (job.action === 'network') {
			await page.waitForTimeout(800);
			return {
				ok: true,
				action: 'network',
				title: await page.title(),
				url: redactUrl(page.url()),
				status: nav.status,
				events: logs.networkEvents.slice(0, 50),
			};
		}
		if (job.action === 'links') {
			const links = await collectLinks(page, job);
			return {
				ok: true,
				action: 'links',
				title: await page.title(),
				url: redactUrl(page.url()),
				status: nav.status,
				links,
			};
		}
		return fail(`Unknown action: ${job.action}`);
	});
}

const job = parseArgs(process.argv.slice(2));
run(job).then((result) => {
	process.stdout.write(`${JSON.stringify(result)}\n`);
	process.exit(result.ok ? 0 : 1);
}).catch((error) => {
	process.stdout.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
	process.exit(1);
});
