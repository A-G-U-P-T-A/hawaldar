import { createClient, type Client, type Row } from '@libsql/client';
import * as fs from 'node:fs';
import { dataHomePaths, ensureDataHome, slugifyName, sqliteFileUrl, uniqueSlug } from './data-home';
import { targetsMatch } from './findings-store';

export interface ReportRecord {
	id: string;
	title: string;
	target: string;
	sessionId: string;
	chatTitle: string;
	runId: string;
	filePath: string;
	findingIds: string[];
	query: string;
	createdAt: number;
}

export interface ReportWrite {
	id?: string;
	title: string;
	target?: string;
	sessionId?: string;
	chatTitle?: string;
	runId?: string;
	filePath: string;
	findingIds?: string[];
	query?: string;
}

export interface ReportFilter {
	query?: string;
	target?: string;
	sessionId?: string;
}

const ID_RE = /^[a-z][a-z0-9_-]{0,63}$/;

export class ReportsStore {
	readonly databasePath: string;
	readonly ready: Promise<void>;
	private client: Client;
	private listeners = new Set<() => void>();

	constructor(dataDir: string) {
		ensureDataHome(dataDir);
		this.databasePath = dataHomePaths(dataDir).findingsDb;
		this.client = createClient({ url: sqliteFileUrl(this.databasePath) });
		this.ready = this.init();
	}

	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private notify(): void {
		for (const listener of this.listeners) {
			listener();
		}
	}

	async list(filter: ReportFilter = {}): Promise<ReportRecord[]> {
		await this.ready;
		const rs = await this.client.execute(
			`SELECT id, title, target, session_id, chat_title, run_id, file_path, finding_ids, query, created_at
			 FROM reports ORDER BY created_at DESC`,
		);
		let rows = rs.rows.map(mapReport);
		if (filter.sessionId !== undefined) {
			rows = rows.filter((row) => row.sessionId === filter.sessionId);
		}
		if (filter.target?.trim()) {
			const want = filter.target.trim();
			rows = rows.filter((row) => targetsMatch(row.target, want) || row.target.toLowerCase().includes(want.toLowerCase()));
		}
		if (filter.query?.trim()) {
			const q = filter.query.trim().toLowerCase();
			rows = rows.filter((row) => (
				row.title.toLowerCase().includes(q)
				|| row.target.toLowerCase().includes(q)
				|| row.chatTitle.toLowerCase().includes(q)
				|| row.sessionId.toLowerCase().includes(q)
				|| row.id.toLowerCase().includes(q)
				|| row.query.toLowerCase().includes(q)
			));
		}
		return rows;
	}

	async get(id: string): Promise<ReportRecord | undefined> {
		await this.ready;
		if (!ID_RE.test(id)) {
			return undefined;
		}
		const rs = await this.client.execute({
			sql: `SELECT id, title, target, session_id, chat_title, run_id, file_path, finding_ids, query, created_at
				FROM reports WHERE id = ?`,
			args: [id],
		});
		const row = rs.rows[0];
		return row ? mapReport(row) : undefined;
	}

	async insert(draft: ReportWrite): Promise<ReportRecord> {
		await this.ready;
		const title = String(draft.title || '').trim() || 'Engagement report';
		const id = draft.id && ID_RE.test(draft.id)
			? draft.id
			: uniqueSlug(slugifyName(title, 'rpt'), await this.ids());
		if (!ID_RE.test(id)) {
			throw new Error('Report id must be a lowercase slug.');
		}
		const now = Date.now();
		const record: ReportRecord = {
			id,
			title: title.slice(0, 200),
			target: String(draft.target || '').trim().slice(0, 300),
			sessionId: String(draft.sessionId || ''),
			chatTitle: String(draft.chatTitle || '').trim().slice(0, 200),
			runId: String(draft.runId || ''),
			filePath: String(draft.filePath || ''),
			findingIds: Array.isArray(draft.findingIds) ? draft.findingIds.filter((item) => ID_RE.test(item)) : [],
			query: String(draft.query || '').trim().slice(0, 300),
			createdAt: now,
		};
		await this.client.execute({
			sql: `INSERT INTO reports (id, title, target, session_id, chat_title, run_id, file_path, finding_ids, query, created_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			args: [
				record.id, record.title, record.target, record.sessionId, record.chatTitle, record.runId,
				record.filePath, JSON.stringify(record.findingIds), record.query, record.createdAt,
			],
		});
		this.notify();
		return record;
	}

	async readBytes(id: string): Promise<Uint8Array> {
		const row = await this.get(id);
		if (!row) {
			throw new Error(`Unknown report: ${id}`);
		}
		if (!row.filePath || !fs.existsSync(row.filePath)) {
			throw new Error('Report file is missing from disk.');
		}
		return new Uint8Array(fs.readFileSync(row.filePath));
	}

	async remove(id: string): Promise<void> {
		await this.ready;
		const row = await this.get(id);
		if (!row) {
			return;
		}
		if (row.filePath && fs.existsSync(row.filePath)) {
			try {
				fs.unlinkSync(row.filePath);
			} catch {
				/* still drop the row */
			}
		}
		await this.client.execute({ sql: 'DELETE FROM reports WHERE id = ?', args: [row.id] });
		this.notify();
	}

	private async ids(): Promise<string[]> {
		const rs = await this.client.execute('SELECT id FROM reports');
		return rs.rows.map((row) => String(row.id));
	}

	private async init(): Promise<void> {
		await this.client.execute(`
			CREATE TABLE IF NOT EXISTS reports (
				id TEXT PRIMARY KEY,
				title TEXT NOT NULL,
				target TEXT NOT NULL DEFAULT '',
				session_id TEXT NOT NULL DEFAULT '',
				chat_title TEXT NOT NULL DEFAULT '',
				run_id TEXT NOT NULL DEFAULT '',
				file_path TEXT NOT NULL DEFAULT '',
				finding_ids TEXT NOT NULL DEFAULT '[]',
				query TEXT NOT NULL DEFAULT '',
				created_at INTEGER NOT NULL
			)
		`);
		await this.client.execute('CREATE INDEX IF NOT EXISTS idx_reports_session ON reports(session_id)');
		await this.client.execute('CREATE INDEX IF NOT EXISTS idx_reports_created ON reports(created_at)');
	}
}

function mapReport(row: Row): ReportRecord {
	return {
		id: String(row.id),
		title: String(row.title ?? ''),
		target: String(row.target ?? ''),
		sessionId: String(row.session_id ?? ''),
		chatTitle: String(row.chat_title ?? ''),
		runId: String(row.run_id ?? ''),
		filePath: String(row.file_path ?? ''),
		findingIds: parseIds(row.finding_ids),
		query: String(row.query ?? ''),
		createdAt: Number(row.created_at) || 0,
	};
}

function parseIds(raw: unknown): string[] {
	try {
		const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
		return Array.isArray(parsed) ? parsed.map((item) => String(item)).filter(Boolean) : [];
	} catch {
		return [];
	}
}
