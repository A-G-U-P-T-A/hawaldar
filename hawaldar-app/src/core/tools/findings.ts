import * as fs from 'node:fs';
import * as path from 'node:path';
import { uniqueSlug, slugifyName } from '../data-home';
import { buildEngagementPdfDocument, formatPdfChatTitle, renderPdfLite, type PdfFindingInput } from '../pdf-lite';
import {
	FINDING_CLASSES,
	FINDING_SEVERITIES,
	FINDING_STATUSES,
	type FindingRecord,
	type FindingRequest,
	type FindingsStore,
	normalizeFindingClass,
	normalizeFindingSeverity,
	normalizeFindingStatus,
} from '../findings-store';
import type { ReportsStore } from '../reports-store';
import { ensureWorkspace, WORKSPACE_DISPLAY_PATH, workspaceHostPath } from '../sandbox/workspace';
import { restoreTargetPlaceholders } from '../policy';
import { currentToolContext, lastMatchingProbe } from '../tool-context';
import {
	evidenceHasToolSnippet,
	evidenceLooksResearchOnly,
	formatFindingsChatTable,
	parseRequestFromEvidence,
	reportFileSlug,
	type FindingRequestShape,
} from '../tool-args';

export const FINDING_TOOL_IDS = ['finding-record', 'finding-list', 'finding-export'] as const;

export function isFindingTool(id: string): boolean {
	return (FINDING_TOOL_IDS as readonly string[]).includes(id);
}

/** Mastra inputSchema for finding tools. Uses the runtime `z` instance. */
export function buildFindingInputSchema(z: any, id: string) {
	if (id === 'finding-record') {
		return z.object({
			id: z.string().optional().describe('Existing finding id to update. Omit to create (class+title+target+session dedupes re-runs).'),
			title: z.string().describe('Short finding title, e.g. "Authentication bypass via direct dashboard access".'),
			class: z.string().optional().describe('Alias for vulnClass. Prefer vulnClass.'),
			vulnClass: z.enum(FINDING_CLASSES as [string, ...string[]]).optional()
				.describe('injection | xss | ssrf | auth | csrf | ssti | idor | version | other'),
			severity: z.enum(FINDING_SEVERITIES as [string, ...string[]]).optional()
				.describe('critical | high | medium | low | info. Do not inflate.'),
			status: z.enum(FINDING_STATUSES as [string, ...string[]]).optional()
				.describe('hypothesis → validating → confirmed | unconfirmed | not-exploitable | informed | fixed. confirmed requires steps + evidence.'),
			target: z.string().optional().describe('Host or URL the finding applies to.'),
			description: z.string().optional(),
			steps: z.union([z.array(z.string()), z.string(), z.number()]).optional()
				.describe('Reproduction steps as string[]. A number (count from finding-list) is ignored.'),
			evidence: z.union([z.string(), z.record(z.unknown()), z.array(z.unknown())]).optional()
				.describe('Tool evidence: probe stdout (poc-request/poc-act/sqlmap/zap), status codes, canary markers, SAST locations (required for confirmed). Never "has evidence: true".'),
			method: z.string().optional().describe('HTTP method of the probe that proved this finding (GET/POST/…).'),
			url: z.string().optional().describe('Exact probe URL with 127.0.0.1, never [IP_ADDRESS].'),
			body: z.union([z.string(), z.record(z.unknown())]).optional().describe('Probe request body if POST/PUT/PATCH.'),
			impact: z.string().optional(),
			remediation: z.string().optional(),
			references: z.array(z.string()).optional(),
		});
	}
	if (id === 'finding-list') {
		return z.object({
			status: z.enum(FINDING_STATUSES as [string, ...string[]]).optional(),
			vulnClass: z.enum(FINDING_CLASSES as [string, ...string[]]).optional(),
			query: z.string().optional(),
			sessionId: z.string().optional(),
			runId: z.string().optional(),
			target: z.string().optional().describe('Website URL, host, or IP:port'),
			limit: z.number().optional(),
		});
	}
	return z.object({
		title: z.string().optional().describe('Report title. Default: Engagement report.'),
		target: z.string().optional().describe('Engagement target shown in the report header.'),
		sessionId: z.string().optional(),
		runId: z.string().optional(),
	});
}

export async function runFindingTool(
	store: FindingsStore,
	id: string,
	input: Record<string, unknown>,
	extra?: {
		sessionId?: string;
		runId?: string;
		source?: string;
		reports?: ReportsStore;
		chatTitle?: string;
	},
) {
	try {
		if (id === 'finding-record') {
			// Model args may carry the provider's [IP_ADDRESS] token; findings store real addresses.
			const restore = (value: string) => restoreTargetPlaceholders(value, currentToolContext()?.impliedTargets ?? []);
			let status = input.status !== undefined ? normalizeFindingStatus(input.status) : undefined;
			let evidence = typeof input.evidence === 'string' ? restore(input.evidence) : undefined;
			let steps = Array.isArray(input.steps) ? input.steps.map((item) => restore(String(item))) : undefined;
			let request = requestFromInput(input, restore);
			if (status === 'confirmed') {
				const gated = gateConfirmedFinding({ evidence, steps, request, vulnClass: input.vulnClass });
				status = gated.status;
				evidence = gated.evidence;
				steps = gated.steps;
				request = gated.request;
				if (gated.downgraded) {
					console.warn('[hawaldar] finding-record: confirmed without tool-output snippet — downgraded to unconfirmed');
				}
			}
			const record = await store.upsert({
				id: typeof input.id === 'string' && input.id.trim() ? input.id.trim() : undefined,
				title: typeof input.title === 'string' ? restore(input.title) : undefined,
				vulnClass: input.vulnClass !== undefined ? normalizeFindingClass(input.vulnClass) : undefined,
				severity: input.severity !== undefined ? normalizeFindingSeverity(input.severity) : undefined,
				status,
				target: typeof input.target === 'string' ? restore(input.target) : undefined,
				description: typeof input.description === 'string' ? restore(input.description) : undefined,
				steps,
				evidence,
				request,
				impact: typeof input.impact === 'string' ? restore(input.impact) : undefined,
				remediation: typeof input.remediation === 'string' ? restore(input.remediation) : undefined,
				references: Array.isArray(input.references) ? input.references.map((item) => restore(String(item))) : undefined,
				source: extra?.source,
				sessionId: extra?.sessionId,
				runId: extra?.runId,
			});
			return ok({
				saved: true,
				id: record.id,
				title: record.title,
				class: record.vulnClass,
				severity: record.severity,
				status: record.status,
				downgraded: status === 'unconfirmed' && input.status === 'confirmed',
			});
		}
		if (id === 'finding-list') {
			const rows = await store.list({
				status: input.status !== undefined ? normalizeFindingStatus(input.status) : undefined,
				vulnClass: input.vulnClass !== undefined ? normalizeFindingClass(input.vulnClass) : undefined,
				query: typeof input.query === 'string' ? input.query : undefined,
				sessionId: typeof input.sessionId === 'string' ? input.sessionId : undefined,
				runId: typeof input.runId === 'string' ? input.runId : undefined,
				target: typeof input.target === 'string' ? input.target : undefined,
				limit: typeof input.limit === 'number' ? input.limit : undefined,
			});
			const counts = await store.counts();
			return ok({
				total: counts.total,
				confirmed: counts.confirmed,
				bySeverity: counts.bySeverity,
				byStatus: counts.byStatus,
				findings: rows.map((row) => ({
					id: row.id,
					title: row.title,
					class: row.vulnClass,
					severity: row.severity,
					status: row.status,
					target: row.target,
					sessionId: row.sessionId,
					runId: row.runId,
					reportId: row.reportId,
					stepCount: row.steps.length,
					hasEvidence: Boolean(row.evidence),
					updatedAt: row.updatedAt,
				})),
			});
		}
		if (id === 'finding-export') {
			const implied = currentToolContext()?.impliedTargets ?? [];
			const target = restoreTargetPlaceholders(
				typeof input.target === 'string' ? input.target.trim() : (implied[0] || ''),
				implied,
			);
			const title = typeof input.title === 'string' && input.title.trim() ? input.title.trim() : 'Engagement report';
			const sessionId = typeof input.sessionId === 'string' && input.sessionId.trim()
				? input.sessionId.trim()
				: extra?.sessionId;
			const runId = typeof input.runId === 'string' && input.runId.trim()
				? input.runId.trim()
				: extra?.runId;
			const findings = await store.list({
				sessionId,
				runId: typeof input.runId === 'string' ? input.runId : undefined,
				target: target || undefined,
			});
			const saved = await persistFindingsPdf({
				store,
				reports: extra?.reports,
				findings,
				title,
				target,
				sessionId: sessionId || '',
				chatTitle: extra?.chatTitle || '',
				runId: runId || '',
				query: target,
				implied,
			});
			const table = formatFindingsChatTable(findings);
			return ok({ ...saved, findings: findings.length, table });
		}
		return fail(`Unknown tool: ${id}`);
	} catch (error) {
		return fail(error instanceof Error ? error.message : String(error));
	}
}

const SEVERITY_ORDER: FindingRecord['severity'][] = ['critical', 'high', 'medium', 'low', 'info'];

export function renderFindingsReport(
	findings: FindingRecord[],
	meta: { title: string; target: string },
): string {
	const confirmed = findings.filter((row) => row.status === 'confirmed' || row.status === 'informed');
	const fixed = findings.filter((row) => row.status === 'fixed');
	const notExploitable = findings.filter((row) => row.status === 'not-exploitable');
	const open = findings.filter((row) => row.status === 'hypothesis' || row.status === 'validating' || row.status === 'unconfirmed');
	const bySeverity = new Map<string, number>();
	for (const row of confirmed) {
		bySeverity.set(row.severity, (bySeverity.get(row.severity) ?? 0) + 1);
	}
	const when = new Date();
	const lines: string[] = [
		`# ${meta.title}`,
		'',
		`- Generated: ${when.toISOString()} (Hawaldar)`,
		meta.target ? `- Target: ${meta.target}` : '- Target: see engagement scope',
		'- Scope: authorized engagement only. Proofs ran in the Podman sandbox with operator approval.',
		'',
		'## Summary',
		'',
		`- Confirmed / informed: **${confirmed.length}**`,
		fixed.length ? `- Fixed (retest no longer reproduces): ${fixed.length}` : '',
		`- Not exploitable (attempted, evidence attached): ${notExploitable.length}`,
		`- Open hypotheses / unconfirmed: ${open.length}`,
	];
	if (confirmed.length > 0) {
		lines.push('', '| Severity | Count |', '| --- | --- |');
		for (const severity of SEVERITY_ORDER) {
			const count = bySeverity.get(severity) ?? 0;
			if (count > 0) {
				lines.push(`| ${severity.toUpperCase()} | ${count} |`);
			}
		}
	}
	if (confirmed.length > 0) {
		lines.push('', '## Confirmed findings', '');
		const sorted = [...confirmed].sort(
			(a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity),
		);
		sorted.forEach((row, index) => {
			lines.push(...renderFinding(row, index + 1));
		});
	}
	if (fixed.length > 0) {
		lines.push('', '## Fixed (retest)', '');
		for (const row of fixed) {
			lines.push(`- **${row.title}** (${row.vulnClass}${row.target ? `, ${row.target}` : ''}) — ${summarize(row.evidence)}`);
		}
	}
	if (notExploitable.length > 0) {
		lines.push('', '## Attempted, not exploitable', '');
		for (const row of notExploitable) {
			lines.push(`- **${row.title}** (${row.vulnClass}${row.target ? `, ${row.target}` : ''}) — ${summarize(row.evidence)}`);
		}
	}
	if (open.length > 0) {
		lines.push('', '## Open hypotheses (unconfirmed)', '');
		for (const row of open) {
			lines.push(`- **${row.title}** (${row.vulnClass}${row.target ? `, ${row.target}` : ''}) — ${summarize(row.description || row.evidence)}`);
		}
	}
	lines.push(
		'',
		'## Notes',
		'',
		'- Every confirmed finding above ships reproduction steps and the tool evidence collected during the run.',
		'- Re-test after remediation: replay the stored poc-request / poc-act / poc-xss-canary / sqlmap-scan (HITL). If it no longer proves the issue, mark the finding fixed.',
		'',
	);
	return lines.join('\n');
}

function renderFinding(row: FindingRecord, index: number): string[] {
	const lines: string[] = [
		`### ${index}. [${row.severity.toUpperCase()}] ${row.title}`,
		'',
		`- Class: ${row.vulnClass}`,
		row.target ? `- Affected: ${row.target}` : '',
		row.sessionId ? `- Chat: ${row.sessionId}` : '',
		row.reportId ? `- Report: ${row.reportId}` : '',
		row.description ? `\n${row.description}` : '',
		'',
		'**Reproduction (PoC):**',
		'',
		...row.steps.map((step, stepIndex) => `${stepIndex + 1}. ${step}`),
		'',
		'**Evidence:**',
		'',
		'```',
		row.evidence,
		'```',
	];
	if (row.request?.method || row.request?.url) {
		lines.push('', '**Request:**', '', '```', formatRequestBlock(row.request), '```');
	}
	if (row.impact) {
		lines.push('', `**Impact:** ${row.impact}`);
	}
	if (row.remediation) {
		lines.push('', `**Remediation:** ${row.remediation}`);
	}
	if (row.references.length > 0) {
		lines.push('', '**References:**', ...row.references.map((ref) => `- ${ref}`));
	}
	lines.push('');
	return lines.filter((line) => line !== '');
}

function summarize(text: string): string {
	const flat = text.replace(/\s+/g, ' ').trim();
	return flat.length > 180 ? `${flat.slice(0, 180)}…` : flat || 'no notes';
}

export async function persistFindingsPdf(opts: {
	store: FindingsStore;
	reports?: ReportsStore;
	findings: FindingRecord[];
	title: string;
	target: string;
	sessionId: string;
	chatTitle: string;
	runId: string;
	query?: string;
	implied?: readonly string[];
}): Promise<{ id: string; title: string; path: string; displayPath: string; findings: number }> {
	const implied = opts.implied ?? [];
	const reportId = uniqueReportId(opts.title);
	const chatTitle = formatPdfChatTitle(opts.chatTitle, opts.sessionId);
	const target = restoreTargetPlaceholders(opts.target || '', implied);
	const document = buildEngagementPdfDocument(
		opts.findings.map((row) => toPdfFinding(row, implied)),
		{
			title: opts.title,
			chatTitle,
			sessionId: opts.sessionId,
			reportId,
			target,
			runId: opts.runId,
			generatedAt: new Date(),
		},
	);
	const bytes = renderPdfLite({
		title: opts.title,
		subject: 'Authorized engagement report',
		watermark: 'HAWALDAR',
		footer: 'Generated by Hawaldar. Not for unaffiliated redistribution as original work.',
		document,
	});
	const saved = saveReportPdf(bytes, target, implied);
	if (opts.reports) {
		await opts.reports.insert({
			id: reportId,
			title: opts.title,
			target: target,
			sessionId: opts.sessionId,
			chatTitle,
			runId: opts.runId,
			filePath: saved.path,
			findingIds: opts.findings.map((row) => row.id),
			query: opts.query || opts.target,
		});
	}
	await opts.store.markReportIds(opts.findings.map((row) => row.id), reportId);
	return { id: reportId, title: opts.title, ...saved, findings: opts.findings.length };
}

export function saveReportPdf(
	bytes: Uint8Array,
	target: string,
	implied: readonly string[] = [],
): { path: string; displayPath: string } {
	ensureWorkspace();
	const dir = path.join(workspaceHostPath(), 'reports');
	fs.mkdirSync(dir, { recursive: true });
	const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
	const slug = reportFileSlug(target, implied);
	const filePath = path.join(dir, `${stamp}-${slug}.pdf`);
	fs.writeFileSync(filePath, Buffer.from(bytes));
	return {
		path: filePath,
		displayPath: `${WORKSPACE_DISPLAY_PATH}/reports/${path.basename(filePath)}`,
	};
}

/** @deprecated PDF is the operator deliverable; kept for tests that still import the name. */
export function saveReportArtifact(
	markdown: string,
	target: string,
	implied: readonly string[] = [],
): { path: string; displayPath: string } {
	const bytes = renderPdfLite({
		title: 'Engagement report',
		watermark: 'HAWALDAR',
		footer: 'Generated by Hawaldar. Not for unaffiliated redistribution as original work.',
		body: markdown,
	});
	return saveReportPdf(bytes, target, implied);
}

function uniqueReportId(_title: string): string {
	const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
	return uniqueSlug(slugifyName(`rpt-${stamp}`, 'rpt'), []);
}

function toPdfFinding(row: FindingRecord, implied: readonly string[]): PdfFindingInput {
	const restore = (value: string) => restoreTargetPlaceholders(value, implied);
	return {
		title: restore(row.title),
		severity: row.severity,
		vulnClass: row.vulnClass,
		status: row.status,
		target: restore(row.target || ''),
		description: restore(row.description || ''),
		steps: row.steps.map((step) => restore(step)),
		evidence: restore(row.evidence || ''),
		request: row.request
			? {
				...row.request,
				url: row.request.url ? restore(row.request.url) : row.request.url,
				body: row.request.body ? restore(row.request.body) : row.request.body,
				response: row.request.response ? restore(row.request.response) : row.request.response,
			}
			: undefined,
		impact: restore(row.impact || ''),
		remediation: restore(row.remediation || ''),
		references: row.references.map((item) => restore(item)),
	};
}

function gateConfirmedFinding(opts: {
	evidence?: string;
	steps?: string[];
	request?: FindingRequest;
	vulnClass?: unknown;
}): { status: 'confirmed' | 'unconfirmed'; evidence: string; steps: string[]; request: FindingRequest; downgraded: boolean } {
	let evidence = opts.evidence || '';
	let steps = opts.steps ? [...opts.steps] : [];
	let request = { ...(opts.request || {}) };
	const probe = lastMatchingProbe({ classHint: typeof opts.vulnClass === 'string' ? opts.vulnClass : undefined });
	if (probe && (!evidenceHasToolSnippet(evidence) || !request.url)) {
		if (!evidenceHasToolSnippet(evidence)) {
			evidence = [evidence, probe.stdout].filter(Boolean).join('\n\n').slice(0, 8_000);
		}
		if (!request.method && probe.method) {
			request.method = probe.method;
		}
		if (!request.url && probe.url) {
			request.url = probe.url;
		}
		if (!request.body && probe.body) {
			request.body = probe.body;
		}
		if (request.status == null && probe.status != null) {
			request.status = probe.status;
		}
		if (!request.response) {
			request.response = probe.stdout.slice(0, 2_000);
		}
		if (!request.tool) {
			request.tool = probe.tool;
		}
		if (!request.payload && probe.payload) {
			request.payload = probe.payload;
		}
		if (!request.actions && probe.actions) {
			request.actions = probe.actions;
		}
		if (steps.length === 0 && probe.method && probe.url) {
			steps = [`${probe.method} ${probe.url}`];
		}
	}
	const parsed = parseRequestFromEvidence(evidence);
	if (parsed) {
		request = { ...parsed, ...request };
	}
	const hasSnippet = evidenceHasToolSnippet(evidence);
	const researchOnly = evidenceLooksResearchOnly(evidence);
	if (!hasSnippet || researchOnly) {
		return { status: 'unconfirmed', evidence, steps, request, downgraded: true };
	}
	return { status: 'confirmed', evidence, steps, request, downgraded: false };
}

function requestFromInput(input: Record<string, unknown>, restore: (value: string) => string): FindingRequest | undefined {
	const method = typeof input.method === 'string' ? input.method.trim().toUpperCase() : undefined;
	const url = typeof input.url === 'string' ? restore(input.url) : undefined;
	const body = typeof input.body === 'string'
		? restore(input.body)
		: (input.body && typeof input.body === 'object' ? JSON.stringify(input.body) : undefined);
	const payload = typeof input.payload === 'string' ? restore(input.payload) : undefined;
	const actions = Array.isArray(input.actions)
		? input.actions as FindingRequest['actions']
		: undefined;
	if (!method && !url && !body && !payload && !actions) {
		return undefined;
	}
	return { method, url, body, payload, actions, tool: payload ? 'poc-xss-canary' : actions ? 'poc-act' : 'poc-request' };
}

function formatRequestBlock(request: FindingRequestShape): string {
	const lines = [
		[request.method, request.url].filter(Boolean).join(' ') || request.url || '',
		request.status != null ? `status ${request.status}` : '',
		request.body ? `body ${request.body}` : '',
		request.response ? `response ${request.response}` : '',
	].filter(Boolean);
	return lines.join('\n');
}

function ok(payload: Record<string, unknown>) {
	return { ok: true, stdout: JSON.stringify(payload, null, 2), stderr: '', exitCode: 0 };
}

function fail(stderr: string) {
	return { ok: false, stdout: '', stderr, exitCode: 1 };
}
