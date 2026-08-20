/**
 * Minimal PDF 1.4 writer (Helvetica / Courier, no native deps).
 * Engagement reports are laid out as structured blocks — not markdown wrap.
 */

export interface PdfCoverMeta {
	title?: string;
	chatTitle?: string;
	sessionId?: string;
	reportId: string;
	target?: string;
	runId?: string;
	generatedAt?: Date;
}

export interface PdfFindingInput {
	title: string;
	severity: string;
	vulnClass: string;
	status: string;
	target?: string;
	description?: string;
	steps?: string[];
	evidence?: string;
	request?: {
		method?: string;
		url?: string;
		status?: number;
		body?: string;
		response?: string;
		tool?: string;
	};
	impact?: string;
	remediation?: string;
	references?: string[];
}

export interface PdfReportDocument {
	cover: PdfCover;
	blocks: PdfBlock[];
}

export interface PdfCover {
	product: string;
	kicker: string;
	date: string;
	chatTitle: string;
	reportId: string;
	target: string;
	runId: string;
	reportTitle: string;
}

export type PdfBlock =
	| { type: 'heading'; level: 1 | 2; text: string }
	| { type: 'para'; text: string }
	| { type: 'figures'; items: { label: string; value: string }[] }
	| { type: 'table'; headers: string[]; rows: string[][]; weights?: number[] }
	| { type: 'finding'; finding: PdfLaidOutFinding }
	| { type: 'list'; items: PdfListItem[] }
	| { type: 'steps'; items: string[] }
	| { type: 'code'; text: string; caption?: string }
	| { type: 'notes'; items: string[] }
	| { type: 'rule' };

export interface PdfListItem {
	title: string;
	meta?: string;
	note?: string;
}

export interface PdfLaidOutFinding {
	index: number;
	severity: string;
	title: string;
	vulnClass: string;
	url: string;
	description: string;
	steps: string[];
	evidence: string;
	request: string;
	impact: string;
	remediation: string;
	references: string[];
}

export interface PdfLiteOptions {
	title?: string;
	author?: string;
	subject?: string;
	watermark?: string;
	footer?: string;
	/** @deprecated Prefer `document`. Markdown is parsed into blocks, never printed as tokens. */
	body?: string;
	document?: PdfReportDocument;
}

const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN_X = 48;
const CONTENT_BOTTOM = 46;
const PAGE1_TOP = 756;
const CONT_TOP = 730;
const CONTENT_W = PAGE_W - MARGIN_X * 2;

const SIZE_TITLE = 18;
const SIZE_H1 = 14;
const SIZE_H2 = 12;
const SIZE_BODY = 10;
const SIZE_META = 9;
const SIZE_MONO = 8;
const SIZE_FOOTER = 8;
const LEAD_BODY = 13;
const LEAD_MONO = 10;
const LEAD_META = 12;

const COLOR_TEXT = [0.12, 0.13, 0.15] as const;
const COLOR_MUTED = [0.40, 0.41, 0.44] as const;
const COLOR_WHITE = [1, 1, 1] as const;
const COLOR_BAND = [0.11, 0.13, 0.16] as const;
const COLOR_ACCENT = [0.70, 0.55, 0.30] as const;
const COLOR_RULE = [0.82, 0.83, 0.85] as const;
const COLOR_FILL = [0.96, 0.96, 0.97] as const;
const COLOR_HEADER_FILL = [0.93, 0.93, 0.94] as const;
const COLOR_WM = [0.94, 0.945, 0.95] as const;

const SEVERITY_FILL: Record<string, readonly [number, number, number]> = {
	critical: [0.62, 0.14, 0.18],
	high: [0.72, 0.30, 0.10],
	medium: [0.72, 0.52, 0.10],
	low: [0.22, 0.46, 0.34],
	info: [0.30, 0.40, 0.55],
};

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low', 'info'] as const;
const WEAK_TITLES = new Set([
	'', 'none', 'chat', 'chat none', 'new chat', 'untitled', 'new thread', 'unassigned',
]);
const STATUS_RANK: Record<string, number> = {
	confirmed: 70,
	informed: 60,
	fixed: 50,
	'not-exploitable': 40,
	validating: 30,
	unconfirmed: 20,
	hypothesis: 10,
};

type FontId = 'F1' | 'F2' | 'F3';

interface Slice {
	height: number;
	gapAfter: number;
	keepWithNext?: boolean;
	draw: (ops: Ops, yTop: number) => void;
}

interface Placed extends Slice {
	yTop: number;
}

export function formatPdfChatTitle(chatTitle?: string, sessionId?: string): string {
	const title = String(chatTitle ?? '').trim();
	if (title && !isWeakChatTitle(title)) {
		return title;
	}
	const id = String(sessionId ?? '').trim();
	if (id) {
		return id.length <= 12 ? id : id.slice(0, 8);
	}
	return 'Unassigned';
}

function isWeakChatTitle(title: string): boolean {
	const normalized = title.toLowerCase().replace(/\s+/g, ' ').trim();
	if (WEAK_TITLES.has(normalized)) {
		return true;
	}
	return /^chat\s*[:\-]?\s*(none|untitled|new)?$/i.test(title);
}

/** Restore the operator-visible loopback address. Never emit `[IP_ADDRESS]`. */
export function restorePdfAddresses(text: string): string {
	return String(text || '')
		.replace(/https?:\/\/\[IP_ADDRESS\]/gi, 'http://127.0.0.1')
		.replace(/\[IP_ADDRESS\]/gi, '127.0.0.1');
}

export function stripMarkdownTokens(text: string): string {
	return restorePdfAddresses(String(text || ''))
		.replace(/```[\s\S]*?```/g, (block) => block.replace(/```/g, '').trim())
		.replace(/^[ \t]*#{1,6}[ \t]+/gm, '')
		.replace(/\*\*([^*]+)\*\*/g, '$1')
		.replace(/__([^_]+)__/g, '$1')
		.replace(/`([^`]+)`/g, '$1')
		.replace(/(^|\s)\*([^*\n]+)\*(?=\s|$)/g, '$1$2')
		.replace(/^[ \t]*[-*][ \t]+/gm, '')
		.replace(/\|/g, ' ')
		.replace(/[ \t]{2,}/g, ' ')
		.trim();
}

/** Truncate a note on a word boundary with `...` — never a hanging `?`. */
export function clipPdfNote(text: string, max = 140): string {
	const flat = stripMarkdownTokens(text).replace(/\s+/g, ' ').trim();
	if (!flat) {
		return '';
	}
	if (flat.length <= max) {
		return flat;
	}
	const sliced = flat.slice(0, Math.max(1, max - 3));
	const cut = sliced.lastIndexOf(' ');
	const core = (cut > sliced.length * 0.45 ? sliced.slice(0, cut) : sliced).trimEnd()
		.replace(/[.,;:]+$/g, '');
	return `${core}...`;
}

/**
 * Collapse near-identical rows at render time (class + title + target).
 * Keeps the richer existing record — does not invent findings.
 */
export function dedupePdfFindings(findings: PdfFindingInput[]): PdfFindingInput[] {
	const groups = new Map<string, PdfFindingInput[]>();
	const order: string[] = [];
	for (const row of findings) {
		const key = pdfFindingDedupeKey(row);
		if (!groups.has(key)) {
			order.push(key);
			groups.set(key, []);
		}
		groups.get(key)!.push(row);
	}
	return order.map((key) => pickRicherFinding(groups.get(key)!));
}

function pdfFindingDedupeKey(row: PdfFindingInput): string {
	const cls = String(row.vulnClass || 'other').toLowerCase().trim();
	const target = normalizeDedupeTarget(row.target || row.request?.url || '');
	const confirmed = row.status === 'confirmed' || row.status === 'informed';
	if (confirmed) {
		return `c|${cls}|${target}|${evidenceFingerprint(row.evidence || '')}`;
	}
	const title = stripFindingTitle(row.title || '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, ' ')
		.trim();
	return `o|${cls}|${title}|${target}`;
}

function evidenceFingerprint(value: string): string {
	const text = clipEvidence(value).replace(/\s+/g, ' ').trim().toLowerCase();
	if (!text) {
		return '';
	}
	const beforeStatus = text.split(/status\s+\d+/i)[0] || text;
	return beforeStatus.replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 80);
}

function normalizeDedupeTarget(value: string): string {
	return displayTarget(value)
		.toLowerCase()
		.replace(/[?#].*$/, '')
		.replace(/\/+$/, '')
		.replace(/^https?:\/\//, '');
}

function pickRicherFinding(group: PdfFindingInput[]): PdfFindingInput {
	return [...group].sort((a, b) => {
		const status = (STATUS_RANK[b.status] || 0) - (STATUS_RANK[a.status] || 0);
		if (status !== 0) {
			return status;
		}
		const evid = String(b.evidence || '').length - String(a.evidence || '').length;
		if (evid !== 0) {
			return evid;
		}
		return (b.steps?.length || 0) - (a.steps?.length || 0);
	})[0];
}

export function cleanPdfStep(step: string): string {
	let value = stripMarkdownTokens(step);
	for (let i = 0; i < 4; i += 1) {
		const next = value.replace(/^(?:step\s*)?\d+[.)]\s+/i, '').replace(/^[-*•]\s+/, '').trim();
		if (next === value) {
			break;
		}
		value = next;
	}
	return value;
}

export function formatReportDate(when: Date = new Date()): string {
	const months = [
		'January', 'February', 'March', 'April', 'May', 'June',
		'July', 'August', 'September', 'October', 'November', 'December',
	];
	const hh = String(when.getHours()).padStart(2, '0');
	const mm = String(when.getMinutes()).padStart(2, '0');
	return `${when.getDate()} ${months[when.getMonth()]} ${when.getFullYear()}, ${hh}:${mm}`;
}

export function buildEngagementPdfDocument(
	findings: PdfFindingInput[],
	meta: PdfCoverMeta,
): PdfReportDocument {
	const unique = dedupePdfFindings(findings);
	const confirmed = unique.filter((row) => row.status === 'confirmed' || row.status === 'informed');
	const fixed = unique.filter((row) => row.status === 'fixed');
	const notExploitable = unique.filter((row) => row.status === 'not-exploitable');
	const open = unique.filter((row) => (
		row.status === 'hypothesis' || row.status === 'validating' || row.status === 'unconfirmed'
	));
	const bySeverity = new Map<string, number>();
	for (const row of confirmed) {
		const key = row.severity.toLowerCase();
		bySeverity.set(key, (bySeverity.get(key) ?? 0) + 1);
	}
	const cover: PdfCover = {
		product: 'HAWALDAR',
		kicker: 'Authorized engagement report',
		date: formatReportDate(meta.generatedAt || new Date()),
		chatTitle: formatPdfChatTitle(meta.chatTitle, meta.sessionId),
		reportId: meta.reportId || '',
		target: displayTarget(meta.target) || 'See engagement scope',
		runId: meta.runId || '',
		reportTitle: stripMarkdownTokens(meta.title || 'Engagement report'),
	};
	const blocks: PdfBlock[] = [
		{ type: 'heading', level: 1, text: 'Summary' },
		{
			type: 'figures',
			items: [
				{ label: 'Confirmed', value: String(confirmed.length) },
				{ label: 'Not exploitable', value: String(notExploitable.length) },
				{ label: 'Open', value: String(open.length) },
				...(fixed.length > 0 ? [{ label: 'Fixed', value: String(fixed.length) }] : []),
			],
		},
		{
			type: 'table',
			headers: ['Severity', 'Count'],
			weights: [2, 1],
			rows: SEVERITY_ORDER.map((severity) => [
				severity.toUpperCase(),
				String(bySeverity.get(severity) ?? 0),
			]),
		},
	];
	if (confirmed.length > 0) {
		blocks.push({ type: 'heading', level: 1, text: 'Confirmed findings' });
		const sorted = [...confirmed].sort(
			(a, b) => SEVERITY_ORDER.indexOf(a.severity.toLowerCase() as typeof SEVERITY_ORDER[number])
				- SEVERITY_ORDER.indexOf(b.severity.toLowerCase() as typeof SEVERITY_ORDER[number]),
		);
		sorted.forEach((row, index) => {
			blocks.push({ type: 'finding', finding: layOutFinding(row, index + 1) });
		});
	}
	if (fixed.length > 0) {
		blocks.push({ type: 'heading', level: 1, text: 'Fixed (retest)' });
		blocks.push({ type: 'list', items: fixed.map(toListItem) });
	}
	if (notExploitable.length > 0) {
		blocks.push({ type: 'heading', level: 1, text: 'Attempted, not exploitable' });
		blocks.push({ type: 'list', items: notExploitable.map(toListItem) });
	}
	if (open.length > 0) {
		blocks.push({ type: 'heading', level: 1, text: 'Open hypotheses' });
		blocks.push({ type: 'list', items: open.map(toListItem) });
	}
	blocks.push({
		type: 'notes',
		items: [
			'Confirmed items include reproduction steps and the tool evidence collected during this engagement.',
			'After remediation, replay the stored probe. If it no longer proves the issue, mark the finding fixed.',
			'This report is limited to the authorized scope. It is not for unaffiliated redistribution as original work.',
		],
	});
	return { cover, blocks };
}

export function renderPdfLite(opts: PdfLiteOptions): Uint8Array {
	const title = pdfWinAnsi(opts.title || opts.document?.cover.reportTitle || 'Hawaldar report');
	const author = pdfWinAnsi(opts.author || 'Hawaldar');
	const subject = pdfWinAnsi(opts.subject || 'Authorized engagement report');
	const watermark = shortWatermark(opts.watermark);
	const footer = pdfWinAnsi(opts.footer || 'Generated by Hawaldar. Not for unaffiliated redistribution as original work.');
	const document = opts.document || documentFromBody(opts.body || '', opts.title);
	const pages = paginate(document);

	const objects: string[] = [];
	const add = (body: string): number => {
		objects.push(body);
		return objects.length;
	};

	const fontId = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
	const fontBoldId = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>');
	const fontMonoId = add('<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>');
	const infoId = add(
		`<< /Title ${pdfLiteral(title)} /Author ${pdfLiteral(author)} /Subject ${pdfLiteral(subject)} /Creator ${pdfLiteral('Hawaldar')} /Producer ${pdfLiteral('Hawaldar pdf-lite')} >>`,
	);

	const contentIds: number[] = [];
	for (let i = 0; i < pages.length; i += 1) {
		const stream = pageStream(pages[i], i, pages.length, document.cover, watermark, footer);
		contentIds.push(add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`));
	}

	const pageIds: number[] = [];
	const pagesIdPlaceholder = objects.length + pages.length + 1;
	for (let i = 0; i < pages.length; i += 1) {
		pageIds.push(add(
			`<< /Type /Page /Parent ${pagesIdPlaceholder} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] `
			+ `/Resources << /Font << /F1 ${fontId} 0 R /F2 ${fontBoldId} 0 R /F3 ${fontMonoId} 0 R >> >> `
			+ `/Contents ${contentIds[i]} 0 R >>`,
		));
	}
	const kids = pageIds.map((id) => `${id} 0 R`).join(' ');
	const pagesId = add(`<< /Type /Pages /Kids [${kids}] /Count ${pageIds.length} >>`);
	if (pagesId !== pagesIdPlaceholder) {
		throw new Error('pdf-lite: Pages object id mismatch');
	}
	const catalogId = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);

	const header = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
	const chunks: string[] = [header];
	const offsets = [0];
	let cursor = header.length;
	for (let i = 0; i < objects.length; i += 1) {
		const block = `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
		offsets[i + 1] = cursor;
		chunks.push(block);
		cursor += block.length;
	}
	const xrefAt = cursor;
	const xrefLines = [`xref\n0 ${objects.length + 1}\n`, '0000000000 65535 f \n'];
	for (let i = 1; i <= objects.length; i += 1) {
		xrefLines.push(`${String(offsets[i]).padStart(10, '0')} 00000 n \n`);
	}
	chunks.push(xrefLines.join(''));
	chunks.push(
		`trailer << /Size ${objects.length + 1} /Root ${catalogId} 0 R /Info ${infoId} 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`,
	);
	return Buffer.from(chunks.join(''), 'latin1');
}

function documentFromBody(body: string, title?: string): PdfReportDocument {
	return {
		cover: {
			product: 'HAWALDAR',
			kicker: 'Authorized engagement report',
			date: formatReportDate(),
			chatTitle: formatPdfChatTitle('', ''),
			reportId: '',
			target: '',
			runId: '',
			reportTitle: stripMarkdownTokens(title || 'Hawaldar report'),
		},
		blocks: parseMarkdownToBlocks(body),
	};
}

function parseMarkdownToBlocks(body: string): PdfBlock[] {
	const lines = String(body || '').replace(/\r\n/g, '\n').split('\n');
	const blocks: PdfBlock[] = [];
	let index = 0;
	let para: string[] = [];
	const flushPara = () => {
		const text = stripMarkdownTokens(para.join(' '));
		if (text) {
			blocks.push({ type: 'para', text });
		}
		para = [];
	};
	while (index < lines.length) {
		const line = lines[index];
		if (/^\s*(```|'''|‘‘‘|’’’)/.test(line)) {
			flushPara();
			index += 1;
			const code: string[] = [];
			while (index < lines.length && !/^\s*(```|'''|‘‘‘|’’’)/.test(lines[index])) {
				code.push(lines[index]);
				index += 1;
			}
			if (index < lines.length) {
				index += 1;
			}
			blocks.push({ type: 'code', text: code.join('\n'), caption: 'Evidence' });
			continue;
		}
		if (/^\s*\|.+\|\s*$/.test(line)) {
			flushPara();
			const table: string[][] = [];
			while (index < lines.length && /^\s*\|/.test(lines[index])) {
				const raw = lines[index];
				if (!/^\s*\|?\s*:?-{2,}/.test(raw)) {
					const cells = raw.split('|').slice(1, -1).map((cell) => stripMarkdownTokens(cell));
					if (cells.length > 0) {
						table.push(cells);
					}
				}
				index += 1;
			}
			if (table.length > 0) {
				blocks.push({ type: 'table', headers: table[0], rows: table.slice(1) });
			}
			continue;
		}
		if (/^#{1,6}\s+/.test(line)) {
			flushPara();
			const hashes = line.match(/^#{1,6}/)?.[0].length ?? 1;
			blocks.push({
				type: 'heading',
				level: hashes >= 3 ? 2 : 1,
				text: stripMarkdownTokens(line.replace(/^#{1,6}\s+/, '')),
			});
			index += 1;
			continue;
		}
		if (/^\s*([-*_]{3,}|\*\*\*+)\s*$/.test(line)) {
			flushPara();
			blocks.push({ type: 'rule' });
			index += 1;
			continue;
		}
		if (/^\s*[-*]\s+/.test(line)) {
			flushPara();
			const items: PdfListItem[] = [];
			while (index < lines.length && /^\s*[-*]\s+/.test(lines[index])) {
				items.push({ title: stripMarkdownTokens(lines[index].replace(/^\s*[-*]\s+/, '')) });
				index += 1;
			}
			blocks.push({ type: 'list', items });
			continue;
		}
		if (/^\s*\d+[.)]\s+/.test(line)) {
			flushPara();
			const items: string[] = [];
			while (index < lines.length && /^\s*\d+[.)]\s+/.test(lines[index])) {
				items.push(cleanPdfStep(lines[index]));
				index += 1;
			}
			blocks.push({ type: 'steps', items });
			continue;
		}
		if (!line.trim()) {
			flushPara();
			index += 1;
			continue;
		}
		para.push(line.trim());
		index += 1;
	}
	flushPara();
	return blocks;
}

function paginate(document: PdfReportDocument): Placed[][] {
	const slices = [
		coverSlice(document.cover),
		...document.blocks.flatMap(blockToSlices),
	];
	const pages: Placed[][] = [];
	let current: Placed[] = [];
	let pageIndex = 0;
	let y = PAGE1_TOP;

	const flush = () => {
		if (current.length === 0) {
			return;
		}
		pages.push(current);
		current = [];
		pageIndex += 1;
		y = CONT_TOP;
	};

	for (let i = 0; i < slices.length; i += 1) {
		const slice = slices[i];
		let need = slice.height;
		if (slice.keepWithNext && slices[i + 1]) {
			need += Math.min(slices[i + 1].height, 40);
		}
		if (current.length > 0 && y - need < CONTENT_BOTTOM) {
			flush();
		}
		current.push({ ...slice, yTop: y });
		y -= slice.height + slice.gapAfter;
	}
	flush();
	return pages.length > 0 ? pages : [[]];
}

function blockToSlices(block: PdfBlock): Slice[] {
	switch (block.type) {
		case 'heading':
			return [headingSlice(block.text, block.level)];
		case 'para':
			return [paragraphSlice(block.text)];
		case 'figures':
			return [figuresSlice(block.items)];
		case 'table':
			return tableSlices(block.headers, block.rows, block.weights);
		case 'finding':
			return findingSlices(block.finding);
		case 'list':
			return [listSlice(block.items)];
		case 'steps':
			return [stepsSlice(block.items)];
		case 'code':
			return codeSlices(block.text, block.caption || 'Evidence');
		case 'notes':
			return [notesSlice(block.items)];
		case 'rule':
			return [{
				height: 10,
				gapAfter: 8,
				draw: (ops, yTop) => ops.rect(MARGIN_X, yTop - 2, CONTENT_W, 0.6, 'f', COLOR_RULE),
			}];
		default:
			return [];
	}
}

function coverSlice(cover: PdfCover): Slice {
	const rows = coverKvRows(cover);
	const valueWidth = CONTENT_W - 88;
	let metaH = 18;
	for (const row of rows) {
		metaH += Math.max(LEAD_META, wrapText(row.value, 'F1', SIZE_META, valueWidth).length * LEAD_META) + 2;
	}
	const bandH = 80;
	const metaBottom = PAGE_H - bandH - metaH;
	const height = Math.max(bandH, PAGE1_TOP - metaBottom + 8);
	return {
		height,
		gapAfter: 18,
		draw: (ops) => {
			const bandBottom = PAGE_H - bandH;
			ops.rect(0, bandBottom, PAGE_W, bandH, 'f', COLOR_BAND);
			ops.rect(0, bandBottom, PAGE_W, 2.4, 'f', COLOR_ACCENT);
			ops.text(MARGIN_X, PAGE_H - 32, 'F2', SIZE_TITLE, cover.product, COLOR_WHITE);
			ops.text(MARGIN_X, PAGE_H - 54, 'F1', 11, cover.kicker, [0.86, 0.86, 0.88]);
			if (cover.reportTitle && !/^engagement report$/i.test(cover.reportTitle)) {
				ops.text(MARGIN_X, PAGE_H - 70, 'F1', SIZE_META, cover.reportTitle, [0.72, 0.73, 0.75]);
			}
			let cursor = bandBottom - 18;
			for (const row of rows) {
				ops.text(MARGIN_X, cursor, 'F2', SIZE_META, row.label, COLOR_MUTED);
				const lines = wrapText(row.value, 'F1', SIZE_META, valueWidth);
				for (const line of lines) {
					ops.text(MARGIN_X + 88, cursor, 'F1', SIZE_META, line, COLOR_TEXT);
					cursor -= LEAD_META;
				}
				cursor -= 2;
			}
			ops.rect(MARGIN_X, cursor + 8, CONTENT_W, 0.6, 'f', COLOR_RULE);
		},
	};
}

function coverKvRows(cover: PdfCover): { label: string; value: string }[] {
	const rows = [
		{ label: 'Chat', value: cover.chatTitle },
		{ label: 'Generated', value: cover.date },
		{ label: 'Report', value: cover.reportId },
		{ label: 'Target', value: cover.target },
		{ label: 'Run', value: cover.runId },
	];
	return rows.filter((row) => row.value.trim());
}

function headingSlice(text: string, level: 1 | 2): Slice {
	const size = level === 1 ? SIZE_H1 : SIZE_H2;
	const lines = wrapText(text, 'F2', size, CONTENT_W);
	const height = lines.length * (size + 4) + (level === 1 ? 10 : 4);
	return {
		height,
		gapAfter: 8,
		keepWithNext: true,
		draw: (ops, yTop) => {
			if (level === 1) {
				ops.rect(MARGIN_X, yTop - 3, 18, 2.2, 'f', COLOR_ACCENT);
			}
			let cursor = yTop - size;
			for (const line of lines) {
				ops.text(MARGIN_X, cursor, 'F2', size, line, COLOR_TEXT);
				cursor -= size + 4;
			}
		},
	};
}

function paragraphSlice(text: string): Slice {
	const lines = wrapText(stripMarkdownTokens(text), 'F1', SIZE_BODY, CONTENT_W);
	const height = Math.max(LEAD_BODY, lines.length * LEAD_BODY);
	return {
		height,
		gapAfter: 8,
		draw: (ops, yTop) => {
			let cursor = yTop - SIZE_BODY;
			for (const line of lines) {
				ops.text(MARGIN_X, cursor, 'F1', SIZE_BODY, line, COLOR_TEXT);
				cursor -= LEAD_BODY;
			}
		},
	};
}

function figuresSlice(items: { label: string; value: string }[]): Slice {
	const count = Math.max(1, items.length);
	const gap = 10;
	const boxW = (CONTENT_W - gap * (count - 1)) / count;
	const height = 54;
	return {
		height,
		gapAfter: 14,
		draw: (ops, yTop) => {
			items.forEach((item, index) => {
				const x = MARGIN_X + index * (boxW + gap);
				const y = yTop - height;
				ops.rect(x, y, boxW, height, 'f', COLOR_FILL);
				ops.rect(x, y, boxW, height, 's', COLOR_RULE);
				const valueW = measure(item.value, 'F2', 16);
				ops.text(x + (boxW - valueW) / 2, y + 26, 'F2', 16, item.value, COLOR_TEXT);
				const labelW = measure(item.label, 'F1', 8);
				ops.text(x + (boxW - labelW) / 2, y + 10, 'F1', 8, item.label, COLOR_MUTED);
			});
		},
	};
}

function tableSlices(headers: string[], rows: string[][], weights?: number[]): Slice[] {
	const per = 22;
	const chunks: string[][][] = [];
	for (let i = 0; i < rows.length; i += per) {
		chunks.push(rows.slice(i, i + per));
	}
	if (chunks.length === 0) {
		chunks.push([]);
	}
	return chunks.map((chunk) => tableSlice(headers, chunk, weights));
}

function tableSlice(headers: string[], rows: string[][], weights?: number[]): Slice {
	const cols = Math.max(1, headers.length);
	const raw = weights && weights.length === cols ? weights : headers.map(() => 1);
	const total = raw.reduce((sum, value) => sum + value, 0) || 1;
	const colW = raw.map((value) => CONTENT_W * (value / total));
	const rowH = 18;
	const height = rowH * (rows.length + 1) + 2;
	return {
		height,
		gapAfter: 14,
		draw: (ops, yTop) => {
			const top = yTop;
			ops.rect(MARGIN_X, top - rowH, CONTENT_W, rowH, 'f', COLOR_HEADER_FILL);
			let x = MARGIN_X;
			headers.forEach((header, col) => {
				const clipped = fitText(header, 'F2', SIZE_META, colW[col] - 16);
				ops.text(x + 8, top - 13, 'F2', SIZE_META, clipped, COLOR_TEXT);
				x += colW[col];
			});
			rows.forEach((row, rowIndex) => {
				const y = top - rowH * (rowIndex + 2);
				if (rowIndex % 2 === 1) {
					ops.rect(MARGIN_X, y, CONTENT_W, rowH, 'f', COLOR_FILL);
				}
				let cellX = MARGIN_X;
				row.forEach((cell, col) => {
					const clipped = fitText(cell, 'F1', SIZE_META, colW[col] - 16);
					ops.text(cellX + 8, y + 5, 'F1', SIZE_META, clipped, COLOR_TEXT);
					cellX += colW[col];
				});
			});
			ops.rect(MARGIN_X, top - height + 2, CONTENT_W, height - 2, 's', COLOR_RULE);
		},
	};
}

function findingSlices(finding: PdfLaidOutFinding): Slice[] {
	const slices: Slice[] = [findingHeaderSlice(finding)];
	if (finding.description) {
		slices.push(paragraphSlice(finding.description));
	}
	if (finding.steps.length > 0) {
		slices.push(headingSlice('Reproduction', 2));
		slices.push(stepsSlice(finding.steps));
	}
	if (finding.evidence) {
		slices.push(...codeSlices(finding.evidence, 'Evidence'));
	}
	if (finding.request) {
		slices.push(...codeSlices(finding.request, 'Request'));
	}
	if (finding.impact) {
		slices.push(labeledParaSlice('Impact', finding.impact));
	}
	if (finding.remediation) {
		slices.push(labeledParaSlice('Remediation', finding.remediation));
	}
	if (finding.references.length > 0) {
		slices.push(listSlice(finding.references.map((item) => ({ title: item }))));
	}
	if (slices.length > 0) {
		slices[slices.length - 1] = { ...slices[slices.length - 1], gapAfter: 18 };
	}
	return slices;
}

function findingHeaderSlice(finding: PdfLaidOutFinding): Slice {
	const severity = finding.severity.toUpperCase();
	const pill = SEVERITY_FILL[finding.severity.toLowerCase()] || SEVERITY_FILL.info;
	const pillW = Math.max(44, measure(severity, 'F2', 8) + 12);
	const title = `${finding.index}. ${finding.title}`;
	const titleLines = wrapText(title, 'F2', SIZE_H2, CONTENT_W - pillW - 12);
	const classLine = `Class  ${finding.vulnClass}`;
	const urlLines = finding.url
		? wrapText(`Affected  ${finding.url}`, 'F1', SIZE_META, CONTENT_W)
		: [];
	const height = 8 + titleLines.length * 16 + LEAD_META + urlLines.length * LEAD_META + 10;
	return {
		height,
		gapAfter: 8,
		keepWithNext: true,
		draw: (ops, yTop) => {
			const pillH = 13;
			const pillY = yTop - pillH - 2;
			ops.rect(MARGIN_X, pillY, pillW, pillH, 'f', pill);
			const sevW = measure(severity, 'F2', 8);
			ops.text(MARGIN_X + (pillW - sevW) / 2, pillY + 3.5, 'F2', 8, severity, COLOR_WHITE);
			let cursor = yTop - 12;
			const titleX = MARGIN_X + pillW + 10;
			for (const line of titleLines) {
				ops.text(titleX, cursor, 'F2', SIZE_H2, line, COLOR_TEXT);
				cursor -= 16;
			}
			cursor -= 2;
			ops.text(MARGIN_X, cursor, 'F1', SIZE_META, classLine, COLOR_MUTED);
			cursor -= LEAD_META;
			for (const line of urlLines) {
				ops.text(MARGIN_X, cursor, 'F1', SIZE_META, line, COLOR_MUTED);
				cursor -= LEAD_META;
			}
			ops.rect(MARGIN_X, cursor + 6, CONTENT_W, 0.4, 'f', COLOR_RULE);
		},
	};
}

function stepsSlice(items: string[]): Slice {
	const cleaned = items.map((item) => cleanPdfStep(item)).filter(Boolean);
	const numberW = 18;
	const textW = CONTENT_W - numberW;
	const linesPer = cleaned.map((item) => wrapText(item, 'F1', SIZE_BODY, textW));
	const height = linesPer.reduce((sum, lines) => sum + Math.max(LEAD_BODY, lines.length * LEAD_BODY) + 4, 4);
	return {
		height,
		gapAfter: 10,
		draw: (ops, yTop) => {
			let cursor = yTop - SIZE_BODY;
			cleaned.forEach((item, index) => {
				const n = String(index + 1);
				ops.text(MARGIN_X, cursor, 'F2', SIZE_BODY, n, COLOR_MUTED);
				const lines = wrapText(item, 'F1', SIZE_BODY, textW);
				for (const line of lines) {
					ops.text(MARGIN_X + numberW, cursor, 'F1', SIZE_BODY, line, COLOR_TEXT);
					cursor -= LEAD_BODY;
				}
				cursor -= 4;
			});
		},
	};
}

function listSlice(items: PdfListItem[]): Slice {
	const prepared = items.map((item) => {
		const headline = [stripMarkdownTokens(item.title), item.meta].filter(Boolean).join('  ·  ');
		const titleLines = wrapText(headline, 'F1', SIZE_BODY, CONTENT_W - 14);
		const noteLines = item.note
			? wrapText(stripMarkdownTokens(item.note), 'F1', SIZE_META, CONTENT_W - 14)
			: [];
		return { titleLines, noteLines };
	});
	const height = prepared.reduce(
		(sum, item) => sum + item.titleLines.length * LEAD_BODY + item.noteLines.length * LEAD_META + 8,
		4,
	);
	return {
		height,
		gapAfter: 10,
		draw: (ops, yTop) => {
			let cursor = yTop - SIZE_BODY;
			for (const item of prepared) {
				ops.rect(MARGIN_X, cursor + 2, 3, 3, 'f', COLOR_ACCENT);
				for (const line of item.titleLines) {
					ops.text(MARGIN_X + 12, cursor, 'F1', SIZE_BODY, line, COLOR_TEXT);
					cursor -= LEAD_BODY;
				}
				for (const line of item.noteLines) {
					ops.text(MARGIN_X + 12, cursor, 'F1', SIZE_META, line, COLOR_MUTED);
					cursor -= LEAD_META;
				}
				cursor -= 6;
			}
		},
	};
}

function notesSlice(items: string[]): Slice {
	const heading: Slice = headingSlice('Notes', 1);
	const paras = items.map((item) => paragraphSlice(item));
	const height = heading.height + paras.reduce((sum, item) => sum + item.height + item.gapAfter, 0);
	return {
		height,
		gapAfter: 8,
		draw: (ops, yTop) => {
			heading.draw(ops, yTop);
			let cursor = yTop - heading.height - heading.gapAfter;
			for (const para of paras) {
				para.draw(ops, cursor);
				cursor -= para.height + para.gapAfter;
			}
		},
	};
}

function labeledParaSlice(label: string, text: string): Slice {
	const lines = wrapText(stripMarkdownTokens(text), 'F1', SIZE_BODY, CONTENT_W);
	const height = LEAD_BODY + lines.length * LEAD_BODY;
	return {
		height,
		gapAfter: 8,
		draw: (ops, yTop) => {
			ops.text(MARGIN_X, yTop - SIZE_BODY, 'F2', SIZE_BODY, `${label}.`, COLOR_TEXT);
			let cursor = yTop - SIZE_BODY - LEAD_BODY;
			for (const line of lines) {
				ops.text(MARGIN_X, cursor, 'F1', SIZE_BODY, line, COLOR_TEXT);
				cursor -= LEAD_BODY;
			}
		},
	};
}

function codeSlices(raw: string, caption: string): Slice[] {
	const clipped = clipEvidence(raw);
	const lines = wrapText(clipped, 'F3', SIZE_MONO, CONTENT_W - 16);
	const per = 16;
	const chunks: string[][] = [];
	for (let i = 0; i < lines.length; i += per) {
		chunks.push(lines.slice(i, i + per));
	}
	if (chunks.length === 0) {
		chunks.push([' ']);
	}
	return chunks.map((chunk, index) => {
		const captionH = index === 0 ? 16 : 0;
		const pad = 8;
		const height = captionH + pad * 2 + chunk.length * LEAD_MONO;
		return {
			height,
			gapAfter: 10,
			draw: (ops, yTop) => {
				let boxTop = yTop;
				if (index === 0) {
					ops.text(MARGIN_X, yTop - 10, 'F2', SIZE_META, caption, COLOR_MUTED);
					boxTop = yTop - captionH;
				}
				const boxH = pad * 2 + chunk.length * LEAD_MONO;
				const boxY = boxTop - boxH;
				ops.rect(MARGIN_X, boxY, CONTENT_W, boxH, 'f', COLOR_FILL);
				ops.rect(MARGIN_X, boxY, CONTENT_W, boxH, 's', COLOR_RULE);
				let cursor = boxTop - pad - SIZE_MONO;
				for (const line of chunk) {
					ops.text(MARGIN_X + 8, cursor, 'F3', SIZE_MONO, line || ' ', COLOR_TEXT);
					cursor -= LEAD_MONO;
				}
			},
		};
	});
}

function pageStream(
	placed: Placed[],
	pageIndex: number,
	pageCount: number,
	cover: PdfCover,
	watermark: string,
	footer: string,
): string {
	const ops = new Ops();
	ops.push('q');
	ops.fill(COLOR_WM);
	ops.push(`1 0 0 1 ${(PAGE_W / 2).toFixed(2)} ${(PAGE_H / 2).toFixed(2)} cm`);
	ops.push('0.7071 0.7071 -0.7071 0.7071 0 0 cm');
	const wmSize = 22;
	const wmW = measure(watermark, 'F2', wmSize);
	ops.push('BT');
	ops.push(`/F2 ${wmSize} Tf`);
	ops.push(`${(-wmW / 2).toFixed(2)} -8 Td`);
	ops.push(`${pdfLiteral(watermark)} Tj`);
	ops.push('ET');
	ops.push('Q');

	if (pageIndex > 0) {
		const left = 'Hawaldar  ·  Authorized engagement report';
		ops.text(MARGIN_X, PAGE_H - 28, 'F1', SIZE_FOOTER, left, COLOR_MUTED);
		if (cover.reportId) {
			const idW = measure(cover.reportId, 'F1', SIZE_FOOTER);
			ops.text(PAGE_W - MARGIN_X - idW, PAGE_H - 28, 'F1', SIZE_FOOTER, cover.reportId, COLOR_MUTED);
		}
		ops.rect(MARGIN_X, PAGE_H - 36, CONTENT_W, 0.5, 'f', COLOR_RULE);
	}

	for (const slice of placed) {
		slice.draw(ops, slice.yTop);
	}

	ops.rect(MARGIN_X, 36, CONTENT_W, 0.5, 'f', COLOR_RULE);
	const pageLabel = `${pageIndex + 1} / ${pageCount}`;
	const pageW = measure(pageLabel, 'F1', SIZE_FOOTER);
	ops.text(PAGE_W - MARGIN_X - pageW, 22, 'F1', SIZE_FOOTER, pageLabel, COLOR_MUTED);
	if (footer) {
		const max = CONTENT_W - pageW - 16;
		ops.text(MARGIN_X, 22, 'F1', SIZE_FOOTER, fitText(footer, 'F1', SIZE_FOOTER, max), COLOR_MUTED);
	}
	return ops.toStream();
}

function layOutFinding(row: PdfFindingInput, index: number): PdfLaidOutFinding {
	const url = displayTarget(row.request?.url || row.target || '');
	return {
		index,
		severity: row.severity || 'info',
		title: stripFindingTitle(row.title || 'Untitled finding'),
		vulnClass: row.vulnClass || 'other',
		url,
		description: stripMarkdownTokens(row.description || ''),
		steps: (row.steps || []).map(cleanPdfStep).filter(Boolean),
		evidence: clipEvidence(row.evidence || ''),
		request: formatRequest(row.request),
		impact: stripMarkdownTokens(row.impact || ''),
		remediation: stripMarkdownTokens(row.remediation || ''),
		references: (row.references || []).map((item) => stripMarkdownTokens(item)).filter(Boolean),
	};
}

function toListItem(row: PdfFindingInput): PdfListItem {
	const url = displayTarget(row.request?.url || row.target || '');
	const meta = [row.vulnClass, url].filter(Boolean).join('  ·  ');
	const note = stripMarkdownTokens(row.description || row.evidence || '');
	return { title: stripFindingTitle(row.title || 'Untitled'), meta, note };
}

function formatRequest(request: PdfFindingInput['request']): string {
	if (!request) {
		return '';
	}
	const lines = [
		[request.method, displayTarget(request.url || '')].filter(Boolean).join(' '),
		request.status != null ? `status ${request.status}` : '',
		request.tool ? `tool ${request.tool}` : '',
		request.body ? `body ${clipEvidence(request.body, 400)}` : '',
		request.response ? `response ${clipEvidence(request.response, 600)}` : '',
	].filter(Boolean);
	return lines.join('\n');
}

function stripFindingTitle(value: string): string {
	return stripMarkdownTokens(value)
		.replace(/^\d+[.)]\s+/, '')
		.replace(/^\[(?:CRITICAL|HIGH|MEDIUM|LOW|INFO)\]\s*/i, '')
		.trim() || 'Untitled finding';
}

function displayTarget(value?: string): string {
	const text = restorePdfAddresses(String(value || '')).replace(/\s+/g, ' ').trim();
	if (!text || /^https?:\/\/$/i.test(text)) {
		return '';
	}
	return text;
}

function clipEvidence(raw: string, max = 1800): string {
	let text = restorePdfAddresses(String(raw || '')).replace(/\r\n/g, '\n').trim();
	if (!text) {
		return '';
	}
	text = text
		.replace(/^\s*```[a-z0-9_-]*\s*/i, '')
		.replace(/\s*```\s*$/i, '')
		.replace(/```/g, '')
		.replace(/^\s*(‘{3}|'{3})\s*/u, '')
		.replace(/\s*(‘{3}|'{3})\s*$/u, '');
	if (/<\/?(?:html|body|div|script|style|span)\b/i.test(text) && text.length > 600) {
		text = text
			.replace(/<script[\s\S]*?<\/script>/gi, ' ')
			.replace(/<style[\s\S]*?<\/style>/gi, ' ')
			.replace(/<[^>]+>/g, ' ')
			.replace(/\s+/g, ' ')
			.trim();
	}
	if (text.length <= max) {
		return text;
	}
	const sliced = text.slice(0, max);
	const cut = sliced.lastIndexOf(' ');
	return `${(cut > max * 0.5 ? sliced.slice(0, cut) : sliced).trimEnd()}\n...`;
}

function shortWatermark(raw?: string): string {
	const text = pdfWinAnsi(String(raw || '').trim());
	if (!text || text.length > 16 || /chat|authorized|engagement|·|•/i.test(text)) {
		return 'HAWALDAR';
	}
	return text;
}

class Ops {
	private lines: string[] = [];

	push(line: string): void {
		this.lines.push(line);
	}

	fill(color: readonly number[]): void {
		this.push(`${color[0].toFixed(3)} ${color[1].toFixed(3)} ${color[2].toFixed(3)} rg`);
	}

	stroke(color: readonly number[]): void {
		this.push(`${color[0].toFixed(3)} ${color[1].toFixed(3)} ${color[2].toFixed(3)} RG`);
	}

	rect(
		x: number,
		y: number,
		w: number,
		h: number,
		mode: 'f' | 's',
		color: readonly number[],
	): void {
		if (mode === 'f') {
			this.fill(color);
		} else {
			this.stroke(color);
			this.push('0.4 w');
		}
		this.push(`${n(x)} ${n(y)} ${n(w)} ${n(h)} re ${mode}`);
	}

	text(
		x: number,
		y: number,
		font: FontId,
		size: number,
		value: string,
		color: readonly number[] = COLOR_TEXT,
	): void {
		const text = pdfWinAnsi(value).replace(/\n/g, ' ');
		if (!text) {
			return;
		}
		this.push('BT');
		this.fill(color);
		this.push(`/${font} ${size} Tf`);
		this.push(`1 0 0 1 ${n(x)} ${n(y)} Tm`);
		this.push(`${pdfLiteral(text)} Tj`);
		this.push('ET');
	}

	toStream(): string {
		return this.lines.join('\n');
	}
}

function n(value: number): string {
	return value.toFixed(2);
}

/** Helvetica widths, 1/1000 em, ASCII 32–126. */
const HELVETICA_ASCII = [
	278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
	556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
	1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
	667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
	333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
	556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];

function unitWidth(code: number, font: FontId): number {
	if (font === 'F3') {
		return 600;
	}
	if (code < 32 || code > 126) {
		return font === 'F2' ? 611 : 556;
	}
	const width = HELVETICA_ASCII[code - 32];
	return font === 'F2' ? Math.round(width * 1.05) : width;
}

function measure(text: string, font: FontId, size: number): number {
	let width = 0;
	for (const ch of pdfWinAnsi(text).replace(/\n/g, ' ')) {
		width += unitWidth(ch.charCodeAt(0), font);
	}
	return (width * size) / 1000;
}

function wrapText(text: string, font: FontId, size: number, width: number): string[] {
	const normalized = pdfWinAnsi(text).replace(/\r\n/g, '\n');
	const out: string[] = [];
	for (const para of normalized.split('\n')) {
		if (!para) {
			out.push('');
			continue;
		}
		const words = para.split(/\s+/);
		let line = '';
		for (const word of words) {
			for (const piece of splitLongToken(word, font, size, width)) {
				const next = line ? `${line} ${piece}` : piece;
				if (measure(next, font, size) <= width) {
					line = next;
				} else {
					if (line) {
						out.push(line);
					}
					line = piece;
				}
			}
		}
		if (line) {
			out.push(line);
		}
	}
	return out.length > 0 ? out : [''];
}

function splitLongToken(token: string, font: FontId, size: number, width: number): string[] {
	if (measure(token, font, size) <= width) {
		return [token];
	}
	const out: string[] = [];
	let acc = '';
	for (const ch of token) {
		const next = acc + ch;
		if (measure(next, font, size) <= width) {
			acc = next;
		} else {
			if (acc) {
				out.push(acc);
			}
			acc = ch;
		}
	}
	if (acc) {
		out.push(acc);
	}
	return out;
}

function fitText(text: string, font: FontId, size: number, width: number): string {
	const value = pdfWinAnsi(text).replace(/\n/g, ' ');
	if (measure(value, font, size) <= width) {
		return value;
	}
	const ellipsis = '...';
	let lo = 0;
	let hi = value.length;
	while (lo < hi) {
		const mid = Math.ceil((lo + hi) / 2);
		if (measure(value.slice(0, mid) + ellipsis, font, size) <= width) {
			lo = mid;
		} else {
			hi = mid - 1;
		}
	}
	return `${value.slice(0, lo).trimEnd()}${ellipsis}`;
}

export function pdfWinAnsi(value: string): string {
	const mapped = restorePdfAddresses(String(value || ''))
		.replace(/[\u2018\u2019\u201A\u2032]/g, "'")
		.replace(/[\u201C\u201D\u201E\u2033]/g, '"')
		.replace(/\u2013/g, '-')
		.replace(/\u2014/g, '--')
		.replace(/\u2026/g, '...')
		.replace(/\u00a0/g, ' ')
		.replace(/\u2022/g, '-')
		.replace(/[‘’]/g, "'")
		.replace(/[“”]/g, '"');
	return Array.from(mapped).map((ch) => {
		const code = ch.charCodeAt(0);
		if (code === 10) {
			return '\n';
		}
		if (code === 13) {
			return '';
		}
		if (code < 32) {
			return ' ';
		}
		if (code > 255) {
			return '';
		}
		return ch;
	}).join('');
}

function pdfLiteral(value: string): string {
	return `(${value.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')})`;
}
