import { extractCanonicalTarget, restoreTargetPlaceholders } from './policy';
import { currentToolContext, rememberProbe, type ProbeSnippet } from './tool-context';
import { FINDING_CLASSES, FINDING_SEVERITIES } from './findings-store';

const BODY_TOOLS = new Set(['poc-request', 'poc-act']);
const PROBE_TOOLS = new Set([
	'poc-request',
	'poc-act',
	'poc-xss-canary',
	'sqlmap-scan',
	'zap-ascan',
	'zap-spider',
]);

const RESEARCH_ONLY = /\b(according to|owasp\.org|wikipedia|cwe-\d+|as described in (?:the )?docs)\b/i;
const HAS_EVIDENCE_TRUE = /\bhas evidence:\s*true\b/i;
const TOOL_SNIPPET = /poc-request|poc-act|poc-xss-canary|sqlmap-scan|zap-ascan|zap-spider|"status"\s*:\s*\d{3}|bodyExcerpt|"fired"\s*:\s*\d|injectable|not injectable|window\.__hwPocFired|HTTP\/\d(?:\.\d)?\s+\d{3}|action:\s*request/i;

/** Present when wrap had to accept args that still fail the inner schema. Execute returns this as a tool error (no Mastra retry). */
export const INVALID_TOOL_ARGS = '__hawaldarInvalidArgs';

/**
 * Coerce model tool args BEFORE Zod. Cohere/OpenRouter send `{}`, JSON `body`
 * as an object, `steps` as a count, and `[IP_ADDRESS]` instead of 127.0.0.1.
 */
export function coerceToolArgs(
	toolId: string,
	raw: unknown,
	impliedTargets: readonly string[] = currentToolContext()?.impliedTargets ?? [],
): Record<string, unknown> {
	const args = asRecord(raw);
	const restored = restoreDeep(args, impliedTargets);
	if (BODY_TOOLS.has(toolId) || 'body' in restored) {
		stringifyBody(restored);
	}
	if (toolId === 'finding-record') {
		coerceFindingRecord(restored, impliedTargets);
	}
	if (toolId === 'finding-export') {
		const target = typeof restored.target === 'string' ? restored.target : '';
		const preferred = extractCanonicalTarget(impliedTargets.filter(Boolean).join(' '))?.display
			|| impliedTargets[0]
			|| '';
		if (!target.trim() && preferred) {
			restored.target = restoreTargetPlaceholders(preferred, impliedTargets);
		} else if (target) {
			restored.target = restoreTargetPlaceholders(target, impliedTargets);
		}
	}
	return restored;
}

/**
 * Wrap a Mastra/Zod inputSchema so coerce runs before parse.
 * Zod 4 has no z.preprocess — use transform so Mastra never retry-loops on
 * coerce-able Cohere shapes. Inner schema JSON is copied so the LLM still
 * sees field descriptions.
 */
export function wrapToolInputSchema(z: any, toolId: string, schema: unknown) {
	const inner = schema as {
		safeParse?: (value: unknown) => { success: boolean; data?: unknown; error?: unknown };
		toJSONSchema?: (...args: unknown[]) => unknown;
		'~standard'?: { jsonSchema?: unknown };
	};
	const apply = (value: unknown) => {
		const coerced = coerceToolArgs(toolId, value);
		if (typeof inner.safeParse !== 'function') {
			return coerced;
		}
		const parsed = inner.safeParse(coerced);
		if (parsed.success) {
			return parsed.data;
		}
		return {
			...coerced,
			[INVALID_TOOL_ARGS]: formatSchemaError(parsed.error),
		};
	};

	let wrapped: any;
	if (typeof z?.preprocess === 'function') {
		wrapped = z.preprocess(apply, typeof z.any === 'function' ? z.any() : schema);
	} else if (typeof z?.any === 'function') {
		const anySchema = z.any();
		wrapped = typeof anySchema.transform === 'function' ? anySchema.transform(apply) : schema;
	} else if (typeof z?.pipe === 'function' && typeof z?.transform === 'function') {
		wrapped = z.pipe(z.transform(apply), typeof z.any === 'function' ? z.any() : schema);
	} else {
		return schema;
	}
	attachJsonSchema(wrapped, inner);
	return wrapped;
}

export function formatSchemaError(error: unknown): string {
	if (!error) {
		return 'Invalid tool arguments.';
	}
	const issues = (error as { issues?: Array<{ path?: unknown; message?: string }> }).issues;
	if (Array.isArray(issues) && issues.length > 0) {
		return issues.map((issue) => {
			const path = Array.isArray(issue.path) ? issue.path.map(String).join('.') : '';
			return `${path || 'input'}: ${issue.message || 'invalid'}`;
		}).join('; ');
	}
	if (typeof (error as { message?: string }).message === 'string') {
		return (error as { message: string }).message;
	}
	return String(error);
}

export function evidenceHasToolSnippet(evidence: string): boolean {
	const text = (evidence || '').trim();
	if (!text || text.length < 24) {
		return false;
	}
	if (HAS_EVIDENCE_TRUE.test(text) && text.length < 80) {
		return false;
	}
	if (TOOL_SNIPPET.test(text)) {
		return true;
	}
	try {
		const parsed = JSON.parse(text) as Record<string, unknown>;
		if (parsed && typeof parsed === 'object') {
			if (parsed.status != null || parsed.bodyExcerpt || parsed.fired != null || parsed.action === 'request' || parsed.injectable != null) {
				return true;
			}
		}
	} catch {
		/* not JSON */
	}
	return false;
}

export function evidenceLooksResearchOnly(evidence: string): boolean {
	const text = (evidence || '').trim();
	if (!text) {
		return true;
	}
	if (evidenceHasToolSnippet(text)) {
		return false;
	}
	return RESEARCH_ONLY.test(text) || HAS_EVIDENCE_TRUE.test(text);
}

export function parseRequestFromEvidence(evidence: string): FindingRequestShape | undefined {
	const text = (evidence || '').trim();
	if (!text) {
		return undefined;
	}
	try {
		const parsed = JSON.parse(text) as Record<string, unknown>;
		return requestFromProbeJson(parsed);
	} catch {
		const start = text.indexOf('{');
		const end = text.lastIndexOf('}');
		if (start >= 0 && end > start) {
			try {
				return requestFromProbeJson(JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>);
			} catch {
				/* fall through */
			}
		}
	}
	const line = /^(GET|POST|PUT|PATCH|HEAD|OPTIONS)\s+(\S+)/im.exec(text);
	if (!line) {
		return undefined;
	}
	return {
		method: line[1].toUpperCase(),
		url: line[2],
		response: text.slice(0, 2_000),
	};
}

export interface FindingRequestShape {
	method?: string;
	url?: string;
	body?: string;
	status?: number;
	response?: string;
	tool?: string;
}

export function captureProbe(toolId: string, input: Record<string, unknown>, result: { ok?: boolean; stdout?: string }): void {
	if (!PROBE_TOOLS.has(toolId) || !result?.ok) {
		return;
	}
	const stdout = String(result.stdout || '');
	const fromJson = parseRequestFromEvidence(stdout);
	const snippet: ProbeSnippet = {
		tool: toolId,
		at: Date.now(),
		method: fromJson?.method || (typeof input.method === 'string' ? input.method : undefined),
		url: fromJson?.url || (typeof input.url === 'string' ? input.url : typeof input.target === 'string' ? input.target : undefined),
		body: fromJson?.body || (typeof input.body === 'string' ? input.body : undefined),
		status: fromJson?.status,
		stdout: stdout.slice(0, 8_000),
	};
	rememberProbe(snippet);
}

export function formatFindingsChatTable(
	rows: Array<{ title: string; vulnClass: string; status: string; target: string }>,
): string {
	if (rows.length === 0) {
		return [
			'## Findings (this run)',
			'',
			'No findings recorded in the store this session.',
		].join('\n');
	}
	const lines = [
		'## Findings (this run)',
		'',
		'| Title | Class | Status | Target |',
		'| --- | --- | --- | --- |',
	];
	for (const row of rows) {
		lines.push(`| ${escapeCell(row.title)} | ${row.vulnClass} | ${row.status} | ${escapeCell(row.target)} |`);
	}
	return lines.join('\n');
}

export function reportFileSlug(target: string, implied: readonly string[] = []): string {
	const restored = restoreTargetPlaceholders(target, implied).trim();
	let slug = restored
		.toLowerCase()
		.replace(/^https?:\/\//, 'http-')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 60);
	slug = slug.replace(/ip-address/g, '127-0-0-1');
	if (!slug || slug === 'ip-address') {
		const fallback = extractCanonicalTarget(implied.filter(Boolean).join(' '))?.display || 'http://127.0.0.1:3000';
		slug = fallback
			.toLowerCase()
			.replace(/^https?:\/\//, 'http-')
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 60) || 'http-127-0-0-1-3000';
	}
	return slug;
}

function coerceFindingRecord(args: Record<string, unknown>, implied: readonly string[]): void {
	if (args.vulnClass == null && args.class != null) {
		args.vulnClass = args.class;
	}
	if (args.class == null && args.vulnClass != null) {
		args.class = args.vulnClass;
	}
	const title = pickString(args.title) || pickString(args.description);
	if (!title) {
		args.title = 'Untitled finding';
		console.warn('[hawaldar] finding-record: missing title — coerced to "Untitled finding"', { args: summarizeArgs(args) });
	} else {
		args.title = title;
	}
	if (!pickString(args.vulnClass) || !FINDING_CLASSES.includes(String(args.vulnClass).toLowerCase() as typeof FINDING_CLASSES[number])) {
		if (args.vulnClass != null) {
			console.warn('[hawaldar] finding-record: invalid class — coerced to other', { class: args.vulnClass });
		} else {
			console.warn('[hawaldar] finding-record: missing class — coerced to other');
		}
		args.vulnClass = 'other';
	} else {
		args.vulnClass = String(args.vulnClass).toLowerCase();
	}
	args.class = args.vulnClass;
	if (!pickString(args.severity) || !FINDING_SEVERITIES.includes(String(args.severity).toLowerCase() as typeof FINDING_SEVERITIES[number])) {
		if (args.severity == null) {
			console.warn('[hawaldar] finding-record: missing severity — coerced to info');
		}
		args.severity = 'info';
	} else {
		args.severity = String(args.severity).toLowerCase();
	}
	const target = pickString(args.target);
	const impliedTarget = extractCanonicalTarget(implied.filter(Boolean).join(' '))?.display
		|| implied[0]
		|| 'http://127.0.0.1:3000';
	if (!target) {
		args.target = restoreTargetPlaceholders(impliedTarget, implied);
		console.warn('[hawaldar] finding-record: missing target — coerced from engagement context', { target: args.target });
	} else {
		args.target = restoreTargetPlaceholders(target, implied);
	}
	args.steps = coerceStringList(args.steps, args);
	const evidence = coerceEvidence(args.evidence);
	if (evidence !== undefined) {
		args.evidence = evidence;
	} else {
		delete args.evidence;
	}
	if (args.references !== undefined) {
		args.references = coerceStringList(args.references, args);
	}
}

/** finding-list returns `steps` as a count; Cohere echoes that number on finding-record. */
function coerceStringList(value: unknown, args: Record<string, unknown>): string[] {
	if (Array.isArray(value)) {
		return value.map((item) => String(item)).map((item) => item.trim()).filter(Boolean);
	}
	if (typeof value === 'string' && value.trim()) {
		return [value.trim()];
	}
	if (typeof value === 'number') {
		const alt = args.reproduction ?? args.reproSteps ?? args.repro;
		if (alt !== value) {
			return coerceStringList(alt, {});
		}
		return [];
	}
	return [];
}

function coerceEvidence(value: unknown): string | undefined {
	if (value == null) {
		return undefined;
	}
	if (typeof value === 'string') {
		return value;
	}
	if (typeof value === 'number' || typeof value === 'boolean') {
		return String(value);
	}
	if (typeof value === 'object') {
		try {
			return JSON.stringify(value);
		} catch {
			return String(value);
		}
	}
	return undefined;
}

function attachJsonSchema(wrapped: any, source: any): void {
	if (!wrapped || !source) {
		return;
	}
	if (typeof source.toJSONSchema === 'function') {
		wrapped.toJSONSchema = (...args: unknown[]) => source.toJSONSchema(...args);
	}
	const from = source['~standard']?.jsonSchema;
	if (from && wrapped['~standard']) {
		wrapped['~standard'].jsonSchema = from;
	}
}

function stringifyBody(args: Record<string, unknown>): void {
	const body = args.body;
	if (body && typeof body === 'object') {
		try {
			args.body = JSON.stringify(body);
		} catch {
			args.body = String(body);
		}
	}
}

function restoreDeep(value: Record<string, unknown>, implied: readonly string[]): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) {
		out[key] = restoreValue(item, implied);
	}
	return out;
}

function restoreValue(value: unknown, implied: readonly string[]): unknown {
	if (typeof value === 'string') {
		return restoreTargetPlaceholders(value, implied);
	}
	if (Array.isArray(value)) {
		return value.map((item) => restoreValue(item, implied));
	}
	if (value && typeof value === 'object') {
		const rec = value as Record<string, unknown>;
		const out: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(rec)) {
			out[key] = restoreValue(item, implied);
		}
		return out;
	}
	return value;
}

function requestFromProbeJson(parsed: Record<string, unknown>): FindingRequestShape | undefined {
	const req = asRecord(parsed.request) ?? parsed;
	const method = pickString(req.method);
	const url = pickString(req.url) || pickString(parsed.finalUrl) || pickString(parsed.target);
	const status = typeof parsed.status === 'number'
		? parsed.status
		: typeof req.status === 'number' ? req.status : undefined;
	const response = pickString(parsed.bodyExcerpt) || pickString(parsed.stdout) || undefined;
	const body = typeof req.body === 'string'
		? req.body
		: (req.body && typeof req.body === 'object' ? JSON.stringify(req.body) : undefined);
	if (!method && !url && status == null && !response) {
		return undefined;
	}
	return {
		method: method?.toUpperCase(),
		url,
		body: body?.slice(0, 2_000),
		status,
		response: response?.slice(0, 2_000),
		tool: pickString(parsed.tool) || pickString(parsed.action),
	};
}

function asRecord(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return {};
	}
	return { ...(value as Record<string, unknown>) };
}

function pickString(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function summarizeArgs(args: Record<string, unknown>): Record<string, unknown> {
	const keys = Object.keys(args);
	return { keys, empty: keys.length === 0 };
}

function escapeCell(value: string): string {
	return (value || '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').slice(0, 80);
}
