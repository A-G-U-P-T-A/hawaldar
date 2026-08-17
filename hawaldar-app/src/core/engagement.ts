import { extractCanonicalTarget, restoreTargetPlaceholders, skipReasonForTool } from './policy';
import type { WorkflowStep } from './playbook-store';

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

/** Real exploit tooling stays refused. The sanctioned PoC stage (poc-validate, poc-* agents) is allowed. */
const EXPLOIT_STEP = /(?:^|[-_/])(exploit|payload|msfvenom|msfconsole|sqlmap|burp-?intruder|metasploit-exploit)(?:$|[-_/])/i;

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

/** Drop DNS/subdomain steps on loopback web labs; prepend juice-shop-status when that lab is the target. */
export function adaptWorkflowSteps(workflowId: string, steps: WorkflowStep[], target?: string): WorkflowStep[] {
	const ref = extractCanonicalTarget(target || '');
	if (workflowId !== 'recon-surface' || !ref?.local) {
		return steps;
	}
	const filtered = steps.filter((step) => !skipReasonForTool(step.id, target));
	if (ref.lab === 'juice-shop' && !filtered.some((step) => step.id === 'juice-shop-status')) {
		return [{ kind: 'tool', id: 'juice-shop-status' }, ...filtered];
	}
	return filtered;
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
	const prior = opts.prior?.trim()
		? `\n\nPrior phase evidence (cite; do not invent):\n${opts.prior.trim().slice(0, 12_000)}`
		: '';
	const pathNote = opts.filePath?.trim() ? `\nWorkspace path: ${opts.filePath.trim()}` : '';
	const brief = AGENT_BRIEFS[opts.agentId] || DEFAULT_AGENT_BRIEF;
	return [
		`Engagement workflow: ${opts.workflowId}.`,
		`Target / ask: ${target}.${pathNote}`,
		'127.0.0.1, localhost, and ::1 are real in-scope loopback addresses — not missing values. Use this Target URL exactly. Do not ask the operator for an IP.',
		brief,
		'Policy: authorized engagement. Detection via vuln-* agents; proof of impact via poc-* agents only (poc-request / poc-act / poc-xss-canary, in-scope, per-probe operator approval). No credential or cookie theft, no destructive SQL or DoS, no Metasploit exploit/session/payload runs.',
		'Record every claim with finding-record: hypothesis when detected, confirmed only with reproduction steps + tool evidence, not-exploitable with proof-attempt evidence.',
		'If a tool image is stopped, call start_service for that agentId and retry (HITL).',
		'Mark claims unconfirmed unless tool output supports them.',
		prior,
	].join('\n');
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
		'Look up public docs, CVE/advisory summaries, and framework notes for findings already in evidence.',
		'Knowledge only. Do not scan hosts unless asked. Never generate exploits.',
		'The Target URL is authoritative. 127.0.0.1 is a real loopback address — do not ask the operator for an IP.',
	].join(' '),
	'vuln-injection': [
		'Injection class detection (SQLi, command injection, SSTI, LDAP — detect only).',
		'Use semgrep-scan / semgrep-owasp, nuclei-severity-info / nuclei-tech (info/low only), and research.',
		'Cite SAST locations, nuclei info/tech hits, and URLs/params from recon. No injection payloads.',
		'Use the Target URL as-is (including http://127.0.0.1:3000). Do not ask for an IP. If recon was empty or skipped, record that gap — do not invent hosts.',
	].join(' '),
	'vuln-xss': [
		'XSS class detection (reflected/stored/DOM — detect only).',
		'Use semgrep-scan / semgrep-owasp, nuclei info/tech/low, and research.',
		'Cite sinks (innerHTML, unescaped templates) and recon URLs. No javascript: or XSS proofs.',
		'Use the Target URL as-is (including http://127.0.0.1:3000). Do not ask for an IP. If recon was empty or skipped, record that gap — do not invent hosts.',
	].join(' '),
	'vuln-ssrf': [
		'SSRF and unsafe-URL-fetch detection only.',
		'Use SAST + nuclei info/tech/low + research. Cite outbound-fetch sinks and recon endpoints. No SSRF probes that hit attacker-controlled hosts.',
		'Use the Target URL as-is. Do not ask for an IP. If recon was empty, record that gap.',
	].join(' '),
	'vuln-auth': [
		'Authentication and authorization detection only (session, JWT handling, missing checks in source, exposed login surfaces from recon).',
		'Use SAST + nuclei info/tech/low + research. No credential stuffing, no session hijack PoCs.',
		'Use the Target URL as-is. Do not ask for an IP. If recon was empty, record that gap.',
	].join(' '),
	'poc-injection': [
		'You prove injection-class hypotheses (SQLi, command injection, SSTI) with bounded probes.',
		'Read hypotheses with finding-list (status=hypothesis, class=injection or ssti). Design the smallest read-only proof: error-based (syntax break → DB/SLT error in response), boolean (true/false content diff), time-based (SLEEP ≤5s), SSTI arithmetic ({{7*7}} → 49).',
		'Execute with poc-request only. Each probe needs operator approval — keep probes few and meaningful.',
		'Update each finding with finding-record: confirmed (steps + evidence) or not-exploitable (attempt evidence). Never mark confirmed without a probe that actually ran.',
	].join(' '),
	'poc-xss': [
		'You prove XSS-class hypotheses with a contained canary.',
		'Read hypotheses with finding-list (status=hypothesis, class=xss). For each reflected candidate from recon, craft a canary that sets window.__hwPocFired (e.g. an img onerror marker) and run poc-xss-canary.',
		'Cookie/storage access and any network exfiltration are refused by the tool — prove execution only.',
		'Update each finding with finding-record: confirmed when fired > 0 or the payload executes in DOM context (steps + evidence), else not-exploitable with the attempt output.',
	].join(' '),
	'poc-ssrf': [
		'You prove SSRF hypotheses with in-scope evidence only.',
		'Read hypotheses with finding-list (status=hypothesis, class=ssrf). Proof shape: point the vulnerable parameter at a URL on the target itself (or an explicitly in-scope host) and show the server fetched it (response content, status, or timing differences).',
		'No third-party callback hosts, no cloud metadata (169.254.0.0/16), no port sweeps. Use poc-request.',
		'Update each finding with finding-record: confirmed (steps + evidence) or not-exploitable (attempt evidence).',
	].join(' '),
	'poc-auth': [
		'You prove authentication/authorization hypotheses (auth bypass, missing checks, IDOR) with contained browser flows.',
		'Read hypotheses with finding-list (status=hypothesis, class=auth or idor). Proofs: open a protected route with no session (poc-request GET → 200 with protected content), or register a benign test user and reach protected functionality (poc-act: fill → submit → goto protected → extract).',
		'State changes stay benign (test records only). No credential guessing, no session-token theft, no deleting or modifying existing data.',
		'Update each finding with finding-record: confirmed (numbered steps + evidence: status codes, page excerpts) or not-exploitable (attempt evidence).',
	].join(' '),
	validation: [
		'You are Validation for this engagement.',
		'Read the findings store with finding-list. Compare every claim to tool evidence: hosts, ports, DNS, URLs, SAST locations, nuclei info/tech/low, and PoC probe output (status codes, excerpts, canary markers).',
		'Confirmed findings must carry reproduction steps and evidence — downgrade to unconfirmed with finding-record when they do not. Hypotheses the PoC stage never attempted stay unconfirmed.',
		'Do not request new probes; the PoC stage ran before you. Finish validation and hand off to reporting.',
	].join(' '),
	reporting: [
		'Write the Markdown engagement report for a security team.',
		'Read findings with finding-list, then call finding-export to save the full report artifact under ~/.hawaldar/workspace/reports. Return the saved path plus a narrative summary.',
		'Sections: Scope and target, Pre-recon (SAST), Attack surface, Vuln-class detections, PoC validation results (proved vs not exploitable), Confirmed findings with reproduction steps, Gaps, Recommended next authorized steps (hardening / code review).',
		'Evidence is the findings store + tool output. Do not inflate severity.',
	].join(' '),
};
