import { restoreRedactedAddresses } from './MarkdownBody';
import {
	addressesFromActivity,
	buildDeskPath,
	formatActivityLine,
	isDeskToolStep,
	lastIndexWhere,
	visibleActivity,
	type ActivityStep,
} from './chatActivityView';

export interface CopyableMessage {
	role: 'user' | 'assistant';
	text: string;
	streaming?: boolean;
	activity?: ActivityStep[];
}

const ANSI_RE = /\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

export function stripAnsi(text: string): string {
	return text.replace(ANSI_RE, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function fenceBlock(body: string, lang = 'text'): string {
	const clean = stripAnsi(body).replace(/\s+$/g, '');
	let ticks = '```';
	while (clean.includes(ticks)) {
		ticks += '`';
	}
	return `${ticks}${lang}\n${clean}\n${ticks}`;
}

function looksLikeOutput(text: string): boolean {
	const trimmed = text.trim();
	if (!trimmed) return false;
	if (trimmed.includes('\n')) return true;
	if (trimmed.length > 160) return true;
	if (/^(Error:|Traceback|exit \d+)/i.test(trimmed)) return true;
	return false;
}

function activityToMarkdown(steps: ActivityStep[] | undefined): string {
	const path = buildDeskPath(steps);
	const visible = visibleActivity(steps).filter((step) => step.status !== 'start' || Boolean(step.detail));
	if (!path.breadcrumb && visible.length === 0) {
		return '';
	}

	const lines: string[] = ['## Activity'];
	if (path.breadcrumb) {
		lines.push('', `**${path.breadcrumb}**`);
	}

	const items = path.lines.length > 0
		? path.lines
		: visible.map((step) => formatActivityLine(step));
	if (items.length > 0) {
		lines.push('');
		for (const item of items) {
			const clean = stripAnsi(item).trim();
			if (!clean) continue;
			if (looksLikeOutput(clean)) {
				const first = clean.split('\n')[0].trim();
				lines.push(`- ${first}`);
				lines.push('');
				lines.push(fenceBlock(clean));
				lines.push('');
			} else {
				lines.push(`- ${clean}`);
			}
		}
	}

	const extra = visible.filter((step) => isDeskToolStep(step) && looksLikeOutput(step.detail));
	for (const step of extra) {
		const already = items.some((item) => item.includes(step.detail) || item === formatActivityLine(step));
		if (already) continue;
		lines.push('', `### ${step.name}`, '', fenceBlock(step.detail));
	}

	return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function speakerMarkdown(msg: CopyableMessage): string {
	if (msg.role === 'user') {
		const body = stripAnsi(msg.text).trim();
		return body ? `## You\n\n${body}` : '## You\n\n_(empty)_';
	}

	const parts: string[] = [];
	const activity = activityToMarkdown(msg.activity);
	if (activity) {
		parts.push(activity);
	}
	parts.push('## Hawaldar');
	const restored = restoreRedactedAddresses(stripAnsi(msg.text), addressesFromActivity(msg.activity)).trim();
	if (restored) {
		parts.push('', restored);
	} else if (msg.streaming) {
		parts.push('', '_(streaming…)_');
	}
	return parts.join('\n');
}

export function turnToMarkdown(messages: CopyableMessage[]): string {
	const idx = lastIndexWhere(messages, (item) => item.role === 'assistant');
	if (idx < 0) {
		return '';
	}
	const assistant = messages[idx];
	const user = idx > 0 && messages[idx - 1].role === 'user' ? messages[idx - 1] : undefined;
	const parts = ['# Hawaldar turn', ''];
	if (user) {
		parts.push(speakerMarkdown(user), '');
	}
	parts.push(speakerMarkdown(assistant));
	return `${stripAnsi(parts.join('\n')).trim()}\n`;
}

export function threadToMarkdown(messages: CopyableMessage[]): string {
	if (messages.length === 0) {
		return '';
	}
	const parts = ['# Hawaldar thread', ''];
	for (const msg of messages) {
		parts.push(speakerMarkdown(msg), '');
	}
	return `${stripAnsi(parts.join('\n')).trim()}\n`;
}

export async function writeClipboard(text: string): Promise<void> {
	const value = stripAnsi(text);
	if (navigator.clipboard?.writeText) {
		await navigator.clipboard.writeText(value);
		return;
	}
	const el = document.createElement('textarea');
	el.value = value;
	el.setAttribute('readonly', '');
	el.style.position = 'fixed';
	el.style.left = '-9999px';
	document.body.appendChild(el);
	el.select();
	document.execCommand('copy');
	document.body.removeChild(el);
}
