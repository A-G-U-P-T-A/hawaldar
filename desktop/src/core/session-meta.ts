import { createClient, type Client } from '@libsql/client';
import { dataHomePaths, ensureDataHome, sqliteFileUrl } from './data-home';

export interface SessionMeta {
	id: string;
	title: string;
	pinned: boolean;
	updatedAt: number;
}

export class SessionMetaStore {
	readonly databasePath: string;
	readonly ready: Promise<void>;
	private client: Client;

	constructor(dataDir: string) {
		ensureDataHome(dataDir);
		this.databasePath = dataHomePaths(dataDir).hawaldarDb;
		this.client = createClient({ url: sqliteFileUrl(this.databasePath) });
		this.ready = this.init();
	}

	async list(): Promise<SessionMeta[]> {
		await this.ready;
		const rs = await this.client.execute(
			'SELECT id, title, pinned, updatedAt FROM session_meta',
		);
		return rs.rows.map((row) => parseSessionMeta(row as Record<string, unknown>)).filter((row): row is SessionMeta => Boolean(row));
	}

	async get(id: string): Promise<SessionMeta | undefined> {
		await this.ready;
		const key = id.trim();
		if (!key) {
			return undefined;
		}
		const rs = await this.client.execute({
			sql: 'SELECT id, title, pinned, updatedAt FROM session_meta WHERE id = ?',
			args: [key],
		});
		return parseSessionMeta(rs.rows[0] as Record<string, unknown> | undefined);
	}

	async upsert(input: { id: string; title?: string; pinned?: boolean }): Promise<SessionMeta | undefined> {
		const id = input.id.trim();
		if (!id) {
			return undefined;
		}
		await this.ready;
		const current = await this.get(id);
		const title = (input.title ?? current?.title ?? '').trim();
		const pinned = input.pinned ?? current?.pinned ?? false;
		const record: SessionMeta = {
			id,
			title,
			pinned,
			updatedAt: Date.now(),
		};
		await this.client.execute({
			sql: `INSERT INTO session_meta (id, title, pinned, updatedAt)
				VALUES (?, ?, ?, ?)
				ON CONFLICT(id) DO UPDATE SET
					title = excluded.title,
					pinned = excluded.pinned,
					updatedAt = excluded.updatedAt`,
			args: [record.id, record.title, record.pinned ? 1 : 0, record.updatedAt],
		});
		return record;
	}

	async remove(id: string): Promise<void> {
		await this.ready;
		const key = id.trim();
		if (!key) {
			return;
		}
		await this.client.execute({
			sql: 'DELETE FROM session_meta WHERE id = ?',
			args: [key],
		});
	}

	private async init(): Promise<void> {
		await this.client.execute(`
			CREATE TABLE IF NOT EXISTS session_meta (
				id TEXT PRIMARY KEY NOT NULL,
				title TEXT NOT NULL,
				pinned INTEGER NOT NULL DEFAULT 0,
				updatedAt INTEGER NOT NULL
			)
		`);
	}
}

function parseSessionMeta(row: Record<string, unknown> | undefined): SessionMeta | undefined {
	if (!row) {
		return undefined;
	}
	const id = String(row.id ?? '').trim();
	if (!id) {
		return undefined;
	}
	return {
		id,
		title: String(row.title ?? '').trim(),
		pinned: Number(row.pinned) === 1 || row.pinned === true,
		updatedAt: Number(row.updatedAt) || 0,
	};
}
