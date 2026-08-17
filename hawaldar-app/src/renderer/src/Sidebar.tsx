import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { CatalogItem } from '../../preload/api';
import BrandMark from './BrandMark';
import { useI18n } from './i18n';
import {
	AgentsIcon,
	ChevronIcon,
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
	GraphIcon,
	FindingsIcon,
	TasksIcon,
} from './navIcons';
import PaneSash from './PaneSash';
import { clampGrow, MAIN_PANE_MIN, useDragResize, usePersistedPanelSize } from './paneResize';
import { groupSessions, isSessionPinned, selectVisibleSessions, type SessionGroupId } from './sessionGroups';

type View = 'chat' | 'settings' | 'podman' | 'status' | 'agents' | 'tools' | 'workflows' | 'providers' | 'traces' | 'logs';

const SIDEBAR_KEY = 'hawaldar.sidebarCollapsed';
const GROUP_COLLAPSE_KEY = 'hawaldar.sessionGroupCollapsed';

const LABELED_NAV: Array<{ id: View; labelKey: string; icon: ReactNode }> = [
	{ id: 'agents', labelKey: 'nav.agents', icon: <AgentsIcon /> },
	{ id: 'tools', labelKey: 'nav.tools', icon: <ToolsIcon /> },
	{ id: 'workflows', labelKey: 'nav.workflows', icon: <WorkflowsIcon /> },
	{ id: 'providers', labelKey: 'nav.providers', icon: <ProvidersIcon /> },
	{ id: 'traces', labelKey: 'nav.traces', icon: <TracesIcon /> },
	{ id: 'logs', labelKey: 'nav.logs', icon: <LogsIcon /> },
	{ id: 'status', labelKey: 'nav.status', icon: <StatusIcon /> },
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

function readGroupCollapsed(): Partial<Record<SessionGroupId, boolean>> {
	try {
		const raw = window.localStorage.getItem(GROUP_COLLAPSE_KEY);
		if (!raw) {
			return {};
		}
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		const out: Partial<Record<SessionGroupId, boolean>> = {};
		for (const [key, value] of Object.entries(parsed)) {
			if (value === true) {
				out[key as SessionGroupId] = true;
			}
		}
		return out;
	} catch {
		return {};
	}
}

function writeGroupCollapsed(value: Partial<Record<SessionGroupId, boolean>>) {
	try {
		window.localStorage.setItem(GROUP_COLLAPSE_KEY, JSON.stringify(value));
	} catch {
		/* private mode / quota */
	}
}

interface Props {
	threads: CatalogItem[];
	activeView: View;
	activeSessionId?: string;
	onOpenView: (view: View) => void;
	onSelectThread: (item: CatalogItem) => void;
	onNewThread: () => void;
	onDeleteThread: (id: string) => void;
	onRenameThread: (id: string, title: string) => void;
	onPinThread: (id: string, pinned: boolean) => void;
	onRefreshThreads?: () => void;
	onOpenGraph?: () => void;
	onOpenTasks?: () => void;
	onOpenFindings?: () => void;
	graphActive?: boolean;
	tasksActive?: boolean;
	findingsActive?: boolean;
	/** Confirmed-findings badge on the rail icon; hidden when 0. */
	findingsCount?: number;
}

export default function Sidebar({
	threads,
	activeView,
	activeSessionId,
	onOpenView,
	onSelectThread,
	onNewThread,
	onDeleteThread,
	onRenameThread,
	onPinThread,
	onRefreshThreads,
	onOpenGraph,
	onOpenTasks,
	onOpenFindings,
	graphActive = false,
	tasksActive = false,
	findingsActive = false,
	findingsCount = 0,
}: Props) {
	const { t } = useI18n();
	const [collapsed, setCollapsed] = useState(readCollapsed);
	const [query, setQuery] = useState('');
	const [groupCollapsed, setGroupCollapsed] = useState(readGroupCollapsed);
	const [now, setNow] = useState(() => Date.now());
	const [pages, setPages] = useState(1);
	const railRef = useRef<HTMLElement>(null);
	const sidebarSize = usePersistedPanelSize('sidebar');
	const searching = query.trim().length > 0;
	const visible = useMemo(
		() => (searching ? { items: threads, hasMore: false } : selectVisibleSessions(threads, pages)),
		[threads, pages, searching],
	);
	const groups = useMemo(() => {
		return groupSessions(visible.items, query, now).filter((group) => {
			if (group.items.length === 0) {
				return false;
			}
			if (group.id === 'pinned' && !group.items.some(isSessionPinned)) {
				return false;
			}
			return true;
		});
	}, [visible.items, query, now]);

	useEffect(() => {
		const id = window.setInterval(() => setNow(Date.now()), 1000);
		return () => window.clearInterval(id);
	}, []);

	useEffect(() => {
		setPages(1);
	}, [query]);

	const sidebarResize = useDragResize({
		enabled: !collapsed,
		allowClick: true,
		getValue: () => sidebarSize.sizeRef.current,
		apply: sidebarSize.setSize,
		clamp: (next) => {
			const body = railRef.current?.closest('.app-body');
			const bodyW = body?.clientWidth ?? window.innerWidth;
			const right = body?.querySelector('.right-rail');
			const rightW = right instanceof HTMLElement && !right.classList.contains('collapsed')
				? right.getBoundingClientRect().width
				: 0;
			return clampGrow(next, sidebarSize.min, bodyW - MAIN_PANE_MIN - rightW);
		},
		onCommit: sidebarSize.commit,
	});

	const toggleGroup = (id: SessionGroupId) => {
		setGroupCollapsed((prev) => {
			const next = { ...prev, [id]: !prev[id] };
			writeGroupCollapsed(next);
			return next;
		});
	};

	const toggle = () => {
		setCollapsed((prev) => {
			const next = !prev;
			writeCollapsed(next);
			return next;
		});
	};

	return (
		<aside
			ref={railRef}
			className={`sessions-rail${collapsed ? ' collapsed' : ''}${sidebarResize.active ? ' is-resizing' : ''}`}
			style={{ ['--sessions-w' as string]: `${sidebarSize.size}px` }}
		>
			<div className="sessions-rail-inner">
				<div className="sessions-title">
					<div className="sessions-brand">
						<BrandMark size={20} className="sessions-mark" />
						<h2 className="rail-label">{t('nav.sessions')}</h2>
					</div>
					<div className="sessions-title-actions">
						<button
							type="button"
							className="icon-btn"
							title={t('nav.newSession')}
							aria-label={t('nav.newSession')}
							onClick={onNewThread}
						>
							+
						</button>
						<button
							type="button"
							className="icon-btn"
							title={t('nav.refresh')}
							onClick={() => {
								onRefreshThreads?.();
								onOpenView('chat');
							}}
						>
							↻
						</button>
					</div>
				</div>

				<div className="sessions-search">
					<input
						type="search"
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						placeholder={t('nav.searchSessions')}
						aria-label={t('nav.searchSessions')}
					/>
				</div>

				<div className="sessions-list">
					{threads.length === 0 && (
						<div className="empty-rail">{t('nav.noSessions').split('\n').map((line, index) => (
							<span key={line}>{index > 0 ? <br /> : null}{line}</span>
						))}</div>
					)}
					{threads.length > 0 && groups.length === 0 && (
						<div className="empty-rail">{t('nav.noMatchingSessions')}</div>
					)}
					{groups.map((group) => {
						if (group.items.length === 0) {
							return null;
						}
						const folded = groupCollapsed[group.id] === true;
						return (
							<section key={group.id} className={`session-group${folded ? ' collapsed' : ''}`}>
								<button
									type="button"
									className="session-group-head"
									aria-expanded={!folded}
									onClick={() => toggleGroup(group.id)}
								>
									<ChevronIcon size={12} direction={folded ? 'right' : 'down'} />
									<span className="session-group-label rail-label">{t(`session.${group.id}`)}</span>
									<span className="session-group-count rail-label">{group.items.length}</span>
								</button>
								{!folded && group.items.map((item) => (
									<SessionRow
										key={item.id}
										item={item}
										active={item.id === activeSessionId}
										onSelect={() => onSelectThread(item)}
										onDelete={() => onDeleteThread(item.id)}
										onRename={(title) => onRenameThread(item.id, title)}
										onPin={() => onPinThread(item.id, !item.pinned)}
									/>
								))}
							</section>
						);
					})}
					{visible.hasMore && (
						<button type="button" className="sessions-more" onClick={() => setPages((n) => n + 1)}>
							{t('nav.showOlder')}
						</button>
					)}
				</div>

				<nav className="rail-footer">
					{LABELED_NAV.map((item) => {
						const label = t(item.labelKey);
						return (
							<button
								key={item.id}
								type="button"
								className={`rail-nav${activeView === item.id ? ' active' : ''}`}
								title={item.id === 'tools' ? t('nav.toolsHint') : label}
								onClick={() => onOpenView(item.id)}
							>
								<span className="rail-nav-icon">{item.icon}</span>
								<span className="rail-label">{label}</span>
							</button>
						);
					})}
					<div className="rail-icon-row">
						<button
							type="button"
							className={`rail-icon-btn${graphActive ? ' active' : ''}`}
							title={t('nav.graph')}
							aria-label={t('nav.graph')}
							onClick={() => onOpenGraph?.()}
						>
							<GraphIcon />
						</button>
						<button
							type="button"
							className={`rail-icon-btn${activeView === 'podman' ? ' active' : ''}`}
							title={t('nav.runtime')}
							aria-label={t('nav.runtime')}
							onClick={() => onOpenView('podman')}
						>
							<ContainerIcon />
						</button>
						<button
							type="button"
							className={`rail-icon-btn${tasksActive ? ' active' : ''}`}
							title={t('nav.tasks')}
							aria-label={t('nav.tasks')}
							onClick={() => onOpenTasks?.()}
						>
							<TasksIcon />
						</button>
						<button
							type="button"
							className={`rail-icon-btn rail-icon-badged${findingsActive ? ' active' : ''}`}
							title={findingsCount > 0 ? t('nav.findingsCount', { count: findingsCount }) : t('nav.findings')}
							aria-label={t('nav.findings')}
							onClick={() => onOpenFindings?.()}
						>
							<FindingsIcon />
							{findingsCount > 0 && (
								<span className="rail-badge" aria-hidden="true">
									{findingsCount > 99 ? '99+' : findingsCount}
								</span>
							)}
						</button>
						<button
							type="button"
							className={`rail-icon-btn${activeView === 'settings' ? ' active' : ''}`}
							title={t('nav.settings')}
							aria-label={t('nav.settings')}
							onClick={() => onOpenView('settings')}
						>
							<GearIcon />
						</button>
					</div>
				</nav>
			</div>

			{!collapsed && (
				<PaneSash
					label="Sidebar width"
					active={sidebarResize.active}
					onPointerDown={sidebarResize.onPointerDown}
					onDoubleClick={sidebarSize.reset}
				/>
			)}
			<button
				type="button"
				className="rail-groove"
				title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
				aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
				aria-expanded={!collapsed}
				onPointerDown={(event) => {
					if (!collapsed) {
						sidebarResize.onPointerDown(event);
					}
				}}
				onClick={(event) => {
					if (sidebarResize.consumeDrag()) {
						event.preventDefault();
						event.stopPropagation();
						return;
					}
					toggle();
				}}
			>
				<span className="rail-groove-ridges" aria-hidden="true" />
			</button>
		</aside>
	);
}

function SessionRow({
	item,
	active,
	onSelect,
	onDelete,
	onRename,
	onPin,
}: {
	item: CatalogItem;
	active: boolean;
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
		if ((event.ctrlKey || event.metaKey) && !event.altKey) {
			const key = event.key.toLowerCase();
			if (key === 'c' || key === 'v' || key === 'x' || key === 'a' || key === 'z' || key === 'y') {
				return;
			}
		}
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
		<div className={`session-row${active ? ' active' : ''}${pinned ? ' pinned' : ''}`}>
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
					<span className="meta rail-label">{active ? 'Active' : item.detail === 'active' ? '' : item.detail}</span>
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
