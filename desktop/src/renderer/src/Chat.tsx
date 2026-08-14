import { useEffect, useMemo, useRef, useState } from 'react';
import type { ListedModel, SlashCommandDTO } from '../../preload/api';
import BrandMark from './BrandMark';
import Dropdown from './Dropdown';

interface Message {
	id: string;
	role: 'user' | 'assistant';
	text: string;
	streaming?: boolean;
}

interface Props {
	agentId: string;
	onAgentChange: (id: string) => void;
	modelLabel: string;
	providerLabel: string;
	hasSelectedProvider: boolean;
	onModelChanged: () => void;
	pendingCommand?: string;
	onCommandConsumed: () => void;
	onActivity: () => void;
}

const AGENTS = [
	{ id: 'orchestrator', label: 'Orchestrator' },
	{ id: 'nmap', label: 'Nmap' },
	{ id: 'tshark', label: 'tshark' },
	{ id: 'ghidra', label: 'Ghidra' },
	{ id: 'httpx', label: 'httpx' },
	{ id: 'subfinder', label: 'Subfinder' },
	{ id: 'radare', label: 'Radare2' },
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

function renderBody(text: string) {
	const parts = text.split(/(`[^`]+`)/g);
	return parts.map((part, i) => {
		if (part.startsWith('`') && part.endsWith('`')) {
			return <code key={i}>{part.slice(1, -1)}</code>;
		}
		return <span key={i}>{part}</span>;
	});
}

export default function Chat({
	agentId,
	onAgentChange,
	modelLabel,
	providerLabel,
	hasSelectedProvider,
	onModelChanged,
	pendingCommand,
	onCommandConsumed,
	onActivity,
}: Props) {
	const [messages, setMessages] = useState<Message[]>([]);
	const [input, setInput] = useState('');
	const [slashChips, setSlashChips] = useState<string[]>([]);
	const [slashSuppressed, setSlashSuppressed] = useState(false);
	const [busy, setBusy] = useState(false);
	const [models, setModels] = useState<ListedModel[]>([]);
	const [selectedModel, setSelectedModel] = useState('');
	const [providerId, setProviderId] = useState('openai');
	const [slashIndex, setSlashIndex] = useState(0);
	const [slashCommands, setSlashCommands] = useState<SlashCommandDTO[]>([]);
	const [welcome, setWelcome] = useState('Authorized reconnaissance. Policy and Podman gate every tool.');
	const [caret, setCaret] = useState(0);
	const bottomRef = useRef<HTMLDivElement>(null);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const pendingCaretRef = useRef<number | null>(null);

	const knownCommands = useMemo(
		() => new Set(slashCommands.map((item) => item.cmd)),
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
			item.cmd.startsWith(prefix) && !slashChips.includes(item.cmd)
		));
	}, [slashToken, slashCommands, slashChips]);

	const slashOpen = !slashSuppressed && slashMatches.length > 0;

	const suggestions = useMemo(() => {
		const preferred = ['status', 'readiness', 'tools', 'agents', 'workflow'];
		return preferred
			.map((cmd) => slashCommands.find((item) => item.cmd === cmd))
			.filter((item): item is SlashCommandDTO => Boolean(item));
	}, [slashCommands]);

	useEffect(() => {
		setSlashIndex(0);
	}, [slashToken?.start, slashToken?.query, slashChips]);

	useEffect(() => {
		void (async () => {
			const [settings, prompts, commands] = await Promise.all([
				window.hawaldar.getSettings(),
				window.hawaldar.getPrompts(),
				window.hawaldar.listSlashCommands(),
			]);
			setProviderId(settings.provider);
			setSelectedModel(settings.model);
			setWelcome(prompts.welcome);
			setSlashCommands(commands);
			if (!settings.hasSelectedProvider) {
				setModels([]);
				return;
			}
			const listed = await window.hawaldar.listModels({
				provider: settings.provider,
				baseUrl: settings.baseUrl,
			});
			setModels(listed.models);
		})();
	}, [modelLabel]);

	useEffect(() => {
		if (pendingCommand) {
			setSlashChips((prev) => appendChip(prev, pendingCommand));
			setSlashSuppressed(false);
			onCommandConsumed();
			textareaRef.current?.focus();
		}
	}, [pendingCommand, onCommandConsumed]);

	useEffect(() => {
		bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
	}, [messages]);

	useEffect(() => {
		const el = textareaRef.current;
		if (!el) return;
		el.style.height = 'auto';
		el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
		const pos = pendingCaretRef.current;
		if (pos !== null) {
			el.setSelectionRange(pos, pos);
			pendingCaretRef.current = null;
		}
	}, [input, slashChips]);

	const syncCaret = (el: HTMLTextAreaElement) => {
		setCaret(el.selectionStart ?? 0);
	};

	const applySlash = (item: SlashCommandDTO) => {
		const cmd = commandFromInsert(item);
		const token = slashTokenBeforeCaret(input, caret) ?? slashToken;
		setSlashChips((prev) => appendChip(prev, cmd));
		if (token) {
			const next = removeSlashToken(input, token.start, token.end);
			pendingCaretRef.current = next.caret;
			setInput(next.text);
			setCaret(next.caret);
		} else {
			setInput('');
			setCaret(0);
		}
		setSlashSuppressed(false);
		requestAnimationFrame(() => textareaRef.current?.focus());
	};

	const removeChip = (cmd: string) => {
		setSlashChips((prev) => prev.filter((item) => item !== cmd));
		textareaRef.current?.focus();
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
		const userMsg: Message = { id: `u-${Date.now()}`, role: 'user', text: trimmed };
		const assistantId = `a-${Date.now()}`;
		setMessages((prev) => [...prev, userMsg, { id: assistantId, role: 'assistant', text: '', streaming: true }]);
		setInput('');
		setSlashChips([]);
		setSlashSuppressed(false);
		setCaret(0);
		setBusy(true);

		const unsub = window.hawaldar.onChatDelta((ev) => {
			setMessages((prev) => prev.map((m) => (
				m.id === assistantId ? { ...m, text: m.text + ev.delta } : m
			)));
		});

		try {
			const result = await window.hawaldar.chatStream({
				prompt,
				command,
				...(commands?.length ? { commands } : {}),
			});
			setMessages((prev) => prev.map((m) => {
				if (m.id !== assistantId) return m;
				const text = m.text.trim() ? m.text : (result.text || '(empty)');
				return { ...m, text, streaming: false };
			}));
			onActivity();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			setMessages((prev) => prev.map((m) => (
				m.id === assistantId ? { ...m, text: message, streaming: false } : m
			)));
		} finally {
			unsub();
			setBusy(false);
		}
	};

	const sendComposer = () => {
		const inline = extractInlineCommands(input, knownCommands);
		const commands = mergeCommands(slashChips, inline.commands);
		if (commands.length) {
			const prompt = inline.prompt;
			const display = `${commands.map((cmd) => `/${cmd}`).join(' ')}${prompt ? ` ${prompt}` : ''}`;
			void sendRaw(display, commands, prompt);
			return;
		}
		void sendRaw(input);
	};

	const onComposerChange = (value: string, nextCaret: number) => {
		const match = value.match(/^\/([\w-]+)\s+([\s\S]*)$/);
		if (match && knownCommands.has(match[1])) {
			setSlashChips((prev) => appendChip(prev, match[1]));
			pendingCaretRef.current = match[2].length;
			setInput(match[2]);
			setCaret(match[2].length);
			setSlashSuppressed(false);
			return;
		}
		setInput(value);
		setCaret(nextCaret);
		setSlashSuppressed(false);
	};

	const showWelcome = messages.length === 0;

	return (
		<div className="interactive-session">
			<div className="interactive-list">
				{showWelcome && (
					<div className="welcome">
						<div className="welcome-mark">
							<BrandMark size={48} />
						</div>
						<h1>Hawaldar</h1>
						<p style={{ whiteSpace: 'pre-line' }}>{welcome}</p>
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
											textareaRef.current?.focus();
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

				{messages.map((m) => (
					m.role === 'user' ? (
						<div key={m.id} className="request-row">
							<div className="request-bubble">{m.text}</div>
						</div>
					) : (
						<div key={m.id} className="response-row">
							<div className="avatar">
								<BrandMark size={24} />
							</div>
							<div className="response-body">
								<div className="agent-label">Hawaldar</div>
								{m.streaming && !m.text ? (
									<span className="thinking ellipsis">Working</span>
								) : (
									renderBody(m.text)
								)}
								{m.streaming && m.text ? <span className="ellipsis" /> : null}
							</div>
						</div>
					)
				))}
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
							placeholder={slashChips.length ? 'Arguments or target…' : 'Ask Hawaldar… or type / anywhere for commands'}
							disabled={busy}
							rows={2}
							onChange={(e) => onComposerChange(e.target.value, e.target.selectionStart ?? e.target.value.length)}
							onSelect={(e) => syncCaret(e.currentTarget)}
							onClick={(e) => syncCaret(e.currentTarget)}
							onKeyUp={(e) => syncCaret(e.currentTarget)}
							onKeyDown={(e) => {
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
							{busy ? 'Running tools…' : 'Type / for commands · Enter to send'}
						</div>
						<button
							type="button"
							className="submit-btn"
							disabled={busy || !composedText.trim()}
							title="Send"
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
									options={(models.length > 0
										? models
										: [{ id: selectedModel || modelLabel, label: selectedModel || modelLabel, source: 'fallback' as const }]
									).map((m) => ({ value: m.id, label: m.id }))}
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
