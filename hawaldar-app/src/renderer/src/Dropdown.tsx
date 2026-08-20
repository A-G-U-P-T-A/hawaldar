import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import Icon from './Icon';

export interface DropdownBadge {
	text: string;
	tone: 'free' | 'paid';
}

export interface DropdownOption {
	value: string;
	label: string;
	detail?: string;
	badge?: DropdownBadge;
	/** One-line row: ellipsis on the label, detail + badge on the right. */
	inline?: boolean;
	disabled?: boolean;
}

function visibleBadge(badge?: DropdownBadge): DropdownBadge | undefined {
	const text = badge?.text?.trim() ?? '';
	if (!text || /^paid$/i.test(text) || /^\s*\$\s*(?:\/M)?\s*$/i.test(text)) {
		return undefined;
	}
	return badge;
}

interface MenuBox {
	left: number;
	width: number;
	maxHeight: number;
	dir: 'up' | 'down';
	top?: number;
	bottom?: number;
}

function placeMenu(
	trigger: DOMRect,
	prefer: 'up' | 'down',
	compact: boolean,
	itemCount: number,
	searchable: boolean,
	hasToolbar: boolean,
): MenuBox {
	const pad = 8;
	const width = Math.min(
		window.innerWidth - pad * 2,
		compact ? Math.max(trigger.width, 280) : Math.max(trigger.width, 160),
	);
	const need = Math.min(320, itemCount * 34 + (searchable ? 44 : 8) + (hasToolbar ? 32 : 0) + 8);
	const spaceBelow = window.innerHeight - trigger.bottom - pad;
	const spaceAbove = trigger.top - pad;
	const dir: 'up' | 'down' = prefer === 'up'
		? (spaceAbove >= need || spaceAbove > spaceBelow ? 'up' : 'down')
		: (spaceBelow >= need || spaceBelow >= spaceAbove ? 'down' : 'up');
	const maxHeight = Math.max(96, Math.min(280, dir === 'up' ? spaceAbove : spaceBelow));
	let left = trigger.left;
	if (left + width > window.innerWidth - pad) {
		left = window.innerWidth - pad - width;
	}
	if (left < pad) {
		left = pad;
	}
	return dir === 'down'
		? { left, width, maxHeight, dir, top: trigger.bottom + 4 }
		: { left, width, maxHeight, dir, bottom: window.innerHeight - trigger.top + 4 };
}

interface Props {
	value: string;
	options: DropdownOption[];
	onChange: (value: string) => void;
	/** Preferred open direction; flips if there is not enough space. */
	prefer?: 'down' | 'up';
	placeholder?: string;
	disabled?: boolean;
	className?: string;
	/** Compact toolbar variant (chat secondary bar). */
	compact?: boolean;
	ariaLabel?: string;
	searchable?: boolean;
	searchPlaceholder?: string;
	/** Compact switches above the search field (Thinking, Free, …). */
	searchToolbar?: ReactNode;
}

export default function Dropdown({
	value,
	options,
	onChange,
	prefer = 'down',
	placeholder = 'Select…',
	disabled = false,
	className = '',
	compact = false,
	ariaLabel,
	searchable = false,
	searchPlaceholder = 'Search…',
	searchToolbar,
}: Props) {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState('');
	const [active, setActive] = useState(0);
	const [box, setBox] = useState<MenuBox | null>(null);
	const rootRef = useRef<HTMLDivElement>(null);
	const menuRef = useRef<HTMLDivElement>(null);
	const listRef = useRef<HTMLDivElement>(null);
	const searchRef = useRef<HTMLInputElement>(null);
	const listId = useId();

	const selected = options.find((item) => item.value === value);
	const filtered = options.filter((item) => {
		if (!query.trim()) return true;
		const q = query.trim().toLowerCase();
		return item.label.toLowerCase().includes(q)
			|| item.value.toLowerCase().includes(q)
			|| (item.detail || '').toLowerCase().includes(q)
			|| (item.badge?.text || '').toLowerCase().includes(q);
	});

	useLayoutEffect(() => {
		if (!open || !rootRef.current) {
			setBox(null);
			return;
		}
		const update = () => {
			if (!rootRef.current) return;
			setBox(placeMenu(
				rootRef.current.getBoundingClientRect(),
				prefer,
				compact,
				Math.max(filtered.length, 1),
				searchable,
				Boolean(searchToolbar),
			));
		};
		update();
		window.addEventListener('resize', update);
		window.addEventListener('scroll', update, true);
		return () => {
			window.removeEventListener('resize', update);
			window.removeEventListener('scroll', update, true);
		};
	}, [open, prefer, compact, filtered.length, searchable]);

	useEffect(() => {
		if (!open) return;
		const onDoc = (event: MouseEvent) => {
			const target = event.target as Node;
			if (rootRef.current?.contains(target) || menuRef.current?.contains(target)) {
				return;
			}
			setOpen(false);
			setQuery('');
		};
		const onKey = (event: globalThis.KeyboardEvent) => {
			if (event.key === 'Escape') {
				setOpen(false);
				setQuery('');
			}
		};
		document.addEventListener('mousedown', onDoc);
		document.addEventListener('keydown', onKey);
		return () => {
			document.removeEventListener('mousedown', onDoc);
			document.removeEventListener('keydown', onKey);
		};
	}, [open]);

	useEffect(() => {
		if (!open || !rootRef.current) return;
		const page = rootRef.current.closest('.workspace-page');
		if (!page) return;
		const closeIfHidden = () => {
			if (page.hasAttribute('inert') || !page.classList.contains('active')) {
				setOpen(false);
				setQuery('');
			}
		};
		closeIfHidden();
		const obs = new MutationObserver(closeIfHidden);
		obs.observe(page, { attributes: true, attributeFilter: ['class', 'inert'] });
		return () => obs.disconnect();
	}, [open]);

	useEffect(() => {
		if (!open) return;
		setActive(Math.max(0, filtered.findIndex((item) => item.value === value)));
		if (searchable) {
			requestAnimationFrame(() => searchRef.current?.focus());
		}
	}, [open]);

	useEffect(() => {
		if (!open) return;
		const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`);
		el?.scrollIntoView({ block: 'nearest' });
	}, [active, open]);

	const pick = (next: string) => {
		onChange(next);
		setOpen(false);
		setQuery('');
	};

	const onTriggerKey = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
		if (disabled) return;
		if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
			event.preventDefault();
			setOpen(true);
		}
	};

	const onListKey = (event: ReactKeyboardEvent<HTMLElement>) => {
		if ((event.ctrlKey || event.metaKey) && !event.altKey) {
			const key = event.key.toLowerCase();
			if (key === 'c' || key === 'v' || key === 'x' || key === 'a' || key === 'z' || key === 'y') {
				return;
			}
		}
		if (event.key === 'ArrowDown') {
			event.preventDefault();
			setActive((i) => Math.min(filtered.length - 1, i + 1));
		} else if (event.key === 'ArrowUp') {
			event.preventDefault();
			setActive((i) => Math.max(0, i - 1));
		} else if (event.key === 'Enter') {
			event.preventDefault();
			const item = filtered[active];
			if (item && !item.disabled) pick(item.value);
		}
	};

	const menuStyle: CSSProperties | undefined = box
		? {
			left: box.left,
			width: box.width,
			maxHeight: box.maxHeight,
			top: box.top,
			bottom: box.bottom,
		}
		: undefined;

	const menu = open && box && createPortal(
		<div
			ref={menuRef}
			className={`dd-menu dd-menu-portal dd-menu-${box.dir}`}
			style={menuStyle}
			role="listbox"
			id={listId}
			aria-label={ariaLabel || 'Options'}
			onKeyDown={onListKey}
		>
			{(searchable || searchToolbar) && (
				<div className="dd-search">
					{searchToolbar && (
						<div className="dd-search-tools" onKeyDown={(event) => event.stopPropagation()}>
							{searchToolbar}
						</div>
					)}
					{searchable && (
						<input
							ref={searchRef}
							type="text"
							value={query}
							placeholder={searchPlaceholder}
							aria-label={searchPlaceholder}
							onChange={(e) => {
								setQuery(e.target.value);
								setActive(0);
							}}
							onKeyDown={onListKey}
						/>
					)}
				</div>
			)}
			<div className="dd-list" ref={listRef}>
				{filtered.length === 0 && (
					<div className="dd-empty">No matches</div>
				)}
				{filtered.map((item, index) => {
					const badge = visibleBadge(item.badge);
					const inline = item.inline === true || Boolean(badge);
					const title = [item.label, item.detail, badge?.text].filter(Boolean).join('  ');
					return (
						<button
							key={item.value}
							type="button"
							role="option"
							data-idx={index}
							aria-selected={item.value === value}
							disabled={item.disabled}
							title={title}
							className={`dd-option${inline ? ' dd-option-inline' : ''}${item.value === value ? ' selected' : ''}${index === active ? ' active' : ''}`}
							onMouseEnter={() => setActive(index)}
							onClick={() => {
								if (!item.disabled) pick(item.value);
							}}
						>
							<span className="dd-option-label">{item.label}</span>
							{(item.detail || badge) && (
								<span className="dd-option-meta">
									{item.detail && <span className="dd-option-detail">{item.detail}</span>}
									{badge && (
										<span className={`dd-option-badge dd-option-badge-${badge.tone}`}>
											{badge.text}
										</span>
									)}
								</span>
							)}
						</button>
					);
				})}
			</div>
		</div>,
		document.body,
	);

	return (
		<div
			ref={rootRef}
			className={`dd ${compact ? 'dd-compact' : ''} ${open ? 'dd-open' : ''} ${className}`.trim()}
		>
			<button
				type="button"
				className="dd-trigger"
				disabled={disabled}
				aria-haspopup="listbox"
				aria-expanded={open}
				aria-controls={listId}
				aria-label={ariaLabel}
				onClick={() => {
					if (!disabled) setOpen((v) => !v);
				}}
				onKeyDown={onTriggerKey}
			>
				<span className="dd-value" title={selected?.label || value || placeholder}>
					{selected?.label || value || placeholder}
				</span>
				<span className="dd-caret" aria-hidden><Icon name="expand_more" size={18} /></span>
			</button>
			{menu}
		</div>
	);
}
