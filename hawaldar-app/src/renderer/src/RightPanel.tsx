import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FindingDTO, NoteSummaryDTO } from '../../preload/api';
import { FindingsIcon, NotesIcon } from './navIcons';
import PaneSash from './PaneSash';
import { clampGrow, MAIN_PANE_MIN, useDragResize, usePersistedPanelSize } from './paneResize';
import { fuzzyMatch } from './sessionGroups';
import { restoreRedactedAddresses } from './keepAddresses';

const COLLAPSED_KEY = 'hawaldar.rightPanelCollapsed';
const PANE_KEY = 'hawaldar.rightPanelPane';

type RailPane = 'notes' | 'findings';

function readCollapsed(): boolean {
	try {
		return window.localStorage.getItem(COLLAPSED_KEY) === '1';
	} catch {
		return false;
	}
}

function writeCollapsed(value: boolean) {
	try {
		window.localStorage.setItem(COLLAPSED_KEY, value ? '1' : '0');
	} catch {
		/* private mode / quota */
	}
}

function readPane(): RailPane {
	try {
		return window.localStorage.getItem(PANE_KEY) === 'findings' ? 'findings' : 'notes';
	} catch {
		return 'notes';
	}
}

function writePane(value: RailPane) {
	try {
		window.localStorage.setItem(PANE_KEY, value);
	} catch {
		/* private mode / quota */
	}
}

function errText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

interface Props {
	activeNoteId?: string;
	listEpoch: number;
	onOpenNote: (id: string, title: string) => void;
	onCreateNote: () => void;
	onNoteRemoved: (id: string) => void;
	onOpenFindings?: () => void;
	findingsCount?: number;
}

export default function RightPanel({
	activeNoteId,
	listEpoch,
	onOpenNote,
	onCreateNote,
	onNoteRemoved,
	onOpenFindings,
	findingsCount = 0,
}: Props) {
	const [collapsed, setCollapsed] = useState(readCollapsed);
	const [pane, setPane] = useState<RailPane>(readPane);
	const railRef = useRef<HTMLElement>(null);
	const railSize = usePersistedPanelSize('rightRail');
	const railResize = useDragResize({
		enabled: !collapsed,
		invert: true,
		allowClick: true,
		getValue: () => railSize.sizeRef.current,
		apply: railSize.setSize,
		clamp: (next) => {
			const body = railRef.current?.closest('.app-body');
			const bodyW = body?.clientWidth ?? window.innerWidth;
			const left = body?.querySelector('.sessions-rail');
			const leftW = left instanceof HTMLElement ? left.getBoundingClientRect().width : 0;
			return clampGrow(next, railSize.min, bodyW - MAIN_PANE_MIN - leftW);
		},
		onCommit: railSize.commit,
	});

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
			className={`right-rail${collapsed ? ' collapsed' : ''}${railResize.active ? ' is-resizing' : ''}`}
			style={{ ['--right-rail-w' as string]: `${railSize.size}px` }}
		>
			{!collapsed && (
				<PaneSash
					className="right-rail-sash"
					label="Notes width"
					active={railResize.active}
					onPointerDown={railResize.onPointerDown}
					onDoubleClick={railSize.reset}
				/>
			)}
			<button
				type="button"
				className="rail-groove right-rail-groove"
				title={collapsed ? 'Expand notes and findings' : 'Collapse notes and findings'}
				aria-label={collapsed ? 'Expand notes and findings' : 'Collapse notes and findings'}
				aria-expanded={!collapsed}
				onPointerDown={(event) => {
					if (!collapsed) {
						railResize.onPointerDown(event);
					}
				}}
				onClick={(event) => {
					if (railResize.consumeDrag()) {
						event.preventDefault();
						event.stopPropagation();
						return;
					}
					toggle();
				}}
			>
				<span className="rail-groove-ridges" aria-hidden="true" />
			</button>

			<div className="right-rail-clip">
				<div className="right-rail-inner" inert={collapsed}>
					<div className="right-rail-head">
						<div className="right-rail-tabs" role="tablist" aria-label="Notes and findings">
							<button
								type="button"
								role="tab"
								className={`right-rail-tab${pane === 'notes' ? ' active' : ''}`}
								aria-selected={pane === 'notes'}
								onClick={() => {
									setPane('notes');
									writePane('notes');
								}}
							>
								<NotesIcon size={14} />
								<span>Notes</span>
							</button>
							<button
								type="button"
								role="tab"
								className={`right-rail-tab right-rail-tab-badged${pane === 'findings' ? ' active' : ''}`}
								aria-selected={pane === 'findings'}
								onClick={() => {
									setPane('findings');
									writePane('findings');
								}}
							>
								<FindingsIcon size={14} />
								<span>Findings</span>
								{findingsCount > 0 && (
									<span className="rail-badge" aria-hidden="true">
										{findingsCount > 99 ? '99+' : findingsCount}
									</span>
								)}
							</button>
						</div>
						{pane === 'notes' ? (
							<button
								type="button"
								className="icon-btn"
								title="New note"
								aria-label="New note"
								onClick={onCreateNote}
							>
								+
							</button>
						) : (
							<button
								type="button"
								className="icon-btn"
								title="Open findings"
								aria-label="Open findings"
								onClick={() => onOpenFindings?.()}
							>
								↗
							</button>
						)}
					</div>
					{pane === 'notes' ? (
						<NotesPane
							listEpoch={listEpoch}
							activeId={activeNoteId}
							onOpen={onOpenNote}
							onRemoved={onNoteRemoved}
						/>
					) : (
						<FindingsPane onOpenPage={() => onOpenFindings?.()} />
					)}
				</div>
			</div>
		</aside>
	);
}

function NotesPane({
	listEpoch,
	activeId,
	onOpen,
	onRemoved,
}: {
	listEpoch: number;
	activeId?: string;
	onOpen: (id: string, title: string) => void;
	onRemoved: (id: string) => void;
}) {
	const [rows, setRows] = useState<NoteSummaryDTO[]>([]);
	const [query, setQuery] = useState('');
	const [error, setError] = useState('');

	const refresh = useCallback(async () => {
		setRows(await window.hawaldar.listNotes());
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh, listEpoch]);

	const remove = async (id: string) => {
		setError('');
		try {
			await window.hawaldar.removeNote(id);
			onRemoved(id);
			await refresh();
		} catch (err) {
			setError(errText(err));
		}
	};

	const visible = useMemo(
		() => rows.filter((row) => fuzzyMatch(query, row.title)),
		[query, rows],
	);

	return (
		<div className="right-pane">
			<div className="right-search">
				<input
					type="search"
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					placeholder="Search notes"
					aria-label="Search notes"
				/>
			</div>
			{error && <div className="right-pane-status is-error">{error}</div>}
			<div className="right-list">
				{rows.length === 0 && (
					<div className="empty-rail">No notes yet.</div>
				)}
				{rows.length > 0 && visible.length === 0 && (
					<div className="empty-rail">No matching notes.</div>
				)}
				{visible.map((row) => (
					<div key={row.id} className={`right-row${activeId === row.id ? ' active' : ''}`}>
						<button type="button" className="right-row-main" onClick={() => onOpen(row.id, row.title)}>
							<span className="title">{row.title}</span>
						</button>
						<span className="row-actions">
							<button
								type="button"
								className="icon-btn"
								title="Delete"
								aria-label={`Delete ${row.title}`}
								onClick={(e) => {
									e.stopPropagation();
									void remove(row.id);
								}}
							>
								×
							</button>
						</span>
					</div>
				))}
			</div>
		</div>
	);
}

function FindingsPane({ onOpenPage }: { onOpenPage: () => void }) {
	const [rows, setRows] = useState<FindingDTO[]>([]);
	const [query, setQuery] = useState('');
	const [error, setError] = useState('');

	const refresh = useCallback(async () => {
		try {
			setRows(await window.hawaldar.listFindings());
			setError('');
		} catch (err) {
			setError(errText(err));
		}
	}, []);

	useEffect(() => {
		void refresh();
		const off = window.hawaldar.onFindingsChanged(() => void refresh());
		return () => off();
	}, [refresh]);

	const visible = useMemo(
		() => rows.filter((row) => fuzzyMatch(query, `${row.title} ${row.vulnClass} ${row.status} ${row.target}`)),
		[query, rows],
	);

	return (
		<div className="right-pane">
			<div className="right-search">
				<input
					type="search"
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					placeholder="Search findings"
					aria-label="Search findings"
				/>
			</div>
			{error && <div className="right-pane-status is-error">{error}</div>}
			<div className="right-list">
				{rows.length === 0 && (
					<div className="empty-rail">No findings yet.</div>
				)}
				{rows.length > 0 && visible.length === 0 && (
					<div className="empty-rail">No matching findings.</div>
				)}
				{visible.map((row) => (
					<div key={row.id} className="right-row">
						<button type="button" className="right-row-main stacked" onClick={onOpenPage}>
							<span className="title">{restoreRedactedAddresses(row.title)}</span>
							<span className="meta">{row.status} · {row.vulnClass}</span>
						</button>
					</div>
				))}
			</div>
		</div>
	);
}
