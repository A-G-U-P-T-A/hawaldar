export type EngagementCheckpointStatus = 'running' | 'failed' | 'done';

export interface EngagementCheckpoint {
	workflowId: string;
	workflowName: string;
	target: string;
	input: Record<string, unknown>;
	completedStepIds: string[];
	failedStepId?: string;
	status: EngagementCheckpointStatus;
	updatedAt: number;
}

export function parseEngagementCheckpoint(raw: unknown): EngagementCheckpoint | undefined {
	if (!raw) {
		return undefined;
	}
	let value: unknown = raw;
	if (typeof raw === 'string') {
		const trimmed = raw.trim();
		if (!trimmed) {
			return undefined;
		}
		try {
			value = JSON.parse(trimmed);
		} catch {
			return undefined;
		}
	}
	if (!value || typeof value !== 'object') {
		return undefined;
	}
	const rec = value as Record<string, unknown>;
	const workflowId = String(rec.workflowId ?? '').trim();
	if (!workflowId) {
		return undefined;
	}
	const status = rec.status === 'failed' || rec.status === 'done' || rec.status === 'running'
		? rec.status
		: 'running';
	const completed = Array.isArray(rec.completedStepIds)
		? rec.completedStepIds.map((item) => String(item)).filter(Boolean)
		: [];
	const input = rec.input && typeof rec.input === 'object' && !Array.isArray(rec.input)
		? rec.input as Record<string, unknown>
		: {};
	return {
		workflowId,
		workflowName: String(rec.workflowName ?? workflowId),
		target: String(rec.target ?? input.target ?? ''),
		input,
		completedStepIds: completed,
		failedStepId: typeof rec.failedStepId === 'string' && rec.failedStepId.trim()
			? rec.failedStepId.trim()
			: undefined,
		status,
		updatedAt: Number(rec.updatedAt) || Date.now(),
	};
}

export function serializeEngagementCheckpoint(checkpoint: EngagementCheckpoint): string {
	return JSON.stringify(checkpoint);
}
