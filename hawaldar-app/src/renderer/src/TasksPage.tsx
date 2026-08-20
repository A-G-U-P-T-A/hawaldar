import { useCallback, useEffect, useState } from 'react';
import type { TaskBoardDTO, TaskDTO, TaskTagDTO } from '../../preload/api';
import { TasksIcon, CloseIcon } from './navIcons';
import TaskBoard from './TaskBoard';
import TaskModal from './TaskModal';

function errText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

interface Props {
	listEpoch: number;
	createTick?: number;
	activeTaskId?: string;
	onChanged: () => void;
	onOpenCardTab: (id: string, title: string) => void;
	onRemoved: (id: string) => void;
}

export default function TasksPage({
	listEpoch,
	createTick = 0,
	activeTaskId,
	onChanged,
	onOpenCardTab,
	onRemoved,
}: Props) {
	const [board, setBoard] = useState<TaskBoardDTO | null>(null);
	const [query, setQuery] = useState('');
	const [tagFilter, setTagFilter] = useState<string[]>([]);
	const [error, setError] = useState('');
	const [busy, setBusy] = useState(false);
	const [createOpen, setCreateOpen] = useState(false);
	const [edit, setEdit] = useState<TaskDTO | null>(null);
	const [editingBoard, setEditingBoard] = useState(false);
	const [pendingTag, setPendingTag] = useState<TaskTagDTO | null>(null);
	const [tagBusy, setTagBusy] = useState(false);

	const refresh = useCallback(async () => {
		setBoard(await window.hawaldar.getTaskBoard());
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh, listEpoch]);

	useEffect(() => {
		if (createTick > 0) {
			setEdit(null);
			setCreateOpen(true);
			setError('');
		}
	}, [createTick]);

	useEffect(() => {
		if (!pendingTag) {
			return;
		}
		const onKey = (event: KeyboardEvent) => {
			if (event.key === 'Escape' && !tagBusy) {
				event.preventDefault();
				setPendingTag(null);
			}
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	}, [pendingTag, tagBusy]);

	const defaultListId = board?.lists.find((list) => list.statusKey === 'open')?.id
		|| board?.lists[0]?.id
		|| '';

	const persistCard = async (draft: { title: string; notes: string; listId: string; tagIds: string[] }, id?: string) => {
		setBusy(true);
		setError('');
		try {
			await window.hawaldar.upsertTask({
				id,
				title: draft.title,
				notes: draft.notes,
				listId: draft.listId,
				tagIds: draft.tagIds,
			});
			setCreateOpen(false);
			setEdit(null);
			onChanged();
			await refresh();
		} catch (err) {
			setError(errText(err));
		} finally {
			setBusy(false);
		}
	};

	const remove = async (id: string) => {
		setBusy(true);
		setError('');
		try {
			await window.hawaldar.removeTask(id);
			onRemoved(id);
			setEdit(null);
			onChanged();
			await refresh();
		} catch (err) {
			setError(errText(err));
		} finally {
			setBusy(false);
		}
	};

	const toggleTag = (id: string) => {
		setTagFilter((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]));
	};

	const tagUseCount = (id: string) => (
		board?.cards.filter((card) => (card.tags ?? []).some((tag) => tag.id === id)).length ?? 0
	);

	const deleteTag = async (tag: TaskTagDTO) => {
		setTagBusy(true);
		setError('');
		try {
			await window.hawaldar.removeTaskTag(tag.id);
			setTagFilter((prev) => prev.filter((id) => id !== tag.id));
			setPendingTag(null);
			onChanged();
			await refresh();
		} catch (err) {
			setError(errText(err));
		} finally {
			setTagBusy(false);
		}
	};

	const askDeleteTag = (tag: TaskTagDTO) => {
		if (tagUseCount(tag.id) > 0) {
			setPendingTag(tag);
			setError('');
			return;
		}
		void deleteTag(tag);
	};

	return (
		<div className="tasks-page">
			<div className="tasks-toolbar">
				<div className="graph-toolbar-lead">
					<TasksIcon size={14} />
					<span>Tasks</span>
					{board && (
						<span className="graph-meta">
							{board.cards.length} card{board.cards.length === 1 ? '' : 's'}
						</span>
					)}
				</div>
				<input
					type="search"
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					placeholder="Search cards"
					aria-label="Search cards"
				/>
				<button
					type="button"
					className={`btn${editingBoard ? ' btn-primary' : ''}`}
					aria-pressed={editingBoard}
					onClick={() => setEditingBoard((on) => !on)}
				>
					Edit board
				</button>
				<button type="button" className="btn btn-primary" onClick={() => {
					setEdit(null);
					setCreateOpen(true);
					setError('');
				}}>
					New task
				</button>
			</div>
			{board && !editingBoard && board.tags.length > 0 && (
				<div className="tasks-filters" role="group" aria-label="Filter by tags">
					{board.tags.map((tag) => (
						<button
							key={tag.id}
							type="button"
							className={`tag-chip${tagFilter.includes(tag.id) ? ' on' : ''}`}
							onClick={() => toggleTag(tag.id)}
						>
							{tag.title}
						</button>
					))}
					{tagFilter.length > 0 && (
						<button type="button" className="tasks-filter-clear" onClick={() => setTagFilter([])}>
							Clear
						</button>
					)}
				</div>
			)}
			{board && editingBoard && (
				<div className="tasks-tag-admin">
					<span className="tasks-tag-admin-label">Tags</span>
					{board.tags.length === 0 && <span className="widget-help">No tags yet. Add them on a card.</span>}
					{board.tags.map((tag) => {
						const used = tagUseCount(tag.id);
						return (
							<span key={tag.id} className="tag-chip on">
								{tag.title}
								{used > 0 && <span className="tasks-tag-count">{used}</span>}
								<button
									type="button"
									className="tag-chip-x"
									title={`Delete ${tag.title}`}
									aria-label={`Delete ${tag.title}`}
									onClick={() => askDeleteTag(tag)}
								>
									<CloseIcon size={14} />
								</button>
							</span>
						);
					})}
				</div>
			)}
			{error && !createOpen && !edit && !pendingTag && <div className="graph-error">{error}</div>}
			{!board && <div className="empty-rail">Loading board…</div>}
			{board && (
				<TaskBoard
					board={board}
					query={query}
					tagIds={tagFilter}
					activeId={activeTaskId}
					editing={editingBoard}
					onOpenCard={setEdit}
					onMoved={() => {
						onChanged();
						void refresh();
					}}
					onListsChanged={() => {
						onChanged();
						void refresh();
					}}
				/>
			)}
			{createOpen && board && (
				<TaskModal
					mode="create"
					lists={board.lists}
					tags={board.tags}
					initial={{ title: '', notes: '', listId: defaultListId, tagIds: [] }}
					busy={busy}
					error={error}
					onClose={() => {
						setCreateOpen(false);
						setError('');
					}}
					onSubmit={(draft) => void persistCard(draft)}
				/>
			)}
			{edit && board && (
				<TaskModal
					mode="edit"
					lists={board.lists}
					tags={board.tags}
					initial={{ title: edit.title, notes: edit.notes, listId: edit.listId, tagIds: (edit.tags ?? []).map((tag) => tag.id) }}
					busy={busy}
					error={error}
					onClose={() => {
						setEdit(null);
						setError('');
					}}
					onSubmit={(draft) => void persistCard(draft, edit.id)}
					onDelete={() => void remove(edit.id)}
					onOpenTab={() => {
						onOpenCardTab(edit.id, edit.title);
						setEdit(null);
					}}
				/>
			)}
			{pendingTag && (
				<div
					className="quit-overlay"
					role="presentation"
					onMouseDown={(event) => {
						if (event.target === event.currentTarget && !tagBusy) {
							setPendingTag(null);
						}
					}}
				>
					<section className="quit-card widget task-modal" role="dialog" aria-modal="true" aria-labelledby="tag-remove-title">
						<h2 className="quit-copy" id="tag-remove-title">Delete tag?</h2>
						<p className="widget-help">
							“{pendingTag.title}” is on {tagUseCount(pendingTag.id)} card{tagUseCount(pendingTag.id) === 1 ? '' : 's'}.
							It will be removed from those cards, then deleted.
						</p>
						{error && <p className="widget-help widget-error">{error}</p>}
						<div className="widget-foot">
							<span className="widget-status" />
							<button type="button" className="btn" disabled={tagBusy} onClick={() => setPendingTag(null)}>
								Cancel
							</button>
							<button type="button" className="btn btn-danger" disabled={tagBusy} onClick={() => void deleteTag(pendingTag)}>
								Delete
							</button>
						</div>
					</section>
				</div>
			)}
		</div>
	);
}
