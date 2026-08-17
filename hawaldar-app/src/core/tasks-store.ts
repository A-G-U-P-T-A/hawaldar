import { createClient, type Client, type Row } from '@libsql/client';
import { dataHomePaths, ensureDataHome, slugifyName, sqliteFileUrl, uniqueSlug } from './data-home';

export type TaskStatus = 'open' | 'doing' | 'done';

export interface TaskTagRecord {
	id: string;
	title: string;
	createdAt: number;
}

export interface TaskTagWrite {
	id?: string;
	title: string;
}

export interface TaskRecord {
	id: string;
	title: string;
	status: TaskStatus;
	notes: string;
	createdAt: number;
	updatedAt: number;
	order: number;
	listId: string;
	listTitle: string;
	boardId: string;
	position: number;
	tags: TaskTagRecord[];
}

export interface TaskWrite {
	id?: string;
	title?: string;
	status?: TaskStatus;
	notes?: string;
	order?: number;
	listId?: string;
	position?: number;
	tagIds?: string[];
}

export interface TaskBoardRecord {
	id: string;
	title: string;
	createdAt: number;
}

export interface TaskListRecord {
	id: string;
	boardId: string;
	title: string;
	position: number;
	statusKey: TaskStatus | '';
	createdAt: number;
}

export interface TaskListWrite {
	id?: string;
	boardId?: string;
	title: string;
	position?: number;
}

export interface TaskBoardSnapshot {
	board: TaskBoardRecord;
	lists: TaskListRecord[];
	cards: TaskRecord[];
	tags: TaskTagRecord[];
}

export interface TaskMove {
	id: string;
	listId: string;
	beforeId?: string;
}

const ID_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const STATUSES = new Set<TaskStatus>(['open', 'doing', 'done']);
export const DEFAULT_BOARD_ID = 'board-tasks';

const DEFAULT_LISTS: Array<{ id: string; title: string; position: number; statusKey: TaskStatus }> = [
	{ id: 'list-start', title: 'Start', position: 1024, statusKey: 'open' },
	{ id: 'list-end', title: 'End', position: 2048, statusKey: 'done' },
];

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
		const rs = await this.client.execute(`
			SELECT c.id, c.title, c.notes, c.position, c.created_at, c.updated_at,
				c.list_id, l.title AS list_title, l.board_id, l.status_key
			FROM cards c
			JOIN lists l ON l.id = c.list_id
			ORDER BY l.position ASC, c.position ASC, c.created_at ASC
		`);
		const byCard = await this.tagsByCard();
		return rs.rows.map((row) => mapCard(row, byCard.get(String(row.id)) ?? []));
	}

	async board(boardId = DEFAULT_BOARD_ID): Promise<TaskBoardSnapshot> {
		await this.ready;
		const board = await this.findBoard(boardId) ?? await this.findBoard(DEFAULT_BOARD_ID);
		if (!board) {
			throw new Error('Task board is missing.');
		}
		const lists = await this.syncListRoles(board.id);
		const cards = (await this.list()).filter((card) => card.boardId === board.id);
		const tags = await this.listTags();
		return { board, lists, cards, tags };
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
		const notes = draft.notes !== undefined ? String(draft.notes) : (existing?.notes ?? '');
		const now = Date.now();
		const id = existing?.id || uniqueSlug(slugifyName(title, 'task'), await this.ids());
		if (!ID_RE.test(id)) {
			throw new Error('Task id must be a lowercase slug.');
		}
		const boardId = existing?.boardId ?? DEFAULT_BOARD_ID;
		const statusChanged = draft.status !== undefined && draft.status !== existing?.status;
		const list = draft.listId
			? await this.requireList(draft.listId)
			: statusChanged
				? await this.listForStatus(boardId, normalizeStatus(draft.status))
				: existing
					? await this.requireList(existing.listId)
					: await this.listForStatus(boardId, normalizeStatus(draft.status ?? 'open'));
		const listChanged = list.id !== existing?.listId;
		const position = draft.position
			?? (draft.order !== undefined ? Number(draft.order) : undefined)
			?? (listChanged ? await this.nextCardPosition(list.id) : existing?.position)
			?? await this.nextCardPosition(list.id);
		const createdAt = existing?.createdAt ?? now;
		await this.client.execute({
			sql: `INSERT INTO cards (id, list_id, title, notes, position, created_at, updated_at)
				VALUES (?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(id) DO UPDATE SET list_id = excluded.list_id, title = excluded.title,
					notes = excluded.notes, position = excluded.position, updated_at = excluded.updated_at`,
			args: [id, list.id, title, notes, position, createdAt, now],
		});
		if (draft.tagIds) {
			await this.replaceCardTags(id, draft.tagIds);
		}
		const row = (await this.find(id))!;
		await this.writeLegacy(row);
		return row;
	}

	async setStatus(id: string, status: TaskStatus): Promise<TaskRecord> {
		const row = await this.find(id);
		if (!row) {
			throw new Error('Unknown task.');
		}
		const list = await this.listForStatus(row.boardId, normalizeStatus(status));
		return this.upsert({ id, status: normalizeStatus(status), listId: list.id });
	}

	async moveCard(move: TaskMove): Promise<TaskRecord> {
		await this.ready;
		const card = await this.find(move.id);
		if (!card) {
			throw new Error('Unknown task.');
		}
		await this.requireList(move.listId);
		const siblings = (await this.cardsInList(move.listId)).filter((row) => row.id !== move.id);
		const beforeIndex = move.beforeId ? siblings.findIndex((row) => row.id === move.beforeId) : -1;
		const after = beforeIndex >= 0 ? siblings[beforeIndex]?.position : undefined;
		const before = beforeIndex > 0
			? siblings[beforeIndex - 1]?.position
			: beforeIndex === 0
				? undefined
				: siblings[siblings.length - 1]?.position;
		let position = midpoint(before, after);
		if (before != null && after != null && after - before < 1e-4) {
			await this.reindexList(move.listId, move.id, move.beforeId);
			const row = (await this.find(move.id))!;
			await this.writeLegacy(row);
			return row;
		}
		const now = Date.now();
		await this.client.execute({
			sql: 'UPDATE cards SET list_id = ?, position = ?, updated_at = ? WHERE id = ?',
			args: [move.listId, position, now, move.id],
		});
		const row = (await this.find(move.id))!;
		await this.writeLegacy(row);
		return row;
	}

	async upsertList(draft: TaskListWrite): Promise<TaskListRecord> {
		await this.ready;
		const title = draft.title.trim();
		if (!title) {
			throw new Error('List title is required.');
		}
		if (title.length > 80) {
			throw new Error('List title is too long.');
		}
		const existing = draft.id ? await this.findList(draft.id) : undefined;
		const boardId = draft.boardId || existing?.boardId || DEFAULT_BOARD_ID;
		await this.requireBoard(boardId);
		const id = existing?.id || uniqueSlug(slugifyName(title, 'list'), await this.listIds());
		if (!ID_RE.test(id)) {
			throw new Error('List id must be a lowercase slug.');
		}
		const now = Date.now();
		const position = draft.position ?? existing?.position ?? await this.nextListPosition(boardId);
		const statusKey = existing?.statusKey ?? '';
		const createdAt = existing?.createdAt ?? now;
		await this.client.execute({
			sql: `INSERT INTO lists (id, board_id, title, position, status_key, created_at)
				VALUES (?, ?, ?, ?, ?, ?)
				ON CONFLICT(id) DO UPDATE SET title = excluded.title, position = excluded.position`,
			args: [id, boardId, title, position, statusKey, createdAt],
		});
		await this.syncListRoles(boardId);
		return (await this.findList(id))!;
	}

	async removeList(id: string, moveToListId?: string): Promise<TaskRecord[]> {
		await this.ready;
		const list = await this.requireList(id);
		const lists = await this.lists(list.boardId);
		if (lists.length <= 1) {
			throw new Error('The board needs at least one stage.');
		}
		const cards = await this.cardsInList(id);
		if (cards.length > 0) {
			if (!moveToListId || moveToListId === id) {
				throw new Error('Choose a stage for the cards in this column.');
			}
			await this.requireList(moveToListId);
		}
		const moved: TaskRecord[] = [];
		for (const card of cards) {
			moved.push(await this.moveCard({ id: card.id, listId: moveToListId! }));
		}
		await this.client.execute({ sql: 'DELETE FROM lists WHERE id = ?', args: [id] });
		await this.syncListRoles(list.boardId);
		return moved;
	}

	async reorderLists(boardId: string, orderedIds: string[]): Promise<TaskListRecord[]> {
		await this.ready;
		const lists = await this.lists(boardId);
		if (lists.length === 0) {
			throw new Error('No lists on this board.');
		}
		const known = new Set(lists.map((list) => list.id));
		if (orderedIds.length !== lists.length || new Set(orderedIds).size !== lists.length) {
			throw new Error('Invalid stage order.');
		}
		for (const id of orderedIds) {
			if (!known.has(id)) {
				throw new Error('Unknown list.');
			}
		}
		for (let i = 0; i < orderedIds.length; i += 1) {
			await this.client.execute({
				sql: 'UPDATE lists SET position = ? WHERE id = ?',
				args: [(i + 1) * 1024, orderedIds[i]],
			});
		}
		return this.syncListRoles(boardId);
	}

	async listTags(): Promise<TaskTagRecord[]> {
		await this.ready;
		const rs = await this.client.execute(
			'SELECT id, title, created_at FROM tags ORDER BY title COLLATE NOCASE',
		);
		return rs.rows.map((row) => mapTag(row));
	}

	async upsertTag(draft: TaskTagWrite): Promise<TaskTagRecord> {
		await this.ready;
		const title = draft.title.trim();
		if (!title) {
			throw new Error('Tag title is required.');
		}
		if (title.length > 40) {
			throw new Error('Tag title is too long.');
		}
		const existing = draft.id ? await this.findTag(draft.id) : await this.findTagByTitle(title);
		if (existing && !draft.id) {
			return existing;
		}
		const id = existing?.id || uniqueSlug(slugifyName(title, 'tag'), await this.tagIds());
		if (!ID_RE.test(id)) {
			throw new Error('Tag id must be a lowercase slug.');
		}
		const createdAt = existing?.createdAt ?? Date.now();
		await this.client.execute({
			sql: `INSERT INTO tags (id, title, created_at) VALUES (?, ?, ?)
				ON CONFLICT(id) DO UPDATE SET title = excluded.title`,
			args: [id, title, createdAt],
		});
		return (await this.findTag(id))!;
	}

	async removeTag(id: string): Promise<void> {
		await this.ready;
		if (!ID_RE.test(id)) {
			return;
		}
		await this.client.execute({ sql: 'DELETE FROM card_tags WHERE tag_id = ?', args: [id] });
		await this.client.execute({ sql: 'DELETE FROM tags WHERE id = ?', args: [id] });
	}

	async setCardTags(cardId: string, tagIds: string[]): Promise<TaskRecord> {
		await this.ready;
		const card = await this.find(cardId);
		if (!card) {
			throw new Error('Unknown task.');
		}
		await this.replaceCardTags(cardId, tagIds);
		return (await this.find(cardId))!;
	}

	async remove(id: string): Promise<void> {
		await this.ready;
		if (!ID_RE.test(id)) {
			return;
		}
		await this.client.execute({ sql: 'DELETE FROM card_tags WHERE card_id = ?', args: [id] });
		await this.client.execute({ sql: 'DELETE FROM cards WHERE id = ?', args: [id] });
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
		await this.client.execute(`
			CREATE TABLE IF NOT EXISTS boards (
				id TEXT PRIMARY KEY,
				title TEXT NOT NULL,
				created_at INTEGER NOT NULL
			);
		`);
		await this.client.execute(`
			CREATE TABLE IF NOT EXISTS lists (
				id TEXT PRIMARY KEY,
				board_id TEXT NOT NULL,
				title TEXT NOT NULL,
				position REAL NOT NULL,
				status_key TEXT NOT NULL DEFAULT '',
				created_at INTEGER NOT NULL
			);
		`);
		await this.client.execute(`
			CREATE TABLE IF NOT EXISTS cards (
				id TEXT PRIMARY KEY,
				list_id TEXT NOT NULL,
				title TEXT NOT NULL,
				notes TEXT NOT NULL DEFAULT '',
				position REAL NOT NULL,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			);
		`);
		await this.client.execute('CREATE INDEX IF NOT EXISTS idx_lists_board_pos ON lists(board_id, position)');
		await this.client.execute('CREATE INDEX IF NOT EXISTS idx_cards_list_pos ON cards(list_id, position)');
		await this.client.execute(`
			CREATE TABLE IF NOT EXISTS tags (
				id TEXT PRIMARY KEY,
				title TEXT NOT NULL,
				created_at INTEGER NOT NULL
			);
		`);
		await this.client.execute(`
			CREATE TABLE IF NOT EXISTS card_tags (
				card_id TEXT NOT NULL,
				tag_id TEXT NOT NULL,
				PRIMARY KEY (card_id, tag_id)
			);
		`);
		await this.client.execute('CREATE INDEX IF NOT EXISTS idx_card_tags_tag ON card_tags(tag_id)');
		await this.seedBoard();
		await this.migrateLegacyTasks();
		await this.syncListRoles(DEFAULT_BOARD_ID);
	}

	private async seedBoard(): Promise<void> {
		const now = Date.now();
		if (!(await this.findBoard(DEFAULT_BOARD_ID))) {
			await this.client.execute({
				sql: 'INSERT INTO boards (id, title, created_at) VALUES (?, ?, ?)',
				args: [DEFAULT_BOARD_ID, 'Tasks', now],
			});
		}
		const existing = await this.lists(DEFAULT_BOARD_ID);
		if (existing.length > 0) {
			return;
		}
		for (const list of DEFAULT_LISTS) {
			await this.client.execute({
				sql: 'INSERT INTO lists (id, board_id, title, position, status_key, created_at) VALUES (?, ?, ?, ?, ?, ?)',
				args: [list.id, DEFAULT_BOARD_ID, list.title, list.position, list.statusKey, now],
			});
		}
	}

	private async migrateLegacyTasks(): Promise<void> {
		const cards = await this.client.execute('SELECT COUNT(*) AS n FROM cards');
		if ((Number(cards.rows[0]?.n) || 0) > 0) {
			return;
		}
		const legacy = await this.client.execute(
			'SELECT id, title, status, notes, createdAt, updatedAt, "order" AS sortOrder FROM tasks ORDER BY "order" ASC, createdAt ASC',
		);
		if (legacy.rows.length === 0) {
			return;
		}
		for (const row of legacy.rows) {
			const status = normalizeStatus(row.status);
			const list = await this.listForStatus(DEFAULT_BOARD_ID, status === 'open' && String(row.status) === 'todo' ? 'open' : status);
			const id = String(row.id);
			if (!ID_RE.test(id)) {
				continue;
			}
			const position = ((Number(row.sortOrder) || 0) + 1) * 1024;
			await this.client.execute({
				sql: `INSERT OR IGNORE INTO cards (id, list_id, title, notes, position, created_at, updated_at)
					VALUES (?, ?, ?, ?, ?, ?, ?)`,
				args: [
					id,
					list.id,
					String(row.title),
					String(row.notes ?? ''),
					position,
					Number(row.createdAt) || Date.now(),
					Number(row.updatedAt) || Date.now(),
				],
			});
		}
	}

	private async find(id: string): Promise<TaskRecord | undefined> {
		if (!ID_RE.test(id)) {
			return undefined;
		}
		const rs = await this.client.execute({
			sql: `SELECT c.id, c.title, c.notes, c.position, c.created_at, c.updated_at,
					c.list_id, l.title AS list_title, l.board_id, l.status_key
				FROM cards c
				JOIN lists l ON l.id = c.list_id
				WHERE c.id = ?`,
			args: [id],
		});
		const row = rs.rows[0];
		if (!row) {
			return undefined;
		}
		const byCard = await this.tagsByCard(id);
		return mapCard(row, byCard.get(id) ?? []);
	}

	private async findBoard(id: string): Promise<TaskBoardRecord | undefined> {
		const rs = await this.client.execute({
			sql: 'SELECT id, title, created_at FROM boards WHERE id = ?',
			args: [id],
		});
		const row = rs.rows[0];
		return row
			? { id: String(row.id), title: String(row.title), createdAt: Number(row.created_at) || 0 }
			: undefined;
	}

	private async requireBoard(id: string): Promise<TaskBoardRecord> {
		const board = await this.findBoard(id);
		if (!board) {
			throw new Error('Unknown board.');
		}
		return board;
	}

	private async lists(boardId: string): Promise<TaskListRecord[]> {
		const rs = await this.client.execute({
			sql: 'SELECT id, board_id, title, position, status_key, created_at FROM lists WHERE board_id = ? ORDER BY position ASC',
			args: [boardId],
		});
		return rs.rows.map((row) => mapList(row));
	}

	private async findList(id: string): Promise<TaskListRecord | undefined> {
		if (!ID_RE.test(id)) {
			return undefined;
		}
		const rs = await this.client.execute({
			sql: 'SELECT id, board_id, title, position, status_key, created_at FROM lists WHERE id = ?',
			args: [id],
		});
		const row = rs.rows[0];
		return row ? mapList(row) : undefined;
	}

	private async requireList(id: string): Promise<TaskListRecord> {
		const list = await this.findList(id);
		if (!list) {
			throw new Error('Unknown list.');
		}
		return list;
	}

	private async listForStatus(boardId: string, status: TaskStatus): Promise<TaskListRecord> {
		const lists = await this.syncListRoles(boardId);
		const found = lists.find((list) => list.statusKey === status)
			|| (status === 'done' ? lists[lists.length - 1] : lists[0]);
		if (!found) {
			throw new Error('No lists on this board.');
		}
		return found;
	}

	private async syncListRoles(boardId: string): Promise<TaskListRecord[]> {
		const lists = await this.lists(boardId);
		for (let i = 0; i < lists.length; i += 1) {
			const role = roleForIndex(i, lists.length);
			if (lists[i].statusKey !== role) {
				await this.client.execute({
					sql: 'UPDATE lists SET status_key = ? WHERE id = ?',
					args: [role, lists[i].id],
				});
				lists[i] = { ...lists[i], statusKey: role };
			}
		}
		return lists;
	}

	private async tagsByCard(cardId?: string): Promise<Map<string, TaskTagRecord[]>> {
		const rs = cardId
			? await this.client.execute({
				sql: `SELECT ct.card_id, t.id, t.title, t.created_at
					FROM card_tags ct
					JOIN tags t ON t.id = ct.tag_id
					WHERE ct.card_id = ?
					ORDER BY t.title COLLATE NOCASE`,
				args: [cardId],
			})
			: await this.client.execute(`
				SELECT ct.card_id, t.id, t.title, t.created_at
				FROM card_tags ct
				JOIN tags t ON t.id = ct.tag_id
				ORDER BY t.title COLLATE NOCASE
			`);
		const map = new Map<string, TaskTagRecord[]>();
		for (const row of rs.rows) {
			const id = String(row.card_id);
			const bucket = map.get(id) ?? [];
			bucket.push(mapTag(row));
			map.set(id, bucket);
		}
		return map;
	}

	private async findTag(id: string): Promise<TaskTagRecord | undefined> {
		if (!ID_RE.test(id)) {
			return undefined;
		}
		const rs = await this.client.execute({
			sql: 'SELECT id, title, created_at FROM tags WHERE id = ?',
			args: [id],
		});
		const row = rs.rows[0];
		return row ? mapTag(row) : undefined;
	}

	private async findTagByTitle(title: string): Promise<TaskTagRecord | undefined> {
		const rs = await this.client.execute({
			sql: 'SELECT id, title, created_at FROM tags WHERE title = ? COLLATE NOCASE',
			args: [title.trim()],
		});
		const row = rs.rows[0];
		return row ? mapTag(row) : undefined;
	}

	private async tagIds(): Promise<string[]> {
		const rs = await this.client.execute('SELECT id FROM tags');
		return rs.rows.map((row) => String(row.id));
	}

	private async replaceCardTags(cardId: string, tagIds: string[]): Promise<void> {
		await this.client.execute({ sql: 'DELETE FROM card_tags WHERE card_id = ?', args: [cardId] });
		const unique = [...new Set(tagIds.filter((id) => ID_RE.test(id)))];
		for (const tagId of unique) {
			if (!(await this.findTag(tagId))) {
				continue;
			}
			await this.client.execute({
				sql: 'INSERT OR IGNORE INTO card_tags (card_id, tag_id) VALUES (?, ?)',
				args: [cardId, tagId],
			});
		}
	}

	private async cardsInList(listId: string): Promise<TaskRecord[]> {
		return (await this.list()).filter((card) => card.listId === listId);
	}

	private async ids(): Promise<string[]> {
		const rs = await this.client.execute('SELECT id FROM cards');
		return rs.rows.map((row) => String(row.id));
	}

	private async listIds(): Promise<string[]> {
		const rs = await this.client.execute('SELECT id FROM lists');
		return rs.rows.map((row) => String(row.id));
	}

	private async nextCardPosition(listId: string): Promise<number> {
		const rs = await this.client.execute({
			sql: 'SELECT MAX(position) AS maxPos FROM cards WHERE list_id = ?',
			args: [listId],
		});
		return (Number(rs.rows[0]?.maxPos) || 0) + 1024;
	}

	private async nextListPosition(boardId: string): Promise<number> {
		const lists = await this.lists(boardId);
		if (lists.length === 0) {
			return 1024;
		}
		if (lists.length === 1) {
			return lists[0].position + 1024;
		}
		const last = lists[lists.length - 1];
		const prev = lists[lists.length - 2];
		if (last.position - prev.position < 1e-3) {
			await this.reindexBoardLists(boardId);
			const again = await this.lists(boardId);
			return midpoint(again[again.length - 2]?.position, again[again.length - 1]?.position);
		}
		return midpoint(prev.position, last.position);
	}

	private async reindexBoardLists(boardId: string): Promise<void> {
		const lists = await this.lists(boardId);
		for (let i = 0; i < lists.length; i += 1) {
			await this.client.execute({
				sql: 'UPDATE lists SET position = ? WHERE id = ?',
				args: [(i + 1) * 1024, lists[i].id],
			});
		}
	}

	private async reindexList(listId: string, movedId: string, beforeId?: string): Promise<void> {
		const moved = await this.find(movedId);
		if (!moved) {
			return;
		}
		const others = (await this.cardsInList(listId)).filter((row) => row.id !== movedId);
		const next: TaskRecord[] = [];
		let inserted = false;
		for (const row of others) {
			if (beforeId && row.id === beforeId) {
				next.push(moved);
				inserted = true;
			}
			next.push(row);
		}
		if (!inserted) {
			next.push(moved);
		}
		const now = Date.now();
		for (let i = 0; i < next.length; i += 1) {
			await this.client.execute({
				sql: 'UPDATE cards SET list_id = ?, position = ?, updated_at = ? WHERE id = ?',
				args: [listId, (i + 1) * 1024, now, next[i].id],
			});
		}
	}

	private async writeLegacy(row: TaskRecord): Promise<void> {
		await this.client.execute({
			sql: `INSERT INTO tasks (id, title, status, notes, createdAt, updatedAt, "order")
				VALUES (?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(id) DO UPDATE SET title = excluded.title, status = excluded.status,
					notes = excluded.notes, updatedAt = excluded.updatedAt, "order" = excluded."order"`,
			args: [row.id, row.title, row.status, row.notes, row.createdAt, row.updatedAt, Math.round(row.position)],
		});
	}
}

function mapCard(row: Row, tags: TaskTagRecord[] = []): TaskRecord {
	const status = statusFromKey(row.status_key);
	const position = Number(row.position) || 0;
	return {
		id: String(row.id),
		title: String(row.title),
		status,
		notes: String(row.notes ?? ''),
		createdAt: Number(row.created_at) || 0,
		updatedAt: Number(row.updated_at) || 0,
		order: position,
		listId: String(row.list_id),
		listTitle: String(row.list_title ?? ''),
		boardId: String(row.board_id),
		position,
		tags,
	};
}

function mapTag(row: Row): TaskTagRecord {
	return {
		id: String(row.id),
		title: String(row.title),
		createdAt: Number(row.created_at) || 0,
	};
}

function roleForIndex(index: number, count: number): TaskStatus {
	if (count <= 1 || index === 0) {
		return 'open';
	}
	if (index === count - 1) {
		return 'done';
	}
	return 'doing';
}

function mapList(row: Row): TaskListRecord {
	const key = String(row.status_key ?? '');
	return {
		id: String(row.id),
		boardId: String(row.board_id),
		title: String(row.title),
		position: Number(row.position) || 0,
		statusKey: STATUSES.has(key as TaskStatus) ? key as TaskStatus : '',
		createdAt: Number(row.created_at) || 0,
	};
}

function statusFromKey(value: unknown): TaskStatus {
	return STATUSES.has(value as TaskStatus) ? value as TaskStatus : 'open';
}

function normalizeStatus(value: unknown): TaskStatus {
	if (value === 'todo') {
		return 'open';
	}
	return STATUSES.has(value as TaskStatus) ? value as TaskStatus : 'open';
}

function midpoint(before?: number, after?: number): number {
	if (before == null && after == null) {
		return 1024;
	}
	if (before == null) {
		return after! / 2;
	}
	if (after == null) {
		return before + 1024;
	}
	return (before + after) / 2;
}
