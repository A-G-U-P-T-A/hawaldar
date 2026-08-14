import { useEffect, useState } from 'react';
import type { NoteDTO, NoteSummaryDTO } from '../../preload/api';

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
	const [dirty, setDirty] = useState(false);

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
		setError('');
		setDirty(false);
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
			setDirty(false);
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
			setDirty(false);
			setStatus('Saved');
			await refresh();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	};

	const remove = async (id: string) => {
		setError('');
		try {
			await window.hawaldar.removeNote(id);
			if (editing === id) {
				setEditing(null);
				setTitle('');
				setBody('');
				setPath('');
				setDirty(false);
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
			<div className="library-split">
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
										setDirty(true);
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
										setDirty(true);
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
								<button type="button" className="btn btn-primary" onClick={() => void save()}>Save note</button>
								<button
									type="button"
									className="btn"
									onClick={() => {
										setEditing(null);
										setError('');
										setDirty(false);
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
