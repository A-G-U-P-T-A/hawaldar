/**
 * Smoke-test entry — bundled on the fly by scripts/smoke-tools.mjs (esbuild)
 * so the TypeScript core runs in plain Node, outside Electron. Do not run
 * this file directly.
 */
import { HawaldarRuntime } from '../src/core/runtime';
import { SettingsStore } from '../src/core/settings';
import { executeTool } from '../src/core/tools/index';
import type { HitlAsk } from '../src/core/hitl';

export interface SmokeRow {
	id: string;
	status: 'PASS' | 'FAIL' | 'SKIP';
	detail: string;
	ms: number;
}

const TARGET = 'http://127.0.0.1:3000';

/** Non-gated tools exercised against the running Juice Shop / loopback. */
const SAFE: Array<{ id: string; input?: Record<string, unknown> }> = [
	{ id: 'runtime_status' },
	{ id: 'juice-shop-status' },
	{ id: 'finding-list' },
	{ id: 'knowledge-search', input: { query: 'juice shop' } },
	{ id: 'httpx', input: { target: TARGET } },
	{ id: 'httpx-title', input: { target: TARGET } },
	{ id: 'katana', input: { target: TARGET } },
	{ id: 'scrapling-fetch', input: { url: TARGET } },
	{ id: 'naabu', input: { target: '127.0.0.1:3000' } },
	{ id: 'scan-top-ports', input: { target: '127.0.0.1', topPorts: 25 } },
	{ id: 'dns-resolve', input: { target: 'localhost' } },
	{ id: 'semgrep-list' },
	{ id: 'semgrep-scan' },
	{ id: 'nuclei-tech', input: { target: TARGET } },
];

/** HITL / PoC / intrusive tools: listed, never executed here. */
const SKIP_APPROVAL = [
	'poc-request',
	'poc-act',
	'poc-xss-canary',
	'sqlmap-scan',
	'zap-ascan',
	'msf-check',
	'msf-run',
];

/** Starts the ZAP daemon (HITL) and its image is not built on this machine. */
const SKIP_IMAGE = ['zap-status'];

function firstLine(value: unknown): string {
	const text = typeof value === 'string' ? value : JSON.stringify(value);
	const line = (text || '').split(/\r?\n/).find((l) => l.trim()) ?? '';
	return line.trim().slice(0, 140);
}

function malformed(id: string, result: unknown): SmokeRow | undefined {
	if (result === undefined || result === null) {
		return { id, status: 'FAIL', detail: 'returned undefined/null', ms: 0 };
	}
	if (typeof result !== 'object') {
		return { id, status: 'FAIL', detail: `returned ${typeof result}`, ms: 0 };
	}
	const rec = result as Record<string, unknown>;
	if (typeof rec.ok !== 'boolean' || typeof rec.stdout !== 'string') {
		return { id, status: 'FAIL', detail: `malformed result: ${firstLine(result)}`, ms: 0 };
	}
	return undefined;
}

export async function runSmoke(appRoot: string, onRow?: (row: SmokeRow) => void): Promise<SmokeRow[]> {
	const store = new SettingsStore(path.join(appRoot, 'resources'));
	// Headless: settings.json apiKey is Electron-safeStorage encrypted; tools do
	// not need a provider key, so blank it rather than decrypting garbage.
	const origRead = store.read.bind(store);
	(store as any).read = async () => ({ ...(await origRead()), apiKey: '' });
	const runtime = new HawaldarRuntime(store);
	await (runtime as any).ready;

	// Every tool we execute has its image built locally, so approving the
	// tool-image gate only marks the service started (no builds/pulls). PoC /
	// intrusive tools are never executed here, so their asks never arrive.
	const askHitl = async (req: HitlAsk) => req.kind === 'tool-image' || req.kind === 'podman';

	const rows: SmokeRow[] = [];
	const push = (row: SmokeRow) => {
		rows.push(row);
		onRow?.(row);
	};

	for (const skip of SKIP_APPROVAL) {
		push({ id: skip, status: 'SKIP', detail: 'approval-gated (PoC/intrusive)', ms: 0 });
	}
	for (const skip of SKIP_IMAGE) {
		push({ id: skip, status: 'SKIP', detail: 'daemon start is HITL-gated; zap image not built', ms: 0 });
	}

	for (const item of SAFE) {
		const started = Date.now();
		try {
			if (item.id === 'runtime_status') {
				const snap = await runtime.snapshot();
				const okShape = Boolean(snap) && typeof snap === 'object' && Array.isArray((snap as any).tools);
				push({
					id: item.id,
					status: okShape ? 'PASS' : 'FAIL',
					detail: okShape
						? `model=${(snap as any).model} tools=${(snap as any).tools.length} agents=${(snap as any).agents?.length ?? '?'}`
						: 'snapshot returned a malformed object',
					ms: Date.now() - started,
				});
				continue;
			}
			const result = await runtime.withHitl(askHitl, async () => {
				const settings = await store.read();
				return executeTool(settings, item.id, (item.input ?? {}) as any, (runtime as any).toolExecOptions());
			});
			const bad = malformed(item.id, result);
			if (bad) {
				bad.ms = Date.now() - started;
				push(bad);
				continue;
			}
			const rec = result as { ok: boolean; stdout: string; stderr?: string };
			push({
				id: item.id,
				status: rec.ok ? 'PASS' : 'FAIL',
				detail: rec.ok ? firstLine(rec.stdout) : firstLine(rec.stderr || rec.stdout) || 'ok=false',
				ms: Date.now() - started,
			});
		} catch (error) {
			push({
				id: item.id,
				status: 'FAIL',
				detail: `threw: ${error instanceof Error ? error.message : String(error)}`.slice(0, 160),
				ms: Date.now() - started,
			});
		}
	}
	return rows;
}
