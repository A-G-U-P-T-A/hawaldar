import { useEffect, useRef, useState } from 'react';
import type { NoteDTO, NoteSummaryDTO } from '../../preload/api';
import { isDocSaveHotkey } from './docEditor';
import PaneSash from './PaneSash';
import {
	clampGrow,
	clearPanelSize,
	PANEL_DEFAULTS,
	readPanelSizeOptional,
	useDragResize,
	writePanelSize,
} from './paneResize';

function formatUpdated(ms: number): string {
	if (!ms) {
		return '—';
	}
	return new Date(ms).toLocaleString();
}

export default function NotesSettings() {
	const [rows, setRows] = useState<NoteSummaryDTO[]>([]);
	const [editing, setEditing] = useState<string | null>(null);
	const [title, setTitle] = useState('');
	const [body, setBody] = useState('');
	const [path, setPath] = useState('');
	const [error, setError] = useState('');
	const [status, setStatus] = useState('');
	const [snapshot, setSnapshot] = useState({ title: '', body: '' });
	const dirty = title !== snapshot.title || body !== snapshot.body;
	const splitRef = useRef<HTMLDivElement>(null);
	const leftRef = useRef<number | null>(readPanelSizeOptional('libraryLeft'));
	const [left, setLeft] = useState<number | null>(() => leftRef.current);

	const libraryMin = (container: number) => Math.max(
		PANEL_DEFAULTS.libraryLeft,
		Math.round(Math.max(0, container - 16) * 0.9 / 2.1),
	);

	const libraryResize = useDragResize({
		getValue: () => {
			if (leftRef.current != null) {
				return leftRef.current;
			}
			const container = splitRef.current?.clientWidth ?? 0;
			const measured = splitRef.current?.querySelector('.table-wrap')?.getBoundingClientRect().width;
			return Math.round(measured ?? libraryMin(container));
		},
		apply: (next) => {
			leftRef.current = next;
			setLeft(next);
		},
		clamp: (next) => {
			const container = splitRef.current?.clientWidth ?? 600;
			return clampGrow(next, libraryMin(container), container - 200);
		},
		onCommit: () => {
			if (leftRef.current != null) {
				writePanelSize('libraryLeft', leftRef.current);
			}
		},
	});

	const resetLibrary = () => {
		leftRef.current = null;
		setLeft(null);
		clearPanelSize('libraryLeft');
	};

	const refresh = async () => {
		setRows(await window.hawaldar.listNotes());
	};

	useEffect(() => {
		void refresh();
	}, []);

	const startCreate = () => {
		setEditing('__new__');
		setTitle('');
		setBody('');
		setPath('notes/*.md');
		setSnapshot({ title: '', body: '' });
		setError('');
		setStatus('');
	};

	const startEdit = async (row: NoteSummaryDTO) => {
		setError('');
		try {
			const note: NoteDTO = await window.hawaldar.getNote(row.id);
			setEditing(note.id);
			setTitle(note.title);
			setBody(note.body);
			setPath(note.path);
			setSnapshot({ title: note.title, body: note.body });
			setStatus('');
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	};

	const save = async () => {
		setError('');
		try {
			const saved = await window.hawaldar.upsertNote({
				id: editing && editing !== '__new__' ? editing : undefined,
				title,
				body,
			});
			setEditing(saved.id);
			setTitle(saved.title);
			setBody(saved.body);
			setPath(saved.path);
			setSnapshot({ title: saved.title, body: saved.body });
			setStatus('Saved');
			await refresh();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	};

	const saveRef = useRef(save);
	saveRef.current = save;

	useEffect(() => {
		if (!editing) {
			return;
		}
		const onKey = (event: KeyboardEvent) => {
			if (!isDocSaveHotkey(event)) {
				return;
			}
			event.preventDefault();
			void saveRef.current();
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	}, [editing]);

	const remove = async (id: string) => {
		setError('');
		try {
			await window.hawaldar.removeNote(id);
			if (editing === id) {
				setEditing(null);
				setTitle('');
				setBody('');
				setPath('');
				setSnapshot({ title: '', body: '' });
			}
			setStatus('Deleted');
			await refresh();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	};

	return (
		<section className="widget">
			<div className="widget-head">
				<h2 className="widget-title">Notes</h2>
			</div>
			<p className="widget-help">
				Markdown in <code>~/.hawaldar/notes/*.md</code>. Index in <code>~/.hawaldar/notes.db</code>.
			</p>
			<div
				ref={splitRef}
				className={`library-split${left != null ? ' has-custom' : ''}${libraryResize.active ? ' is-resizing' : ''}`}
				style={left != null ? { ['--library-left' as string]: `${left}px` } : undefined}
			>
				<div className="table-wrap">
					<table className="data-table tools-table">
						<colgroup>
							<col />
							<col className="col-source" />
							<col className="col-action" />
						</colgroup>
						<thead>
							<tr>
								<th scope="col">Title</th>
								<th scope="col">Updated</th>
								<th scope="col" />
							</tr>
						</thead>
						<tbody>
							{rows.length === 0 && (
								<tr>
									<td colSpan={3} className="table-empty">No notes yet.</td>
								</tr>
							)}
							{rows.map((row) => (
								<tr
									key={row.id}
									className={`clickable${editing === row.id ? ' selected' : ''}`}
									onClick={() => void startEdit(row)}
								>
									<td className="col-nowrap" title={row.path}>{row.title}</td>
									<td className="mono">{formatUpdated(row.updatedAt)}</td>
									<td className="col-action">
										<button
											type="button"
											className="btn"
											onClick={(e) => {
												e.stopPropagation();
												void remove(row.id);
											}}
										>
											Remove
										</button>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
				<PaneSash
					className="library-sash"
					label="Notes list"
					active={libraryResize.active}
					onPointerDown={libraryResize.onPointerDown}
					onDoubleClick={resetLibrary}
				/>
				<div className="library-editor">
					<h3 className="widget-sub">{editing && editing !== '__new__' ? 'Edit note' : 'Note'}</h3>
					{!editing ? (
						<div className="widget-foot">
							<span className="widget-status">{status}</span>
							<button type="button" className="btn" onClick={startCreate}>New note</button>
						</div>
					) : (
						<>
							<div className="field">
								<label htmlFor="note-title">Title</label>
								<input
									id="note-title"
									value={title}
									onChange={(e) => {
										setTitle(e.target.value);
										setStatus('');
									}}
									placeholder="Engagement notes"
								/>
							</div>
							<div className="field">
								<label htmlFor="note-body">Markdown</label>
								<textarea
									id="note-body"
									className="mono-input"
									rows={16}
									value={body}
									onChange={(e) => {
										setBody(e.target.value);
										setStatus('');
									}}
									spellCheck={false}
									placeholder="# Scope&#10;&#10;Write markdown…"
								/>
							</div>
							{path && editing !== '__new__' && (
								<p className="widget-help">File <code>~/.hawaldar/{path}</code></p>
							)}
							{error && <p className="widget-help widget-error">{error}</p>}
							<div className="widget-foot">
								<span className="widget-status">{dirty ? 'Unsaved' : status}</span>
								<button type="button" className="btn" onClick={startCreate}>New note</button>
								<button type="button" className={dirty ? 'btn btn-primary' : 'btn btn-primary-dim'} onClick={() => void save()}>Save note</button>
								<button
									type="button"
									className="btn"
									onClick={() => {
										if (dirty) {
											setTitle(snapshot.title);
											setBody(snapshot.body);
											setError('');
											setStatus('');
											return;
										}
										setEditing(null);
										setError('');
									}}
								>
									Cancel
								</button>
							</div>
						</>
					)}
				</div>
			</div>
		</section>
	);
}
