import { USER_DECLINED } from '../hitl-gate';
import type { FindingRecord, FindingRequest } from '../findings-store';

export const RETEST_TOOLS = ['poc-request', 'poc-act', 'poc-xss-canary', 'sqlmap-scan'] as const;
export type RetestToolId = (typeof RETEST_TOOLS)[number];

export type RetestVerdict = 'fixed' | 'still-open' | 'aborted';

export interface RetestEvaluation {
	verdict: RetestVerdict;
	reason: string;
}

export interface ProbeRunResult {
	ok: boolean;
	stdout?: string;
	stderr?: string;
	exitCode?: number;
}

/** executeTool's inferred return includes HITL `unknown`; retest only needs stdout/stderr/ok. */
export function asProbeRunResult(value: unknown): ProbeRunResult {
	if (!value || typeof value !== 'object') {
		return { ok: false, stdout: '', stderr: 'Retest probe returned no result.', exitCode: 1 };
	}
	const rec = value as Record<string, unknown>;
	return {
		ok: rec.ok === true,
		stdout: typeof rec.stdout === 'string' ? rec.stdout : '',
		stderr: typeof rec.stderr === 'string' ? rec.stderr : '',
		exitCode: typeof rec.exitCode === 'number' ? rec.exitCode : (rec.ok === true ? 0 : 1),
	};
}

const BLOCKED_TOOLS = /^(msf|msfvenom|metasploit|payload)/i;

/** Replay only a stored poc-request / poc-act / poc-xss-canary / sqlmap-scan. Never invent a probe. */
export function resolveRetestTool(finding: FindingRecord): RetestToolId | undefined {
	const stored = finding.request?.tool?.trim() || '';
	if (BLOCKED_TOOLS.test(stored)) {
		return undefined;
	}
	if ((RETEST_TOOLS as readonly string[]).includes(stored)) {
		return stored as RetestToolId;
	}
	if (finding.request?.payload && finding.request.url) {
		return 'poc-xss-canary';
	}
	if (finding.request?.actions && finding.request.actions.length > 0 && finding.request.url) {
		return 'poc-act';
	}
	if (finding.request?.url || finding.target) {
		return 'poc-request';
	}
	return undefined;
}

export function retestToolInput(finding: FindingRecord): {
	url?: string;
	target?: string;
	method?: string;
	body?: string;
	payload?: string;
	actions?: FindingRequest['actions'];
} | undefined {
	const tool = resolveRetestTool(finding);
	if (!tool) {
		return undefined;
	}
	const req = finding.request || {};
	const url = req.url || finding.target;
	if (!url) {
		return undefined;
	}
	if (tool === 'poc-xss-canary' && !req.payload) {
		return undefined;
	}
	if (tool === 'poc-act' && (!req.actions || req.actions.length === 0)) {
		return undefined;
	}
	return {
		url,
		target: url,
		method: req.method,
		body: req.body,
		payload: req.payload,
		actions: req.actions,
	};
}

export function evaluateRetest(
	finding: FindingRecord,
	result: ProbeRunResult,
): RetestEvaluation {
	const stdout = String(result.stdout || '');
	const stderr = String(result.stderr || '');
	if (stderr.includes(USER_DECLINED) || /operator declined|approval declined/i.test(stderr)) {
		return { verdict: 'aborted', reason: 'Operator declined the retest probe.' };
	}
	if (!stdout.trim() && !result.ok) {
		return { verdict: 'aborted', reason: stderr.trim() || 'Retest probe did not run.' };
	}
	const tool = resolveRetestTool(finding) || finding.request?.tool || '';
	if (tool === 'poc-xss-canary') {
		const fired = parseCanaryFired(stdout);
		if (fired === false) {
			return { verdict: 'fixed', reason: 'XSS canary did not fire on retest.' };
		}
		if (fired === true) {
			return { verdict: 'still-open', reason: 'XSS canary still fired.' };
		}
	}
	if (tool === 'sqlmap-scan') {
		const injectable = parseSqlmapInjectable(stdout);
		if (injectable === false) {
			return { verdict: 'fixed', reason: 'sqlmap no longer reports the parameter as injectable.' };
		}
		if (injectable === true) {
			return { verdict: 'still-open', reason: 'sqlmap still reports the target as injectable.' };
		}
	}
	const retestStatus = parseHttpStatus(stdout);
	const originalStatus = finding.request?.status;
	if (finding.vulnClass === 'auth' && retestStatus != null && (retestStatus === 401 || retestStatus === 403)) {
		return { verdict: 'fixed', reason: `Auth surface now returns ${retestStatus}.` };
	}
	if (originalStatus != null && originalStatus >= 200 && originalStatus < 300 && retestStatus != null && retestStatus >= 400) {
		return { verdict: 'fixed', reason: `Probe returned ${retestStatus} (was ${originalStatus}).` };
	}
	if (/authentication["']?\s*:\s*true/i.test(finding.evidence + JSON.stringify(finding.request))
		&& /authentication["']?\s*:\s*false/i.test(stdout)) {
		return { verdict: 'fixed', reason: 'Authentication token is no longer granted.' };
	}
	if (retestStatus != null && retestStatus >= 200 && retestStatus < 300) {
		return { verdict: 'still-open', reason: `Probe still returned ${retestStatus}.` };
	}
	if (result.ok && stdout.trim()) {
		return { verdict: 'still-open', reason: 'Retest completed; stored PoC still produced a successful probe.' };
	}
	return { verdict: 'aborted', reason: stderr.trim() || 'Could not judge the retest from the probe output.' };
}

export function appendRetestEvidence(existing: string, stdout: string, verdict: RetestVerdict): string {
	const block = [
		existing.trim(),
		'',
		`--- retest ${new Date().toISOString()} (${verdict}) ---`,
		stdout.trim().slice(0, 6_000),
	].filter((line, index, all) => !(line === '' && index === 0) && !(line === '' && all[index - 1] === '')).join('\n');
	return block.slice(0, 8_000);
}

export function mergeRetestRequest(previous: FindingRequest, stdout: string): FindingRequest {
	const status = parseHttpStatus(stdout);
	const next = { ...previous };
	if (status != null) {
		next.status = status;
	}
	if (stdout.trim()) {
		next.response = stdout.trim().slice(0, 2_000);
	}
	return next;
}

function parseHttpStatus(text: string): number | undefined {
	const json = /"status"\s*:\s*(\d{3})/.exec(text);
	if (json) {
		return Number(json[1]);
	}
	const line = /(?:status|HTTP\/\d(?:\.\d)?)\s+(\d{3})/i.exec(text);
	if (line) {
		return Number(line[1]);
	}
	return undefined;
}

function parseCanaryFired(text: string): boolean | undefined {
	const fired = /"fired"\s*:\s*(\d+)/.exec(text);
	if (fired) {
		return Number(fired[1]) > 0;
	}
	if (/"ok"\s*:\s*false/.test(text) && /canary|__hwPocFired/i.test(text)) {
		return false;
	}
	return undefined;
}

function parseSqlmapInjectable(text: string): boolean | undefined {
	if (/Injectable:\s*YES/i.test(text) || /parameter '[^']+' is .* injectable/i.test(text) || /is vulnerable/i.test(text)) {
		return true;
	}
	if (/Injectable:\s*no\b/i.test(text) || /does not seem to be injectable/i.test(text) || /all tested parameters do not appear to be injectable/i.test(text)) {
		return false;
	}
	return undefined;
}
