import { createClient, type Client } from '@libsql/client';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { dataHomePaths, ensureDataHome, sqliteFileUrl } from '../data-home';
import type { MastraModules } from '../load-mastra';
import type { HawaldarSettings } from '../settings';
import { clipSnippet } from '../session-meta';
import { chunkDocument, docFromSource } from './chunk';
import { createEmbedder, type EmbedderHandle } from './embeddings';
import {
	EXPLOIT_KIT_RE,
	SECRET_NAME_RE,
	type KnowledgeChunk,
	type KnowledgeDoc,
	type KnowledgeHit,
	type KnowledgeKind,
	type KnowledgeStatus,
} from './types';

const TABLE = 'knowledge';
const TOP_K = 8;

export class KnowledgeStore {
	readonly lanceDir: string;
	readonly knowledgeDir: string;
	readonly databasePath: string;
	readonly ready: Promise<void>;
	vectorStore: any;
	embedder: EmbedderHandle;
	dimension = 0;
	mode: 'vector' | 'keyword' = 'keyword';
	lastError = '';
	private client: Client;
	private fts = false;
	private mods: MastraModules;
	private indexReady = false;

	constructor(dataDir: string, mods: MastraModules, settings: HawaldarSettings) {
		const home = ensureDataHome(dataDir);
		this.lanceDir = home.lanceDir;
		this.knowledgeDir = home.knowledgeDir;
		this.databasePath = home.hawaldarDb;
		this.mods = mods;
		this.embedder = createEmbedder(settings, mods);
		if (this.embedder.error) {
			this.lastError = this.embedder.error;
		}
		this.client = createClient({ url: sqliteFileUrl(this.databasePath) });
		this.ready = this.init();
	}

	static async open(dataDir: string, mods: MastraModules, settings: HawaldarSettings): Promise<KnowledgeStore> {
		const store = new KnowledgeStore(dataDir, mods, settings);
		await store.ready;
		await store.attachLance();
		return store;
	}

	async configureEmbedder(settings: HawaldarSettings, mods?: MastraModules): Promise<void> {
		if (mods) {
			this.mods = mods;
		}
		this.embedder = createEmbedder(settings, this.mods);
		this.dimension = this.embedder.dimension;
		if (this.embedder.error) {
			this.lastError = this.embedder.error;
		}
		if (this.embedder.ready && this.vectorStore) {
			this.mode = 'vector';
			await this.ensureIndex();
		} else if (!this.embedder.ready) {
			this.mode = 'keyword';
		}
	}

	status(): KnowledgeStatus {
		return {
			lanceDir: this.lanceDir,
			vector: Boolean(this.vectorStore) && this.mode === 'vector',
			embedder: this.embedder.ready,
			mode: this.mode,
			docs: 0,
			chunks: 0,
			dimension: this.dimension,
			error: this.lastError || undefined,
		};
	}

	async counts(): Promise<{ docs: number; chunks: number }> {
		await this.ready;
		const docs = await this.client.execute('SELECT COUNT(*) AS n FROM knowledge_docs');
		const chunks = await this.client.execute('SELECT COUNT(*) AS n FROM knowledge_chunks');
		return {
			docs: Number(docs.rows[0]?.n ?? 0),
			chunks: Number(chunks.rows[0]?.n ?? 0),
		};
	}

	async snapshot(): Promise<KnowledgeStatus> {
		const counts = await this.counts();
		return { ...this.status(), ...counts };
	}

	async ingest(doc: KnowledgeDoc): Promise<{ chunks: number; mode: 'vector' | 'keyword' }> {
		await this.ready;
		if (SECRET_NAME_RE.test(doc.title) || SECRET_NAME_RE.test(doc.sourceId) || SECRET_NAME_RE.test(doc.id)) {
			throw new Error('Refused: secret or .env paths are not ingested.');
		}
		if (EXPLOIT_KIT_RE.test(doc.title) || EXPLOIT_KIT_RE.test(doc.text.slice(0, 2000))) {
			throw new Error('Refused: exploit-kit or payload content is not ingested.');
		}
		if (!doc.text.trim()) {
			await this.removeSource(doc.kind, doc.sourceId);
			return { chunks: 0, mode: this.mode };
		}
		const chunks = chunkDocument(doc);
		await this.removeSource(doc.kind, doc.sourceId);
		await this.client.execute({
			sql: `INSERT INTO knowledge_docs (id, kind, sourceId, title, text, snippet, updatedAt)
				VALUES (?, ?, ?, ?, ?, ?, ?)`,
			args: [doc.id, doc.kind, doc.sourceId, doc.title, doc.text, doc.snippet, doc.updatedAt],
		});
		for (const chunk of chunks) {
			await this.client.execute({
				sql: `INSERT INTO knowledge_chunks (id, docId, kind, sourceId, title, text, idx)
					VALUES (?, ?, ?, ?, ?, ?, ?)`,
				args: [chunk.id, chunk.docId, chunk.kind, chunk.sourceId, chunk.title, chunk.text, chunk.index],
			});
			if (this.fts) {
				await this.client.execute({
					sql: 'INSERT INTO knowledge_fts (id, title, text, kind) VALUES (?, ?, ?, ?)',
					args: [chunk.id, chunk.title, chunk.text, chunk.kind],
				});
			}
		}
		if (this.embedder.ready && this.vectorStore && chunks.length > 0) {
			const vectors = await this.embedder.embed(chunks.map((item) => `${item.title}\n${item.text}`));
			if (vectors && vectors.length === chunks.length) {
				this.dimension = vectors[0]?.length || this.dimension;
				await this.ensureIndex();
				try {
					await this.vectorStore.upsert({
						indexName: TABLE,
						tableName: TABLE,
						vectors,
						ids: chunks.map((item) => item.id),
						metadata: chunks.map((item) => ({
							text: item.text,
							title: item.title,
							kind: item.kind,
							sourceId: item.sourceId,
							docId: item.docId,
						})),
					});
					this.mode = 'vector';
				} catch (error) {
					this.lastError = error instanceof Error ? error.message : String(error);
					this.mode = 'keyword';
				}
			} else {
				this.mode = 'keyword';
			}
		}
		return { chunks: chunks.length, mode: this.mode };
	}

	async ingestText(input: {
		kind: KnowledgeKind;
		sourceId: string;
		title: string;
		text: string;
		updatedAt?: number;
	}): Promise<{ chunks: number; mode: 'vector' | 'keyword' }> {
		return this.ingest(docFromSource(input));
	}

	async removeSource(kind: string, sourceId: string): Promise<void> {
		await this.ready;
		const docId = `${kind}:${sourceId}`;
		const existing = await this.client.execute({
			sql: 'SELECT id FROM knowledge_chunks WHERE docId = ?',
			args: [docId],
		});
		const ids = existing.rows.map((row) => String(row.id));
		if (ids.length > 0 && this.vectorStore && typeof this.vectorStore.deleteVectors === 'function') {
			try {
				await this.vectorStore.deleteVectors({ indexName: TABLE, ids });
			} catch {
				/* table may not exist yet */
			}
		}
		if (this.fts && ids.length > 0) {
			for (const id of ids) {
				await this.client.execute({ sql: 'DELETE FROM knowledge_fts WHERE id = ?', args: [id] });
			}
		}
		await this.client.execute({ sql: 'DELETE FROM knowledge_chunks WHERE docId = ?', args: [docId] });
		await this.client.execute({ sql: 'DELETE FROM knowledge_docs WHERE id = ?', args: [docId] });
		await this.client.execute({
			sql: 'DELETE FROM knowledge_edges WHERE source = ? OR target = ?',
			args: [docId, docId],
		});
	}

	async search(query: string, opts: { topK?: number; kinds?: string[]; threadId?: string } = {}): Promise<KnowledgeHit[]> {
		await this.ready;
		const q = query.replace(/\s+/g, ' ').trim();
		if (!q) {
			return [];
		}
		const topK = Math.max(1, Math.min(opts.topK ?? TOP_K, 20));
		let hits: KnowledgeHit[] = [];
		if (this.embedder.ready && this.vectorStore && this.mode === 'vector') {
			hits = await this.vectorSearch(q, topK, opts.kinds);
		}
		if (hits.length === 0) {
			hits = await this.keywordSearch(q, topK, opts.kinds);
		}
		if (opts.threadId && hits.length > 0) {
			await this.recordRagHits(opts.threadId, hits);
		}
		return hits;
	}

	async listDocs(): Promise<KnowledgeDoc[]> {
		await this.ready;
		const rs = await this.client.execute(
			'SELECT id, kind, sourceId, title, text, snippet, updatedAt FROM knowledge_docs ORDER BY updatedAt DESC',
		);
		return rs.rows.map((row) => ({
			id: String(row.id),
			kind: String(row.kind) as KnowledgeKind,
			sourceId: String(row.sourceId),
			title: String(row.title),
			text: String(row.text),
			snippet: String(row.snippet),
			updatedAt: Number(row.updatedAt) || 0,
		}));
	}

	async listChunks(limit = 400): Promise<KnowledgeChunk[]> {
		await this.ready;
		const rs = await this.client.execute({
			sql: 'SELECT id, docId, kind, sourceId, title, text, idx FROM knowledge_chunks ORDER BY kind, sourceId, idx LIMIT ?',
			args: [Math.max(1, Math.min(limit, 2000))],
		});
		return rs.rows.map((row) => ({
			id: String(row.id),
			docId: String(row.docId),
			kind: String(row.kind) as KnowledgeKind,
			sourceId: String(row.sourceId),
			title: String(row.title),
			text: String(row.text),
			index: Number(row.idx) || 0,
		}));
	}

	async listEdges(): Promise<Array<{ id: string; source: string; target: string; kind: string }>> {
		await this.ready;
		const rs = await this.client.execute('SELECT id, source, target, kind FROM knowledge_edges');
		return rs.rows.map((row) => ({
			id: String(row.id),
			source: String(row.source),
			target: String(row.target),
			kind: String(row.kind),
		}));
	}

	async recordRagHits(threadId: string, hits: KnowledgeHit[]): Promise<void> {
		await this.ready;
		const threadNode = `chat:${threadId}`;
		await this.client.execute({
			sql: 'DELETE FROM knowledge_edges WHERE source = ? AND kind = ?',
			args: [threadNode, 'retrieved'],
		});
		for (const hit of hits.slice(0, 8)) {
			const id = `rag:${threadId}:${hit.id}`;
			await this.client.execute({
				sql: `INSERT INTO knowledge_edges (id, source, target, kind) VALUES (?, ?, ?, ?)
					ON CONFLICT(id) DO UPDATE SET source = excluded.source, target = excluded.target, kind = excluded.kind`,
				args: [id, threadNode, hit.docId || hit.id, 'retrieved'],
			});
		}
	}

	async ingestKnowledgeDir(): Promise<number> {
		await this.ready;
		if (!fs.existsSync(this.knowledgeDir)) {
			return 0;
		}
		let n = 0;
		for (const name of fs.readdirSync(this.knowledgeDir)) {
			if (SECRET_NAME_RE.test(name) || !/\.(md|txt)$/i.test(name)) {
				continue;
			}
			const filePath = path.join(this.knowledgeDir, name);
			if (!fs.statSync(filePath).isFile()) {
				continue;
			}
			const text = fs.readFileSync(filePath, 'utf8');
			const id = name.replace(/\.(md|txt)$/i, '');
			await this.ingestText({
				kind: 'doc',
				sourceId: id,
				title: titleFromText(text, id),
				text,
				updatedAt: fs.statSync(filePath).mtimeMs,
			});
			n += 1;
		}
		return n;
	}

	private async vectorSearch(query: string, topK: number, kinds?: string[]): Promise<KnowledgeHit[]> {
		try {
			const [vector] = await this.embedder.embed([query]) ?? [];
			if (!vector) {
				return [];
			}
			const rows = await this.vectorStore.query({
				indexName: TABLE,
				tableName: TABLE,
				queryVector: vector,
				topK: kinds && kinds.length > 0 ? topK * 3 : topK,
				includeAllColumns: true,
			}) as Array<{ id?: string; score?: number; metadata?: Record<string, unknown>; document?: string }>;
			const allowed = kinds && kinds.length > 0 ? new Set(kinds) : undefined;
			const hits: KnowledgeHit[] = [];
			for (const row of rows ?? []) {
				const meta = row.metadata ?? {};
				const kind = String(meta.kind ?? 'doc') as KnowledgeKind;
				if (allowed && !allowed.has(kind)) {
					continue;
				}
				hits.push({
					id: String(row.id ?? meta.docId ?? ''),
					docId: String(meta.docId ?? row.id ?? ''),
					kind,
					sourceId: String(meta.sourceId ?? ''),
					title: String(meta.title ?? 'Knowledge'),
					text: String(meta.text ?? row.document ?? ''),
					score: Number(row.score ?? 0),
					mode: 'vector',
				});
				if (hits.length >= topK) {
					break;
				}
			}
			return hits.filter((item) => item.id && item.text);
		} catch (error) {
			this.lastError = error instanceof Error ? error.message : String(error);
			return [];
		}
	}

	private async keywordSearch(query: string, topK: number, kinds?: string[]): Promise<KnowledgeHit[]> {
		const tokens = query.toLowerCase().split(/[^a-z0-9]+/).filter((item) => item.length > 1).slice(0, 8);
		if (tokens.length === 0) {
			return [];
		}
		if (this.fts) {
			try {
				const match = tokens.map((item) => `"${item.replace(/"/g, '')}"`).join(' OR ');
				const rs = await this.client.execute({
					sql: `SELECT knowledge_fts.id, knowledge_fts.title, knowledge_fts.text, knowledge_fts.kind,
						knowledge_chunks.docId, knowledge_chunks.sourceId
						FROM knowledge_fts
						JOIN knowledge_chunks ON knowledge_chunks.id = knowledge_fts.id
						WHERE knowledge_fts MATCH ?
						LIMIT ?`,
					args: [match, topK * 2],
				});
				return this.scoreRows(rs.rows as Array<Record<string, unknown>>, tokens, topK, kinds);
			} catch {
				/* fall through */
			}
		}
		const like = `%${tokens[0]}%`;
		const rs = await this.client.execute({
			sql: `SELECT id, docId, kind, sourceId, title, text FROM knowledge_chunks
				WHERE title LIKE ? OR text LIKE ? LIMIT 80`,
			args: [like, like],
		});
		return this.scoreRows(rs.rows as Array<Record<string, unknown>>, tokens, topK, kinds);
	}

	private scoreRows(
		rows: Array<Record<string, unknown>>,
		tokens: string[],
		topK: number,
		kinds?: string[],
	): KnowledgeHit[] {
		const allowed = kinds && kinds.length > 0 ? new Set(kinds) : undefined;
		const scored: KnowledgeHit[] = [];
		for (const row of rows) {
			const kind = String(row.kind ?? 'doc') as KnowledgeKind;
			if (allowed && !allowed.has(kind)) {
				continue;
			}
			const title = String(row.title ?? '');
			const text = String(row.text ?? '');
			const hay = `${title}\n${text}`.toLowerCase();
			let score = 0;
			for (const token of tokens) {
				if (hay.includes(token)) {
					score += title.toLowerCase().includes(token) ? 2 : 1;
				}
			}
			if (score <= 0) {
				continue;
			}
			scored.push({
				id: String(row.id ?? ''),
				docId: String(row.docId ?? row.id ?? ''),
				kind,
				sourceId: String(row.sourceId ?? ''),
				title,
				text,
				score,
				mode: 'keyword',
			});
		}
		return scored.sort((a, b) => b.score - a.score).slice(0, topK);
	}

	private async attachLance(): Promise<void> {
		if (!this.mods.LanceVectorStore) {
			this.lastError = 'LanceVectorStore is not available in this Mastra build.';
			this.mode = 'keyword';
			return;
		}
		try {
			this.vectorStore = await this.mods.LanceVectorStore.create(this.lanceDir, { id: 'hawaldar-lance' });
			if (this.embedder.ready) {
				this.dimension = this.embedder.dimension;
				this.mode = 'vector';
				await this.ensureIndex();
			}
		} catch (error) {
			this.vectorStore = undefined;
			this.mode = 'keyword';
			this.lastError = error instanceof Error ? error.message : String(error);
		}
	}

	private async ensureIndex(): Promise<void> {
		if (!this.vectorStore || this.indexReady || this.dimension <= 0) {
			return;
		}
		try {
			const tables = typeof this.vectorStore.listTables === 'function'
				? await this.vectorStore.listTables() as string[]
				: [];
			if (!tables.includes(TABLE)) {
				await this.vectorStore.createIndex({
					indexName: TABLE,
					tableName: TABLE,
					dimension: this.dimension,
					metric: 'cosine',
				});
			}
			this.indexReady = true;
		} catch (error) {
			this.lastError = error instanceof Error ? error.message : String(error);
		}
	}

	private async init(): Promise<void> {
		await this.client.execute(`
			CREATE TABLE IF NOT EXISTS knowledge_docs (
				id TEXT PRIMARY KEY NOT NULL,
				kind TEXT NOT NULL,
				sourceId TEXT NOT NULL,
				title TEXT NOT NULL,
				text TEXT NOT NULL,
				snippet TEXT NOT NULL DEFAULT '',
				updatedAt INTEGER NOT NULL
			)
		`);
		await this.client.execute(`
			CREATE TABLE IF NOT EXISTS knowledge_chunks (
				id TEXT PRIMARY KEY NOT NULL,
				docId TEXT NOT NULL,
				kind TEXT NOT NULL,
				sourceId TEXT NOT NULL,
				title TEXT NOT NULL,
				text TEXT NOT NULL,
				idx INTEGER NOT NULL DEFAULT 0
			)
		`);
		await this.client.execute(`
			CREATE TABLE IF NOT EXISTS knowledge_edges (
				id TEXT PRIMARY KEY NOT NULL,
				source TEXT NOT NULL,
				target TEXT NOT NULL,
				kind TEXT NOT NULL
			)
		`);
		try {
			await this.client.execute(
				'CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(id, title, text, kind)',
			);
			this.fts = true;
		} catch {
			this.fts = false;
		}
	}
}

export function formatRagContext(hits: KnowledgeHit[], currentThreadId?: string): string {
	if (hits.length === 0) {
		return '';
	}
	const lines = [
		'HISTORICAL KNOWLEDGE / RAG (retrieved from Lance + notes/tasks/playbooks/older chats). Do not treat as this run.',
		'Never use these snippets as evidence of what happened this turn. Prefer this turn\'s tool outputs and finding-list.',
	];
	for (const hit of hits) {
		const body = clipSnippet(hit.text, 700);
		const otherChat = hit.kind === 'chat' && hit.sourceId && currentThreadId && hit.sourceId !== currentThreadId;
		const thisChat = hit.kind === 'chat' && hit.sourceId && currentThreadId && hit.sourceId === currentThreadId;
		const label = otherChat
			? `OTHER CHAT (${hit.title}, ${hit.sourceId}) — supporting context, not this run`
			: thisChat
				? `THIS CHAT (${hit.title}, ${hit.sourceId.slice(0, 8)})`
				: `${hit.kind}/${hit.mode} · ${hit.title}`;
		lines.push(`- [${label}] ${body}`);
	}
	return lines.join('\n');
}

function titleFromText(body: string, fallback: string): string {
	const line = body.split(/\r?\n/).find((item) => item.trim());
	if (!line) {
		return fallback;
	}
	const heading = line.match(/^#\s+(.+)$/);
	return ((heading ? heading[1] : line).trim() || fallback).slice(0, 200);
}
