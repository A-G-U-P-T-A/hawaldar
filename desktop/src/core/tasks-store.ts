import { createClient, type Client } from '@libsql/client';
import { dataHomePaths, ensureDataHome, slugifyName, sqliteFileUrl, uniqueSlug } from './data-home';

export type TaskStatus = 'open' | 'doing' | 'done';

export interface TaskRecord {
	id: string;
	title: string;
	status: TaskStatus;
	notes: string;
	createdAt: number;
	updatedAt: number;
	order: number;
}

export interface TaskWrite {
	id?: string;
	title?: string;
	status?: TaskStatus;
	notes?: string;
	order?: number;
}

const ID_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const STATUSES = new Set<TaskStatus>(['open', 'doing', 'done']);

export class TaskStore {
	readonly databasePath: string;
	readonly ready: Promise<void>;
	private client: Client;

	constructor(dataDir: string) {
		const home = ensureDataHome(dataDir);
		this.databasePath = dataHomePaths(dataDir).tasksDb;
		this.client = createClient({ url: sqliteFileUrl(this.databasePath) });
		this.ready = this.init();
	}

	async list(): Promise<TaskRecord[]> {
		await this.ready;
		const rs = await this.client.execute(
			'SELECT id, title, status, notes, createdAt, updatedAt, "order" AS sortOrder FROM tasks ORDER BY "order" ASC, createdAt ASC',
		);
		return rs.rows.map((row) => ({
			id: String(row.id),
			title: String(row.title),
			status: normalizeStatus(row.status),
			notes: String(row.notes ?? ''),
			createdAt: Number(row.createdAt) || 0,
			updatedAt: Number(row.updatedAt) || 0,
			order: Number(row.sortOrder) || 0,
		}));
	}

	async upsert(draft: TaskWrite): Promise<TaskRecord> {
		await this.ready;
		const existing = draft.id ? await this.find(draft.id) : undefined;
		const title = (draft.title ?? existing?.title ?? '').trim();
		if (!title) {
			throw new Error('Task title is required.');
		}
		if (title.length > 200) {
			throw new Error('Task title is too long.');
		}
		const status = normalizeStatus(draft.status ?? existing?.status ?? 'open');
		const notes = draft.notes !== undefined ? String(draft.notes) : (existing?.notes ?? '');
		const now = Date.now();
		const id = existing?.id || uniqueSlug(slugifyName(title, 'task'), await this.ids());
		if (!ID_RE.test(id)) {
			throw new Error('Task id must be a lowercase slug.');
		}
		const order = draft.order ?? existing?.order ?? await this.nextOrder();
		const createdAt = existing?.createdAt ?? now;
		await this.client.execute({
			sql: `INSERT INTO tasks (id, title, status, notes, createdAt, updatedAt, "order")
				VALUES (?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(id) DO UPDATE SET title = excluded.title, status = excluded.status,
					notes = excluded.notes, updatedAt = excluded.updatedAt, "order" = excluded."order"`,
			args: [id, title, status, notes, createdAt, now, order],
		});
		return (await this.find(id))!;
	}

	async setStatus(id: string, status: TaskStatus): Promise<TaskRecord> {
		return this.upsert({ id, status: normalizeStatus(status) });
	}

	async remove(id: string): Promise<void> {
		await this.ready;
		if (!ID_RE.test(id)) {
			return;
		}
		await this.client.execute({ sql: 'DELETE FROM tasks WHERE id = ?', args: [id] });
	}

	private async init(): Promise<void> {
		await this.client.execute(`
			CREATE TABLE IF NOT EXISTS tasks (
				id TEXT PRIMARY KEY,
				title TEXT NOT NULL,
				status TEXT NOT NULL DEFAULT 'open',
				notes TEXT NOT NULL DEFAULT '',
				createdAt INTEGER NOT NULL,
				updatedAt INTEGER NOT NULL,
				"order" INTEGER NOT NULL DEFAULT 0
			);
		`);
	}

	private async find(id: string): Promise<TaskRecord | undefined> {
		if (!ID_RE.test(id)) {
			return undefined;
		}
		const rs = await this.client.execute({
			sql: 'SELECT id, title, status, notes, createdAt, updatedAt, "order" AS sortOrder FROM tasks WHERE id = ?',
			args: [id],
		});
		const row = rs.rows[0];
		return row
			? {
				id: String(row.id),
				title: String(row.title),
				status: normalizeStatus(row.status),
				notes: String(row.notes ?? ''),
				createdAt: Number(row.createdAt) || 0,
				updatedAt: Number(row.updatedAt) || 0,
				order: Number(row.sortOrder) || 0,
			}
			: undefined;
	}

	private async ids(): Promise<string[]> {
		const rs = await this.client.execute('SELECT id FROM tasks');
		return rs.rows.map((row) => String(row.id));
	}

	private async nextOrder(): Promise<number> {
		const rs = await this.client.execute('SELECT MAX("order") AS maxOrder FROM tasks');
		return (Number(rs.rows[0]?.maxOrder) || 0) + 1;
	}
}

function normalizeStatus(value: unknown): TaskStatus {
	return STATUSES.has(value as TaskStatus) ? value as TaskStatus : 'open';
}
