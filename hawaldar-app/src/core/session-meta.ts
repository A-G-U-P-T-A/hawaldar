import { createClient, type Client } from '@libsql/client';
import { dataHomePaths, ensureDataHome, sqliteFileUrl } from './data-home';
import {
	parseEngagementCheckpoint,
	serializeEngagementCheckpoint,
	type EngagementCheckpoint,
} from './engagement-checkpoint';

export interface SessionMeta {
	id: string;
	title: string;
	pinned: boolean;
	createdAt: number;
	updatedAt: number;
	snippet: string;
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
			'SELECT id, title, pinned, createdAt, updatedAt, snippet FROM session_meta',
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
			sql: 'SELECT id, title, pinned, createdAt, updatedAt, snippet FROM session_meta WHERE id = ?',
			args: [key],
		});
		return parseSessionMeta(rs.rows[0] as Record<string, unknown> | undefined);
	}

	async upsert(input: {
		id: string;
		title?: string;
		pinned?: boolean;
		snippet?: string;
		createdAt?: number;
		updatedAt?: number;
		touch?: boolean;
	}): Promise<SessionMeta | undefined> {
		const id = input.id.trim();
		if (!id) {
			return undefined;
		}
		await this.ready;
		const current = await this.get(id);
		const now = Date.now();
		const createdAt = toEpochMs(current?.createdAt) || toEpochMs(input.createdAt) || now;
		let updatedAt = toEpochMs(current?.updatedAt);
		const incoming = toEpochMs(input.updatedAt);
		if (incoming > 0) {
			updatedAt = incoming;
		} else if (input.touch || !current) {
			updatedAt = now;
		}
		if (input.touch) {
			updatedAt = Math.max(updatedAt, now);
		}
		if (updatedAt <= 0) {
			updatedAt = createdAt || now;
		}
		const record: SessionMeta = {
			id,
			title: (input.title ?? current?.title ?? '').trim(),
			pinned: input.pinned ?? current?.pinned ?? false,
			createdAt,
			updatedAt,
			snippet: input.snippet !== undefined ? clipSnippet(input.snippet) : (current?.snippet ?? ''),
		};
		await this.client.execute({
			sql: `INSERT INTO session_meta (id, title, pinned, createdAt, updatedAt, snippet)
				VALUES (?, ?, ?, ?, ?, ?)
				ON CONFLICT(id) DO UPDATE SET
					title = excluded.title,
					pinned = excluded.pinned,
					createdAt = excluded.createdAt,
					updatedAt = excluded.updatedAt,
					snippet = excluded.snippet`,
			args: [record.id, record.title, record.pinned ? 1 : 0, record.createdAt, record.updatedAt, record.snippet],
		});
		return record;
	}

	async touch(id: string, snippet?: string): Promise<SessionMeta | undefined> {
		return this.upsert({
			id,
			snippet,
			touch: true,
		});
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

	async getEngagement(threadId: string): Promise<EngagementCheckpoint | undefined> {
		await this.ready;
		const key = threadId.trim();
		if (!key) {
			return undefined;
		}
		try {
			const rs = await this.client.execute({
				sql: 'SELECT engagement FROM session_meta WHERE id = ?',
				args: [key],
			});
			return parseEngagementCheckpoint(rs.rows[0]?.engagement);
		} catch {
			return undefined;
		}
	}

	async setEngagement(threadId: string, checkpoint: EngagementCheckpoint | undefined): Promise<void> {
		const id = threadId.trim();
		if (!id) {
			return;
		}
		await this.ready;
		const current = await this.get(id);
		if (!current) {
			await this.upsert({ id, touch: true });
		}
		await this.client.execute({
			sql: `UPDATE session_meta SET engagement = ?, updatedAt = ? WHERE id = ?`,
			args: [checkpoint ? serializeEngagementCheckpoint(checkpoint) : null, Date.now(), id],
		});
	}

	private async init(): Promise<void> {
		await this.client.execute(`
			CREATE TABLE IF NOT EXISTS session_meta (
				id TEXT PRIMARY KEY NOT NULL,
				title TEXT NOT NULL,
				pinned INTEGER NOT NULL DEFAULT 0,
				createdAt INTEGER NOT NULL DEFAULT 0,
				updatedAt INTEGER NOT NULL,
				snippet TEXT NOT NULL DEFAULT ''
			)
		`);
		try {
			await this.client.execute('ALTER TABLE session_meta ADD COLUMN snippet TEXT NOT NULL DEFAULT \'\'');
		} catch {
			/* already present */
		}
		try {
			await this.client.execute('ALTER TABLE session_meta ADD COLUMN createdAt INTEGER NOT NULL DEFAULT 0');
		} catch {
			/* already present */
		}
		try {
			await this.client.execute('ALTER TABLE session_meta ADD COLUMN engagement TEXT');
		} catch {
			/* already present */
		}
	}
}

const EPOCH_MS_MIN = 1e11;
const EPOCH_MS_MAX = 1e14;

export function toEpochMs(value: unknown): number {
	if (value == null || value === '') {
		return 0;
	}
	if (typeof value === 'number') {
		return normalizeEpochNumber(value);
	}
	if (typeof value === 'bigint') {
		return normalizeEpochNumber(Number(value));
	}
	if (typeof value === 'object') {
		const rec = value as { getTime?: unknown; toISOString?: unknown };
		if (typeof rec.getTime === 'function') {
			return normalizeEpochNumber((rec as Date).getTime());
		}
		if (typeof rec.toISOString === 'function') {
			return toEpochMs((rec as { toISOString: () => string }).toISOString());
		}
	}
	if (typeof value === 'string') {
		const trimmed = value.trim();
		if (!trimmed) {
			return 0;
		}
		if (/^[+-]?\d+(\.\d+)?$/.test(trimmed)) {
			return normalizeEpochNumber(Number(trimmed));
		}
		const parsed = Date.parse(trimmed);
		return Number.isNaN(parsed) ? 0 : parsed;
	}
	return 0;
}

function normalizeEpochNumber(value: number): number {
	if (!Number.isFinite(value) || value <= 0) {
		return 0;
	}
	if (value < EPOCH_MS_MIN) {
		return Math.round(value * 1000);
	}
	if (value > EPOCH_MS_MAX) {
		return Math.round(value / 1000);
	}
	return Math.round(value);
}

const PLACEHOLDER_TITLES = new Set(['', 'new thread', 'new chat', 'untitled', 'chat', 'none', 'chat none']);

export function isPlaceholderSessionTitle(title: string | undefined): boolean {
	const trimmed = String(title ?? '').trim();
	if (!trimmed) {
		return true;
	}
	const lowered = trimmed.toLowerCase().replace(/\s+/g, ' ');
	if (PLACEHOLDER_TITLES.has(lowered) || /^chat\s*[:\-]?\s*(none|untitled|new)?$/i.test(trimmed)) {
		return true;
	}
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed);
}

/** Sidebar title from the first user line: "hi", "dns google.com", … */
export function titleFromFirstPrompt(prompt: string, max = 48): string {
	const line = prompt.replace(/\s+/g, ' ').trim();
	if (!line || isPlaceholderSessionTitle(line)) {
		return '';
	}
	if (line.length <= max) {
		return line;
	}
	return `${line.slice(0, Math.max(1, max - 1))}…`;
}

export function clipSnippet(text: string, max = 160): string {
	const next = text.replace(/\s+/g, ' ').trim();
	if (next.length <= max) {
		return next;
	}
	return `${next.slice(0, Math.max(1, max - 1))}…`;
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
		createdAt: toEpochMs(row.createdAt),
		updatedAt: toEpochMs(row.updatedAt),
		snippet: String(row.snippet ?? '').trim(),
	};
}
