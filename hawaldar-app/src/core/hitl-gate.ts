/**
 * HITL helpers with no Electron / Podman imports so Approve/resume can be
 * unit-tested in plain Node. Catalog tools must use askHitl (IPC) only —
 * Mastra suspend/resumeStream after Approve has taken the process down.
 */

export const USER_DECLINED = 'user declined';

/** Always return a defined tool payload so Cohere/OpenRouter never see tool_results without outputs. */
export function definedToolResult(stderr: string, extra?: Record<string, unknown>) {
	return { ok: false, stdout: '', stderr, exitCode: 0, ...extra };
}

export type HitlKind = 'podman' | 'tool-image' | 'poc-probe';

export interface HitlAsk {
	kind: HitlKind;
	title: string;
	explanation: string;
	serviceId?: string;
}

export interface HitlSuspendPayload extends HitlAsk {}

export interface HitlResumeData {
	approved: boolean;
	kind: HitlKind;
	serviceId?: string;
}

export interface HitlToolContext {
	agent?: {
		suspend?: (payload: HitlSuspendPayload) => Promise<unknown>;
		resumeData?: HitlResumeData;
	};
	workflow?: {
		suspend?: (payload: HitlSuspendPayload) => Promise<unknown>;
		resumeData?: HitlResumeData;
	};
}

export function parseHitlResume(raw: unknown): HitlResumeData | undefined {
	if (!raw || typeof raw !== 'object') {
		return undefined;
	}
	const rec = raw as Record<string, unknown>;
	if (typeof rec.approved !== 'boolean') {
		return undefined;
	}
	const kind = rec.kind === 'tool-image' || rec.kind === 'podman' || rec.kind === 'poc-probe' ? rec.kind : undefined;
	if (!kind) {
		return { approved: rec.approved, kind: 'podman' };
	}
	return {
		approved: rec.approved,
		kind,
		serviceId: typeof rec.serviceId === 'string' && rec.serviceId.trim() ? rec.serviceId.trim() : undefined,
	};
}

export function parseHitlSuspendPayload(raw: unknown): HitlSuspendPayload | undefined {
	if (!raw || typeof raw !== 'object') {
		return undefined;
	}
	const rec = raw as Record<string, unknown>;
	const kind = rec.kind === 'tool-image' || rec.kind === 'podman' || rec.kind === 'poc-probe' ? rec.kind : undefined;
	if (!kind || typeof rec.title !== 'string' || typeof rec.explanation !== 'string') {
		return undefined;
	}
	return {
		kind,
		title: rec.title,
		explanation: rec.explanation,
		serviceId: typeof rec.serviceId === 'string' && rec.serviceId.trim() ? rec.serviceId.trim() : undefined,
	};
}

/** Mastra suspend/resume schemas. Catalog tools must not attach these — IPC HITL only. */
export function hitlToolSchemas(z: any) {
	const kind = z.enum(['podman', 'tool-image', 'poc-probe']);
	return {
		suspendSchema: z.object({
			kind,
			title: z.string(),
			explanation: z.string(),
			serviceId: z.string().optional(),
		}),
		resumeSchema: z.object({
			approved: z.boolean(),
			kind,
			serviceId: z.string().optional(),
		}),
	};
}

/**
 * Per-probe operator approval. IPC `askHitl` only — never Mastra `suspend()`.
 * `resumeData` is kept so a leftover Mastra resume still short-circuits.
 */
export async function ensurePocApproval(
	summary: { title: string; explanation: string },
	options?: { hitlContext?: HitlToolContext; askHitl?: (req: HitlAsk) => Promise<boolean> },
): Promise<{ status: 'ok' } | { status: 'declined'; detail: string } | { status: 'suspended'; value: unknown }> {
	const resume = parseHitlResume(
		options?.hitlContext?.agent?.resumeData ?? options?.hitlContext?.workflow?.resumeData,
	);
	if (resume?.kind === 'poc-probe') {
		return resume.approved ? { status: 'ok' } : { status: 'declined', detail: USER_DECLINED };
	}
	const ask: HitlAsk = {
		kind: 'poc-probe',
		title: summary.title,
		explanation: summary.explanation,
	};
	if (!options?.askHitl) {
		return { status: 'declined', detail: 'PoC probes need operator approval.' };
	}
	const approved = await options.askHitl(ask);
	return approved ? { status: 'ok' } : { status: 'declined', detail: USER_DECLINED };
}

/** Resolve the renderer Approve/Decline after the IPC handle has returned. */
export function releaseHitlWaiter(resolve: (approved: boolean) => void, approved: boolean): void {
	setImmediate(() => {
		try {
			resolve(approved);
		} catch (error) {
			console.error('[hawaldar] hitl waiter', error);
		}
	});
}
