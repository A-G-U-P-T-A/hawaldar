import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { NoteSummaryDTO } from '../../preload/api';
import { NotesIcon } from './navIcons';
import PaneSash from './PaneSash';
import { clampGrow, MAIN_PANE_MIN, useDragResize, usePersistedPanelSize } from './paneResize';
import { fuzzyMatch } from './sessionGroups';

const COLLAPSED_KEY = 'hawaldar.rightPanelCollapsed';

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

function errText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

interface Props {
	activeNoteId?: string;
	listEpoch: number;
	onOpenNote: (id: string, title: string) => void;
	onCreateNote: () => void;
	onNoteRemoved: (id: string) => void;
}

export default function RightPanel({
	activeNoteId,
	listEpoch,
	onOpenNote,
	onCreateNote,
	onNoteRemoved,
}: Props) {
	const [collapsed, setCollapsed] = useState(readCollapsed);
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
				title={collapsed ? 'Expand notes' : 'Collapse notes'}
				aria-label={collapsed ? 'Expand notes' : 'Collapse notes'}
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
						<div className="right-rail-title">
							<NotesIcon size={14} />
							<span>Notes</span>
						</div>
						<button
							type="button"
							className="icon-btn"
							title="New note"
							aria-label="New note"
							onClick={onCreateNote}
						>
							+
						</button>
					</div>
					<NotesPane
						listEpoch={listEpoch}
						activeId={activeNoteId}
						onOpen={onOpenNote}
						onRemoved={onNoteRemoved}
					/>
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
