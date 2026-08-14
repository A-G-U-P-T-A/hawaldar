import { createClient, type Client } from '@libsql/client';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROW_ID = 'current';
const DATA_DIR = path.join(os.homedir(), '.hawaldar');
const DATABASE_PATH = path.join(DATA_DIR, 'mastra.db');

export interface RuntimeStateRow {
	engine: 'podman' | 'docker';
	resolvedPath: string;
	machineName: string;
	machineRunning: boolean;
	lastSetupOk: boolean;
	lastError: string;
	updatedAt: number;
}

export interface PersistRuntimeExtras {
	lastSetupOk?: boolean;
	lastError?: string;
}

let clientPromise: Promise<Client> | null = null;

function fileUrl(filePath: string): string {
	return `file:${filePath.replace(/\\/g, '/')}`;
}

async function client(): Promise<Client> {
	if (!clientPromise) {
		clientPromise = (async () => {
			fs.mkdirSync(DATA_DIR, { recursive: true });
			const db = createClient({ url: fileUrl(DATABASE_PATH) });
			await db.execute(`
				CREATE TABLE IF NOT EXISTS runtime_state (
					id TEXT PRIMARY KEY NOT NULL,
					engine TEXT NOT NULL DEFAULT 'podman',
					resolvedPath TEXT NOT NULL DEFAULT '',
					machineName TEXT NOT NULL DEFAULT '',
					machineRunning INTEGER NOT NULL DEFAULT 0,
					lastSetupOk INTEGER NOT NULL DEFAULT 0,
					lastError TEXT NOT NULL DEFAULT '',
					updatedAt INTEGER NOT NULL DEFAULT 0
				)
			`);
			return db;
		})();
	}
	return clientPromise;
}

function asEngine(value: unknown): 'podman' | 'docker' {
	return value === 'docker' ? 'docker' : 'podman';
}

function fromRow(row: Record<string, unknown>): RuntimeStateRow {
	return {
		engine: asEngine(row.engine),
		resolvedPath: String(row.resolvedPath ?? ''),
		machineName: String(row.machineName ?? ''),
		machineRunning: Number(row.machineRunning) === 1,
		lastSetupOk: Number(row.lastSetupOk) === 1,
		lastError: String(row.lastError ?? ''),
		updatedAt: Number(row.updatedAt) || 0,
	};
}

export async function readRuntimeState(): Promise<RuntimeStateRow | null> {
	try {
		const db = await client();
		const result = await db.execute({
			sql: 'SELECT engine, resolvedPath, machineName, machineRunning, lastSetupOk, lastError, updatedAt FROM runtime_state WHERE id = ?',
			args: [ROW_ID],
		});
		const row = result.rows[0] as Record<string, unknown> | undefined;
		return row ? fromRow(row) : null;
	} catch {
		return null;
	}
}

export async function upsertRuntimeState(row: RuntimeStateRow): Promise<RuntimeStateRow> {
	const db = await client();
	await db.execute({
		sql: `INSERT INTO runtime_state (
				id, engine, resolvedPath, machineName, machineRunning, lastSetupOk, lastError, updatedAt
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(id) DO UPDATE SET
				engine = excluded.engine,
				resolvedPath = excluded.resolvedPath,
				machineName = excluded.machineName,
				machineRunning = excluded.machineRunning,
				lastSetupOk = excluded.lastSetupOk,
				lastError = excluded.lastError,
				updatedAt = excluded.updatedAt`,
		args: [
			ROW_ID,
			row.engine,
			row.resolvedPath,
			row.machineName,
			row.machineRunning ? 1 : 0,
			row.lastSetupOk ? 1 : 0,
			row.lastError,
			row.updatedAt,
		],
	});
	return row;
}

export async function persistRuntimeFromStatus(
	status: {
		engine: 'podman' | 'docker';
		resolvedPath: string;
		availability: string;
		error?: string;
		machines: Array<{ name: string; running: boolean; lastUp?: string }>;
	},
	extras?: PersistRuntimeExtras,
): Promise<RuntimeStateRow> {
	const prev = await readRuntimeState();
	const runningMachine = status.machines.find((item) => item.running);
	const firstMachine = status.machines[0];
	const machineRunning = status.engine === 'docker'
		? status.availability === 'ok'
		: Boolean(runningMachine);
	const lastSetupOk = Boolean(
		prev?.lastSetupOk
		|| extras?.lastSetupOk
		|| status.availability === 'ok'
		|| status.machines.some((item) => Boolean(item.lastUp)),
	);
	const lastError = extras?.lastError !== undefined
		? extras.lastError
		: (status.availability === 'ok' ? '' : (status.error || prev?.lastError || ''));

	return upsertRuntimeState({
		engine: status.engine,
		resolvedPath: status.resolvedPath,
		machineName: runningMachine?.name || firstMachine?.name || prev?.machineName || '',
		machineRunning,
		lastSetupOk,
		lastError,
		updatedAt: Date.now(),
	});
}
