import { useEffect, useMemo, useState, type DragEvent } from 'react';
import type { TaskBoardDTO, TaskDTO, TaskListDTO } from '../../preload/api';
import { DragIcon, CloseIcon } from './navIcons';
import Dropdown from './Dropdown';
import { fuzzyMatch } from './sessionGroups';

interface Props {
	board: TaskBoardDTO;
	query: string;
	tagIds?: string[];
	activeId?: string;
	editing?: boolean;
	onOpenCard: (card: TaskDTO) => void;
	onMoved: () => void;
	onListsChanged: () => void;
}

const CARD_DRAG = 'application/x-hawaldar-card';
const LIST_DRAG = 'application/x-hawaldar-list';

function hasType(event: DragEvent, type: string): boolean {
	return Array.from(event.dataTransfer.types).includes(type);
}

export default function TaskBoard({
	board,
	query,
	tagIds = [],
	activeId,
	editing = false,
	onOpenCard,
	onMoved,
	onListsChanged,
}: Props) {
	const [dragging, setDragging] = useState<string | null>(null);
	const [draggingList, setDraggingList] = useState<string | null>(null);
	const [overList, setOverList] = useState<string | null>(null);
	const [adding, setAdding] = useState(false);
	const [listTitle, setListTitle] = useState('');
	const [error, setError] = useState('');
	const [pendingDelete, setPendingDelete] = useState<TaskListDTO | null>(null);
	const [moveToListId, setMoveToListId] = useState('');
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		if (!editing) {
			setAdding(false);
			setListTitle('');
			setDraggingList(null);
		}
	}, [editing]);

	const cardsByList = useMemo(() => {
		const map = new Map<string, TaskDTO[]>();
		for (const list of board.lists) {
			map.set(list.id, []);
		}
		const required = new Set(tagIds);
		for (const card of board.cards) {
			const tags = card.tags ?? [];
			if (query.trim() && !fuzzyMatch(query, card.title, card.notes, card.listTitle, ...tags.map((tag) => tag.title))) {
				continue;
			}
			if (required.size > 0 && !tags.some((tag) => required.has(tag.id))) {
				continue;
			}
			const bucket = map.get(card.listId) ?? [];
			bucket.push(card);
			map.set(card.listId, bucket);
		}
		return map;
	}, [board, query, tagIds]);

	const move = async (cardId: string, listId: string, beforeId?: string) => {
		setError('');
		try {
			await window.hawaldar.moveTask({ id: cardId, listId, beforeId });
			onMoved();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	};

	const reorder = async (movedId: string, beforeId?: string) => {
		if (movedId === beforeId) {
			return;
		}
		const ids = board.lists.map((list) => list.id).filter((id) => id !== movedId);
		const idx = beforeId ? ids.indexOf(beforeId) : -1;
		if (idx >= 0) {
			ids.splice(idx, 0, movedId);
		} else {
			ids.push(movedId);
		}
		setError('');
		try {
			await window.hawaldar.reorderTaskLists(board.board.id, ids);
			onListsChanged();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	};

	const addList = async () => {
		const title = listTitle.trim();
		if (!title) {
			setAdding(false);
			return;
		}
		setError('');
		try {
			await window.hawaldar.upsertTaskList({ boardId: board.board.id, title });
			setListTitle('');
			setAdding(false);
			onListsChanged();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	};

	const renameList = async (list: TaskListDTO, title: string) => {
		const next = title.trim();
		if (!next || next === list.title) {
			return;
		}
		setError('');
		try {
			await window.hawaldar.upsertTaskList({ id: list.id, boardId: list.boardId, title: next });
			onListsChanged();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	};

	const askRemove = (list: TaskListDTO) => {
		const others = board.lists.filter((item) => item.id !== list.id);
		setPendingDelete(list);
		setMoveToListId(others[0]?.id || '');
		setError('');
	};

	useEffect(() => {
		if (!pendingDelete) {
			return;
		}
		const onKey = (event: KeyboardEvent) => {
			if (event.key === 'Escape' && !busy) {
				event.preventDefault();
				setPendingDelete(null);
			}
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	}, [busy, pendingDelete]);

	const confirmRemove = async () => {
		if (!pendingDelete) {
			return;
		}
		const cards = board.cards.filter((card) => card.listId === pendingDelete.id);
		setBusy(true);
		setError('');
		try {
			await window.hawaldar.removeTaskList(pendingDelete.id, cards.length > 0 ? moveToListId : undefined);
			setPendingDelete(null);
			onListsChanged();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	const clearDrag = () => {
		setOverList(null);
		setDragging(null);
		setDraggingList(null);
	};

	return (
		<div className={`task-board-wrap${editing ? ' is-editing' : ''}`}>
			{error && !pendingDelete && <div className="right-pane-status is-error">{error}</div>}
			<div className="task-board">
				{board.lists.map((list) => {
					const cards = cardsByList.get(list.id) ?? [];
					return (
						<section
							key={list.id}
							className={`task-col${overList === list.id ? ' drag-over' : ''}${draggingList === list.id ? ' dragging' : ''}`}
							onDragOver={(event) => {
								if (editing && (hasType(event, LIST_DRAG) || draggingList)) {
									event.preventDefault();
									event.dataTransfer.dropEffect = 'move';
									setOverList(list.id);
									return;
								}
								event.preventDefault();
								event.dataTransfer.dropEffect = 'move';
								setOverList(list.id);
							}}
							onDragLeave={(event) => {
								if (!event.currentTarget.contains(event.relatedTarget as Node)) {
									setOverList((cur) => (cur === list.id ? null : cur));
								}
							}}
							onDrop={(event) => {
								event.preventDefault();
								const listId = event.dataTransfer.getData(LIST_DRAG);
								if (editing && listId) {
									clearDrag();
									void reorder(listId, list.id);
									return;
								}
								const cardId = event.dataTransfer.getData(CARD_DRAG) || event.dataTransfer.getData('text/plain');
								clearDrag();
								if (cardId) {
									void move(cardId, list.id);
								}
							}}
						>
							<header className="task-col-head">
								{editing && (
									<span
										className="task-col-grip"
										draggable
										title="Reorder stage"
										aria-label={`Reorder ${list.title}`}
										onDragStart={(event) => {
											event.dataTransfer.setData(LIST_DRAG, list.id);
											event.dataTransfer.effectAllowed = 'move';
											setDraggingList(list.id);
										}}
										onDragEnd={clearDrag}
									>
										<DragIcon size={16} />
									</span>
								)}
								{editing ? (
									<input
										className="task-col-title"
										defaultValue={list.title}
										key={`${list.id}:${list.title}`}
										aria-label={`${list.title} column title`}
										onBlur={(event) => void renameList(list, event.target.value)}
										onKeyDown={(event) => {
											if (event.key === 'Enter') {
												event.currentTarget.blur();
											}
										}}
									/>
								) : (
									<span className="task-col-title is-static">{list.title}</span>
								)}
								<span className="task-col-count">{cards.length}</span>
								{editing && board.lists.length > 1 && (
									<button
										type="button"
										className="icon-btn task-col-remove"
										title="Remove stage"
										aria-label={`Remove ${list.title}`}
										onClick={() => askRemove(list)}
									>
										<CloseIcon size={16} />
									</button>
								)}
							</header>
							<div className="task-col-cards">
								{cards.map((card) => (
									<article
										key={card.id}
										className={`task-card${activeId === card.id ? ' active' : ''}${dragging === card.id ? ' dragging' : ''}`}
										draggable
										onDragStart={(event) => {
											event.stopPropagation();
											event.dataTransfer.setData(CARD_DRAG, card.id);
											event.dataTransfer.setData('text/plain', card.id);
											event.dataTransfer.effectAllowed = 'move';
											setDragging(card.id);
										}}
										onDragEnd={clearDrag}
										onDragOver={(event) => {
											if (editing && (hasType(event, LIST_DRAG) || draggingList)) {
												return;
											}
											event.preventDefault();
											event.stopPropagation();
											setOverList(list.id);
										}}
										onDrop={(event) => {
											if (editing && event.dataTransfer.getData(LIST_DRAG)) {
												return;
											}
											event.preventDefault();
											event.stopPropagation();
											const cardId = event.dataTransfer.getData(CARD_DRAG) || event.dataTransfer.getData('text/plain');
											clearDrag();
											if (cardId && cardId !== card.id) {
												void move(cardId, list.id, card.id);
											}
										}}
									>
										<button type="button" className="task-card-main" onClick={() => onOpenCard(card)}>
											<span className="task-card-title">{card.title}</span>
											{card.notes.trim() && <span className="task-card-note">{card.notes.trim()}</span>}
											{(card.tags ?? []).length > 0 && (
												<span className="task-card-tags">
													{(card.tags ?? []).map((tag) => (
														<span key={tag.id} className="tag-chip">{tag.title}</span>
													))}
												</span>
											)}
										</button>
									</article>
								))}
							</div>
						</section>
					);
				})}
				{editing && (
					<section
						className={`task-col task-col-add${overList === '__end' ? ' drag-over' : ''}`}
						onDragOver={(event) => {
							if (hasType(event, LIST_DRAG) || draggingList) {
								event.preventDefault();
								event.dataTransfer.dropEffect = 'move';
								setOverList('__end');
							}
						}}
						onDragLeave={(event) => {
							if (!event.currentTarget.contains(event.relatedTarget as Node)) {
								setOverList((cur) => (cur === '__end' ? null : cur));
							}
						}}
						onDrop={(event) => {
							event.preventDefault();
							const listId = event.dataTransfer.getData(LIST_DRAG);
							clearDrag();
							if (listId) {
								void reorder(listId);
							}
						}}
					>
						{adding ? (
							<input
								className="task-col-title"
								value={listTitle}
								onChange={(e) => setListTitle(e.target.value)}
								onBlur={() => void addList()}
								onKeyDown={(event) => {
									if (event.key === 'Enter') {
										event.preventDefault();
										void addList();
									}
									if (event.key === 'Escape') {
										setAdding(false);
										setListTitle('');
									}
								}}
								placeholder="Stage title"
								autoFocus
								aria-label="New stage title"
							/>
						) : (
							<button type="button" className="task-col-add-btn" onClick={() => setAdding(true)}>
								+ Stage
							</button>
						)}
					</section>
				)}
			</div>
			{pendingDelete && (
				<div
					className="quit-overlay"
					role="presentation"
					onMouseDown={(event) => {
						if (event.target === event.currentTarget && !busy) {
							setPendingDelete(null);
						}
					}}
				>
					<section className="quit-card widget task-modal" role="dialog" aria-modal="true" aria-labelledby="stage-remove-title">
						<h2 className="quit-copy" id="stage-remove-title">Remove stage?</h2>
						<p className="widget-help">
							{board.cards.filter((card) => card.listId === pendingDelete.id).length > 0
								? `Move cards from “${pendingDelete.title}” to another stage. Cards are not deleted.`
								: `“${pendingDelete.title}” is empty and will be removed.`}
						</p>
						{board.cards.some((card) => card.listId === pendingDelete.id) && (
							<div className="field">
								<label htmlFor="stage-move-to">Move cards to</label>
								<Dropdown
									prefer="down"
									ariaLabel="Move cards to"
									value={moveToListId}
									options={board.lists
										.filter((list) => list.id !== pendingDelete.id)
										.map((list) => ({ value: list.id, label: list.title }))}
									onChange={setMoveToListId}
								/>
							</div>
						)}
						{error && <p className="widget-help widget-error">{error}</p>}
						<div className="widget-foot">
							<span className="widget-status" />
							<button type="button" className="btn" disabled={busy} onClick={() => setPendingDelete(null)}>
								Cancel
							</button>
							<button type="button" className="btn btn-danger" disabled={busy} onClick={() => void confirmRemove()}>
								Remove
							</button>
						</div>
					</section>
				</div>
			)}
		</div>
	);
}
