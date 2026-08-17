import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ChatHistoryMessage, ListedModel, SlashCommandDTO, WorkflowDTO } from '../../preload/api';
import { ActivityTrail, FindingLine, MemoryCard, ToolStepList } from './ActivityView';
import BrandMark from './BrandMark';
import Dropdown from './Dropdown';
import MarkdownBody from './MarkdownBody';
import { modelSearchToolbar } from './ThinkToggle';
import {
	addressesFromActivity,
	applyActivity,
	buildDeskHops,
	isCardStep,
	isFindingRecordStep,
	isMemoryStep,
	phaseLabel,
	visibleActivity,
	workflowPhaseId,
	type ActivityStep,
} from './chatActivityView';
import { threadToMarkdown, turnToMarkdown, writeClipboard } from './chatCopy';
import { useI18n } from './i18n';
import { findListedModel, isListedFree, modelPickerOption } from './modelDisplay';

interface Message {
	id: string;
	role: 'user' | 'assistant';
	text: string;
	createdAt?: number;
	streaming?: boolean;
	activity?: ActivityStep[];
}

const HISTORY_INITIAL = 2;
const HISTORY_PAGE = 20;

function toUiMessage(row: ChatHistoryMessage): Message {
	return { id: row.id, role: row.role, text: row.text, createdAt: row.createdAt };
}

function isOnboardingProviderHint(text: string): boolean {
	return /set a provider\s*\/\s*API key/i.test(text);
}

function resolveAssistantText(
	streamed: string,
	result: { text?: string; error?: string },
	providerReady: boolean,
): string {
	const candidates = [streamed.trim(), (result.error || '').trim(), (result.text || '').trim()].filter(Boolean);
	const honest = candidates.filter((item) => !isOnboardingProviderHint(item));
	if (honest.length) {
		return honest[0];
	}
	if (!providerReady && candidates.length) {
		return candidates[0];
	}
	return candidates[0] && !isOnboardingProviderHint(candidates[0])
		? candidates[0]
		: (result.error || 'No reply from the model.');
}

interface Props {
	sessionId?: string;
	onSessionBound?: (id: string) => void;
	agentId: string;
	onAgentChange: (id: string) => void;
	modelLabel: string;
	providerLabel: string;
	hasSelectedProvider: boolean;
	onModelChanged: () => void;
	pendingCommand?: string;
	onCommandConsumed: () => void;
	onActivity: () => void;
	onOpenFindings?: () => void;
}

const AGENTS = [
	{ id: 'orchestrator', label: 'Orchestrator' },
	{ id: 'nmap', label: 'Nmap' },
	{ id: 'dns', label: 'DNS' },
	{ id: 'tshark', label: 'tshark' },
	{ id: 'ghidra', label: 'Ghidra' },
	{ id: 'httpx', label: 'httpx' },
	{ id: 'subfinder', label: 'Subfinder' },
	{ id: 'radare', label: 'Radare2' },
	{ id: 'metasploit', label: 'Metasploit' },
	{ id: 'browser', label: 'Browser' },
	{ id: 'scrapling', label: 'Scrapling' },
	{ id: 'research', label: 'Research' },
];

function mergeCommands(...lists: string[][]): string[] {
	const commands: string[] = [];
	for (const list of lists) {
		for (const cmd of list) {
			if (!commands.includes(cmd)) commands.push(cmd);
		}
	}
	return commands;
}

function parseLeadingCommands(
	raw: string,
	known: Set<string>,
): { commands: string[]; prompt: string } {
	const commands: string[] = [];
	let rest = raw.trim();
	while (rest.startsWith('/')) {
		const match = rest.match(/^\/(\w[\w-]*)(?:\s+|$)([\s\S]*)$/);
		if (!match || !known.has(match[1])) break;
		if (!commands.includes(match[1])) {
			commands.push(match[1]);
		}
		rest = (match[2] || '').trim();
	}
	return { commands, prompt: rest };
}

/** Known `/cmd` tokens anywhere in the prompt (word-boundary `/`, not `https://`). */
function extractInlineCommands(
	raw: string,
	known: Set<string>,
): { commands: string[]; prompt: string } {
	const commands: string[] = [];
	const prompt = raw
		.replace(/(^|[\s])\/(\w[\w-]*)(?=[\s]|$)/g, (full, prefix: string, cmd: string) => {
			if (!known.has(cmd)) return full;
			if (!commands.includes(cmd)) commands.push(cmd);
			return prefix;
		})
		.replace(/[ \t]{2,}/g, ' ')
		.trim();
	return { commands, prompt };
}

function parseCommand(
	raw: string,
	defaultAgent: string,
	known: Set<string>,
): { command?: string; commands?: string[]; prompt: string } {
	const leading = parseLeadingCommands(raw, known);
	const inline = extractInlineCommands(leading.prompt, known);
	const commands = mergeCommands(leading.commands, inline.commands);
	if (commands.length) {
		return { command: commands[0], commands, prompt: inline.prompt };
	}
	if (defaultAgent !== 'orchestrator') {
		return { command: defaultAgent, commands: [defaultAgent], prompt: raw.trim() };
	}
	return { prompt: raw.trim() };
}

interface SlashToken {
	start: number;
	end: number;
	query: string;
}

/** `/` + optional query immediately before the caret, at a word boundary. */
function slashTokenBeforeCaret(value: string, caret: number): SlashToken | null {
	const pos = Math.max(0, Math.min(caret, value.length));
	const before = value.slice(0, pos);
	const match = before.match(/(?:^|[\s])\/([\w-]*)$/);
	if (!match) return null;
	const query = match[1];
	const start = pos - query.length - 1;
	return { start, end: pos, query: query.toLowerCase() };
}

function removeSlashToken(value: string, start: number, end: number): { text: string; caret: number } {
	const before = value.slice(0, start);
	let after = value.slice(end);
	if (before.endsWith(' ') && after.startsWith(' ')) {
		after = after.slice(1);
	}
	return { text: before + after, caret: before.length };
}

function commandFromInsert(item: SlashCommandDTO): string {
	return item.cmd;
}

async function collectThreadMessages(
	sessionId: string | undefined,
	loaded: Message[],
	hasMore: boolean,
): Promise<Message[]> {
	if (!sessionId || !hasMore || loaded.length === 0) {
		return loaded;
	}
	const seen = new Set(loaded.map((item) => item.id));
	const older: Message[] = [];
	let cursor = loaded[0].createdAt;
	if (!cursor) {
		return loaded;
	}
	for (let page = 0; page < 40; page += 1) {
		const result = await window.hawaldar.chatHistory(sessionId, { limit: 100, before: cursor });
		const batch = result.messages.filter((item) => !seen.has(item.id)).map(toUiMessage);
		for (const item of batch) {
			seen.add(item.id);
		}
		older.unshift(...batch);
		if (!result.hasMore || result.messages.length === 0) {
			break;
		}
		const next = result.messages[0]?.createdAt;
		if (!next || next >= cursor) {
			break;
		}
		cursor = next;
	}
	return [...older, ...loaded];
}

function WorkingRow() {
	return (
		<div className="tool-row is-running">
			<span className="tool-status is-running" aria-label="running" />
			<span className="tool-row-label">Working<span className="ellipsis" /></span>
		</div>
	);
}

function MessageActivity({
	streaming,
	steps,
	waiting,
	text,
	onOpenFindings,
}: {
	streaming: boolean;
	steps?: ActivityStep[];
	waiting: boolean;
	text?: string;
	onOpenFindings?: () => void;
}) {
	const visible = visibleActivity(steps).filter((step) => {
		if (step.status !== 'error' || !text) return true;
		return !text.includes(step.detail);
	});
	const hops = buildDeskHops(steps);
	const toolSteps = visible.filter((step) => !isCardStep(step));
	const memorySteps = visible.filter((step) => isMemoryStep(step) && step.status !== 'error');
	const findingSteps = visible.filter((step) => isFindingRecordStep(step) && step.status !== 'error');
	const errors = visible.filter(
		(step) => step.status === 'error' && !memorySteps.includes(step) && !findingSteps.includes(step),
	);
	const doneToolSteps = toolSteps.filter((step) => step.status !== 'error');

	if (streaming) {
		if (visible.length === 0 && hops.length === 0) {
			return waiting ? <div className="response-activity"><WorkingRow /></div> : null;
		}
		return (
			<div className="response-activity">
				<ActivityTrail hops={hops} />
				{visible.length === 0 && waiting ? <WorkingRow /> : null}
				<ToolStepList steps={toolSteps} />
				{memorySteps.map((step) => <MemoryCard key={step.id} step={step} />)}
				{findingSteps.map((step) => <FindingLine key={step.id} step={step} onOpenFindings={onOpenFindings} />)}
			</div>
		);
	}

	if (hops.length === 0 && errors.length === 0 && memorySteps.length === 0 && findingSteps.length === 0) {
		return null;
	}
	return (
		<div className="response-activity">
			<ActivityTrail hops={hops} />
			{errors.length > 0 ? <ToolStepList steps={errors} /> : null}
			{doneToolSteps.length > 0 ? (
				<details className="tool-steps-used">
					<summary>
						Used {doneToolSteps.length} {doneToolSteps.length === 1 ? 'tool' : 'tools'}
					</summary>
					<ToolStepList steps={doneToolSteps} />
				</details>
			) : null}
			{memorySteps.map((step) => <MemoryCard key={step.id} step={step} />)}
			{findingSteps.map((step) => <FindingLine key={step.id} step={step} onOpenFindings={onOpenFindings} />)}
		</div>
	);
}

function formatTurnTime(createdAt?: number): string {
	if (!createdAt) return '';
	const date = new Date(createdAt);
	if (Number.isNaN(date.getTime())) return '';
	return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function turnPhase(steps?: ActivityStep[]): string {
	for (let i = (steps?.length ?? 0) - 1; i >= 0; i -= 1) {
		const id = steps?.[i] ? workflowPhaseId(steps[i]) : undefined;
		if (id) return phaseLabel(id);
	}
	return '';
}

/** Slash / suggestion subtitle. Never show MCP repo names. */
function publicDetail(detail?: string): string {
	const text = (detail || '').trim();
	if (!text) return '';
	if (/\bmcp\b/i.test(text) || /WireMCP|GhidraMCP/i.test(text)) return '';
	return text;
}

function appendChip(chips: string[], cmd: string): string[] {
	return chips.includes(cmd) ? chips : [...chips, cmd];
}

function workflowToSlash(workflow: WorkflowDTO): SlashCommandDTO {
	return {
		cmd: workflow.id,
		label: `/${workflow.id}`,
		title: workflow.name,
		detail: workflow.name,
		insert: `/${workflow.id} `,
		kind: 'workflow',
	};
}

/** Enabled playbook workflows only. Disabled ids are dropped even if prompts listed them. */
function mergeSlashWithWorkflows(
	commands: SlashCommandDTO[],
	workflows: WorkflowDTO[],
): SlashCommandDTO[] {
	const disabled = new Set(workflows.filter((item) => !item.enabled).map((item) => item.id));
	const byCmd = new Map<string, SlashCommandDTO>();
	for (const item of commands) {
		if (disabled.has(item.cmd)) continue;
		byCmd.set(item.cmd, item);
	}
	for (const workflow of workflows) {
		if (!workflow.enabled) continue;
		const existing = byCmd.get(workflow.id);
		if (!existing) {
			byCmd.set(workflow.id, workflowToSlash(workflow));
			continue;
		}
		if (
			existing.kind === 'workflow'
			|| existing.detail === 'Workflow'
			|| existing.detail === workflow.name
			|| existing.title === workflow.name
		) {
			byCmd.set(workflow.id, { ...existing, ...workflowToSlash(workflow) });
		}
	}
	return [...byCmd.values()];
}

function slashItemMatches(item: SlashCommandDTO, query: string): boolean {
	if (!query) return true;
	if (item.cmd.startsWith(query)) return true;
	if ((item.title || '').toLowerCase().includes(query)) return true;
	const label = item.label.toLowerCase().replace(/^\//, '');
	return label.startsWith(query);
}


export default function Chat({
	sessionId,
	onSessionBound,
	agentId,
	onAgentChange,
	modelLabel,
	providerLabel,
	hasSelectedProvider,
	onModelChanged,
	pendingCommand,
	onCommandConsumed,
	onActivity,
	onOpenFindings,
}: Props) {
	const { t } = useI18n();
	const [messages, setMessages] = useState<Message[]>([]);
	const [hasMore, setHasMore] = useState(false);
	const [historyReady, setHistoryReady] = useState(!sessionId);
	const [loadingOlder, setLoadingOlder] = useState(false);
	const [input, setInput] = useState('');
	const [slashChips, setSlashChips] = useState<string[]>([]);
	const [slashSuppressed, setSlashSuppressed] = useState(false);
	const [busy, setBusy] = useState(false);
	const [models, setModels] = useState<ListedModel[]>([]);
	const [selectedModel, setSelectedModel] = useState('');
	const [providerId, setProviderId] = useState('');
	const [thinking, setThinking] = useState(false);
	const [freeOnly, setFreeOnly] = useState(false);
	const [slashIndex, setSlashIndex] = useState(0);
	const [slashCommands, setSlashCommands] = useState<SlashCommandDTO[]>([]);
	const [welcome, setWelcome] = useState('Authorized reconnaissance workstation. Policy and Podman gate every tool.');
	const [caret, setCaret] = useState(0);
	const listRef = useRef<HTMLDivElement>(null);
	const bottomRef = useRef<HTMLDivElement>(null);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const stickToBottomRef = useRef(true);
	const ignoreScrollRef = useRef(false);
	const adjustFromHeightRef = useRef<number | null>(null);
	const loadingOlderRef = useRef(false);
	const loadedSessionRef = useRef<string | undefined>(undefined);
	const boundSessionRef = useRef<string | undefined>(undefined);
	const sessionIdRef = useRef(sessionId);
	sessionIdRef.current = sessionId;
	const pendingCaretRef = useRef<number | null>(null);
	const selectionRef = useRef({ start: 0, end: 0 });
	const restoringCaretRef = useRef(false);
	const [copied, setCopied] = useState<'turn' | 'thread' | null>(null);
	const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => () => {
		if (copiedTimerRef.current) {
			clearTimeout(copiedTimerRef.current);
		}
	}, []);

	const knownCommands = useMemo(
		() => new Set(slashCommands.map((item) => item.cmd)),
		[slashCommands],
	);

	const workflowIds = useMemo(
		() => new Set(slashCommands.filter((item) => item.kind === 'workflow').map((item) => item.cmd)),
		[slashCommands],
	);

	const slashToken = useMemo(
		() => slashTokenBeforeCaret(input, caret),
		[input, caret],
	);

	const slashMatches = useMemo(() => {
		if (!slashToken) return [];
		const prefix = slashToken.query;
		return slashCommands.filter((item) => (
			slashItemMatches(item, prefix) && !slashChips.includes(item.cmd)
		));
	}, [slashToken, slashCommands, slashChips]);

	const slashOpen = !slashSuppressed && slashMatches.length > 0;

	const suggestions = useMemo(() => {
		const preferred = ['status', 'readiness', 'tools', 'agents', 'workflow', 'full-engagement'];
		return preferred
			.map((cmd) => slashCommands.find((item) => item.cmd === cmd))
			.filter((item): item is SlashCommandDTO => Boolean(item));
	}, [slashCommands]);

	useEffect(() => {
		setSlashIndex(0);
	}, [slashToken?.start, slashToken?.query, slashChips]);

	useEffect(() => {
		void (async () => {
			const [settings, prompts, commands, workflows] = await Promise.all([
				window.hawaldar.getSettings(),
				window.hawaldar.getPrompts(),
				window.hawaldar.listSlashCommands(),
				window.hawaldar.listPlaybookWorkflows(),
			]);
			setProviderId(settings.provider);
			setSelectedModel(settings.model);
			setThinking(settings.thinking === true);
			setWelcome(prompts.welcome);
			setSlashCommands(mergeSlashWithWorkflows(commands, workflows));
			if (!settings.hasSelectedProvider) {
				setModels([]);
				setFreeOnly(false);
				return;
			}
			const listed = await window.hawaldar.listModels({
				provider: settings.provider,
				baseUrl: settings.baseUrl,
			});
			setModels(listed.models);
			if (!listed.models.some(isListedFree)) {
				setFreeOnly(false);
			}
		})();
	}, [modelLabel]);

	const queueCaret = (pos: number) => {
		const next = Math.max(0, pos);
		pendingCaretRef.current = next;
		selectionRef.current = { start: next, end: next };
		setCaret(next);
	};

	const applyComposerSelection = (el: HTMLTextAreaElement) => {
		const pending = pendingCaretRef.current;
		const start = pending ?? selectionRef.current.start;
		const end = pending ?? selectionRef.current.end;
		const max = el.value.length;
		const a = Math.max(0, Math.min(start, max));
		const b = Math.max(0, Math.min(end, max));
		el.setSelectionRange(a, b);
		selectionRef.current = { start: a, end: b };
	};

	const focusComposer = () => {
		const el = textareaRef.current;
		if (!el) return;
		el.focus();
		applyComposerSelection(el);
	};

	useEffect(() => {
		if (pendingCommand) {
			setSlashChips((prev) => appendChip(prev, pendingCommand));
			setSlashSuppressed(false);
			onCommandConsumed();
			focusComposer();
		}
	}, [pendingCommand, onCommandConsumed]);

	useEffect(() => {
		if (!sessionId) {
			if (boundSessionRef.current) {
				return;
			}
			setMessages([]);
			setHasMore(false);
			setHistoryReady(true);
			loadedSessionRef.current = undefined;
			return;
		}
		if (boundSessionRef.current === sessionId) {
			loadedSessionRef.current = sessionId;
			setHistoryReady(true);
			void window.hawaldar.chatHistory(sessionId, { limit: HISTORY_INITIAL }).then((page) => {
				if (sessionIdRef.current === sessionId) {
					setHasMore(page.hasMore);
				}
			}).catch(() => {
				if (sessionIdRef.current === sessionId) {
					setHasMore(false);
				}
			});
			return;
		}
		if (loadedSessionRef.current === sessionId) {
			return;
		}

		let cancelled = false;
		setMessages([]);
		setHasMore(false);
		setHistoryReady(false);
		stickToBottomRef.current = true;
		void (async () => {
			try {
				const page = await window.hawaldar.chatHistory(sessionId, { limit: HISTORY_INITIAL });
				if (cancelled) return;
				loadedSessionRef.current = sessionId;
				setMessages(page.messages.map(toUiMessage));
				setHasMore(page.hasMore);
			} catch {
				if (!cancelled) {
					setMessages([]);
					setHasMore(false);
				}
			} finally {
				if (!cancelled) setHistoryReady(true);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [sessionId]);

	useLayoutEffect(() => {
		const el = listRef.current;
		if (!el) return;
		const fromHeight = adjustFromHeightRef.current;
		ignoreScrollRef.current = true;
		if (fromHeight != null) {
			el.scrollTop += el.scrollHeight - fromHeight;
			adjustFromHeightRef.current = null;
		} else if (stickToBottomRef.current) {
			el.scrollTop = el.scrollHeight;
		}
		requestAnimationFrame(() => {
			ignoreScrollRef.current = false;
		});
	}, [messages]);

	const loadOlder = async () => {
		const id = sessionIdRef.current;
		const el = listRef.current;
		if (!id || !historyReady || !hasMore || loadingOlderRef.current || messages.length === 0) {
			return;
		}
		const before = messages[0].createdAt;
		if (!before) {
			setHasMore(false);
			return;
		}
		loadingOlderRef.current = true;
		setLoadingOlder(true);
		try {
			const page = await window.hawaldar.chatHistory(id, { limit: HISTORY_PAGE, before });
			if (sessionIdRef.current !== id) {
				return;
			}
			if (el) {
				adjustFromHeightRef.current = el.scrollHeight;
			}
			setHasMore(page.hasMore && page.messages.length > 0);
			setMessages((prev) => {
				const seen = new Set(prev.map((item) => item.id));
				const older = page.messages.filter((item) => !seen.has(item.id)).map(toUiMessage);
				return older.length ? [...older, ...prev] : prev;
			});
		} catch {
			if (sessionIdRef.current === id) {
				setHasMore(false);
			}
		} finally {
			loadingOlderRef.current = false;
			setLoadingOlder(false);
		}
	};

	const onListScroll = () => {
		const el = listRef.current;
		if (!el || ignoreScrollRef.current) return;
		const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
		stickToBottomRef.current = gap < 48;
		const canScroll = el.scrollHeight > el.clientHeight + 1;
		if (canScroll && el.scrollTop < 48) {
			void loadOlder();
		}
	};

	const onListWheel = (event: { deltaY: number }) => {
		const el = listRef.current;
		if (!el) return;
		if (event.deltaY < 0 && el.scrollTop <= 0) {
			void loadOlder();
		}
	};

	// Chromium moves textarea selection to 0 when `value` or `height: auto` is rewritten.
	useLayoutEffect(() => {
		const el = textareaRef.current;
		if (!el) return;
		restoringCaretRef.current = true;
		el.style.height = 'auto';
		el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
		applyComposerSelection(el);
		pendingCaretRef.current = null;
		restoringCaretRef.current = false;
	}, [input, slashChips]);

	const syncCaret = (el: HTMLTextAreaElement) => {
		if (restoringCaretRef.current || pendingCaretRef.current !== null) return;
		const start = el.selectionStart ?? 0;
		const end = el.selectionEnd ?? start;
		selectionRef.current = { start, end };
		setCaret(start);
	};

	const applySlash = (item: SlashCommandDTO) => {
		const cmd = commandFromInsert(item);
		const token = slashTokenBeforeCaret(input, caret) ?? slashToken;
		setSlashChips((prev) => appendChip(prev, cmd));
		if (token) {
			const next = removeSlashToken(input, token.start, token.end);
			queueCaret(next.caret);
			setInput(next.text);
		} else {
			queueCaret(0);
			setInput('');
		}
		setSlashSuppressed(false);
		requestAnimationFrame(() => focusComposer());
	};

	const removeChip = (cmd: string) => {
		setSlashChips((prev) => prev.filter((item) => item !== cmd));
		focusComposer();
	};

	const removeLastChip = () => {
		setSlashChips((prev) => prev.slice(0, -1));
	};

	const composedText = slashChips.length
		? `${slashChips.map((cmd) => `/${cmd}`).join(' ')}${input ? ` ${input}` : ''}`
		: input;

	const sendRaw = async (raw: string, commandsOverride?: string[], promptOverride?: string) => {
		const trimmed = raw.trim();
		if (!trimmed || busy) return;
		const parsed = parseCommand(trimmed, agentId, knownCommands);
		const commands = commandsOverride?.length ? commandsOverride : parsed.commands;
		const command = commands?.[0] ?? parsed.command;
		const prompt = promptOverride !== undefined ? promptOverride : parsed.prompt;
		const now = Date.now();
		const userMsg: Message = { id: `u-${now}`, role: 'user', text: trimmed, createdAt: now };
		const assistantId = `a-${now}`;
		stickToBottomRef.current = true;
		setMessages((prev) => [...prev, userMsg, { id: assistantId, role: 'assistant', text: '', streaming: true, createdAt: now }]);
		setInput('');
		setSlashChips([]);
		setSlashSuppressed(false);
		queueCaret(0);
		setBusy(true);

		const unsubDelta = window.hawaldar.onChatDelta((ev) => {
			setMessages((prev) => prev.map((m) => (
				m.id === assistantId ? { ...m, text: m.text + ev.delta } : m
			)));
		});
		const unsubActivity = window.hawaldar.onChatActivity((ev) => {
			setMessages((prev) => prev.map((m) => (
				m.id === assistantId ? { ...m, activity: applyActivity(m.activity ?? [], ev) } : m
			)));
		});

		try {
			const result = await window.hawaldar.chatStream({
				prompt,
				command,
				threadId: sessionIdRef.current || boundSessionRef.current,
				...(commands?.length ? { commands } : {}),
			});
			setMessages((prev) => prev.map((m) => {
				if (m.id !== assistantId) return m;
				const text = resolveAssistantText(m.text, result, hasSelectedProvider);
				return { ...m, text, streaming: false };
			}));
			if (result.threadId) {
				boundSessionRef.current = result.threadId;
				if (result.threadId !== sessionIdRef.current) {
					onSessionBound?.(result.threadId);
				}
			}
			onActivity();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			setMessages((prev) => prev.map((m) => (
				m.id === assistantId ? { ...m, text: message, streaming: false } : m
			)));
		} finally {
			unsubDelta();
			unsubActivity();
			setBusy(false);
		}
	};

	const sendComposer = () => {
		const inline = extractInlineCommands(input, knownCommands);
		const commands = mergeCommands(slashChips, inline.commands);
		const prompt = inline.prompt;
		const workflowOnly = commands.filter((cmd) => workflowIds.has(cmd));
		if (
			workflowOnly.length === 1
			&& commands.every((cmd) => workflowIds.has(cmd) || cmd === 'workflow')
		) {
			const workflowCmd = workflowOnly[0];
			const display = `/${workflowCmd}${prompt ? ` ${prompt}` : ''}`;
			void sendRaw(display, [workflowCmd], prompt);
			return;
		}
		if (commands.length) {
			const display = `${commands.map((cmd) => `/${cmd}`).join(' ')}${prompt ? ` ${prompt}` : ''}`;
			void sendRaw(display, commands, prompt);
			return;
		}
		void sendRaw(input);
	};

	const onComposerChange = (value: string, nextCaret: number) => {
		const match = value.match(/^\/([\w-]+)\s+/);
		if (match && knownCommands.has(match[1])) {
			const leftover = value.slice(match[0].length);
			const caretAfter = Math.max(0, Math.min(nextCaret - match[0].length, leftover.length));
			setSlashChips((prev) => appendChip(prev, match[1]));
			queueCaret(caretAfter);
			setInput(leftover);
			setSlashSuppressed(false);
			return;
		}
		queueCaret(nextCaret);
		setInput(value);
		setSlashSuppressed(false);
	};

	const persistThinking = (next: boolean) => {
		setThinking(next);
		void window.hawaldar.saveSettings({ thinking: next });
	};

	const selectedListed = findListedModel(models, selectedModel || modelLabel);
	const showThinking = selectedListed?.supportsReasoning === true;
	const hasFreeModels = models.some(isListedFree);
	const pickerModels = models.length > 0
		? (freeOnly && hasFreeModels ? models.filter(isListedFree) : models)
		: [{ id: selectedModel || modelLabel, label: selectedModel || modelLabel, source: 'fallback' as const }];

	const showWelcome = historyReady && messages.length === 0;
	const canCopyTurn = messages.some((item) => item.role === 'assistant');
	const canCopyThread = messages.length > 0;

	const markCopied = (which: 'turn' | 'thread') => {
		setCopied(which);
		if (copiedTimerRef.current) {
			clearTimeout(copiedTimerRef.current);
		}
		copiedTimerRef.current = setTimeout(() => {
			setCopied(null);
			copiedTimerRef.current = null;
		}, 1200);
	};

	const copyTurn = async () => {
		const markdown = turnToMarkdown(messages);
		if (!markdown.trim()) return;
		try {
			await writeClipboard(markdown);
			markCopied('turn');
		} catch {
			/* clipboard unavailable */
		}
	};

	const copyThread = async () => {
		const thread = await collectThreadMessages(
			sessionIdRef.current || boundSessionRef.current,
			messages,
			hasMore,
		);
		const markdown = threadToMarkdown(thread);
		if (!markdown.trim()) return;
		try {
			await writeClipboard(markdown);
			markCopied('thread');
		} catch {
			/* clipboard unavailable */
		}
	};

	return (
		<div className="interactive-session">
			<div
				ref={listRef}
				className="interactive-list"
				onScroll={onListScroll}
				onWheel={onListWheel}
			>
				{loadingOlder && (
					<div className="history-status">Loading earlier messages…</div>
				)}
				{showWelcome && (
					<div className="welcome">
						<div className="welcome-mark">
							<BrandMark size={48} />
						</div>
						<h1>Hawaldar</h1>
						<MarkdownBody className="welcome-md" text={welcome} />
						<div className="suggest-grid">
							{suggestions.map((s) => (
								<button
									key={s.cmd}
									type="button"
									className="suggest"
									onClick={() => {
										const value = s.insert ?? s.label;
										if (value.endsWith(' ')) {
											setSlashChips((prev) => appendChip(prev, s.cmd));
											setSlashSuppressed(false);
											focusComposer();
										} else {
											void sendRaw(value);
										}
									}}
								>
									{publicDetail(s.detail) || s.label}
								</button>
							))}
						</div>
					</div>
				)}

				{messages.map((m) => {
					const time = formatTurnTime(m.createdAt);
					const fullTime = m.createdAt ? new Date(m.createdAt).toLocaleString() : undefined;
					const phase = turnPhase(m.activity);
					return m.role === 'user' ? (
						<div key={m.id} className="request-row" title={fullTime}>
							{time ? <span className="msg-time" aria-hidden>{time}</span> : null}
							<div className="request-bubble">{m.text}</div>
						</div>
					) : (
						<div key={m.id} className="response-row">
							<div className="avatar">
								<BrandMark size={24} />
							</div>
							<div className="response-body">
								<div className="msg-head">
									<span className="agent-label">Hawaldar</span>
									{phase ? <span className="msg-phase">{phase}</span> : null}
									{time ? <span className="msg-time" title={fullTime}>{time}</span> : null}
								</div>
								<MessageActivity
									streaming={Boolean(m.streaming)}
									steps={m.activity}
									waiting={!m.text}
									text={m.text}
									onOpenFindings={onOpenFindings}
								/>
								{m.text ? <MarkdownBody text={m.text} keepAddresses={addressesFromActivity(m.activity)} /> : null}
								{m.streaming && m.text ? <span className="ellipsis" /> : null}
							</div>
						</div>
					);
				})}
				<div ref={bottomRef} />
			</div>

			<div className="input-part">
				<div className={`chat-input-container${busy ? ' working' : ''}`}>
					{slashOpen && (
						<div
							className="slash-menu"
							role="listbox"
							aria-label="Slash commands"
							onMouseDown={(e) => e.preventDefault()}
							onPointerDown={(e) => e.preventDefault()}
						>
							{slashMatches.map((item, index) => (
								<button
									key={item.cmd}
									type="button"
									role="option"
									tabIndex={-1}
									aria-selected={index === slashIndex}
									className={`slash-item${index === slashIndex ? ' active' : ''}`}
									onMouseDown={(e) => {
										e.preventDefault();
										e.stopPropagation();
										applySlash(item);
									}}
									onPointerDown={(e) => {
										e.preventDefault();
										e.stopPropagation();
									}}
									onClick={(e) => {
										e.preventDefault();
										applySlash(item);
									}}
								>
									<span className="slash-cmd">{item.label}</span>
									{item.title ? <span className="slash-title">{item.title}</span> : null}
									{publicDetail(item.detail) ? <span className="slash-detail">{publicDetail(item.detail)}</span> : null}
								</button>
							))}
						</div>
					)}
					<div className="composer-line">
						{slashChips.length > 0 && (
							<div className="slash-chips">
								{slashChips.map((cmd) => (
									<button
										key={cmd}
										type="button"
										className="slash-chip"
										title="Click to remove. Backspace at the start of the prompt removes the last command"
										onMouseDown={(e) => e.preventDefault()}
										onClick={() => removeChip(cmd)}
									>
										/{cmd}
									</button>
								))}
							</div>
						)}
						<textarea
							ref={textareaRef}
							value={input}
							placeholder={slashChips.length ? t('chat.placeholderArgs') : t('chat.placeholder')}
							disabled={busy}
							rows={2}
							onChange={(e) => onComposerChange(e.target.value, e.target.selectionStart ?? e.target.value.length)}
							onSelect={(e) => syncCaret(e.currentTarget)}
							onClick={(e) => syncCaret(e.currentTarget)}
							onKeyUp={(e) => syncCaret(e.currentTarget)}
							onKeyDown={(e) => {
								if ((e.ctrlKey || e.metaKey) && !e.altKey) {
									const key = e.key.toLowerCase();
									if (key === 'c' || key === 'v' || key === 'x' || key === 'a' || key === 'z' || key === 'y') {
										return;
									}
								}
								if (slashOpen) {
									if (e.key === 'ArrowDown') {
										e.preventDefault();
										setSlashIndex((i) => (i + 1) % slashMatches.length);
										return;
									}
									if (e.key === 'ArrowUp') {
										e.preventDefault();
										setSlashIndex((i) => (i - 1 + slashMatches.length) % slashMatches.length);
										return;
									}
									if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
										e.preventDefault();
										const item = slashMatches[slashIndex] || slashMatches[0];
										if (item) applySlash(item);
										return;
									}
									if (e.key === 'Escape') {
										e.preventDefault();
										setSlashSuppressed(true);
										return;
									}
									if (e.key === ' ') {
										setSlashSuppressed(true);
									}
								}
								if (e.key === 'Escape' && slashChips.length && !input) {
									e.preventDefault();
									removeLastChip();
									return;
								}
								if (
									e.key === 'Backspace'
									&& slashChips.length
									&& e.currentTarget.selectionStart === 0
									&& e.currentTarget.selectionEnd === 0
								) {
									e.preventDefault();
									removeLastChip();
									return;
								}
								if (e.key === 'Enter' && !e.shiftKey) {
									e.preventDefault();
									sendComposer();
								}
							}}
						/>
					</div>
					<div className="chat-input-toolbars">
						<div className="toolbar-left">
							<button
								type="button"
								className={`copy-md-btn${copied === 'turn' ? ' copied' : ''}`}
								disabled={!canCopyTurn}
								title={t('chat.copyTurnTitle')}
								onMouseDown={(e) => e.preventDefault()}
								onClick={() => void copyTurn()}
							>
								{copied === 'turn' ? t('chat.copied') : t('chat.copyTurn')}
							</button>
							<button
								type="button"
								className={`copy-md-btn${copied === 'thread' ? ' copied' : ''}`}
								disabled={!canCopyThread}
								title={t('chat.copyThreadTitle')}
								onMouseDown={(e) => e.preventDefault()}
								onClick={() => void copyThread()}
							>
								{copied === 'thread' ? t('chat.copied') : t('chat.copyThread')}
							</button>
							<span className="toolbar-hint">{busy ? t('chat.running') : t('chat.hint')}</span>
						</div>
						<button
							type="button"
							className="submit-btn"
							disabled={busy || !composedText.trim()}
							title={t('chat.send')}
							onClick={() => sendComposer()}
						>
							<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden>
								<path d="M8 3.5 3.5 8H7v4.5h2V8h3.5L8 3.5z" />
							</svg>
						</button>
					</div>
				</div>

				<div className="secondary-toolbar">
					<label className="picker">
						Agent
						<Dropdown
							compact
							prefer="up"
							ariaLabel="Agent"
							value={agentId}
							options={AGENTS.map((a) => ({ value: a.id, label: a.label }))}
							onChange={onAgentChange}
						/>
					</label>
					{hasSelectedProvider && (
						<>
							<span className="picker provider-name">{providerLabel || providerId}</span>
							<label className="picker">
								Model
								<Dropdown
									compact
									prefer="up"
									searchable
									searchPlaceholder="Search models…"
									ariaLabel="Model"
									value={selectedModel || modelLabel}
									options={pickerModels.map(modelPickerOption)}
									searchToolbar={modelSearchToolbar({
										showThinking,
										thinking,
										onThinking: persistThinking,
										showFree: hasFreeModels,
										freeOnly,
										onFreeOnly: setFreeOnly,
									})}
									onChange={(model) => {
										setSelectedModel(model);
										void (async () => {
											await window.hawaldar.saveSettings({ provider: providerId, model });
											await window.hawaldar.reloadRuntime();
											onModelChanged();
										})();
									}}
								/>
							</label>
						</>
					)}
					<span className="context-usage">recon only · podman</span>
				</div>
			</div>
		</div>
	);
}
