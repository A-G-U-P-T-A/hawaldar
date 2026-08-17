import { createClient, type Client } from '@libsql/client';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { dataHomePaths, ensureDataHome, slugifyName, sqliteFileUrl, uniqueSlug } from './data-home';

export interface NoteSummary {
	id: string;
	title: string;
	path: string;
	updatedAt: number;
}

export interface NoteRecord extends NoteSummary {
	body: string;
}

export interface NoteWrite {
	id?: string;
	title: string;
	body: string;
}

const ID_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const MAX_BODY = 2_000_000;

export class NotesStore {
	readonly notesDir: string;
	readonly databasePath: string;
	readonly ready: Promise<void>;
	private client: Client;

	constructor(dataDir: string) {
		const home = ensureDataHome(dataDir);
		this.notesDir = home.notesDir;
		this.databasePath = dataHomePaths(dataDir).notesDb;
		this.client = createClient({ url: sqliteFileUrl(this.databasePath) });
		this.ready = this.init();
	}

	async list(): Promise<NoteSummary[]> {
		await this.ready;
		await this.reconcile();
		const rs = await this.client.execute('SELECT id, title, path, updatedAt FROM notes ORDER BY updatedAt DESC, title COLLATE NOCASE');
		return rs.rows.map((row) => ({
			id: String(row.id),
			title: String(row.title),
			path: String(row.path),
			updatedAt: Number(row.updatedAt) || 0,
		}));
	}

	async get(id: string): Promise<NoteRecord> {
		await this.ready;
		const safe = assertNoteId(id);
		const rs = await this.client.execute({
			sql: 'SELECT id, title, path, updatedAt FROM notes WHERE id = ?',
			args: [safe],
		});
		const row = rs.rows[0];
		if (!row) {
			throw new Error(`Unknown note: ${safe}`);
		}
		const filePath = this.fileFor(safe);
		const body = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
		return {
			id: String(row.id),
			title: String(row.title),
			path: String(row.path),
			updatedAt: Number(row.updatedAt) || 0,
			body,
		};
	}

	async upsert(draft: NoteWrite): Promise<NoteRecord> {
		await this.ready;
		const title = draft.title.trim();
		if (!title) {
			throw new Error('Note title is required.');
		}
		if (title.length > 200) {
			throw new Error('Note title is too long.');
		}
		const body = typeof draft.body === 'string' ? draft.body : '';
		if (body.length > MAX_BODY) {
			throw new Error('Note is too large.');
		}
		const existing = draft.id ? await this.find(draft.id) : undefined;
		const id = existing?.id || uniqueSlug(slugifyName(title, 'note'), await this.ids());
		if (!ID_RE.test(id)) {
			throw new Error('Note id must be a lowercase slug.');
		}
		const rel = displayPath(id);
		const now = Date.now();
		fs.writeFileSync(this.fileFor(id), body, 'utf8');
		await this.client.execute({
			sql: `INSERT INTO notes (id, title, path, updatedAt)
				VALUES (?, ?, ?, ?)
				ON CONFLICT(id) DO UPDATE SET title = excluded.title, path = excluded.path, updatedAt = excluded.updatedAt`,
			args: [id, title, rel, now],
		});
		return this.get(id);
	}

	async remove(id: string): Promise<void> {
		await this.ready;
		const safe = assertNoteId(id);
		const filePath = this.fileFor(safe);
		if (fs.existsSync(filePath)) {
			fs.unlinkSync(filePath);
		}
		await this.client.execute({ sql: 'DELETE FROM notes WHERE id = ?', args: [safe] });
	}

	private async init(): Promise<void> {
		await this.client.execute(`
			CREATE TABLE IF NOT EXISTS notes (
				id TEXT PRIMARY KEY,
				title TEXT NOT NULL,
				path TEXT NOT NULL,
				updatedAt INTEGER NOT NULL
			);
		`);
		await this.reconcile();
	}

	private async find(id: string): Promise<NoteSummary | undefined> {
		if (!ID_RE.test(id)) {
			return undefined;
		}
		const rs = await this.client.execute({
			sql: 'SELECT id, title, path, updatedAt FROM notes WHERE id = ?',
			args: [id],
		});
		const row = rs.rows[0];
		return row
			? {
				id: String(row.id),
				title: String(row.title),
				path: String(row.path),
				updatedAt: Number(row.updatedAt) || 0,
			}
			: undefined;
	}

	private async ids(): Promise<string[]> {
		const rs = await this.client.execute('SELECT id FROM notes');
		return rs.rows.map((row) => String(row.id));
	}

	private fileFor(id: string): string {
		const resolved = path.resolve(this.notesDir, `${id}.md`);
		const root = path.resolve(this.notesDir);
		const rel = path.relative(root, resolved);
		if (rel.startsWith('..') || path.isAbsolute(rel)) {
			throw new Error('Note path is outside ~/.hawaldar/notes.');
		}
		return resolved;
	}

	private async reconcile(): Promise<void> {
		const onDisk = new Set<string>();
		for (const name of fs.readdirSync(this.notesDir)) {
			if (!name.endsWith('.md')) {
				continue;
			}
			const id = name.slice(0, -3);
			if (!ID_RE.test(id)) {
				continue;
			}
			onDisk.add(id);
			const existing = await this.find(id);
			if (existing) {
				continue;
			}
			const filePath = this.fileFor(id);
			const body = fs.readFileSync(filePath, 'utf8');
			const title = titleFromMarkdown(body, id);
			const stat = fs.statSync(filePath);
			await this.client.execute({
				sql: 'INSERT INTO notes (id, title, path, updatedAt) VALUES (?, ?, ?, ?)',
				args: [id, title, displayPath(id), stat.mtimeMs || Date.now()],
			});
		}
		const indexed = await this.ids();
		for (const id of indexed) {
			if (!onDisk.has(id)) {
				await this.client.execute({ sql: 'DELETE FROM notes WHERE id = ?', args: [id] });
			}
		}
	}
}

function displayPath(id: string): string {
	return `notes/${id}.md`;
}

function assertNoteId(id: string): string {
	const trimmed = id.trim();
	if (!ID_RE.test(trimmed)) {
		throw new Error('Invalid note id.');
	}
	return trimmed;
}

function titleFromMarkdown(body: string, fallback: string): string {
	const line = body.split(/\r?\n/).find((item) => item.trim());
	if (!line) {
		return fallback;
	}
	const heading = line.match(/^#\s+(.+)$/);
	const title = (heading ? heading[1] : line).trim();
	return title.slice(0, 200) || fallback;
}
