import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { TaskDTO, TaskStatus } from '../../preload/api';
import type { DocEditorHandle } from './docEditor';
import Dropdown from './Dropdown';
import MarkdownSplit from './MarkdownSplit';

const STATUSES: Array<{ value: TaskStatus; label: string }> = [
	{ value: 'open', label: 'open' },
	{ value: 'doing', label: 'doing' },
	{ value: 'done', label: 'done' },
];

function errText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

interface Snapshot {
	title: string;
	status: TaskStatus;
	notes: string;
}

const EMPTY: Snapshot = { title: 'Untitled', status: 'open', notes: '' };

interface Props {
	tabId: string;
	taskId: string;
	draft?: boolean;
	onTitle: (title: string) => void;
	onChanged: () => void;
	onBound: (id: string) => void;
	onDirtyChange: (tabId: string, dirty: boolean) => void;
}

const TaskTab = forwardRef<DocEditorHandle, Props>(function TaskTab({
	tabId,
	taskId,
	draft = false,
	onTitle,
	onChanged,
	onBound,
	onDirtyChange,
}, ref) {
	const [title, setTitle] = useState(EMPTY.title);
	const [status, setStatus] = useState<TaskStatus>(EMPTY.status);
	const [notes, setNotes] = useState(EMPTY.notes);
	const [snapshot, setSnapshot] = useState<Snapshot>(EMPTY);
	const [error, setError] = useState('');
	const [saveState, setSaveState] = useState('');
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

	const dirty = title !== snapshot.title || status !== snapshot.status || notes !== snapshot.notes;

	useEffect(() => {
		onDirtyChangeRef.current(tabId, ready && dirty);
		return () => onDirtyChangeRef.current(tabId, false);
	}, [dirty, ready, tabId]);

	const applySaved = (row: TaskDTO, nextStatus = 'Saved') => {
		const next = { title: row.title, status: row.status, notes: row.notes };
		setTitle(next.title);
		setStatus(next.status);
		setNotes(next.notes);
		setSnapshot(next);
		setSaveState(nextStatus);
		setError('');
		onTitleRef.current(row.title);
	};

	const save = useCallback(async () => {
		if (!ready || saving) {
			return false;
		}
		const nextTitle = title.trim();
		if (!nextTitle) {
			setError('Task title is required.');
			setSaveState('');
			return false;
		}
		setSaving(true);
		try {
			const saved: TaskDTO = await window.hawaldar.upsertTask({
				id: draft ? undefined : taskId,
				title: nextTitle,
				status,
				notes,
			});
			applySaved(saved);
			onChangedRef.current();
			if (saved.id !== taskId) {
				skipLoadRef.current = true;
				onBoundRef.current(saved.id);
			}
			return true;
		} catch (err) {
			setError(errText(err));
			setSaveState('');
			return false;
		} finally {
			setSaving(false);
		}
	}, [draft, notes, ready, saving, status, taskId, title]);

	const discard = useCallback(() => {
		setTitle(snapshot.title);
		setStatus(snapshot.status);
		setNotes(snapshot.notes);
		onTitleRef.current(snapshot.title);
		setError('');
		setSaveState('');
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
			setStatus(EMPTY.status);
			setNotes(EMPTY.notes);
			setSnapshot(EMPTY);
			setError('');
			setSaveState('');
			onTitleRef.current(EMPTY.title);
			setReady(true);
			return () => {
				cancelled = true;
			};
		}
		void (async () => {
			try {
				const rows = await window.hawaldar.listTasks();
				const row = rows.find((item) => item.id === taskId);
				if (!row) {
					throw new Error('Unknown task.');
				}
				if (cancelled) {
					return;
				}
				applySaved(row, '');
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
	}, [draft, taskId]);

	if (!ready && !error) {
		return <div className="doc-editor"><div className="empty-rail">Loading task…</div></div>;
	}

	return (
		<div className="doc-editor">
			<MarkdownSplit
				value={notes}
				onChange={(next) => {
					setNotes(next);
					setSaveState('');
				}}
				onSave={() => void save()}
				placeholder="Notes (markdown)…"
				ariaLabel="Task notes"
				header={(
					<>
						<input
							className="doc-editor-title"
							value={title}
							onChange={(e) => {
								setTitle(e.target.value);
								onTitleRef.current(e.target.value);
								setSaveState('');
							}}
							placeholder="Task title"
							aria-label="Task title"
						/>
						<div className="doc-editor-tools">
							<Dropdown
								compact
								prefer="down"
								ariaLabel="Task status"
								value={status}
								options={STATUSES}
								onChange={(next) => {
									setStatus(next as TaskStatus);
									setSaveState('');
								}}
							/>
						</div>
					</>
				)}
			/>
			<div className="doc-editor-actions">
				<span className={`doc-editor-status${error ? ' is-error' : ''}`}>{error || saveState}</span>
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

export default TaskTab;
