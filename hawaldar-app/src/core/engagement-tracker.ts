import type { WorkflowRecord } from './playbook-store';
import { AGENT_ROLES, TOOL_CATALOG } from './tools/catalog';

export type EngagementPhaseStatus = 'pending' | 'active' | 'done' | 'failed' | 'skipped';

export interface EngagementPhase {
	id: string;
	label: string;
	status: EngagementPhaseStatus;
	detail: string;
	startedAt: number;
	endedAt: number;
}

export interface EngagementRun {
	runId: string;
	workflowId: string;
	workflowName: string;
	target: string;
	startedAt: number;
	finishedAt: number;
	ok: boolean | undefined;
	phases: EngagementPhase[];
}

/** Canonical stage order for the engagement rail (Shannon-style). Unknown phases append in run order. */
export const ENGAGEMENT_STAGE_ORDER = [
	'pre-recon',
	'source-review',
	'recon-surface',
	'web-recon',
	'vuln-detect',
	'poc-validate',
	'validate',
	'report',
	'correlate-report',
] as const;

const STAGE_LABELS: Record<string, string> = {
	'pre-recon': 'Pre-recon (SAST)',
	'source-review': 'Source review',
	'recon-surface': 'Reconnaissance',
	'web-recon': 'Web recon',
	'vuln-detect': 'Vulnerability analysis',
	'poc-validate': 'PoC validation',
	validate: 'Validation',
	report: 'Reporting',
	'correlate-report': 'Correlate & report',
};

type EngagementListener = (run: EngagementRun) => void;

function phaseLabel(id: string, workflowNames: Map<string, string>): string {
	if (STAGE_LABELS[id]) {
		return STAGE_LABELS[id];
	}
	const workflow = workflowNames.get(id);
	if (workflow) {
		return workflow;
	}
	const agent = AGENT_ROLES.find((role) => role.id === id);
	if (agent) {
		return agent.name;
	}
	const tool = TOOL_CATALOG.find((item) => item.id === id);
	if (tool) {
		return tool.title;
	}
	return id.replace(/[-_]+/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase());
}

function sortPhases(phases: EngagementPhase[]): EngagementPhase[] {
	const order = new Map<string, number>(ENGAGEMENT_STAGE_ORDER.map((id, index) => [id, index]));
	return [...phases].sort((a, b) => {
		const ai = order.get(a.id) ?? ENGAGEMENT_STAGE_ORDER.length;
		const bi = order.get(b.id) ?? ENGAGEMENT_STAGE_ORDER.length;
		return ai - bi;
	});
}

/**
 * In-memory tracker for the currently-running (or last) engagement workflow.
 * The findings DB is the durable record; this drives the live phase rail.
 */
export class EngagementTracker {
	private run: EngagementRun | undefined;
	private listeners = new Set<EngagementListener>();

	onChange(listener: EngagementListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	current(): EngagementRun | undefined {
		return this.run ? { ...this.run, phases: this.run.phases.map((phase) => ({ ...phase })) } : undefined;
	}

	private emit(): void {
		const snapshot = this.current();
		if (!snapshot) {
			return;
		}
		for (const listener of this.listeners) {
			listener(snapshot);
		}
	}

	begin(def: WorkflowRecord, target: string, workflowNames: Map<string, string>): EngagementRunHandle {
		const now = Date.now();
		this.run = {
			runId: `run-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
			workflowId: def.id,
			workflowName: def.name,
			target,
			startedAt: now,
			finishedAt: 0,
			ok: undefined,
			phases: sortPhases(def.steps.map((step) => ({
				id: step.id,
				label: phaseLabel(step.id, workflowNames),
				status: 'pending' as const,
				detail: '',
				startedAt: 0,
				endedAt: 0,
			}))),
		};
		this.emit();
		return new EngagementRunHandle(this);
	}

	phaseStart(id: string, detail = ''): void {
		const phase = this.run?.phases.find((item) => item.id === id);
		if (!phase) {
			return;
		}
		phase.status = 'active';
		phase.detail = detail;
		phase.startedAt = phase.startedAt || Date.now();
		this.emit();
	}

	phaseEnd(id: string, status: 'done' | 'failed' | 'skipped', detail = ''): void {
		const phase = this.run?.phases.find((item) => item.id === id);
		if (!phase) {
			return;
		}
		phase.status = status;
		if (detail) {
			phase.detail = detail.slice(0, 240);
		}
		phase.endedAt = Date.now();
		this.emit();
	}

	finish(ok: boolean): void {
		if (!this.run) {
			return;
		}
		for (const phase of this.run.phases) {
			if (phase.status === 'active') {
				phase.status = ok ? 'done' : 'failed';
				phase.endedAt = Date.now();
			}
		}
		this.run.ok = ok;
		this.run.finishedAt = Date.now();
		this.emit();
	}
}

export class EngagementRunHandle {
	constructor(private readonly tracker: EngagementTracker) {}

	phaseStart(id: string, detail = ''): void {
		this.tracker.phaseStart(id, detail);
	}

	phaseDone(id: string, detail = ''): void {
		this.tracker.phaseEnd(id, 'done', detail);
	}

	phaseFailed(id: string, detail = ''): void {
		this.tracker.phaseEnd(id, 'failed', detail);
	}

	finish(ok: boolean): void {
		this.tracker.finish(ok);
	}
}
