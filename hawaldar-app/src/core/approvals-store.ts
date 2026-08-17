import { createClient, type Client } from '@libsql/client';
import { dataHomePaths, ensureDataHome, sqliteFileUrl } from './data-home';

/**
 * Remembered HITL approvals. Only `podman` (existing-machine start) and
 * `tool-image` (catalog service / agent id) are stored. `poc-probe` and
 * other per-run destructive kinds must never land here.
 */
export type RememberedHitlKind = 'podman' | 'tool-image';

/** Stable subject for starting an existing Podman machine (never install/create). */
export const PODMAN_MACHINE_SUBJECT = 'machine';

export interface ApprovalRecord {
	kind: RememberedHitlKind;
	subject: string;
	approvedAt: number;
	lastUsed: number;
}

const KIND_SET = new Set<RememberedHitlKind>(['podman', 'tool-image']);
const SUBJECT_RE = /^[a-zA-Z0-9._:/-]{1,128}$/;

function normalizeKind(value: unknown): RememberedHitlKind | undefined {
	const raw = String(value ?? '').trim();
	return KIND_SET.has(raw as RememberedHitlKind) ? raw as RememberedHitlKind : undefined;
}

function normalizeSubject(value: unknown): string | undefined {
	const raw = String(value ?? '').trim();
	return SUBJECT_RE.test(raw) ? raw : undefined;
}

export class ApprovalsStore {
	readonly databasePath: string;
	readonly ready: Promise<void>;
	private client: Client;

	constructor(dataDir: string) {
		ensureDataHome(dataDir);
		this.databasePath = dataHomePaths(dataDir).approvalsDb;
		this.client = createClient({ url: sqliteFileUrl(this.databasePath) });
		this.ready = this.init();
	}

	async has(kind: RememberedHitlKind, subject: string): Promise<boolean> {
		await this.ready;
		const k = normalizeKind(kind);
		const s = normalizeSubject(subject);
		if (!k || !s) {
			return false;
		}
		const rs = await this.client.execute({
			sql: 'SELECT kind FROM approvals WHERE kind = ? AND subject = ? LIMIT 1',
			args: [k, s],
		});
		return Boolean(rs.rows[0]);
	}

	/** Insert or refresh last_used. Declines are never written. */
	async remember(kind: RememberedHitlKind, subject: string): Promise<void> {
		await this.ready;
		const k = normalizeKind(kind);
		const s = normalizeSubject(subject);
		if (!k || !s) {
			return;
		}
		const now = Date.now();
		await this.client.execute({
			sql: `INSERT INTO approvals (kind, subject, approved_at, last_used)
				VALUES (?, ?, ?, ?)
				ON CONFLICT(kind, subject) DO UPDATE SET last_used = excluded.last_used`,
			args: [k, s, now, now],
		});
	}

	async clear(): Promise<number> {
		await this.ready;
		const rs = await this.client.execute('SELECT COUNT(*) AS n FROM approvals');
		await this.client.execute('DELETE FROM approvals');
		return Number(rs.rows[0]?.n) || 0;
	}

	async count(): Promise<number> {
		await this.ready;
		const rs = await this.client.execute('SELECT COUNT(*) AS n FROM approvals');
		return Number(rs.rows[0]?.n) || 0;
	}

	private async init(): Promise<void> {
		await this.client.execute(`
			CREATE TABLE IF NOT EXISTS approvals (
				kind TEXT NOT NULL,
				subject TEXT NOT NULL,
				approved_at INTEGER NOT NULL,
				last_used INTEGER NOT NULL,
				PRIMARY KEY (kind, subject)
			);
		`);
	}
}
