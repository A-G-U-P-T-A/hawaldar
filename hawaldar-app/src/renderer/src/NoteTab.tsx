import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { NoteDTO } from '../../preload/api';
import type { DocEditorHandle } from './docEditor';
import MarkdownSplit from './MarkdownSplit';

function errText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

interface Snapshot {
	title: string;
	body: string;
}

const EMPTY: Snapshot = { title: 'Untitled', body: '' };

interface Props {
	tabId: string;
	noteId: string;
	draft?: boolean;
	onTitle: (title: string) => void;
	onChanged: () => void;
	onBound: (id: string) => void;
	onDirtyChange: (tabId: string, dirty: boolean) => void;
}

const NoteTab = forwardRef<DocEditorHandle, Props>(function NoteTab({
	tabId,
	noteId,
	draft = false,
	onTitle,
	onChanged,
	onBound,
	onDirtyChange,
}, ref) {
	const [title, setTitle] = useState(EMPTY.title);
	const [body, setBody] = useState(EMPTY.body);
	const [path, setPath] = useState('');
	const [snapshot, setSnapshot] = useState<Snapshot>(EMPTY);
	const [error, setError] = useState('');
	const [status, setStatus] = useState('');
	const [ready, setReady] = useState(false);
	const [saving, setSaving] = useState(false);
	const onTitleRef = useRef(onTitle);
	const onChangedRef = useRef(onChanged);
	const onBoundRef = useRef(onBound);
	const onDirtyChangeRef = useRef(onDirtyChange);
	const skipLoadRef = useRef(false);
	onTitleRef.current = onTitle;
	onChangedRef.current = onChanged;
	onBoundRef.current = onBound;
	onDirtyChangeRef.current = onDirtyChange;

	const dirty = title !== snapshot.title || body !== snapshot.body;

	useEffect(() => {
		onDirtyChangeRef.current(tabId, ready && dirty);
		return () => onDirtyChangeRef.current(tabId, false);
	}, [dirty, ready, tabId]);

	const applySaved = (note: NoteDTO, nextStatus = 'Saved') => {
		const next = { title: note.title, body: note.body };
		setTitle(next.title);
		setBody(next.body);
		setPath(note.path);
		setSnapshot(next);
		setStatus(nextStatus);
		setError('');
		onTitleRef.current(note.title);
	};

	const save = useCallback(async () => {
		if (!ready || saving) {
			return false;
		}
		const nextTitle = title.trim();
		if (!nextTitle) {
			setError('Note title is required.');
			setStatus('');
			return false;
		}
		setSaving(true);
		try {
			const saved = await window.hawaldar.upsertNote({
				id: draft ? undefined : noteId,
				title: nextTitle,
				body,
			});
			applySaved(saved);
			onChangedRef.current();
			if (saved.id !== noteId) {
				skipLoadRef.current = true;
				onBoundRef.current(saved.id);
			}
			return true;
		} catch (err) {
			setError(errText(err));
			setStatus('');
			return false;
		} finally {
			setSaving(false);
		}
	}, [body, draft, noteId, ready, saving, title]);

	const discard = useCallback(() => {
		setTitle(snapshot.title);
		setBody(snapshot.body);
		onTitleRef.current(snapshot.title);
		setError('');
		setStatus('');
	}, [snapshot]);

	useImperativeHandle(ref, () => ({ save, discard }), [discard, save]);

	useEffect(() => {
		let cancelled = false;
		if (skipLoadRef.current) {
			skipLoadRef.current = false;
			setReady(true);
			return;
		}
		setReady(false);
		if (draft) {
			setTitle(EMPTY.title);
			setBody(EMPTY.body);
			setPath('');
			setSnapshot(EMPTY);
			setError('');
			setStatus('');
			onTitleRef.current(EMPTY.title);
			setReady(true);
			return () => {
				cancelled = true;
			};
		}
		void (async () => {
			try {
				const note: NoteDTO = await window.hawaldar.getNote(noteId);
				if (cancelled) {
					return;
				}
				applySaved(note, '');
			} catch (err) {
				if (!cancelled) {
					setError(errText(err));
				}
			} finally {
				if (!cancelled) {
					setReady(true);
				}
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [draft, noteId]);

	if (!ready && !error) {
		return <div className="doc-editor"><div className="empty-rail">Loading note…</div></div>;
	}

	return (
		<div className="doc-editor">
			<MarkdownSplit
				value={body}
				onChange={(next) => {
					setBody(next);
					setStatus('');
				}}
				onSave={() => void save()}
				placeholder="Write markdown…"
				ariaLabel="Note body"
				header={(
					<input
						className="doc-editor-title"
						value={title}
						onChange={(e) => {
							setTitle(e.target.value);
							onTitleRef.current(e.target.value);
							setStatus('');
						}}
						placeholder="Note title"
						aria-label="Note title"
					/>
				)}
			/>
			{path && (
				<p className="doc-editor-path">~/.hawaldar/{path}</p>
			)}
			<div className="doc-editor-actions">
				<span className={`doc-editor-status${error ? ' is-error' : ''}`}>{error || status}</span>
				<button type="button" className="btn" disabled={!dirty || saving} onClick={discard}>
					Cancel
				</button>
				<button type="button" className={dirty ? 'btn btn-primary' : 'btn btn-primary-dim'} disabled={saving} onClick={() => void save()}>
					Save
				</button>
			</div>
		</div>
	);
});

export default NoteTab;
