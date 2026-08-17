import { evaluateBrowserNavigation } from '../policy';
import { looksLikeDockerBin } from '../sandbox/host-info';
import { podmanRun } from '../sandbox/podman';
import { imageFor, isToolEnabled, type HawaldarSettings } from '../settings';
import { rewriteLoopbackUrl } from './browser';
import { BUILTIN_SOURCE, TOOL_CATALOG } from './catalog';
import { redactSecrets } from './poc';

/**
 * Bounded SQLMap proof runner. The host builds the entire argv from a strict
 * allowlist — the model supplies a URL and bounded knobs only, never raw flags.
 * Goal: prove injectability (sqlmap's "is vulnerable"/"injectable" verdict plus
 * DBMS fingerprint). Data extraction is refused in code (REFUSED_FLAGS) both on
 * the raw input and on the final argv before it ever reaches the container.
 */

const MEMORY_MB = 1024;
const PIDS = 256;
const EVIDENCE_CAP = 4_000;
const MAX_LEVEL = 2;
const MAX_RISK = 2;
const MAX_CRAWL = 1;
const MAX_RETRIES = 2;
const MAX_TIMEOUT_SEC = 60;
const ALLOWED_TECHNIQUES = new Set(['B', 'E', 'U', 'S', 'T']);

/** Data extraction / takeover / evasion. Never reach the container. */
const REFUSED_FLAGS = [
	'--dump', '--dump-all', '--os-shell', '--os-pwn', '--os-bof',
	'--file-read', '--file-write', '--file-dest',
	'--passwords', '--users', '--privileges', '--roles',
	'--sql-query', '--sql-shell', '--eval',
	'--tor', '--tamper', '--proxy', '--proxy-file',
	'--shell', '--udf-inject', '--shared-lib',
	'--priv-esc', '--msf-path', '--reg-read', '--reg-add', '--reg-del',
];
const REFUSED_RE = /--(dump(?:-all)?|os-(?:shell|pwn|bof)|file-(?:read|write|dest)|passwords|users|privileges|roles|sql-(?:query|shell)|eval|tor|tamper|proxy(?:-file)?|shell|udf-inject|shared-lib|priv-esc|msf-path|reg-(?:read|add|del))\b/i;

export interface SqlmapToolInput {
	url?: string;
	level?: number;
	risk?: number;
	technique?: string;
	forms?: boolean;
	crawl?: number;
	timeoutSec?: number;
	retries?: number;
	banner?: boolean;
	currentUser?: boolean;
	currentDb?: boolean;
	dbs?: boolean;
}

export interface SqlmapChecked {
	url: string;
	originalUrl: string;
	displayHost: string;
	reachHostLoopback: boolean;
	args: string[];
	summaryBits: string[];
}

/** Mastra inputSchema for sqlmap tools. Uses the runtime `z` instance. */
export function buildSqlmapInputSchema(z: any, id: string) {
	void id;
	return z.object({
		url: z.string().describe('In-scope http(s) URL, ideally with a query parameter (e.g. ?id=1). Loopback follows local-target rules.'),
		level: z.number().int().min(1).max(MAX_LEVEL).optional().describe('Test level, max 2 (default 1).'),
		risk: z.number().int().min(1).max(MAX_RISK).optional().describe('Risk, max 2 (default 1).'),
		technique: z.string().optional().describe('Subset of B,E,U,S,T (boolean, error, union, stacked, time). Q is refused.'),
		forms: z.boolean().optional().describe('Parse and test HTML forms on the page.'),
		crawl: z.number().int().min(0).max(MAX_CRAWL).optional().describe('Crawl depth from the URL, max 1 (default 0).'),
		timeoutSec: z.number().int().min(5).max(MAX_TIMEOUT_SEC).optional().describe('Per-request timeout seconds (default 30).'),
		retries: z.number().int().min(0).max(MAX_RETRIES).optional().describe('Request retries, max 2 (default 1).'),
		banner: z.boolean().optional().describe('Fingerprint only: DBMS banner.'),
		currentUser: z.boolean().optional().describe('Fingerprint only: current DB user name.'),
		currentDb: z.boolean().optional().describe('Fingerprint only: current database name.'),
		dbs: z.boolean().optional().describe('Fingerprint only: list database names. Table/column dump flags stay refused.'),
	});
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
	if (value === undefined || value === null || Number.isNaN(Number(value))) {
		return fallback;
	}
	return Math.min(max, Math.max(min, Math.trunc(Number(value))));
}

function parseTechnique(raw: string | undefined): { ok: true; value: string } | { ok: false; reason: string } {
	const cleaned = (raw ?? '').trim().toUpperCase().replace(/[^A-Z]/g, '');
	if (!cleaned) {
		return { ok: true, value: '' };
	}
	const bad = [...cleaned].filter((ch) => !ALLOWED_TECHNIQUES.has(ch));
	if (bad.length > 0) {
		return { ok: false, reason: `Technique ${bad.join(',')} refused. Allowed: B (boolean), E (error), U (union), S (stacked), T (time). Q is refused.` };
	}
	return { ok: true, value: [...new Set(cleaned)].join('') };
}

function guardRefused(rawInput: unknown, argv: readonly string[]): string | undefined {
	const rawText = JSON.stringify(rawInput ?? {});
	const hit = REFUSED_RE.exec(rawText) ?? REFUSED_RE.exec(argv.join(' '));
	if (hit) {
		const flag = REFUSED_FLAGS.find((item) => hit[0].toLowerCase().startsWith(item)) ?? hit[0];
		return `sqlmap flag ${flag} is refused. sqlmap-scan proves injectability only — data extraction (--dump, --passwords, --users, …), OS takeover (--os-shell, --os-pwn, --file-*), raw SQL (--sql-query, --sql-shell, --eval), and evasion (--tor, --tamper, out-of-scope --proxy) never run.`;
	}
	return undefined;
}

/** Validate + scope-gate + build the allowlisted argv. Shared by the HITL summary and the runner. */
export function checkSqlmapRun(settings: HawaldarSettings, input: SqlmapToolInput): { ok: true; value: SqlmapChecked } | { ok: false; reason: string } {
	const raw = (input.url ?? '').trim();
	if (!raw) {
		return { ok: false, reason: 'url is required (in-scope http(s), ideally with a query parameter).' };
	}
	const technique = parseTechnique(input.technique);
	if (!technique.ok) {
		return technique;
	}
	const decision = evaluateBrowserNavigation(settings.scope, raw, 'navigate');
	if (!decision.allow || !decision.url || !decision.host) {
		return { ok: false, reason: decision.reason };
	}
	const rewritten = rewriteLoopbackUrl(decision.url, looksLikeDockerBin(settings.podmanPath));

	const level = clampInt(input.level, 1, 1, MAX_LEVEL);
	const risk = clampInt(input.risk, 1, 1, MAX_RISK);
	const crawl = clampInt(input.crawl, 0, 0, MAX_CRAWL);
	const timeoutSec = clampInt(input.timeoutSec, 30, 5, MAX_TIMEOUT_SEC);
	const retries = clampInt(input.retries, 1, 0, MAX_RETRIES);

	const args = [
		'-u', rewritten.href,
		'--batch',
		'--disable-coloring',
		'--level', String(level),
		'--risk', String(risk),
		'--timeout', String(timeoutSec),
		'--retries', String(retries),
		'--threads', '1',
	];
	if (technique.value) {
		args.push('--technique', technique.value);
	}
	if (input.forms === true) {
		args.push('--forms');
	}
	if (crawl > 0) {
		args.push('--crawl', String(crawl));
	}
	if (input.banner === true) {
		args.push('--banner');
	}
	if (input.currentUser === true) {
		args.push('--current-user');
	}
	if (input.currentDb === true) {
		args.push('--current-db');
	}
	if (input.dbs === true) {
		args.push('--dbs');
	}

	const refused = guardRefused(input, args);
	if (refused) {
		return { ok: false, reason: refused };
	}

	const summaryBits = [`level ${level}`, `risk ${risk}`];
	if (technique.value) {
		summaryBits.push(`technique ${technique.value}`);
	}
	if (input.forms === true) {
		summaryBits.push('forms');
	}
	if (crawl > 0) {
		summaryBits.push(`crawl ${crawl}`);
	}
	const fingerprint = [
		input.banner === true ? 'banner' : '',
		input.currentUser === true ? 'current-user' : '',
		input.currentDb === true ? 'current-db' : '',
		input.dbs === true ? 'dbs' : '',
	].filter(Boolean);
	if (fingerprint.length > 0) {
		summaryBits.push(`fingerprint: ${fingerprint.join(', ')}`);
	}

	return {
		ok: true,
		value: {
			url: rewritten.href,
			originalUrl: decision.url,
			displayHost: decision.host,
			reachHostLoopback: rewritten.reachHostLoopback,
			args,
			summaryBits,
		},
	};
}

/** HITL summary for sqlmap-scan (validated before the dialog shows). */
export function sqlmapAskSummary(
	settings: HawaldarSettings,
	id: string,
	input: SqlmapToolInput,
): { ok: true; value: { title: string; explanation: string } } | { ok: false; reason: string } {
	if (id !== 'sqlmap-scan') {
		return { ok: false, reason: `Unknown sqlmap tool: ${id}` };
	}
	const checked = checkSqlmapRun(settings, input);
	if (!checked.ok) {
		return checked;
	}
	return {
		ok: true,
		value: {
			title: `Approve SQLMap proof on ${checked.value.displayHost}?`,
			explanation: [
				`sqlmap-scan runs sqlmap against ${checked.value.originalUrl} with ${checked.value.summaryBits.join(' · ')}.`,
				'Bounded proof of injectability only: level/risk ≤ 2, techniques B/E/U/S/T (no stacked Q), fingerprint flags only. Data extraction, OS takeover, raw SQL, and tamper scripts are refused in code.',
			].join('\n'),
		},
	};
}

export async function runSqlmapTool(settings: HawaldarSettings, id: string, input: SqlmapToolInput) {
	if (!isToolEnabled(settings, id)) {
		return fail(`${id} is disabled.`);
	}
	if (id !== 'sqlmap-scan') {
		return fail(`Unknown tool: ${id}`);
	}
	const checked = checkSqlmapRun(settings, input);
	if (!checked.ok) {
		return fail(checked.reason);
	}
	const result = await podmanRun({
		podmanPath: settings.podmanPath,
		image: imageFor(settings, 'sqlmap'),
		command: 'sqlmap',
		args: checked.value.args,
		timeoutMs: TOOL_CATALOG.find((tool) => tool.id === id)?.timeoutMs ?? 600_000,
		network: 'target',
		reachHostLoopback: checked.value.reachHostLoopback,
		memoryMb: MEMORY_MB,
		pidsLimit: PIDS,
	});
	const parsed = parseSqlmapOutput(result.stdout);
	return {
		ok: result.exitCode === 0 && !result.timedOut,
		stdout: redactSecrets(buildReport(checked.value, parsed, result.timedOut)).slice(0, 20_000),
		stderr: result.stderr.slice(0, 4_000),
		exitCode: result.exitCode,
		timedOut: result.timedOut,
		source: BUILTIN_SOURCE,
		tool: id,
	};
}

interface SqlmapParsed {
	injectable: boolean;
	parameters: string[];
	dbms: string[];
	banner: string;
	currentUser: string;
	currentDb: string;
	dbs: string[];
	evidence: string;
}

function parseSqlmapOutput(stdout: string): SqlmapParsed {
	const text = stdout.replace(/\x1b\[[0-9;]*m/g, '');
	const parameters: string[] = [];
	const dbms: string[] = [];
	const dbs: string[] = [];
	let banner = '';
	let currentUser = '';
	let currentDb = '';
	const evidenceLines: string[] = [];
	const keepEvidence = (line: string) => {
		if (evidenceLines.length < 60) {
			evidenceLines.push(line.trim());
		}
	};

	for (const line of text.split(/\r?\n/)) {
		if (/parameter '[^']+' is .* injectable/i.test(line) || /is vulnerable/i.test(line)) {
			keepEvidence(line);
			continue;
		}
		if (/^\s*(Parameter|Type|Title|Payload):/.test(line)) {
			keepEvidence(line);
			if (/^\s*Parameter:/.test(line)) {
				parameters.push(line.trim());
			}
			continue;
		}
		const dbmsMatch = /back-end DBMS(?:\s+is)?:\s*(.+)$/i.exec(line);
		if (dbmsMatch) {
			dbms.push(dbmsMatch[1].trim());
			keepEvidence(line);
			continue;
		}
		const bannerMatch = /banner:\s*'([^']+)'/i.exec(line);
		if (bannerMatch) {
			banner = bannerMatch[1];
			continue;
		}
		const userMatch = /current user:\s*'([^']+)'/i.exec(line);
		if (userMatch) {
			currentUser = userMatch[1];
			continue;
		}
		const dbMatch = /current database:\s*'([^']+)'/i.exec(line);
		if (dbMatch) {
			currentDb = dbMatch[1];
			continue;
		}
		if (/available databases \[\d+\]:/i.test(line)) {
			keepEvidence(line);
			continue;
		}
		const dbRow = /^\[\*\]\s+(.+)$/.exec(line);
		if (dbRow && dbs.length < 40 && /available databases/.test(evidenceLines.at(-1) ?? '')) {
			dbs.push(dbRow[1].trim());
		}
	}
	return {
		injectable: parameters.length > 0 || evidenceLines.some((line) => /injectable|is vulnerable/i.test(line)),
		parameters: [...new Set(parameters)].slice(0, 20),
		dbms: [...new Set(dbms)].slice(0, 5),
		banner,
		currentUser,
		currentDb,
		dbs,
		evidence: evidenceLines.join('\n').slice(0, EVIDENCE_CAP),
	};
}

function buildReport(checked: SqlmapChecked, parsed: SqlmapParsed, timedOut: boolean): string {
	const lines = [
		`SQLMap bounded proof — ${checked.originalUrl}`,
		checked.url !== checked.originalUrl ? `Scanned as: ${checked.url}` : '',
		`Args: ${checked.summaryBits.join(' · ')}`,
		timedOut ? 'Timed out: yes (partial output below)' : '',
		`Injectable: ${parsed.injectable ? 'YES' : 'no'}`,
	];
	if (parsed.parameters.length > 0) {
		lines.push('', 'Parameters:', ...parsed.parameters.map((item) => `- ${item}`));
	}
	if (parsed.dbms.length > 0) {
		lines.push('', `DBMS: ${parsed.dbms.join(' | ')}`);
	}
	if (parsed.banner) {
		lines.push(`Banner: ${parsed.banner}`);
	}
	if (parsed.currentUser) {
		lines.push(`Current user: ${parsed.currentUser}`);
	}
	if (parsed.currentDb) {
		lines.push(`Current database: ${parsed.currentDb}`);
	}
	if (parsed.dbs.length > 0) {
		lines.push(`Databases: ${parsed.dbs.join(', ')}`);
	}
	if (parsed.evidence) {
		lines.push('', 'Evidence excerpt:', parsed.evidence);
	}
	if (!parsed.injectable && !parsed.evidence) {
		lines.push('', 'No injection points found within the bounded flags. A negative result is evidence too.');
	}
	lines.push('', 'Proof only: data extraction, OS takeover, raw SQL, and tamper scripts are refused in code.');
	return lines.filter((line) => line !== '').join('\n');
}

function fail(stderr: string) {
	return { ok: false, stdout: '', stderr, exitCode: 1 };
}
