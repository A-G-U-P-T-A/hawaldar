import { extractCanonicalTarget, restoreTargetPlaceholders, skipReasonForTool } from './policy';
import { JUICE_SHOP_SEARCH_URL, JUICE_SHOP_URL } from './tools/juice-shop';
import type { WorkflowStep } from './playbook-store';
import { TOOL_CATALOG } from './tools/catalog';

export const ENGAGEMENT_WORKFLOW_IDS = [
	'pre-recon',
	'recon-surface',
	'web-recon',
	'source-review',
	'vuln-detect',
	'poc-validate',
	'validate',
	'report',
	'correlate-report',
	'full-engagement',
] as const;

export type EngagementWorkflowId = (typeof ENGAGEMENT_WORKFLOW_IDS)[number];

/** Slash / chat aliases → persisted workflow id. */
export const WORKFLOW_ALIASES: Record<string, string> = {
	'full-recon': 'full-engagement',
	'full-engagement': 'full-engagement',
	engagement: 'full-engagement',
	analyze: 'full-engagement',
	'pre-recon': 'pre-recon',
	prerecon: 'pre-recon',
	'source-review': 'source-review',
	'recon-surface': 'recon-surface',
	recon: 'recon-surface',
	'web-recon': 'web-recon',
	'vuln-detect': 'vuln-detect',
	vuln: 'vuln-detect',
	'poc-validate': 'poc-validate',
	poc: 'poc-validate',
	prove: 'poc-validate',
	validate: 'validate',
	report: 'report',
	'correlate-report': 'correlate-report',
};

export const WORKFLOW_SLASH_ALIASES: Array<{ cmd: string; workflowId: string; detail: string }> = [
	{ cmd: 'full-recon', workflowId: 'full-engagement', detail: 'Full engagement (pre-recon → report)' },
	{ cmd: 'analyze', workflowId: 'full-engagement', detail: 'Alias for /full-engagement' },
	{ cmd: 'engagement', workflowId: 'full-engagement', detail: 'Alias for /full-engagement' },
	{ cmd: 'recon', workflowId: 'recon-surface', detail: 'Alias for /recon-surface' },
	{ cmd: 'vuln', workflowId: 'vuln-detect', detail: 'Alias for /vuln-detect' },
	{ cmd: 'poc', workflowId: 'poc-validate', detail: 'Alias for /poc-validate' },
	{ cmd: 'prove', workflowId: 'poc-validate', detail: 'Alias for /poc-validate' },
];

/** Agents that consume prior-phase evidence and must not fan out with peers. */
export const SEQUENTIAL_AGENTS = new Set(['validation', 'reporting', 'policy', 'orchestrator']);

/** Tool steps that must finish before later recon/PoC tools (HITL or service readiness). */
const SEQUENTIAL_TOOLS = new Set([
	'juice-shop-status',
	'sqlmap-scan',
	'zap-ascan',
	'poc-request',
	'poc-act',
	'poc-xss-canary',
]);

/** Real exploit tooling stays refused. Sanctioned sqlmap-scan / zap-ascan / poc-* are allowed. */
const EXPLOIT_STEP = /(?:^|[-_/])(exploit|payload|msfvenom|msfconsole|burp-?intruder|metasploit-exploit)(?:$|[-_/])/i;

export function resolveWorkflowRef(keyOrId: string): string {
	const raw = keyOrId.trim();
	if (!raw) {
		return raw;
	}
	return WORKFLOW_ALIASES[raw.toLowerCase()] || raw;
}

export function isEngagementWorkflow(id: string): boolean {
	return (ENGAGEMENT_WORKFLOW_IDS as readonly string[]).includes(id);
}

export function stepLooksLikeExploit(id: string): boolean {
	return EXPLOIT_STEP.test(id);
}

export function takeLeadingSlashCommand(raw: string): { cmd: string; rest: string } | undefined {
	const match = raw.trim().match(/^\/(\w[\w-]*)(?:\s+|$)([\s\S]*)$/);
	if (!match) {
		return undefined;
	}
	return { cmd: match[1].toLowerCase(), rest: (match[2] || '').trim() };
}

function isLocalWebTarget(target?: string): boolean {
	const ref = extractCanonicalTarget(target || '');
	return Boolean(ref?.local && (ref.port || ref.url || /^https?:/i.test(target || '')));
}

function prependUnique(steps: WorkflowStep[], extras: WorkflowStep[]): WorkflowStep[] {
	const add = extras.filter((extra) => !steps.some((step) => step.id === extra.id));
	return add.length ? [...add, ...steps] : steps;
}

/**
 * Deterministic playbook: runtime calls recon/SAST/nuclei tools.
 * Loopback web labs skip DNS/subdomain. poc-validate always gets HITL
 * sqlmap-scan + zap-ascan on localhost web apps. Empty SAST is not a stop.
 */
export function adaptWorkflowSteps(workflowId: string, steps: WorkflowStep[], target?: string): WorkflowStep[] {
	const ref = extractCanonicalTarget(target || '');
	const localWeb = isLocalWebTarget(target);
	let next = steps.filter((step) => {
		if (step.kind !== 'tool') {
			return true;
		}
		return !skipReasonForTool(step.id, target);
	});

	if (workflowId === 'pre-recon' || workflowId === 'source-review') {
		return next.filter((step) => !(step.kind === 'agent' && step.id === 'research'));
	}

	if (workflowId === 'recon-surface') {
		if (ref?.lab === 'juice-shop') {
			next = prependUnique(next, [{ kind: 'tool', id: 'juice-shop-status' }]);
		}
		return next;
	}

	if (workflowId === 'vuln-detect') {
		return prependUnique(next, [
			{ kind: 'tool', id: 'nuclei-tech' },
			{ kind: 'tool', id: 'nuclei-severity-info' },
		]);
	}

	if (workflowId === 'poc-validate' && localWeb) {
		return prependUnique(next, [
			{ kind: 'tool', id: 'sqlmap-scan' },
			{ kind: 'tool', id: 'zap-spider' },
			{ kind: 'tool', id: 'zap-ascan' },
		]);
	}

	return next;
}

/** Batch independent tool/agent steps; keep HITL/readiness tools and sequential agents alone. */
export function groupIndependentSteps(steps: WorkflowStep[]): WorkflowStep[][] {
	const batches: WorkflowStep[][] = [];
	let current: WorkflowStep[] = [];
	let kind: WorkflowStep['kind'] | undefined;
	const flush = () => {
		if (current.length > 0) {
			batches.push(current);
		}
		current = [];
		kind = undefined;
	};
	const stepAgent = (step: WorkflowStep): string => {
		if (step.kind === 'agent') {
			return step.id;
		}
		return TOOL_CATALOG.find((tool) => tool.id === step.id)?.agentId ?? step.id;
	};
	for (const step of steps) {
		if (
			step.kind === 'workflow'
			|| (step.kind === 'agent' && SEQUENTIAL_AGENTS.has(step.id))
			|| (step.kind === 'tool' && SEQUENTIAL_TOOLS.has(step.id))
		) {
			flush();
			batches.push([step]);
			continue;
		}
		if (kind && kind !== step.kind) {
			flush();
		}
		if (step.kind === 'tool' && current.some((item) => stepAgent(item) === stepAgent(step))) {
			flush();
		}
		kind = step.kind;
		current.push(step);
	}
	flush();
	return batches;
}

export function clipThreadEvidence(text: string, max = 4_000): string {
	const trimmed = text.replace(/\s+/g, ' ').trim();
	if (!trimmed) {
		return '';
	}
	return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/** Prefer a parameterized in-scope URL for bounded sqlmap; keep origin for ZAP. */
export function playbookStepUrl(toolId: string, target?: string, url?: string): string | undefined {
	const blob = `${url || ''} ${target || ''}`.trim();
	const ref = extractCanonicalTarget(blob);
	if (toolId === 'sqlmap-scan' && (ref?.lab === 'juice-shop' || (ref?.local && ref.port === 3000))) {
		return JUICE_SHOP_SEARCH_URL;
	}
	if (url?.trim()) {
		return url.trim();
	}
	return ref?.url || target?.trim() || undefined;
}

export function playbookSqlmapOptions(target?: string): { forms: boolean; level: number; risk: number } {
	const ref = extractCanonicalTarget(target || '');
	if (ref?.lab === 'juice-shop' || (ref?.local && ref.port === 3000)) {
		return { forms: true, level: 2, risk: 2 };
	}
	return { forms: true, level: 1, risk: 1 };
}

export function playbookWebOrigin(target?: string): string {
	const ref = extractCanonicalTarget(target || '');
	return ref?.url || ref?.display || JUICE_SHOP_URL;
}

export function engagementAgentPrompt(opts: {
	workflowId: string;
	agentId: string;
	target?: string;
	message?: string;
	filePath?: string;
	prior?: string;
}): string {
	const restoredTarget = restoreTargetPlaceholders(opts.target?.trim() || opts.message?.trim() || '');
	const canonical = extractCanonicalTarget(restoredTarget) || extractCanonicalTarget(`${opts.target || ''} ${opts.message || ''}`);
	const target = canonical?.display || restoredTarget || 'implied / local / workspace';
	const juice = canonical?.lab === 'juice-shop' || (canonical?.local && canonical.port === 3000);
	const prior = opts.prior?.trim()
		? `\n\nPrior phase evidence and thread history (cite; do not invent; do not rediscover the lab from scratch):\n${opts.prior.trim().slice(0, 12_000)}`
		: '';
	const pathNote = opts.filePath?.trim() ? `\nWorkspace path: ${opts.filePath.trim()}` : '';
	const brief = AGENT_BRIEFS[opts.agentId] || DEFAULT_AGENT_BRIEF;
	const juiceNote = juice
		? 'This target is OWASP Juice Shop at http://127.0.0.1:3000. Cite prior httpx/katana/browser/scrapling/nuclei output. Do not open owasp.org or call research-search / research-open / browser-search to rediscover it.'
		: '';
	return [
		`Playbook step: workflow ${opts.workflowId}, agent ${opts.agentId}.`,
		`Target / ask: ${target}.${pathNote}`,
		'127.0.0.1, localhost, and ::1 are real in-scope loopback addresses — not missing values. Use this Target URL exactly. Do not ask the operator for an IP.',
		'Do only this specialist’s work. Call only tools listed for this turn — never invent a tool name, including names with spaces. The runtime continues the next playbook phase after you return.',
		'Docs: delegate via agent-research only if a specific CVE/doc is missing from prior evidence. You do not have research-search, research-open, or browser-search unless those ids are in YOUR tool list.',
		juiceNote,
		brief,
		'Policy: authorized engagement. Detection via vuln-* agents; proof of impact via poc-* agents only (poc-request / poc-act / poc-xss-canary, in-scope, per-probe operator approval). No credential or cookie theft, no destructive SQL or DoS, no Metasploit exploit/session/payload runs.',
		'Record every claim with finding-record: hypothesis when detected (including version/unpatched stack from banners), confirmed only with reproduction steps + tool evidence, not-exploitable with proof-attempt evidence.',
		'If a tool image is stopped, call start_service for that agentId and retry (HITL).',
		'Mark claims unconfirmed unless tool output supports them.',
		prior,
	].filter(Boolean).join('\n');
}

/** Cohere (and similar) emit this as assistant text when they invent a tool title. */
export function isMissingToolHallucination(text: string): boolean {
	const t = text.trim();
	if (!t) {
		return false;
	}
	return /TOOL\s+["']?[^"'\n]+["']?\s+NOT FOUND/i.test(t)
		&& (/AVAILABLE TOOLS:/i.test(t) || /use agent-research/i.test(t) || /CALL TOOLS BY THEIR EXACT NAME/i.test(t));
}

/** Playbook agent replies must not become the final answer when the model invented a tool. */
export function sanitizePlaybookAgentOutput(text: string, agentId: string): string {
	const trimmed = (text || '').trim();
	if (!trimmed) {
		return '(empty)';
	}
	if (isMissingToolHallucination(trimmed)) {
		return `Skipped: ${agentId} requested a tool it does not have. Runtime continues the playbook.`;
	}
	return trimmed;
}

export function isEmptyPlaybookOutput(text: string): boolean {
	const trimmed = (text || '').replace(/^##\s+(?:agent:)?[^\n]+\n/, '').trim();
	return !trimmed || trimmed === '(empty)';
}

export const POC_PLAYBOOK_AGENTS = ['poc-injection', 'poc-xss', 'poc-ssrf', 'poc-auth'] as const;

export function isPocPlaybookAgent(id: string): boolean {
	return (POC_PLAYBOOK_AGENTS as readonly string[]).includes(id);
}

export interface ThisRunFacts {
	targetReady: boolean;
	httpxOk: boolean;
	katanaOk: boolean;
	naabuOk: boolean;
	scraplingOk: boolean;
	browserOk: boolean;
	nucleiOk: boolean;
	sqlmapRan: boolean;
	semgrepEmpty: boolean;
}

export function thisRunFacts(prior: string): ThisRunFacts {
	const text = prior || '';
	return {
		targetReady: /juice-shop-status[\s\S]{0,800}\bready\b/i.test(text) || /hw-juice-shop ready/i.test(text),
		httpxOk: /## httpx(?:-title|-tech)?\b[\s\S]{0,400}\[200\]/i.test(text) || /\bhttpx\b[\s\S]{0,200}\[200\]/.test(text),
		katanaOk: /## katana\b[\s\S]{0,400}https?:\/\//i.test(text),
		naabuOk: /## naabu(?:-top-ports)?\b[\s\S]{0,400}(open|Skipped:)/i.test(text),
		scraplingOk: /## scrapling-fetch\b[\s\S]{0,400}\b200\b/i.test(text),
		browserOk: /## browser-open\b[\s\S]{0,400}\b200\b/i.test(text),
		nucleiOk: /## nuclei(?:-tech|-severity-info)?\b/i.test(text),
		sqlmapRan: /## sqlmap-scan\b/i.test(text),
		semgrepEmpty: /no scannable source|empty workspace/i.test(text),
	};
}

export function reportingContradictsThisRun(text: string, prior: string): boolean {
	const facts = thisRunFacts(prior);
	const up = facts.targetReady || facts.httpxOk || facts.browserOk || facts.scraplingOk;
	if (up && /target unreachable|port 3000 filtered|critical blocker|host is down|could not reach/i.test(text)) {
		return true;
	}
	if ((facts.katanaOk || facts.naabuOk) && /missing (?:naabu|katana)|naabu\+katana|katana binary|naabu binary/i.test(text)) {
		return true;
	}
	if (facts.scraplingOk && /playwright missing|scrapling.*missing|missing scrapling/i.test(text)) {
		return true;
	}
	if (facts.browserOk && /browser timeout|browser (?:failed|missing)/i.test(text) && !/poc-xss-canary/.test(text)) {
		return true;
	}
	if (up && /nmap[\s\S]{0,200}(135|139|445)|windows smb/i.test(text)) {
		return true;
	}
	if (facts.semgrepEmpty && /engagement (?:failed|FAIL)|CRITICAL BLOCKER[\s\S]{0,80}semgrep/i.test(text)) {
		return true;
	}
	return false;
}

export function gateReportingNarrative(text: string, prior: string, table: string, exportNote: string): string {
	const trimmed = (text || '').trim();
	if (!reportingContradictsThisRun(trimmed, prior)) {
		return [table, exportNote, trimmed].filter(Boolean).join('\n\n');
	}
	return [
		table,
		exportNote,
		'The model narrative was omitted because it contradicted this turn\'s tool output (claimed the target was down or tools were missing). The findings table and Prior phase evidence are the record.',
	].filter(Boolean).join('\n\n');
}

export interface PocFallbackJob {
	toolId: string;
	url: string;
	method?: string;
	body?: string;
	payload?: string;
}

export function pocFallbackJob(agentId: string, target?: string): PocFallbackJob | undefined {
	const origin = playbookWebOrigin(target);
	if (agentId === 'poc-injection') {
		return {
			toolId: 'poc-request',
			url: `${origin.replace(/\/$/, '')}/rest/user/login`,
			method: 'POST',
			body: JSON.stringify({ email: 'test@local', password: 'test' }),
		};
	}
	if (agentId === 'poc-xss') {
		return {
			toolId: 'poc-xss-canary',
			url: `${origin}/#/search?q=test`,
			payload: '<img src=x onerror="window.__hwPocFired=1">',
		};
	}
	if (agentId === 'poc-auth') {
		return {
			toolId: 'poc-request',
			url: `${origin.replace(/\/$/, '')}/rest/admin`,
			method: 'GET',
		};
	}
	return undefined;
}

const DEFAULT_AGENT_BRIEF = 'Use only your tools. Return Markdown. Do not invent evidence.';

const AGENT_BRIEFS: Record<string, string> = {
	semgrep: [
		'You are the Semgrep (SAST) specialist. Scan ~/.hawaldar/workspace — never a live URL.',
		'Call semgrep-list if you need to see what is there, then semgrep-scan and/or semgrep-owasp.',
		'An empty workspace is a recorded gap, not a reason to ask for an IP or abort the engagement.',
		'Report rule id, file, line, and severity. No autofix exploits. No payload generation.',
	].join(' '),
	research: [
		'Playbook research is optional and must not block later phases.',
		'If prior evidence already identifies the app (e.g. Juice Shop at http://127.0.0.1:3000), cite it in one line and stop — do not open owasp.org.',
		'If the workspace is empty or SAST had no hits, write a one-line gap note and stop.',
		'Knowledge only. Do not scan hosts. Never generate exploits.',
	].join(' '),
	'vuln-injection': [
		'Injection class detection (SQLi, command injection, SSTI, LDAP — detect only).',
		'Nuclei-tech / nuclei-severity-info already ran as playbook tools. Cite that output plus recon URLs. Do not pick recon tools. Do not call research-search / research-open / browser-search.',
		'Docs via agent-research only when a specific CVE is missing from prior evidence.',
		'finding-record hypotheses (class=injection or ssti). No injection payloads.',
		'Empty workspace is a recorded gap, not a stop. For http://127.0.0.1:3000 hypothesize injection on GET /rest/products/search?q= and POST /rest/user/login from recon — still no payloads.',
	].join(' '),
	'vuln-xss': [
		'XSS class detection (reflected/stored/DOM — detect only).',
		'Cite prior nuclei + recon. Do not pick recon tools. Docs via agent-research only; never research-search / research-open / browser-search.',
		'finding-record (class=xss). No javascript: or XSS proofs.',
		'For Juice Shop, hypothesize reflected XSS on search (`q`) from recon.',
	].join(' '),
	'vuln-ssrf': [
		'SSRF and unsafe-URL-fetch detection only.',
		'Cite prior nuclei + recon. Docs via agent-research only; never research-search. No SSRF probes that hit attacker-controlled hosts.',
		'finding-record (class=ssrf). If recon was empty, record that gap.',
	].join(' '),
	'vuln-auth': [
		'Authentication and authorization detection only.',
		'Cite prior nuclei + recon (login surfaces). Docs via agent-research only; never research-search. No credential stuffing.',
		'finding-record (class=auth or idor).',
	].join(' '),
	'poc-injection': [
		'Prove injection-class hypotheses with bounded HITL probes. sqlmap-scan may already have run as a playbook tool — cite it; do not rerun unless it was skipped.',
		'finding-list (status=hypothesis, class=injection or ssti). If none, still run a bounded poc-request on the Target URL (Juice Shop: GET /rest/products/search?q=test and POST /rest/user/login). Do not skip this stage.',
		'Read-only proofs only: error-based, boolean, time-based (SLEEP ≤5s), SSTI arithmetic ({{7*7}} → 49). Each probe needs operator approval.',
		'finding-record: confirmed (steps + evidence) or not-exploitable (attempt evidence).',
	].join(' '),
	'poc-xss': [
		'Prove XSS-class hypotheses with poc-xss-canary (window.__hwPocFired). zap-ascan may already have run as a playbook tool — cite it.',
		'finding-list (status=hypothesis, class=xss). If none, still run one canary on Juice Shop search reflection. Do not skip this stage.',
		'No cookie/storage/network exfiltration. finding-record confirmed or not-exploitable.',
	].join(' '),
	'poc-ssrf': [
		'Prove SSRF hypotheses with in-scope poc-request only (target fetches itself). No third-party callbacks, no cloud metadata.',
		'If no SSRF hypothesis, record that gap with finding-record (unconfirmed) and stop — do not invent a probe.',
	].join(' '),
	'poc-auth': [
		'Prove auth/IDOR hypotheses with poc-request / poc-act (benign test user only).',
		'finding-list (class=auth or idor). If none, still try one bounded Juice Shop IDOR/auth check: open a protected route with no session, or register a test user via poc-act. Do not skip this stage.',
		'No credential guessing, no token theft. finding-record confirmed or not-exploitable.',
	].join(' '),
	validation: [
		'You are Validation for this engagement.',
		'Read the findings store with finding-list. Compare every claim to THIS TURN\'s Prior phase evidence and probe stdout only. Do not use RAG, knowledge-search, or older chats.',
		'Confirmed findings must quote the actual probe: method, URL (127.0.0.1 never [IP_ADDRESS]), status, truncated response body from poc-request / poc-act / poc-xss-canary / sqlmap / zap. "has evidence: true" is not evidence — downgrade to unconfirmed.',
		'If juice-shop-status is ready or httpx returned 200, the target is up. Empty workspace / Semgrep "no scannable source" is a GAP note, not a critical blocker, and does not fail the engagement.',
		'Do not request new probes; the PoC stage ran before you. Finish validation and hand off to reporting.',
	].join(' '),
	reporting: [
		'Write a SHORT engagement summary for a security team from THIS TURN only.',
		'Read findings with finding-list, then call finding-export. Return the saved path plus a findings table (title, class, status, target) and one line per confirmed/not-exploitable item citing the probe.',
		'Cite only Prior phase evidence in this prompt and finding-list. Forbidden: knowledge-search, RAG chat snippets, claiming the target is unreachable when juice-shop-status is ready or httpx is 200, claiming katana/naabu/scrapling/browser missing when this turn ran them, calling empty-workspace Semgrep a CRITICAL BLOCKER that voids the rest of the engagement.',
		'Semgrep "no scannable source" is expected for a live Juice Shop URL — record it as a gap. Confirmed findings must quote method + 127.0.0.1 URL + status + body snippet, never "has evidence: true".',
		'Do not invent missing tools. Do not mix older failed chats into this report.',
	].join(' '),
};
