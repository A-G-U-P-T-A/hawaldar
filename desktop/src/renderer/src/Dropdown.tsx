import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';

export interface DropdownOption {
	value: string;
	label: string;
	detail?: string;
	disabled?: boolean;
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
}: Props) {
	const [open, setOpen] = useState(false);
	const [dir, setDir] = useState<'down' | 'up'>(prefer);
	const [query, setQuery] = useState('');
	const [active, setActive] = useState(0);
	const rootRef = useRef<HTMLDivElement>(null);
	const listRef = useRef<HTMLDivElement>(null);
	const searchRef = useRef<HTMLInputElement>(null);
	const listId = useId();

	const selected = options.find((item) => item.value === value);
	const filtered = options.filter((item) => {
		if (!query.trim()) return true;
		const q = query.trim().toLowerCase();
		return item.label.toLowerCase().includes(q)
			|| item.value.toLowerCase().includes(q)
			|| (item.detail || '').toLowerCase().includes(q);
	});

	useEffect(() => {
		if (!open) return;
		const onDoc = (event: MouseEvent) => {
			if (!rootRef.current?.contains(event.target as Node)) {
				setOpen(false);
				setQuery('');
			}
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
		const rect = rootRef.current.getBoundingClientRect();
		const spaceBelow = window.innerHeight - rect.bottom;
		const spaceAbove = rect.top;
		const need = Math.min(280, filtered.length * 34 + (searchable ? 44 : 8) + 8);
		if (prefer === 'up') {
			setDir(spaceAbove >= need || spaceAbove > spaceBelow ? 'up' : 'down');
		} else {
			setDir(spaceBelow >= need || spaceBelow >= spaceAbove ? 'down' : 'up');
		}
		setActive(Math.max(0, filtered.findIndex((item) => item.value === value)));
		if (searchable) {
			requestAnimationFrame(() => searchRef.current?.focus());
		}
	}, [open, prefer, filtered.length, searchable, value]);

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
				<span className="dd-caret" aria-hidden>▾</span>
			</button>
			{open && (
				<div
					className={`dd-menu dd-menu-${dir}`}
					role="listbox"
					id={listId}
					aria-label={ariaLabel || 'Options'}
					onKeyDown={onListKey}
				>
					{searchable && (
						<div className="dd-search">
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
						</div>
					)}
					<div className="dd-list" ref={listRef}>
						{filtered.length === 0 && (
							<div className="dd-empty">No matches</div>
						)}
						{filtered.map((item, index) => (
							<button
								key={item.value}
								type="button"
								role="option"
								data-idx={index}
								aria-selected={item.value === value}
								disabled={item.disabled}
								className={`dd-option${item.value === value ? ' selected' : ''}${index === active ? ' active' : ''}`}
								onMouseEnter={() => setActive(index)}
								onClick={() => {
									if (!item.disabled) pick(item.value);
								}}
							>
								<span className="dd-option-label">{item.label}</span>
								{item.detail && <span className="dd-option-detail">{item.detail}</span>}
							</button>
						))}
					</div>
				</div>
			)}
		</div>
	);
}
