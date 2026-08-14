import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { CatalogItem } from '../../preload/api';
import BrandMark from './BrandMark';
import {
	AgentsIcon,
	ContainerIcon,
	GearIcon,
	LogsIcon,
	PinIcon,
	ProvidersIcon,
	RenameIcon,
	StatusIcon,
	ToolsIcon,
	TracesIcon,
	WorkflowsIcon,
} from './navIcons';

type View = 'chat' | 'settings' | 'podman' | 'status' | 'agents' | 'tools' | 'workflows' | 'providers' | 'traces' | 'logs';

const SIDEBAR_KEY = 'hawaldar.sidebarCollapsed';

const LABELED_NAV: Array<{ id: View; label: string; icon: ReactNode }> = [
	{ id: 'agents', label: 'Agents', icon: <AgentsIcon /> },
	{ id: 'tools', label: 'Tools', icon: <ToolsIcon /> },
	{ id: 'workflows', label: 'Workflows', icon: <WorkflowsIcon /> },
	{ id: 'providers', label: 'Providers', icon: <ProvidersIcon /> },
	{ id: 'traces', label: 'Traces', icon: <TracesIcon /> },
	{ id: 'logs', label: 'Logs', icon: <LogsIcon /> },
	{ id: 'status', label: 'Status', icon: <StatusIcon /> },
];

function readCollapsed(): boolean {
	try {
		return window.localStorage.getItem(SIDEBAR_KEY) === '1';
	} catch {
		return false;
	}
}

function writeCollapsed(value: boolean) {
	try {
		window.localStorage.setItem(SIDEBAR_KEY, value ? '1' : '0');
	} catch {
		/* private mode / quota */
	}
}

interface Props {
	threads: CatalogItem[];
	activeView: View;
	onOpenView: (view: View) => void;
	onSelectThread: (item: CatalogItem) => void;
	onNewThread: () => void;
	onDeleteThread: (id: string) => void;
	onRenameThread: (id: string, title: string) => void;
	onPinThread: (id: string, pinned: boolean) => void;
}

export default function Sidebar({
	threads,
	activeView,
	onOpenView,
	onSelectThread,
	onNewThread,
	onDeleteThread,
	onRenameThread,
	onPinThread,
}: Props) {
	const [collapsed, setCollapsed] = useState(readCollapsed);

	const toggle = () => {
		setCollapsed((prev) => {
			const next = !prev;
			writeCollapsed(next);
			return next;
		});
	};

	return (
		<aside className={`sessions-rail${collapsed ? ' collapsed' : ''}`}>
			<div className="sessions-rail-inner">
				<div className="sessions-title">
					<div className="sessions-brand">
						<BrandMark size={20} className="sessions-mark" />
						<h2 className="rail-label">Sessions</h2>
					</div>
					<div className="sessions-title-actions">
						<button type="button" className="icon-btn" title="Refresh" onClick={() => onOpenView('chat')}>↻</button>
					</div>
				</div>

				<button type="button" className="sessions-new" onClick={onNewThread} title="New Session">
					<span>+</span>
					<span className="rail-label">New Session</span>
				</button>

				<div className="sessions-list">
					{threads.length === 0 && (
						<div className="empty-rail">No sessions yet.<br />Start chatting to create one.</div>
					)}
					{threads.map((item) => (
						<SessionRow
							key={item.id}
							item={item}
							onSelect={() => onSelectThread(item)}
							onDelete={() => onDeleteThread(item.id)}
							onRename={(title) => onRenameThread(item.id, title)}
							onPin={() => onPinThread(item.id, !item.pinned)}
						/>
					))}
				</div>

				<nav className="rail-footer">
					{LABELED_NAV.map((item) => (
						<button
							key={item.id}
							type="button"
							className={`rail-nav${activeView === item.id ? ' active' : ''}`}
							title={item.label}
							onClick={() => onOpenView(item.id)}
						>
							<span className="rail-nav-icon">{item.icon}</span>
							<span className="rail-label">{item.label}</span>
						</button>
					))}
					<div className="rail-icon-row">
						<button
							type="button"
							className={`rail-icon-btn${activeView === 'podman' ? ' active' : ''}`}
							title="Runtime"
							aria-label="Runtime"
							onClick={() => onOpenView('podman')}
						>
							<ContainerIcon />
						</button>
						<button
							type="button"
							className={`rail-icon-btn${activeView === 'settings' ? ' active' : ''}`}
							title="Settings"
							aria-label="Settings"
							onClick={() => onOpenView('settings')}
						>
							<GearIcon />
						</button>
					</div>
				</nav>
			</div>

			<button
				type="button"
				className="rail-groove"
				title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
				aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
				aria-expanded={!collapsed}
				onClick={toggle}
			>
				<span className="rail-groove-ridges" aria-hidden="true" />
			</button>
		</aside>
	);
}

function SessionRow({
	item,
	onSelect,
	onDelete,
	onRename,
	onPin,
}: {
	item: CatalogItem;
	onSelect: () => void;
	onDelete: () => void;
	onRename: (title: string) => void;
	onPin: () => void;
}) {
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(item.label);
	const inputRef = useRef<HTMLInputElement>(null);
	const pinned = item.pinned === true;

	useEffect(() => {
		setDraft(item.label);
	}, [item.label]);

	useEffect(() => {
		if (editing) {
			inputRef.current?.focus();
			inputRef.current?.select();
		}
	}, [editing]);

	const commit = () => {
		const next = draft.trim();
		setEditing(false);
		if (!next || next === item.label) {
			setDraft(item.label);
			return;
		}
		onRename(next);
	};

	const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
		if (event.key === 'Enter') {
			event.preventDefault();
			commit();
		}
		if (event.key === 'Escape') {
			event.preventDefault();
			setDraft(item.label);
			setEditing(false);
		}
	};

	return (
		<div className={`session-row${item.detail === 'active' ? ' active' : ''}${pinned ? ' pinned' : ''}`}>
			{pinned && (
				<span className="session-pin-glyph" title="Pinned" aria-hidden="true">
					<PinIcon filled size={12} />
				</span>
			)}
			{editing ? (
				<input
					ref={inputRef}
					className="session-rename"
					value={draft}
					aria-label="Session title"
					onChange={(e) => setDraft(e.target.value)}
					onBlur={commit}
					onKeyDown={onKeyDown}
					onClick={(e) => e.stopPropagation()}
				/>
			) : (
				<button type="button" className="session-main" onClick={onSelect}>
					<span className="title rail-label">{item.label}</span>
					<span className="meta rail-label">{item.detail === 'active' ? 'Active' : item.detail}</span>
				</button>
			)}
			<span className="row-actions">
				<button
					type="button"
					className={`icon-btn${pinned ? ' on' : ''}`}
					title={pinned ? 'Unpin' : 'Pin'}
					aria-label={pinned ? 'Unpin' : 'Pin'}
					onClick={(e) => {
						e.stopPropagation();
						onPin();
					}}
				>
					<PinIcon filled={pinned} />
				</button>
				<button
					type="button"
					className="icon-btn"
					title="Rename"
					aria-label="Rename"
					onClick={(e) => {
						e.stopPropagation();
						setDraft(item.label);
						setEditing(true);
					}}
				>
					<RenameIcon />
				</button>
				<button
					type="button"
					className="icon-btn"
					title="Delete"
					aria-label="Delete"
					onClick={(e) => {
						e.stopPropagation();
						onDelete();
					}}
				>
					×
				</button>
			</span>
		</div>
	);
}
