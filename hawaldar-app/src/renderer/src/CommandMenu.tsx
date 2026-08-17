import { useEffect, useMemo, useRef, useState } from 'react';

export type CommandId =
	| 'copy'
	| 'cut'
	| 'paste'
	| 'selectAll'
	| 'createTask'
	| 'createNote'
	| 'createChat'
	| 'openTasks'
	| 'openGraph'
	| 'openSettings'
	| 'openRuntime';

interface Command {
	id: CommandId;
	label: string;
	group: 'edit' | 'create' | 'open';
	run: () => void;
}

interface Props {
	disabled?: boolean;
	onCreateTask: () => void;
	onCreateNote: () => void;
	onCreateChat: () => void;
	onOpenTasks: () => void;
	onOpenGraph: () => void;
	onOpenSettings: () => void;
	onOpenRuntime: () => void;
}

function isEditable(target: EventTarget | null): boolean {
	if (!(target instanceof Element)) {
		return false;
	}
	const el = target.closest('input, textarea, [contenteditable="true"]');
	if (!el) {
		return false;
	}
	if (el instanceof HTMLInputElement) {
		const type = el.type;
		if (type === 'button' || type === 'submit' || type === 'checkbox' || type === 'radio' || type === 'file') {
			return false;
		}
		return !el.readOnly && !el.disabled;
	}
	if (el instanceof HTMLTextAreaElement) {
		return !el.readOnly && !el.disabled;
	}
	return true;
}

function hasTextSelection(target: EventTarget | null): boolean {
	if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
		return target.selectionStart !== target.selectionEnd;
	}
	const sel = window.getSelection();
	return Boolean(sel && !sel.isCollapsed && sel.toString());
}

function runEdit(command: 'copy' | 'cut' | 'paste' | 'selectAll'): void {
	document.execCommand(command === 'selectAll' ? 'selectAll' : command);
}

export default function CommandMenu({
	disabled = false,
	onCreateTask,
	onCreateNote,
	onCreateChat,
	onOpenTasks,
	onOpenGraph,
	onOpenSettings,
	onOpenRuntime,
}: Props) {
	const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
	const [query, setQuery] = useState('');
	const [active, setActive] = useState(0);
	const [editTarget, setEditTarget] = useState<{ editable: boolean; selection: boolean }>({
		editable: false,
		selection: false,
	});
	const rootRef = useRef<HTMLDivElement>(null);
	const searchRef = useRef<HTMLInputElement>(null);

	const close = () => {
		setPos(null);
		setQuery('');
		setActive(0);
	};

	const commands = useMemo<Command[]>(() => {
		const items: Command[] = [];
		if (editTarget.selection) {
			items.push({ id: 'copy', label: 'Copy', group: 'edit', run: () => runEdit('copy') });
		}
		if (editTarget.editable) {
			if (editTarget.selection) {
				items.push({ id: 'cut', label: 'Cut', group: 'edit', run: () => runEdit('cut') });
			}
			items.push({ id: 'paste', label: 'Paste', group: 'edit', run: () => runEdit('paste') });
			items.push({ id: 'selectAll', label: 'Select all', group: 'edit', run: () => runEdit('selectAll') });
		}
		items.push(
			{ id: 'createTask', label: 'Create new task', group: 'create', run: onCreateTask },
			{ id: 'createNote', label: 'Create new note', group: 'create', run: onCreateNote },
			{ id: 'createChat', label: 'Create new chat', group: 'create', run: onCreateChat },
			{ id: 'openTasks', label: 'Open Tasks', group: 'open', run: onOpenTasks },
			{ id: 'openGraph', label: 'Open Memory graph', group: 'open', run: onOpenGraph },
			{ id: 'openSettings', label: 'Open Settings', group: 'open', run: onOpenSettings },
			{ id: 'openRuntime', label: 'Open Runtime', group: 'open', run: onOpenRuntime },
		);
		return items;
	}, [editTarget, onCreateChat, onCreateNote, onCreateTask, onOpenGraph, onOpenRuntime, onOpenSettings, onOpenTasks]);

	const filtered = useMemo(() => {
		const q = query.trim().toLowerCase();
		if (!q) {
			return commands;
		}
		return commands.filter((item) => item.label.toLowerCase().includes(q) || item.id.toLowerCase().includes(q));
	}, [commands, query]);

	useEffect(() => {
		setActive(0);
	}, [query, pos]);

	useEffect(() => {
		const onContext = (event: MouseEvent) => {
			const target = event.target;
			if (target instanceof Element && target.closest('.quit-overlay, .cmd-menu')) {
				event.preventDefault();
				return;
			}
			event.preventDefault();
			if (disabled) {
				close();
				return;
			}
			setEditTarget({
				editable: isEditable(target),
				selection: hasTextSelection(target),
			});
			const pad = 8;
			const width = 260;
			const x = Math.min(Math.max(event.clientX, pad), window.innerWidth - width - pad);
			const y = Math.min(Math.max(event.clientY, pad), window.innerHeight - 320);
			setQuery('');
			setActive(0);
			setPos({ x, y });
		};
		const onPointer = (event: MouseEvent) => {
			if (!rootRef.current?.contains(event.target as Node)) {
				close();
			}
		};
		document.addEventListener('contextmenu', onContext, true);
		document.addEventListener('mousedown', onPointer);
		return () => {
			document.removeEventListener('contextmenu', onContext, true);
			document.removeEventListener('mousedown', onPointer);
		};
	}, [disabled]);

	useEffect(() => {
		if (!pos) {
			return;
		}
		searchRef.current?.focus();
		const onKey = (event: KeyboardEvent) => {
			if (event.key === 'Escape') {
				event.preventDefault();
				close();
			}
			if (event.key === 'ArrowDown') {
				event.preventDefault();
				setActive((cur) => (cur + 1) % Math.max(filtered.length, 1));
			}
			if (event.key === 'ArrowUp') {
				event.preventDefault();
				setActive((cur) => (cur - 1 + Math.max(filtered.length, 1)) % Math.max(filtered.length, 1));
			}
			if (event.key === 'Enter') {
				event.preventDefault();
				const item = filtered[active];
				if (item) {
					item.run();
					close();
				}
			}
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	}, [active, filtered, pos]);

	useEffect(() => {
		if (!pos || !rootRef.current) {
			return;
		}
		const rect = rootRef.current.getBoundingClientRect();
		const pad = 8;
		let x = pos.x;
		let y = pos.y;
		if (rect.right > window.innerWidth - pad) {
			x = Math.max(pad, window.innerWidth - rect.width - pad);
		}
		if (rect.bottom > window.innerHeight - pad) {
			y = Math.max(pad, window.innerHeight - rect.height - pad);
		}
		if (x !== pos.x || y !== pos.y) {
			setPos({ x, y });
		}
	}, [pos, filtered.length]);

	if (!pos) {
		return null;
	}

	let lastGroup: Command['group'] | '' = '';

	return (
		<div
			ref={rootRef}
			className="cmd-menu"
			style={{ left: pos.x, top: pos.y }}
			role="menu"
			aria-label="Hawaldar commands"
		>
			<div className="cmd-menu-search">
				<input
					ref={searchRef}
					type="search"
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					placeholder="Search commands"
					aria-label="Search commands"
				/>
			</div>
			<div className="cmd-menu-list">
				{filtered.length === 0 && <div className="dd-empty">No matches</div>}
				{filtered.map((item, index) => {
					const sep = item.group !== lastGroup && lastGroup !== '';
					lastGroup = item.group;
					return (
						<div key={item.id}>
							{sep && <div className="cmd-menu-sep" />}
							<button
								type="button"
								role="menuitem"
								className={`cmd-menu-item${index === active ? ' active' : ''}`}
								onMouseEnter={() => setActive(index)}
								onClick={() => {
									item.run();
									close();
								}}
							>
								{item.label}
							</button>
						</div>
					);
				})}
			</div>
		</div>
	);
}
