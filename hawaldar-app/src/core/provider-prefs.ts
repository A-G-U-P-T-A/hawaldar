import { createClient, type Client } from '@libsql/client';
import { dataHomePaths, ensureDataHome, sqliteFileUrl } from './data-home';
import { getProvider } from './providers';

const ROW_ID = 'active';

export interface ProviderState {
	provider: string;
	model: string;
	baseUrl: string;
	/** Active provider id (the one selected for chat). */
	enabled: string;
	/** True only after the user saves a provider in Settings. */
	hasSelected: boolean;
	updatedAt: number;
	/** Reasoning toggle. Not the API key. */
	thinking: boolean;
}

export class ProviderPrefsStore {
	readonly databasePath: string;
	readonly ready: Promise<void>;
	private client: Client;

	constructor(dataDir: string) {
		ensureDataHome(dataDir);
		this.databasePath = dataHomePaths(dataDir).hawaldarDb;
		this.client = createClient({ url: sqliteFileUrl(this.databasePath) });
		this.ready = this.init();
	}

	async get(): Promise<ProviderState | undefined> {
		try {
			await this.ready;
			let row: Record<string, unknown> | undefined;
			try {
				const rs = await this.client.execute({
					sql: 'SELECT provider, model, baseUrl, enabled, hasSelected, updatedAt, thinking FROM provider_state WHERE id = ?',
					args: [ROW_ID],
				});
				row = rs.rows[0] as Record<string, unknown> | undefined;
			} catch {
				const rs = await this.client.execute({
					sql: 'SELECT provider, model, baseUrl, enabled, hasSelected, updatedAt FROM provider_state WHERE id = ?',
					args: [ROW_ID],
				});
				row = rs.rows[0] as Record<string, unknown> | undefined;
			}
			if (!row) {
				return undefined;
			}
			return parseProviderState(row);
		} catch {
			return undefined;
		}
	}

	async upsert(input: {
		provider: string;
		model: string;
		baseUrl: string;
		enabled?: string;
		hasSelected?: boolean;
		updatedAt?: number;
		thinking?: boolean;
	}): Promise<ProviderState | undefined> {
		const record = normalizeProviderState({
			provider: input.provider,
			model: input.model,
			baseUrl: input.baseUrl,
			enabled: input.enabled || input.provider,
			hasSelected: input.hasSelected ?? true,
			updatedAt: input.updatedAt ?? Date.now(),
			thinking: input.thinking === true,
		});
		if (!record) {
			return undefined;
		}
		try {
			await this.ready;
			await this.client.execute({
				sql: `INSERT INTO provider_state (id, provider, model, baseUrl, enabled, hasSelected, updatedAt, thinking)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?)
					ON CONFLICT(id) DO UPDATE SET
						provider = excluded.provider,
						model = excluded.model,
						baseUrl = excluded.baseUrl,
						enabled = excluded.enabled,
						hasSelected = excluded.hasSelected,
						updatedAt = excluded.updatedAt,
						thinking = excluded.thinking`,
				args: [
					ROW_ID,
					record.provider,
					record.model,
					record.baseUrl,
					record.enabled,
					record.hasSelected ? 1 : 0,
					record.updatedAt,
					record.thinking ? 1 : 0,
				],
			});
			return record;
		} catch {
			return undefined;
		}
	}

	private async init(): Promise<void> {
		await this.client.execute(`
			CREATE TABLE IF NOT EXISTS provider_state (
				id TEXT PRIMARY KEY NOT NULL,
				provider TEXT NOT NULL,
				model TEXT NOT NULL,
				baseUrl TEXT NOT NULL,
				enabled TEXT NOT NULL,
				hasSelected INTEGER NOT NULL DEFAULT 0,
				updatedAt INTEGER NOT NULL,
				thinking INTEGER NOT NULL DEFAULT 0
			)
		`);
		try {
			await this.client.execute(
				'ALTER TABLE provider_state ADD COLUMN hasSelected INTEGER NOT NULL DEFAULT 0',
			);
		} catch {
			/* column already exists */
		}
		try {
			await this.client.execute(
				'ALTER TABLE provider_state ADD COLUMN thinking INTEGER NOT NULL DEFAULT 0',
			);
		} catch {
			/* column already exists */
		}
	}
}

function parseProviderState(row: {
	provider?: unknown;
	model?: unknown;
	baseUrl?: unknown;
	enabled?: unknown;
	hasSelected?: unknown;
	updatedAt?: unknown;
	thinking?: unknown;
}): ProviderState | undefined {
	return normalizeProviderState({
		provider: String(row.provider ?? ''),
		model: String(row.model ?? ''),
		baseUrl: String(row.baseUrl ?? ''),
		enabled: String(row.enabled ?? row.provider ?? ''),
		hasSelected: row.hasSelected === 1 || row.hasSelected === true || row.hasSelected === '1',
		updatedAt: Number(row.updatedAt) || 0,
		thinking: row.thinking === 1 || row.thinking === true || row.thinking === '1',
	});
}

function normalizeProviderState(raw: ProviderState): ProviderState | undefined {
	const provider = raw.provider.trim();
	if (!provider || !getProvider(provider)) {
		return undefined;
	}
	const enabled = raw.enabled.trim() || provider;
	return {
		provider,
		model: raw.model.trim(),
		baseUrl: raw.baseUrl.replace(/\/$/, ''),
		enabled: getProvider(enabled) ? enabled : provider,
		hasSelected: Boolean(raw.hasSelected) && Boolean(getProvider(enabled) || getProvider(provider)),
		updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0,
		thinking: Boolean(raw.thinking),
	};
}
