import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	FINDING_CLASSES,
	FINDING_SEVERITIES,
	FINDING_STATUSES,
	type FindingRecord,
	type FindingsStore,
	normalizeFindingClass,
	normalizeFindingSeverity,
	normalizeFindingStatus,
} from '../findings-store';
import { ensureWorkspace, WORKSPACE_DISPLAY_PATH, workspaceHostPath } from '../sandbox/workspace';

export const FINDING_TOOL_IDS = ['finding-record', 'finding-list', 'finding-export'] as const;

export function isFindingTool(id: string): boolean {
	return (FINDING_TOOL_IDS as readonly string[]).includes(id);
}

/** Mastra inputSchema for finding tools. Uses the runtime `z` instance. */
export function buildFindingInputSchema(z: any, id: string) {
	if (id === 'finding-record') {
		return z.object({
			id: z.string().optional().describe('Existing finding id to update. Omit to create (class+title+target dedupes re-runs).'),
			title: z.string().describe('Short finding title, e.g. "Authentication bypass via direct dashboard access".'),
			vulnClass: z.enum(FINDING_CLASSES as [string, ...string[]]).optional()
				.describe('injection | xss | ssrf | auth | csrf | ssti | idor | other'),
			severity: z.enum(FINDING_SEVERITIES as [string, ...string[]]).optional()
				.describe('critical | high | medium | low | info. Do not inflate.'),
			status: z.enum(FINDING_STATUSES as [string, ...string[]]).optional()
				.describe('hypothesis → validating → confirmed | unconfirmed | not-exploitable. confirmed requires steps + evidence.'),
			target: z.string().optional().describe('Host or URL the finding applies to.'),
			description: z.string().optional(),
			steps: z.array(z.string()).optional().describe('Numbered reproduction steps (required for confirmed).'),
			evidence: z.string().optional().describe('Tool evidence: status codes, response excerpts, SAST locations (required for confirmed).'),
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
			limit: z.number().optional(),
		});
	}
	return z.object({
		title: z.string().optional().describe('Report title. Default: Engagement report.'),
		target: z.string().optional().describe('Engagement target shown in the report header.'),
	});
}

export async function runFindingTool(
	store: FindingsStore,
	id: string,
	input: Record<string, unknown>,
	extra?: { sessionId?: string; source?: string },
) {
	try {
		if (id === 'finding-record') {
			const record = await store.upsert({
				id: typeof input.id === 'string' && input.id.trim() ? input.id.trim() : undefined,
				title: typeof input.title === 'string' ? input.title : undefined,
				vulnClass: input.vulnClass !== undefined ? normalizeFindingClass(input.vulnClass) : undefined,
				severity: input.severity !== undefined ? normalizeFindingSeverity(input.severity) : undefined,
				status: input.status !== undefined ? normalizeFindingStatus(input.status) : undefined,
				target: typeof input.target === 'string' ? input.target : undefined,
				description: typeof input.description === 'string' ? input.description : undefined,
				steps: Array.isArray(input.steps) ? input.steps.map((item) => String(item)) : undefined,
				evidence: typeof input.evidence === 'string' ? input.evidence : undefined,
				impact: typeof input.impact === 'string' ? input.impact : undefined,
				remediation: typeof input.remediation === 'string' ? input.remediation : undefined,
				references: Array.isArray(input.references) ? input.references.map((item) => String(item)) : undefined,
				source: extra?.source,
				sessionId: extra?.sessionId,
			});
			return ok({
				saved: true,
				id: record.id,
				title: record.title,
				class: record.vulnClass,
				severity: record.severity,
				status: record.status,
			});
		}
		if (id === 'finding-list') {
			const rows = await store.list({
				status: input.status !== undefined ? normalizeFindingStatus(input.status) : undefined,
				vulnClass: input.vulnClass !== undefined ? normalizeFindingClass(input.vulnClass) : undefined,
				query: typeof input.query === 'string' ? input.query : undefined,
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
					steps: row.steps.length,
					hasEvidence: Boolean(row.evidence),
					updatedAt: row.updatedAt,
				})),
			});
		}
		if (id === 'finding-export') {
			const target = typeof input.target === 'string' ? input.target.trim() : '';
			const title = typeof input.title === 'string' && input.title.trim() ? input.title.trim() : 'Engagement report';
			const findings = await store.list();
			const markdown = renderFindingsReport(findings, { title, target });
			const saved = saveReportArtifact(markdown, target);
			return ok({ ...saved, findings: findings.length });
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
	const confirmed = findings.filter((row) => row.status === 'confirmed');
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
		`- Confirmed vulnerabilities: **${confirmed.length}**`,
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
		'- Re-test after remediation: re-run the matching playbook and confirm the finding flips to not-exploitable.',
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

export function saveReportArtifact(markdown: string, target: string): { path: string; displayPath: string } {
	ensureWorkspace();
	const dir = path.join(workspaceHostPath(), 'reports');
	fs.mkdirSync(dir, { recursive: true });
	const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
	const slug = (target.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'engagement').slice(0, 60);
	const filePath = path.join(dir, `${stamp}-${slug}.md`);
	fs.writeFileSync(filePath, markdown, 'utf8');
	return {
		path: filePath,
		displayPath: `${WORKSPACE_DISPLAY_PATH}/reports/${path.basename(filePath)}`,
	};
}

function ok(payload: Record<string, unknown>) {
	return { ok: true, stdout: JSON.stringify(payload, null, 2), stderr: '', exitCode: 0 };
}

function fail(stderr: string) {
	return { ok: false, stdout: '', stderr, exitCode: 1 };
}
