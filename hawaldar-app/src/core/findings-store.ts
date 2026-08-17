import { createClient, type Client, type Row } from '@libsql/client';
import { dataHomePaths, ensureDataHome, slugifyName, sqliteFileUrl, uniqueSlug } from './data-home';

export type FindingClass =
	| 'injection'
	| 'xss'
	| 'ssrf'
	| 'auth'
	| 'csrf'
	| 'ssti'
	| 'idor'
	| 'other';

export type FindingSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export type FindingStatus = 'hypothesis' | 'validating' | 'confirmed' | 'unconfirmed' | 'not-exploitable';

export interface FindingRecord {
	id: string;
	title: string;
	vulnClass: FindingClass;
	severity: FindingSeverity;
	status: FindingStatus;
	target: string;
	description: string;
	/** Numbered reproduction steps (the PoC). */
	steps: string[];
	/** Tool evidence that backs the claim (status codes, excerpts, SAST locations). */
	evidence: string;
	impact: string;
	remediation: string;
	references: string[];
	/** Agent id that recorded or last updated the finding. */
	source: string;
	sessionId: string;
	createdAt: number;
	updatedAt: number;
}

export interface FindingWrite {
	id?: string;
	title?: string;
	vulnClass?: FindingClass;
	severity?: FindingSeverity;
	status?: FindingStatus;
	target?: string;
	description?: string;
	steps?: string[];
	evidence?: string;
	impact?: string;
	remediation?: string;
	references?: string[];
	source?: string;
	sessionId?: string;
}

export interface FindingFilter {
	status?: FindingStatus;
	vulnClass?: FindingClass;
	query?: string;
	limit?: number;
}

export const FINDING_CLASSES: FindingClass[] = ['injection', 'xss', 'ssrf', 'auth', 'csrf', 'ssti', 'idor', 'other'];
export const FINDING_SEVERITIES: FindingSeverity[] = ['critical', 'high', 'medium', 'low', 'info'];
export const FINDING_STATUSES: FindingStatus[] = ['hypothesis', 'validating', 'confirmed', 'unconfirmed', 'not-exploitable'];

const ID_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const CAPS = {
	title: 200,
	description: 4_000,
	steps: 20,
	step: 500,
	evidence: 8_000,
	impact: 2_000,
	remediation: 2_000,
	references: 10,
	reference: 500,
	target: 300,
};

type ChangeListener = () => void;

function clip(value: string, max: number): string {
	return value.length > max ? `${value.slice(0, max)}…` : value;
}

function cleanText(value: unknown, max: number): string {
	return clip(String(value ?? '').trim(), max);
}

function cleanSteps(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value
		.map((item) => cleanText(item, CAPS.step))
		.filter(Boolean)
		.slice(0, CAPS.steps);
}

function cleanReferences(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value
		.map((item) => cleanText(item, CAPS.reference))
		.filter(Boolean)
		.slice(0, CAPS.references);
}

export function normalizeFindingClass(value: unknown): FindingClass {
	const raw = String(value ?? '').trim().toLowerCase();
	return (FINDING_CLASSES as string[]).includes(raw) ? raw as FindingClass : 'other';
}

export function normalizeFindingSeverity(value: unknown): FindingSeverity {
	const raw = String(value ?? '').trim().toLowerCase();
	return (FINDING_SEVERITIES as string[]).includes(raw) ? raw as FindingSeverity : 'medium';
}

export function normalizeFindingStatus(value: unknown): FindingStatus {
	const raw = String(value ?? '').trim().toLowerCase();
	return (FINDING_STATUSES as string[]).includes(raw) ? raw as FindingStatus : 'hypothesis';
}

export class FindingsStore {
	readonly databasePath: string;
	readonly ready: Promise<void>;
	private client: Client;
	private listeners = new Set<ChangeListener>();

	constructor(dataDir: string) {
		ensureDataHome(dataDir);
		this.databasePath = dataHomePaths(dataDir).findingsDb;
		this.client = createClient({ url: sqliteFileUrl(this.databasePath) });
		this.ready = this.init();
	}

	onChange(listener: ChangeListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private notify(): void {
		for (const listener of this.listeners) {
			listener();
		}
	}

	async list(filter: FindingFilter = {}): Promise<FindingRecord[]> {
		await this.ready;
		const rs = await this.client.execute(`
			SELECT id, title, class, severity, status, target, description, steps, evidence,
				impact, remediation, refs, source, session_id, created_at, updated_at
			FROM findings
			ORDER BY updated_at DESC
		`);
		let rows = rs.rows.map(mapFinding);
		if (filter.status) {
			rows = rows.filter((row) => row.status === filter.status);
		}
		if (filter.vulnClass) {
			rows = rows.filter((row) => row.vulnClass === filter.vulnClass);
		}
		if (filter.query?.trim()) {
			const q = filter.query.trim().toLowerCase();
			rows = rows.filter((row) => (
				row.title.toLowerCase().includes(q)
				|| row.target.toLowerCase().includes(q)
				|| row.description.toLowerCase().includes(q)
			));
		}
		const limit = Math.max(1, Math.min(filter.limit ?? 500, 1_000));
		return rows.slice(0, limit);
	}

	async get(id: string): Promise<FindingRecord | undefined> {
		await this.ready;
		if (!ID_RE.test(id)) {
			return undefined;
		}
		const rs = await this.client.execute({
			sql: `SELECT id, title, class, severity, status, target, description, steps, evidence,
					impact, remediation, refs, source, session_id, created_at, updated_at
				FROM findings WHERE id = ?`,
			args: [id],
		});
		const row = rs.rows[0];
		return row ? mapFinding(row) : undefined;
	}

	/**
	 * Insert or update a finding. Without `id`, a natural key (class + title + target)
	 * dedupes re-runs of the same engagement. `confirmed` requires repro steps and evidence —
	 * the store is the enforcement point for "no invented PoCs".
	 */
	async upsert(draft: FindingWrite): Promise<FindingRecord> {
		await this.ready;
		const existing = draft.id
			? await this.get(draft.id)
			: await this.findByNaturalKey(draft);
		const title = cleanText(draft.title ?? existing?.title, CAPS.title);
		if (!title) {
			throw new Error('Finding title is required.');
		}
		const vulnClass = draft.vulnClass ? normalizeFindingClass(draft.vulnClass) : (existing?.vulnClass ?? 'other');
		const severity = draft.severity ? normalizeFindingSeverity(draft.severity) : (existing?.severity ?? 'medium');
		const status = draft.status ? normalizeFindingStatus(draft.status) : (existing?.status ?? 'hypothesis');
		const steps = draft.steps !== undefined ? cleanSteps(draft.steps) : (existing?.steps ?? []);
		const evidence = draft.evidence !== undefined
			? cleanText(draft.evidence, CAPS.evidence)
			: (existing?.evidence ?? '');
		if (status === 'confirmed' && (steps.length === 0 || !evidence)) {
			throw new Error('A confirmed finding needs reproduction steps and tool evidence. Mark it unconfirmed instead.');
		}
		if (status === 'not-exploitable' && !evidence && !existing?.evidence) {
			throw new Error('A not-exploitable finding needs evidence of the failed proof attempt.');
		}
		const now = Date.now();
		const id = existing?.id || uniqueSlug(slugifyName(title, 'finding'), await this.ids());
		if (!ID_RE.test(id)) {
			throw new Error('Finding id must be a lowercase slug.');
		}
		const record: FindingRecord = {
			id,
			title,
			vulnClass,
			severity,
			status,
			target: cleanText(draft.target ?? existing?.target, CAPS.target),
			description: cleanText(draft.description ?? existing?.description, CAPS.description),
			steps,
			evidence,
			impact: cleanText(draft.impact ?? existing?.impact, CAPS.impact),
			remediation: cleanText(draft.remediation ?? existing?.remediation, CAPS.remediation),
			references: draft.references !== undefined ? cleanReferences(draft.references) : (existing?.references ?? []),
			source: cleanText(draft.source ?? existing?.source, 80),
			sessionId: String(draft.sessionId ?? existing?.sessionId ?? ''),
			createdAt: existing?.createdAt ?? now,
			updatedAt: now,
		};
		await this.client.execute({
			sql: `INSERT INTO findings (id, title, class, severity, status, target, description, steps, evidence,
					impact, remediation, refs, source, session_id, created_at, updated_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(id) DO UPDATE SET title = excluded.title, class = excluded.class,
					severity = excluded.severity, status = excluded.status, target = excluded.target,
					description = excluded.description, steps = excluded.steps, evidence = excluded.evidence,
					impact = excluded.impact, remediation = excluded.remediation, refs = excluded.refs,
					source = excluded.source, session_id = excluded.session_id, updated_at = excluded.updated_at`,
			args: [
				record.id, record.title, record.vulnClass, record.severity, record.status, record.target,
				record.description, JSON.stringify(record.steps), record.evidence, record.impact,
				record.remediation, JSON.stringify(record.references), record.source, record.sessionId,
				record.createdAt, record.updatedAt,
			],
		});
		this.notify();
		return record;
	}

	async remove(id: string): Promise<void> {
		await this.ready;
		if (!ID_RE.test(id)) {
			return;
		}
		await this.client.execute({ sql: 'DELETE FROM findings WHERE id = ?', args: [id] });
		this.notify();
	}

	async clear(): Promise<number> {
		await this.ready;
		const rs = await this.client.execute('SELECT COUNT(*) AS n FROM findings');
		await this.client.execute('DELETE FROM findings');
		this.notify();
		return Number(rs.rows[0]?.n) || 0;
	}

	async counts(): Promise<{ total: number; confirmed: number; bySeverity: Record<string, number>; byStatus: Record<string, number> }> {
		const rows = await this.list();
		const bySeverity: Record<string, number> = {};
		const byStatus: Record<string, number> = {};
		for (const row of rows) {
			bySeverity[row.severity] = (bySeverity[row.severity] ?? 0) + 1;
			byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
		}
		return { total: rows.length, confirmed: byStatus.confirmed ?? 0, bySeverity, byStatus };
	}

	private async findByNaturalKey(draft: FindingWrite): Promise<FindingRecord | undefined> {
		const title = cleanText(draft.title, CAPS.title);
		if (!title) {
			return undefined;
		}
		const vulnClass = normalizeFindingClass(draft.vulnClass);
		const target = cleanText(draft.target, CAPS.target);
		const rs = await this.client.execute({
			sql: 'SELECT id FROM findings WHERE class = ? AND target = ? AND lower(title) = lower(?)',
			args: [vulnClass, target, title],
		});
		const row = rs.rows[0];
		return row ? this.get(String(row.id)) : undefined;
	}

	private async ids(): Promise<string[]> {
		const rs = await this.client.execute('SELECT id FROM findings');
		return rs.rows.map((row) => String(row.id));
	}

	private async init(): Promise<void> {
		await this.client.execute(`
			CREATE TABLE IF NOT EXISTS findings (
				id TEXT PRIMARY KEY,
				title TEXT NOT NULL,
				class TEXT NOT NULL DEFAULT 'other',
				severity TEXT NOT NULL DEFAULT 'medium',
				status TEXT NOT NULL DEFAULT 'hypothesis',
				target TEXT NOT NULL DEFAULT '',
				description TEXT NOT NULL DEFAULT '',
				steps TEXT NOT NULL DEFAULT '[]',
				evidence TEXT NOT NULL DEFAULT '',
				impact TEXT NOT NULL DEFAULT '',
				remediation TEXT NOT NULL DEFAULT '',
				refs TEXT NOT NULL DEFAULT '[]',
				source TEXT NOT NULL DEFAULT '',
				session_id TEXT NOT NULL DEFAULT '',
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			);
		`);
		await this.client.execute('CREATE INDEX IF NOT EXISTS idx_findings_status ON findings(status)');
		await this.client.execute('CREATE INDEX IF NOT EXISTS idx_findings_class ON findings(class)');
	}
}

function mapFinding(row: Row): FindingRecord {
	return {
		id: String(row.id),
		title: String(row.title ?? ''),
		vulnClass: normalizeFindingClass(row.class),
		severity: normalizeFindingSeverity(row.severity),
		status: normalizeFindingStatus(row.status),
		target: String(row.target ?? ''),
		description: String(row.description ?? ''),
		steps: parseJsonList(row.steps),
		evidence: String(row.evidence ?? ''),
		impact: String(row.impact ?? ''),
		remediation: String(row.remediation ?? ''),
		references: parseJsonList(row.refs),
		source: String(row.source ?? ''),
		sessionId: String(row.session_id ?? ''),
		createdAt: Number(row.created_at) || 0,
		updatedAt: Number(row.updated_at) || 0,
	};
}

function parseJsonList(raw: unknown): string[] {
	try {
		const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
		return Array.isArray(parsed) ? parsed.map((item) => String(item)).filter(Boolean) : [];
	} catch {
		return [];
	}
}
