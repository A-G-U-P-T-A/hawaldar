import { createClient, type Client } from '@libsql/client';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { rejectForbiddenTool } from './policy';
import { isServiceStarted, serviceRequiredMessage } from './sandbox/podman-services';
import type { HawaldarSettings } from './settings';
import { AGENT_ROLES, TOOL_CATALOG } from './tools/catalog';

export type WorkflowStepKind = 'tool' | 'agent';

export interface WorkflowStep {
	kind: WorkflowStepKind;
	id: string;
}

export interface WorkflowRecord {
	id: string;
	key: string;
	name: string;
	steps: WorkflowStep[];
	enabled: boolean;
	builtin: boolean;
	updatedAt: number;
}

export type RuleKind = 'require_service' | 'max_timeout' | 'allowed_tools' | 'blocked_tools';

export interface RuleDefinition {
	workflowId?: string;
	serviceId?: string;
	timeoutMs?: number;
	toolIds?: string[];
}

export interface RuleRecord {
	id: string;
	name: string;
	kind: RuleKind;
	definition: RuleDefinition;
	enabled: boolean;
	updatedAt: number;
}

export interface WorkflowWrite {
	id?: string;
	name: string;
	steps: WorkflowStep[];
	enabled?: boolean;
}

export interface RuleWrite {
	id?: string;
	name: string;
	kind: RuleKind;
	definition: RuleDefinition;
	enabled?: boolean;
}

export interface RuleDecision {
	ok: boolean;
	reason: string;
	maxTimeoutMs?: number;
}

const ID_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const RULE_KINDS = new Set<RuleKind>(['require_service', 'max_timeout', 'allowed_tools', 'blocked_tools']);
const FORBIDDEN_STEP = /metasploit|msfconsole|msfvenom|sqlmap|stealth|os-?detect|exploit/i;

const BUILTIN_WORKFLOWS: WorkflowRecord[] = [
	{
		id: 'authorized-recon',
		key: 'authorizedRecon',
		name: 'Authorized recon',
		steps: [
			{ kind: 'tool', id: 'discover-hosts' },
			{ kind: 'tool', id: 'quick-scan' },
			{ kind: 'tool', id: 'detect-services' },
		],
		enabled: true,
		builtin: true,
		updatedAt: 0,
	},
	{
		id: 'pd-recon',
		key: 'pdRecon',
		name: 'ProjectDiscovery recon',
		steps: [
			{ kind: 'tool', id: 'subfinder' },
			{ kind: 'tool', id: 'dnsx' },
			{ kind: 'tool', id: 'httpx' },
		],
		enabled: true,
		builtin: true,
		updatedAt: 0,
	},
	{
		id: 'binary-triage',
		key: 'binaryTriage',
		name: 'Binary triage',
		steps: [
			{ kind: 'tool', id: 'list_methods' },
			{ kind: 'tool', id: 'r2_info' },
			{ kind: 'tool', id: 'binwalk_scan' },
		],
		enabled: true,
		builtin: true,
		updatedAt: 0,
	},
	{
		id: 'pcap-review',
		key: 'pcapReview',
		name: 'Pcap review',
		steps: [
			{ kind: 'tool', id: 'analyze_pcap' },
			{ kind: 'tool', id: 'get_summary_stats' },
			{ kind: 'tool', id: 'get_conversations' },
		],
		enabled: true,
		builtin: true,
		updatedAt: 0,
	},
];

export function toMastraKey(id: string): string {
	return id.replace(/-([a-z0-9])/g, (_m, ch: string) => ch.toUpperCase()).replace(/[^a-zA-Z0-9]/g, '');
}

export function slugify(name: string, fallback: string): string {
	const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
	return ID_RE.test(slug) ? slug : fallback;
}

export function findWorkflow(list: WorkflowRecord[], keyOrId: string): WorkflowRecord | undefined {
	return list.find((item) => item.id === keyOrId || item.key === keyOrId);
}

export function evaluatePlaybookRules(
	rules: RuleRecord[],
	workflow: WorkflowRecord,
	settings: HawaldarSettings,
): RuleDecision {
	let maxTimeoutMs: number | undefined;
	const toolSteps = workflow.steps.filter((step) => step.kind === 'tool').map((step) => step.id);

	for (const rule of rules) {
		if (!rule.enabled) {
			continue;
		}
		const scoped = rule.definition.workflowId;
		if (scoped && scoped !== workflow.id && scoped !== workflow.key) {
			continue;
		}
		if (rule.kind === 'require_service') {
			const serviceId = rule.definition.serviceId?.trim();
			if (serviceId) {
				if (!isServiceStarted(settings, serviceId)) {
					return { ok: false, reason: `Rule "${rule.name}": ${serviceRequiredMessage(serviceId)}` };
				}
			} else {
				for (const toolId of toolSteps) {
					const agentId = agentForTool(settings, toolId);
					if (agentId && !isServiceStarted(settings, agentId)) {
						return { ok: false, reason: `Rule "${rule.name}": ${serviceRequiredMessage(agentId)}` };
					}
				}
			}
		}
		if (rule.kind === 'allowed_tools') {
			const allowed = new Set((rule.definition.toolIds || []).map((id) => id.trim()).filter(Boolean));
			const blocked = toolSteps.filter((id) => !allowed.has(id));
			if (blocked.length > 0) {
				return { ok: false, reason: `Rule "${rule.name}": tools not allowed for this workflow: ${blocked.join(', ')}` };
			}
		}
		if (rule.kind === 'blocked_tools') {
			const deny = new Set((rule.definition.toolIds || []).map((id) => id.trim()).filter(Boolean));
			const hit = toolSteps.filter((id) => deny.has(id));
			if (hit.length > 0) {
				return { ok: false, reason: `Rule "${rule.name}": blocked tools: ${hit.join(', ')}` };
			}
		}
		if (rule.kind === 'max_timeout') {
			const ms = Number(rule.definition.timeoutMs);
			if (Number.isFinite(ms) && ms >= 1_000) {
				maxTimeoutMs = maxTimeoutMs === undefined ? ms : Math.min(maxTimeoutMs, ms);
			}
		}
	}
	return { ok: true, reason: 'ok', maxTimeoutMs };
}

/** Apply enabled rules to a single tool call (agent or workflow step). Workflow-scoped rules are skipped unless `workflow` is set. */
export function evaluateToolRules(
	rules: RuleRecord[],
	toolId: string,
	settings: HawaldarSettings,
	workflow?: WorkflowRecord,
): RuleDecision {
	let maxTimeoutMs: number | undefined;
	for (const rule of rules) {
		if (!rule.enabled) {
			continue;
		}
		const scoped = rule.definition.workflowId;
		if (scoped) {
			if (!workflow || (scoped !== workflow.id && scoped !== workflow.key)) {
				continue;
			}
		}
		if (rule.kind === 'blocked_tools') {
			const deny = new Set((rule.definition.toolIds || []).map((id) => id.trim()).filter(Boolean));
			if (deny.has(toolId)) {
				return { ok: false, reason: `Rule "${rule.name}": tool ${toolId} is blocked.` };
			}
		}
		if (rule.kind === 'allowed_tools') {
			const allowed = new Set((rule.definition.toolIds || []).map((id) => id.trim()).filter(Boolean));
			if (allowed.size > 0 && !allowed.has(toolId)) {
				return { ok: false, reason: `Rule "${rule.name}": tool ${toolId} is not on the allow list.` };
			}
		}
		if (rule.kind === 'require_service') {
			const serviceId = rule.definition.serviceId?.trim() || agentForTool(settings, toolId);
			if (serviceId && !isServiceStarted(settings, serviceId)) {
				return { ok: false, reason: `Rule "${rule.name}": ${serviceRequiredMessage(serviceId)}` };
			}
		}
		if (rule.kind === 'max_timeout') {
			const ms = Number(rule.definition.timeoutMs);
			if (Number.isFinite(ms) && ms >= 1_000) {
				maxTimeoutMs = maxTimeoutMs === undefined ? ms : Math.min(maxTimeoutMs, ms);
			}
		}
	}
	return { ok: true, reason: 'ok', maxTimeoutMs };
}

function agentForTool(settings: HawaldarSettings, toolId: string): string | undefined {
	return TOOL_CATALOG.find((tool) => tool.id === toolId)?.agentId
		|| settings.customTools.find((tool) => tool.id === toolId)?.agentId;
}

export function assertSafeSteps(steps: WorkflowStep[], settings?: HawaldarSettings): string | undefined {
	if (!Array.isArray(steps) || steps.length === 0) {
		return 'Add at least one tool or agent step.';
	}
	if (steps.length > 16) {
		return 'A workflow can have at most 16 steps.';
	}
	const knownAgents = new Set(AGENT_ROLES.map((item) => item.id));
	const knownTools = new Set([
		...TOOL_CATALOG.map((item) => item.id),
		...(settings?.customTools || []).map((item) => item.id),
	]);
	for (const step of steps) {
		if (!step || (step.kind !== 'tool' && step.kind !== 'agent')) {
			return 'Each step must be a tool or an agent.';
		}
		if (!ID_RE.test(step.id) && !/^[a-z][a-z0-9_]*$/i.test(step.id)) {
			return `Invalid step id: ${step.id}`;
		}
		if (FORBIDDEN_STEP.test(step.id) || rejectForbiddenTool(step.id)) {
			return `${step.id} is outside Hawaldar policy.`;
		}
		if (step.kind === 'agent' && !knownAgents.has(step.id)) {
			return `Unknown agent: ${step.id}`;
		}
		if (step.kind === 'tool' && knownTools.size > 0 && !knownTools.has(step.id)) {
			return `Unknown tool: ${step.id}`;
		}
	}
	return undefined;
}

export class PlaybookStore {
	readonly databasePath: string;
	readonly ready: Promise<void>;
	private client: Client;
	private workflows: WorkflowRecord[] = [];
	private rules: RuleRecord[] = [];

	constructor(dataDir: string) {
		fs.mkdirSync(dataDir, { recursive: true });
		this.databasePath = process.env.HAWALDAR_DATABASE_PATH || path.join(dataDir, 'hawaldar.db');
		this.client = createClient({ url: `file:${this.databasePath}` });
		this.ready = this.init();
	}

	listWorkflows(): WorkflowRecord[] {
		return this.workflows.map((item) => ({ ...item, steps: item.steps.map((step) => ({ ...step })) }));
	}

	listRules(): RuleRecord[] {
		return this.rules.map((item) => ({ ...item, definition: { ...item.definition } }));
	}

	getWorkflow(keyOrId: string): WorkflowRecord | undefined {
		const found = findWorkflow(this.workflows, keyOrId);
		return found ? { ...found, steps: found.steps.map((step) => ({ ...step })) } : undefined;
	}

	async refresh(): Promise<void> {
		await this.ready;
		this.workflows = await this.readWorkflows();
		this.rules = await this.readRules();
	}

	async upsertWorkflow(draft: WorkflowWrite, settings?: HawaldarSettings): Promise<WorkflowRecord> {
		await this.ready;
		const name = draft.name.trim();
		if (!name) {
			throw new Error('Workflow name is required.');
		}
		const stepError = assertSafeSteps(draft.steps, settings);
		if (stepError) {
			throw new Error(stepError);
		}
		const existing = draft.id ? this.workflows.find((item) => item.id === draft.id) : undefined;
		const id = existing?.id || uniqueId(slugify(name, 'workflow'), this.workflows.map((item) => item.id));
		if (!ID_RE.test(id)) {
			throw new Error('Workflow id must be a lowercase slug.');
		}
		const now = Date.now();
		const record: WorkflowRecord = {
			id,
			key: existing?.key || toMastraKey(id),
			name,
			steps: draft.steps.map((step) => ({ kind: step.kind, id: step.id })),
			enabled: draft.enabled ?? existing?.enabled ?? true,
			builtin: existing?.builtin ?? false,
			updatedAt: now,
		};
		await this.client.execute({
			sql: `INSERT INTO workflows (id, name, steps, enabled, updatedAt)
				VALUES (?, ?, ?, ?, ?)
				ON CONFLICT(id) DO UPDATE SET name = excluded.name, steps = excluded.steps,
					enabled = excluded.enabled, updatedAt = excluded.updatedAt`,
			args: [record.id, record.name, JSON.stringify(record.steps), record.enabled ? 1 : 0, record.updatedAt],
		});
		await this.refresh();
		return this.getWorkflow(record.id)!;
	}

	async setWorkflowEnabled(id: string, enabled: boolean): Promise<WorkflowRecord> {
		await this.ready;
		const existing = this.workflows.find((item) => item.id === id);
		if (!existing) {
			throw new Error(`Unknown workflow: ${id}`);
		}
		await this.client.execute({
			sql: 'UPDATE workflows SET enabled = ?, updatedAt = ? WHERE id = ?',
			args: [enabled ? 1 : 0, Date.now(), id],
		});
		await this.refresh();
		return this.getWorkflow(id)!;
	}

	async removeWorkflow(id: string): Promise<void> {
		await this.ready;
		const existing = this.workflows.find((item) => item.id === id);
		if (!existing) {
			return;
		}
		if (existing.builtin) {
			throw new Error('Built-in workflows can be disabled, not deleted.');
		}
		await this.client.execute({ sql: 'DELETE FROM workflows WHERE id = ?', args: [id] });
		await this.refresh();
	}

	async upsertRule(draft: RuleWrite): Promise<RuleRecord> {
		await this.ready;
		const name = draft.name.trim();
		if (!name) {
			throw new Error('Rule name is required.');
		}
		if (!RULE_KINDS.has(draft.kind)) {
			throw new Error('Unknown rule kind.');
		}
		const definition = normalizeRuleDefinition(draft.kind, draft.definition || {});
		const existing = draft.id ? this.rules.find((item) => item.id === draft.id) : undefined;
		const id = existing?.id || uniqueId(slugify(name, 'rule'), this.rules.map((item) => item.id));
		const now = Date.now();
		const record: RuleRecord = {
			id,
			name,
			kind: draft.kind,
			definition,
			enabled: draft.enabled ?? existing?.enabled ?? true,
			updatedAt: now,
		};
		await this.client.execute({
			sql: `INSERT INTO rules (id, name, definition, enabled, updatedAt)
				VALUES (?, ?, ?, ?, ?)
				ON CONFLICT(id) DO UPDATE SET name = excluded.name, definition = excluded.definition,
					enabled = excluded.enabled, updatedAt = excluded.updatedAt`,
			args: [record.id, record.name, JSON.stringify({ kind: record.kind, ...record.definition }), record.enabled ? 1 : 0, record.updatedAt],
		});
		await this.refresh();
		return this.rules.find((item) => item.id === record.id)!;
	}

	async setRuleEnabled(id: string, enabled: boolean): Promise<RuleRecord> {
		await this.ready;
		if (!this.rules.some((item) => item.id === id)) {
			throw new Error(`Unknown rule: ${id}`);
		}
		await this.client.execute({
			sql: 'UPDATE rules SET enabled = ?, updatedAt = ? WHERE id = ?',
			args: [enabled ? 1 : 0, Date.now(), id],
		});
		await this.refresh();
		return this.rules.find((item) => item.id === id)!;
	}

	async removeRule(id: string): Promise<void> {
		await this.ready;
		await this.client.execute({ sql: 'DELETE FROM rules WHERE id = ?', args: [id] });
		await this.refresh();
	}

	private async init(): Promise<void> {
		await this.client.executeMultiple(`
			CREATE TABLE IF NOT EXISTS workflows (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL,
				steps TEXT NOT NULL,
				enabled INTEGER NOT NULL DEFAULT 1,
				updatedAt INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS rules (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL,
				definition TEXT NOT NULL,
				enabled INTEGER NOT NULL DEFAULT 1,
				updatedAt INTEGER NOT NULL
			);
		`);
		const existing = await this.readWorkflows();
		const have = new Set(existing.map((item) => item.id));
		const now = Date.now();
		for (const seed of BUILTIN_WORKFLOWS) {
			if (have.has(seed.id)) {
				continue;
			}
			await this.client.execute({
				sql: 'INSERT INTO workflows (id, name, steps, enabled, updatedAt) VALUES (?, ?, ?, ?, ?)',
				args: [seed.id, seed.name, JSON.stringify(seed.steps), 1, now],
			});
		}
		this.workflows = await this.readWorkflows();
		this.rules = await this.readRules();
	}

	private async readWorkflows(): Promise<WorkflowRecord[]> {
		const rs = await this.client.execute('SELECT id, name, steps, enabled, updatedAt FROM workflows ORDER BY name COLLATE NOCASE');
		return rs.rows.map((row) => {
			const id = String(row.id);
			const seed = BUILTIN_WORKFLOWS.find((item) => item.id === id);
			return {
				id,
				key: seed?.key || toMastraKey(id),
				name: String(row.name),
				steps: parseSteps(row.steps),
				enabled: Number(row.enabled) !== 0,
				builtin: Boolean(seed),
				updatedAt: Number(row.updatedAt) || 0,
			};
		});
	}

	private async readRules(): Promise<RuleRecord[]> {
		const rs = await this.client.execute('SELECT id, name, definition, enabled, updatedAt FROM rules ORDER BY name COLLATE NOCASE');
		return rs.rows.map((row) => {
			const parsed = parseRuleDefinition(row.definition);
			return {
				id: String(row.id),
				name: String(row.name),
				kind: parsed.kind,
				definition: parsed.definition,
				enabled: Number(row.enabled) !== 0,
				updatedAt: Number(row.updatedAt) || 0,
			};
		});
	}
}

function uniqueId(base: string, taken: string[]): string {
	if (!taken.includes(base) && ID_RE.test(base)) {
		return base;
	}
	let i = 2;
	while (taken.includes(`${base}-${i}`)) {
		i += 1;
	}
	return `${base}-${i}`;
}

function parseSteps(raw: unknown): WorkflowStep[] {
	try {
		const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
		if (!Array.isArray(parsed)) {
			return [];
		}
		return parsed
			.filter((item) => item && (item.kind === 'tool' || item.kind === 'agent') && typeof item.id === 'string')
			.map((item) => ({ kind: item.kind as WorkflowStepKind, id: String(item.id) }));
	} catch {
		return [];
	}
}

function parseRuleDefinition(raw: unknown): { kind: RuleKind; definition: RuleDefinition } {
	try {
		const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
		const kind = RULE_KINDS.has(parsed?.kind) ? parsed.kind as RuleKind : 'require_service';
		return { kind, definition: normalizeRuleDefinition(kind, parsed && typeof parsed === 'object' ? parsed : {}) };
	} catch {
		return { kind: 'require_service', definition: {} };
	}
}

function normalizeRuleDefinition(kind: RuleKind, raw: RuleDefinition): RuleDefinition {
	const workflowId = typeof raw.workflowId === 'string' && raw.workflowId.trim() ? raw.workflowId.trim() : undefined;
	if (kind === 'require_service') {
		const serviceId = typeof raw.serviceId === 'string' && raw.serviceId.trim() ? raw.serviceId.trim() : undefined;
		return { workflowId, serviceId };
	}
	if (kind === 'max_timeout') {
		const timeoutMs = Math.min(Math.max(Number(raw.timeoutMs) || 180_000, 1_000), 600_000);
		return { workflowId, timeoutMs };
	}
	const toolIds = Array.isArray(raw.toolIds)
		? raw.toolIds.map((id) => String(id).trim()).filter(Boolean)
		: [];
	return { workflowId, toolIds };
}
