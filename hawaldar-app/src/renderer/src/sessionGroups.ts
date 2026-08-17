import type { CatalogItem } from '../../preload/api';

export type SessionGroupId =
	| 'pinned'
	| 'last5'
	| 'current'
	| 'last1h'
	| 'lastHour'
	| 'today'
	| 'yesterday'
	| 'week'
	| 'month'
	| 'lastMonth'
	| 'year'
	| 'lastYear'
	| 'older';

export type SessionCalendarSpan =
	| 'today'
	| 'yesterday'
	| 'week'
	| 'month'
	| 'lastMonth'
	| 'year'
	| 'lastYear';

export type SessionBucketRule =
	| { type: 'pinned' }
	| { type: 'maxAge'; maxAgeMs: number }
	| { type: 'calendar'; span: SessionCalendarSpan }
	| { type: 'older' };

export interface SessionBucketConfig {
	id: SessionGroupId;
	label: string;
	/** Set false to skip the bucket without deleting it. Default true. */
	enabled?: boolean;
	rule: SessionBucketRule;
}

export interface SessionGroup {
	id: SessionGroupId;
	label: string;
	items: CatalogItem[];
}

const minutes = (n: number) => n * 60 * 1000;
const hours = (n: number) => minutes(n * 60);

export const SESSION_LIST_PAGE_SIZE = 20;

/** Edit this list to change sidebar recency groups. First matching enabled bucket wins. */
export const SESSION_GROUP_BUCKETS: SessionBucketConfig[] = [
	{ id: 'pinned', label: 'Pinned', rule: { type: 'pinned' } },
	{ id: 'last5', label: 'Last 5 minutes', rule: { type: 'maxAge', maxAgeMs: minutes(5) } },
	{ id: 'current', label: 'Last 15 minutes', rule: { type: 'maxAge', maxAgeMs: minutes(15) } },
	{ id: 'lastHour', label: 'Last 1 hour', rule: { type: 'maxAge', maxAgeMs: hours(1) } },
	{ id: 'today', label: 'Today', rule: { type: 'calendar', span: 'today' } },
	{ id: 'yesterday', label: 'Yesterday', rule: { type: 'calendar', span: 'yesterday' } },
	{ id: 'week', label: 'This week', enabled: false, rule: { type: 'calendar', span: 'week' } },
	{ id: 'month', label: 'This month', enabled: false, rule: { type: 'calendar', span: 'month' } },
	{ id: 'lastMonth', label: 'Last month', enabled: false, rule: { type: 'calendar', span: 'lastMonth' } },
	{ id: 'year', label: 'This year', enabled: false, rule: { type: 'calendar', span: 'year' } },
	{ id: 'lastYear', label: 'Last year', enabled: false, rule: { type: 'calendar', span: 'lastYear' } },
	{ id: 'older', label: 'Older', rule: { type: 'older' } },
];

export const SESSION_GROUP_ORDER: SessionGroupId[] = SESSION_GROUP_BUCKETS.map((bucket) => bucket.id);

export const SESSION_GROUP_LABELS: Record<SessionGroupId, string> = Object.fromEntries(
	SESSION_GROUP_BUCKETS.map((bucket) => [bucket.id, bucket.label]),
) as Record<SessionGroupId, string>;

const EPOCH_MS_MIN = 1e11;
const EPOCH_MS_MAX = 1e14;

export function toEpochMs(value: unknown): number {
	if (value == null || value === '') {
		return 0;
	}
	if (typeof value === 'number') {
		return normalizeEpochNumber(value);
	}
	if (typeof value === 'bigint') {
		return normalizeEpochNumber(Number(value));
	}
	if (typeof value === 'object') {
		const rec = value as { getTime?: unknown; toISOString?: unknown };
		if (typeof rec.getTime === 'function') {
			return normalizeEpochNumber((rec as Date).getTime());
		}
		if (typeof rec.toISOString === 'function') {
			return toEpochMs((rec as { toISOString: () => string }).toISOString());
		}
	}
	if (typeof value === 'string') {
		const trimmed = value.trim();
		if (!trimmed) {
			return 0;
		}
		if (/^[+-]?\d+(\.\d+)?$/.test(trimmed)) {
			return normalizeEpochNumber(Number(trimmed));
		}
		const parsed = Date.parse(trimmed);
		return Number.isNaN(parsed) ? 0 : parsed;
	}
	return 0;
}

function normalizeEpochNumber(value: number): number {
	if (!Number.isFinite(value) || value <= 0) {
		return 0;
	}
	if (value < EPOCH_MS_MIN) {
		return Math.round(value * 1000);
	}
	if (value > EPOCH_MS_MAX) {
		return Math.round(value / 1000);
	}
	return Math.round(value);
}

export function isSessionPinned(item: { pinned?: unknown }): boolean {
	return item.pinned === true || item.pinned === 1 || item.pinned === '1';
}

export function fuzzyMatch(query: string, ...haystacks: Array<string | undefined>): boolean {
	const raw = query.trim().toLowerCase();
	if (!raw) {
		return true;
	}
	const hay = haystacks.map((part) => (part || '').toLowerCase()).join(' ');
	return raw.split(/\s+/).filter(Boolean).every((token) => includesOrSubseq(hay, token));
}

export function groupSessions(
	threads: CatalogItem[],
	query = '',
	now = Date.now(),
	buckets: readonly SessionBucketConfig[] = SESSION_GROUP_BUCKETS,
): SessionGroup[] {
	const active = enabledBuckets(buckets);
	const collected = new Map<SessionGroupId, CatalogItem[]>();
	for (const bucket of active) {
		collected.set(bucket.id, []);
	}
	const pinnedOn = active.some((bucket) => bucket.rule.type === 'pinned');
	const matched = threads.filter((row) => fuzzyMatch(query, row.label, row.snippet));
	const hasPinned = pinnedOn && matched.some(isSessionPinned);
	for (const item of matched) {
		const id = hasPinned && isSessionPinned(item) ? 'pinned' : timeGroupId(item.updatedAt, now, active);
		collected.get(id)?.push(item);
	}
	const groups: SessionGroup[] = [];
	for (const bucket of active) {
		if (bucket.rule.type === 'pinned' && !hasPinned) {
			continue;
		}
		const items = (collected.get(bucket.id) ?? []).slice().sort((a, b) => toEpochMs(b.updatedAt) - toEpochMs(a.updatedAt));
		if (items.length === 0) {
			continue;
		}
		groups.push({ id: bucket.id, label: bucket.label, items });
	}
	return groups;
}

/** Latest `pageCount` pages by updatedAt, plus every pinned thread. */
export function selectVisibleSessions(
	threads: CatalogItem[],
	pageCount: number,
	pageSize = SESSION_LIST_PAGE_SIZE,
): { items: CatalogItem[]; hasMore: boolean } {
	const size = Math.max(1, Math.floor(pageSize));
	const limit = Math.max(1, Math.floor(pageCount)) * size;
	const pinned = threads.filter(isSessionPinned);
	const rest = threads
		.filter((item) => !isSessionPinned(item))
		.slice()
		.sort((a, b) => toEpochMs(b.updatedAt) - toEpochMs(a.updatedAt));
	const pageItems = rest.slice(0, limit);
	return {
		items: [...pinned, ...pageItems],
		hasMore: rest.length > limit,
	};
}

export function sameSessionList(left: CatalogItem[], right: CatalogItem[]): boolean {
	if (left.length !== right.length) {
		return false;
	}
	for (let i = 0; i < left.length; i += 1) {
		const a = left[i];
		const b = right[i];
		if (
			a.id !== b.id
			|| a.label !== b.label
			|| a.detail !== b.detail
			|| a.pinned !== b.pinned
			|| toEpochMs(a.updatedAt) !== toEpochMs(b.updatedAt)
			|| a.snippet !== b.snippet
		) {
			return false;
		}
	}
	return true;
}

export function timeGroupId(
	updatedAt: unknown,
	now: number,
	buckets: readonly SessionBucketConfig[] = SESSION_GROUP_BUCKETS,
): Exclude<SessionGroupId, 'pinned'> {
	const at = toEpochMs(updatedAt);
	if (at <= 0) {
		return 'older';
	}
	const cal = calendarBounds(now);
	for (const bucket of enabledBuckets(buckets)) {
		if (bucket.rule.type === 'pinned') {
			continue;
		}
		if (matchesRule(bucket.rule, at, now, cal)) {
			return bucket.id as Exclude<SessionGroupId, 'pinned'>;
		}
	}
	return 'older';
}

/** T-2min → last5; T-10min → last15; T-30min → lastHour; calendar yesterday → yesterday. */
export function verifyRecencyBuckets(now = Date.now()): void {
	const min = 60_000;
	const startToday = startOfDay(new Date(now)).getTime();
	const cases: Array<[number, Exclude<SessionGroupId, 'pinned'>]> = [
		[now - 2 * min, 'last5'],
		[now - 10 * min, 'current'],
		[now - 30 * min, 'lastHour'],
		[startToday - 12 * 60 * min, 'yesterday'],
		[0, 'older'],
	];
	if (now - startToday > 60 * min) {
		cases.push([startToday + min, 'today']);
	}
	for (const [at, expect] of cases) {
		const got = timeGroupId(at, now);
		if (got !== expect) {
			throw new Error(`session group sanity: ${expect} expected for ${at}, got ${got}`);
		}
	}
}

function enabledBuckets(buckets: readonly SessionBucketConfig[]): SessionBucketConfig[] {
	return buckets.filter((bucket) => bucket.enabled !== false);
}

interface CalendarBounds {
	startToday: Date;
	startYesterday: Date;
	startWeek: Date;
	thisYear: number;
	thisMonth: number;
	lastMonthYear: number;
	lastMonth: number;
}

function calendarBounds(now: number): CalendarBounds {
	const current = new Date(now);
	const startToday = startOfDay(current);
	const startYesterday = new Date(startToday);
	startYesterday.setDate(startYesterday.getDate() - 1);
	const lastMonthDate = new Date(current.getFullYear(), current.getMonth() - 1, 1);
	return {
		startToday,
		startYesterday,
		startWeek: startOfWeekMonday(current),
		thisYear: current.getFullYear(),
		thisMonth: current.getMonth(),
		lastMonthYear: lastMonthDate.getFullYear(),
		lastMonth: lastMonthDate.getMonth(),
	};
}

function matchesRule(rule: SessionBucketRule, at: number, now: number, cal: CalendarBounds): boolean {
	if (rule.type === 'maxAge') {
		if (at <= 0 || at > now + 2_000) {
			return false;
		}
		return now - at <= rule.maxAgeMs;
	}
	if (rule.type === 'older') {
		return true;
	}
	if (rule.type !== 'calendar') {
		return false;
	}
	const when = new Date(at);
	switch (rule.span) {
		case 'today':
			return when >= cal.startToday;
		case 'yesterday':
			return when >= cal.startYesterday;
		case 'week':
			return when >= cal.startWeek;
		case 'month':
			return when.getFullYear() === cal.thisYear && when.getMonth() === cal.thisMonth;
		case 'lastMonth':
			return when.getFullYear() === cal.lastMonthYear && when.getMonth() === cal.lastMonth;
		case 'year':
			return when.getFullYear() === cal.thisYear;
		case 'lastYear':
			return when.getFullYear() === cal.thisYear - 1;
		default:
			return false;
	}
}

function includesOrSubseq(hay: string, needle: string): boolean {
	if (hay.includes(needle)) {
		return true;
	}
	let i = 0;
	for (const ch of hay) {
		if (ch === needle[i]) {
			i += 1;
			if (i >= needle.length) {
				return true;
			}
		}
	}
	return false;
}

function startOfDay(value: Date): Date {
	return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

function startOfWeekMonday(value: Date): Date {
	const start = startOfDay(value);
	const day = start.getDay();
	start.setDate(start.getDate() - (day === 0 ? 6 : day - 1));
	return start;
}

if (import.meta.env?.DEV) {
	verifyRecencyBuckets();
}
