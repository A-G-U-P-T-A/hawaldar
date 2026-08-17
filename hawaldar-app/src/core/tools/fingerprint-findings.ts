import type { FindingClass, FindingSeverity, FindingStatus, FindingsStore } from '../findings-store';
import { JUICE_SHOP_LOGIN_URL, JUICE_SHOP_SEARCH_URL, JUICE_SHOP_URL } from './juice-shop';

const FINGERPRINT_TOOLS = new Set([
	'httpx',
	'httpx-title',
	'httpx-tech',
	'nuclei',
	'nuclei-tech',
	'nuclei-severity-info',
	'detect-services',
	'juice-shop-status',
	'browser-open',
	'scrapling-fetch',
]);

const STACK_RULES: Array<{ re: RegExp; title: string; product: string }> = [
	{ re: /owasp[-\s]?juice[-\s]?shop/i, title: 'Identified OWASP Juice Shop', product: 'OWASP Juice Shop' },
	{ re: /\bexpress(?:\/[\d.]+)?\b/i, title: 'Identified Express', product: 'Express' },
	{ re: /\bnode\.js(?:[/\s]v?[\d.]+)?\b/i, title: 'Identified Node.js', product: 'Node.js' },
];

const CVE_RE = /\bcve-\d{4}-\d{4,7}\b/gi;

export interface FingerprintDraft {
	title: string;
	vulnClass: FindingClass;
	severity: FindingSeverity;
	status: FindingStatus;
	target: string;
	description: string;
	evidence: string;
}

export function isFingerprintTool(id: string): boolean {
	return FINGERPRINT_TOOLS.has(id);
}

/** Pure parse of scanner stdout into version / route hypotheses. No payloads. */
export function parseFingerprintFindings(toolId: string, stdout: string, target: string): FingerprintDraft[] {
	const text = (stdout || '').trim();
	if (!text || !isFingerprintTool(toolId)) {
		return [];
	}
	const host = target.trim() || JUICE_SHOP_URL;
	const out: FingerprintDraft[] = [];
	const seen = new Set<string>();
	const push = (draft: FingerprintDraft) => {
		const key = `${draft.vulnClass}|${draft.title}|${draft.target}`;
		if (seen.has(key)) {
			return;
		}
		seen.add(key);
		out.push(draft);
	};

	for (const rule of STACK_RULES) {
		if (!rule.re.test(text)) {
			continue;
		}
		push({
			title: draftTitle(rule.title, text, rule.product),
			vulnClass: 'version',
			severity: 'info',
			status: 'hypothesis',
			target: host,
			description: `${rule.product} identified by ${toolId}. Treat as unpatched until a later PoC proves impact. SAST is not required for this record.`,
			evidence: clipEvidence(text),
		});
	}

	const cves = [...new Set((text.match(CVE_RE) || []).map((item) => item.toUpperCase()))];
	for (const cve of cves.slice(0, 8)) {
		push({
			title: `Identified ${cve}`,
			vulnClass: 'version',
			severity: 'low',
			status: 'hypothesis',
			target: host,
			description: `${cve} named by ${toolId}. Hypothesis only — prove impact with sanctioned poc-* / sqlmap-scan / zap-ascan if in-scope.`,
			evidence: clipEvidence(text),
		});
	}

	if (out.some((item) => /juice shop/i.test(item.title)) || juiceShopTarget(host)) {
		for (const extra of juiceShopPublicHypotheses(host)) {
			push(extra);
		}
	}

	return out;
}

export function juiceShopPublicHypotheses(target: string): FingerprintDraft[] {
	const origin = originOf(target) || JUICE_SHOP_URL;
	return [
		{
			title: 'SQL injection candidate: /rest/products/search',
			vulnClass: 'injection',
			severity: 'medium',
			status: 'hypothesis',
			target: JUICE_SHOP_SEARCH_URL,
			description: 'Public Juice Shop search API accepts `q`. Empty workspace SAST does not rule injection out. Prove with sqlmap-scan or poc-request on this URL.',
			evidence: `OWASP Juice Shop public API on ${origin}: GET /rest/products/search?q=`,
		},
		{
			title: 'Reflected XSS candidate: search',
			vulnClass: 'xss',
			severity: 'medium',
			status: 'hypothesis',
			target: JUICE_SHOP_SEARCH_URL,
			description: 'Search reflects input on Juice Shop. Prove with poc-xss-canary on this in-scope URL.',
			evidence: `OWASP Juice Shop public search surface on ${origin}`,
		},
		{
			title: 'Auth surface: /rest/user/login',
			vulnClass: 'auth',
			severity: 'info',
			status: 'hypothesis',
			target: JUICE_SHOP_LOGIN_URL,
			description: 'Login API is in-scope. Prove auth issues with poc-request / poc-act only (no credential stuffing).',
			evidence: `OWASP Juice Shop public API on ${origin}: POST /rest/user/login`,
		},
		{
			title: 'IDOR candidate: authenticated object access',
			vulnClass: 'idor',
			severity: 'medium',
			status: 'hypothesis',
			target: `${origin}/rest/basket/1`,
			description: 'Public Juice Shop lab includes IDOR-class object access. Prove with poc-act / poc-request on in-scope routes only (benign test records, no credential stuffing).',
			evidence: `OWASP Juice Shop public lab on ${origin}`,
		},
	];
}

export async function recordFingerprintFindings(
	store: FindingsStore,
	toolId: string,
	stdout: string,
	target: string,
): Promise<number> {
	const drafts = parseFingerprintFindings(toolId, stdout, target);
	let saved = 0;
	for (const draft of drafts) {
		try {
			await store.upsert({
				...draft,
				source: toolId,
			});
			saved += 1;
		} catch {
			/* natural-key upsert is best-effort; never fail the scan */
		}
	}
	return saved;
}

function draftTitle(base: string, text: string, product: string): string {
	const version = text.match(new RegExp(`${product}[/\\s]+v?(\\d[\\w.+-]*)`, 'i'));
	if (version?.[1]) {
		return `${base} ${version[1]}`;
	}
	return `${base} (unpatched until proven)`;
}

function originOf(raw: string): string {
	try {
		return new URL(raw).origin;
	} catch {
		return raw.replace(/\/+$/, '');
	}
}

function juiceShopTarget(raw: string): boolean {
	const text = (raw || '').toLowerCase();
	if (text.includes('juice') && text.includes('shop')) {
		return true;
	}
	return /127\.0\.0\.1:3000/.test(text) || /localhost:3000/.test(text);
}

function clipEvidence(text: string): string {
	const trimmed = text.replace(/\s+/g, ' ').trim();
	return trimmed.length > 1200 ? `${trimmed.slice(0, 1200)}…` : trimmed;
}
