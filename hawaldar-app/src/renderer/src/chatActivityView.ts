import type { ChatActivityEvent } from '../../preload/api';
import { toDisplayText } from './displayText';
import { TOOL_CATALOG } from './toolMeta';

export interface ActivityStep {
	id: string;
	type: ChatActivityEvent['type'];
	name: string;
	detail: string;
	status: ChatActivityEvent['status'];
}

export function lastIndexWhere<T>(items: T[], pred: (item: T) => boolean): number {
	for (let i = items.length - 1; i >= 0; i--) {
		if (pred(items[i])) return i;
	}
	return -1;
}

/** Weak detail (empty / placeholder) must never overwrite a good one. */
function isWeakActivityDetail(text: string): boolean {
	const t = text.trim();
	return !t || /^unknown error$/i.test(t) || t === '[object Object]' || t === '{}' || t === '[]';
}

function preferActivityDetail(incoming: string, existing: string): string {
	if (isWeakActivityDetail(incoming)) return existing;
	if (isWeakActivityDetail(existing)) return incoming;
	if (incoming.includes('://') && !existing.includes('://')) return incoming;
	if (/:\d+/.test(incoming) && !/:\d+/.test(existing)) return incoming;
	return incoming || existing;
}

export function applyActivity(steps: ActivityStep[], ev: ChatActivityEvent): ActivityStep[] {
	if (!ev || typeof ev !== 'object') {
		return steps;
	}
	const name = typeof ev.name === 'string' && ev.name ? ev.name : 'tool';
	const next = steps.slice();
	const detail = ev.detail ? toDisplayText(ev.detail) : '';
	if (ev.type === 'agent') {
		if (next.some((step) => step.type === 'agent' && step.name === name)) return next;
		next.push({
			id: `agent-${name}`,
			type: 'agent',
			name,
			detail: detail || name,
			status: 'ok',
		});
		return next;
	}
	if (ev.type === 'text') {
		if (next.some((step) => step.type === 'text')) return next;
		next.push({
			id: `text-${next.length}`,
			type: 'text',
			name,
			detail,
			status: 'text',
		});
		return next;
	}
	if (ev.type === 'tool:start') {
		const idx = lastIndexWhere(next, (step) => step.name === name);
		if (idx >= 0) {
			next[idx] = { ...next[idx], type: ev.type, detail: preferActivityDetail(detail, next[idx].detail), status: 'start' };
			return next;
		}
		next.push({
			id: `${name}-${next.length}`,
			type: ev.type,
			name,
			detail,
			status: ev.status,
		});
		return next;
	}
	const idx = lastIndexWhere(next, (step) => step.name === name);
	if (idx >= 0) {
		next[idx] = {
			...next[idx],
			type: 'tool:done',
			detail: preferActivityDetail(detail, next[idx].detail),
			status: ev.status,
		};
		return next;
	}
	next.push({
		id: `${name}-${next.length}`,
		type: ev.type,
		name,
		detail,
		status: ev.status,
	});
	return next;
}

export function formatActivityLine(step: ActivityStep): string {
	const detail = isWeakActivityDetail(step.detail) ? '' : step.detail;
	const starting = /^Starting /i.test(detail) || /^Stopping /i.test(detail);
	if (step.status === 'error') {
		if (detail) {
			return detail.includes(step.name) ? detail : `${step.name}: ${detail}`;
		}
		return `${step.name} failed`;
	}
	if (starting) {
		if (step.status === 'ok') {
			return /^Stopping /i.test(detail) ? `${step.name} stopped` : `${step.name} image ready`;
		}
		return detail;
	}
	if (detail.startsWith('delegate →')) {
		return detail;
	}
	if (step.status === 'ok') {
		if (detail) {
			return detail.includes(step.name) ? detail : `${step.name} → ${detail}`;
		}
		return `${step.name} finished`;
	}
	if (detail) {
		return `${step.name} → ${detail}`;
	}
	return step.name;
}

function agentHopLabel(id: string): string {
	if (id === 'orchestrator') return 'Orchestrator';
	return id;
}

function toolOwner(toolId: string): string | undefined {
	const spec = TOOL_CATALOG.find((tool) => tool.id === toolId);
	if (!spec || spec.agentId === 'runtime') return undefined;
	return spec.agentId;
}

export function delegateTarget(step: ActivityStep): string | undefined {
	const match = step.detail.match(/^delegate\s*→\s*(\S+)/);
	return match?.[1];
}

export function serviceControlLine(step: ActivityStep): string | undefined {
	if (/^Starting /i.test(step.detail)) return `start_service ${step.name}`;
	if (/^Stopping /i.test(step.detail)) return `stop_service ${step.name}`;
	if (step.name === 'start_service' || step.name === 'stop_service' || step.name === 'restart_service') {
		return step.detail ? `${step.name} ${step.detail}` : step.name;
	}
	return undefined;
}

export function isDeskToolStep(step: ActivityStep): boolean {
	if (step.type === 'text' || step.type === 'agent') return false;
	if (delegateTarget(step)) return false;
	if (serviceControlLine(step)) return false;
	return true;
}

/** Working-memory writes get their own card, not a trail hop. */
export function isMemoryStep(step: ActivityStep): boolean {
	return step.name === 'updateWorkingMemory' || step.name === 'update-working-memory';
}

/** finding-record renders as a severity-badged line, not a trail hop. */
export function isFindingRecordStep(step: ActivityStep): boolean {
	return step.name === 'finding-record';
}

/** Steps hidden from the chip trail because a dedicated card shows them. */
export function isCardStep(step: ActivityStep): boolean {
	return isMemoryStep(step) || isFindingRecordStep(step);
}

export interface FindingBadge {
	severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
	title: string;
}

const FINDING_BADGE_RE = /^(critical|high|medium|low|info)\s+·\s+(.+)$/s;

export function findingBadgeFromStep(step: ActivityStep): FindingBadge | undefined {
	if (!isFindingRecordStep(step)) return undefined;
	const match = step.detail.trim().match(FINDING_BADGE_RE);
	if (match) {
		return { severity: match[1] as FindingBadge['severity'], title: match[2].trim() };
	}
	const title = step.detail.trim();
	return title ? { severity: 'info', title } : undefined;
}

export function isWorkflowStep(step: ActivityStep): boolean {
	return step.name === 'run_workflow';
}

/** Engagement phase labels mirrored from the core engagement tracker (renderer cannot import core). */
const PHASE_LABELS: Record<string, string> = {
	'pre-recon': 'Pre-recon (SAST)',
	'source-review': 'Source review',
	'recon-surface': 'Reconnaissance',
	'web-recon': 'Web recon',
	'vuln-detect': 'Vulnerability analysis',
	'poc-validate': 'PoC validation',
	validate: 'Validation',
	report: 'Reporting',
	'correlate-report': 'Correlate & report',
	'full-engagement': 'Full engagement',
};

export function phaseLabel(id: string): string {
	const key = id.trim();
	if (PHASE_LABELS[key]) return PHASE_LABELS[key];
	return key.replace(/[-_]+/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase());
}

export function workflowPhaseId(step: ActivityStep): string | undefined {
	if (!isWorkflowStep(step)) return undefined;
	const id = step.detail.trim();
	return id || undefined;
}

/** HITL wait rows: suspended tool start or the approval wait marker. */
export function isApprovalWaitStep(step: ActivityStep): boolean {
	if (step.status !== 'start') return false;
	return /waiting for approval/i.test(step.detail);
}

export function usedToolNames(steps: ActivityStep[]): string[] {
	const names: string[] = [];
	for (const step of steps) {
		if (!isDeskToolStep(step)) continue;
		if (!names.includes(step.name)) names.push(step.name);
	}
	return names;
}

export type DeskHopKind = 'you' | 'agent' | 'tool' | 'phase';

export interface DeskHop {
	label: string;
	kind: DeskHopKind;
}

/** Structured `You → agent → tool` trail. Memory writes and finding records render as cards instead. */
export function buildDeskHops(steps: ActivityStep[] | undefined): DeskHop[] {
	const list = steps ?? [];
	const hops: DeskHop[] = [{ label: 'You', kind: 'you' }];
	const pushHop = (label: string, kind: DeskHopKind) => {
		if (!label || hops[hops.length - 1]?.label === label) return;
		if (hops.some((hop) => hop.label === label)) return;
		hops.push({ label, kind });
	};

	const agentStep = list.find((step) => step.type === 'agent');
	if (agentStep) {
		pushHop(agentHopLabel(agentStep.name), 'agent');
	}

	for (const step of list) {
		const delegated = delegateTarget(step);
		if (delegated) {
			pushHop(delegated, 'agent');
			continue;
		}
		if (serviceControlLine(step)) continue;
		if (isCardStep(step)) continue;
		if (!isDeskToolStep(step)) continue;
		const phaseId = workflowPhaseId(step);
		if (phaseId) {
			pushHop(phaseLabel(phaseId), 'phase');
			continue;
		}
		const owner = toolOwner(step.name);
		if (owner) {
			pushHop(agentHopLabel(owner), 'agent');
		}
		pushHop(step.name, 'tool');
	}

	const hasWork = list.some((step) => isDeskToolStep(step) || serviceControlLine(step));
	if (hops.length === 1 && hasWork) {
		hops.splice(1, 0, { label: 'Orchestrator', kind: 'agent' });
	}
	if (hops.length <= 1) {
		return [];
	}
	return hops;
}

export function buildDeskPath(steps: ActivityStep[] | undefined): { breadcrumb: string; lines: string[] } {
	const list = steps ?? [];
	const hops = buildDeskHops(steps);
	const lines: string[] = [];

	for (const step of list) {
		const delegated = delegateTarget(step);
		if (delegated) {
			continue;
		}
		const service = serviceControlLine(step);
		if (service) {
			if (!lines.includes(service)) lines.push(service);
			continue;
		}
		if (isMemoryStep(step)) continue;
		if (!isDeskToolStep(step)) continue;
		const detail = step.detail.trim();
		const line = detail
			? (detail.includes(step.name) ? detail : `${step.name} → ${detail}`)
			: step.name;
		if (!lines.includes(line)) lines.push(line);
	}

	if (hops.length === 0 && lines.length === 0) {
		return { breadcrumb: '', lines: [] };
	}
	return { breadcrumb: hops.map((hop) => hop.label).join(' → '), lines };
}

const KEEP_ADDR = /\b(127\.\d{1,3}\.\d{1,3}\.\d{1,3}|::1|localhost|host\.(?:containers|docker)\.internal|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})\b/gi;

export function addressesFromActivity(steps: ActivityStep[] | undefined): string[] {
	const found: string[] = [];
	const add = (value: string) => {
		const item = value.trim();
		if (!item || found.includes(item)) return;
		found.push(item);
	};
	for (const step of steps ?? []) {
		if (step.name === 'scan-local-ports') add('127.0.0.1');
		for (const match of `${step.detail} ${step.name}`.matchAll(KEEP_ADDR)) {
			add(match[1]);
		}
	}
	return found;
}

export function visibleActivity(steps: ActivityStep[] | undefined): ActivityStep[] {
	return (steps ?? []).filter((step) => step.type !== 'text' && step.type !== 'agent');
}
