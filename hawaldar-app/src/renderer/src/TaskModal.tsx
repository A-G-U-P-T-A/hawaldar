import { useEffect, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { TaskListDTO, TaskTagDTO } from '../../preload/api';
import { CloseIcon } from './navIcons';
import Dropdown from './Dropdown';

interface Draft {
	title: string;
	notes: string;
	listId: string;
	tagIds: string[];
}

interface Props {
	mode: 'create' | 'edit';
	lists: TaskListDTO[];
	tags: TaskTagDTO[];
	initial: Draft;
	busy?: boolean;
	error?: string;
	onClose: () => void;
	onSubmit: (draft: Draft) => void;
	onDelete?: () => void;
	onOpenTab?: () => void;
}

export default function TaskModal({
	mode,
	lists,
	tags: initialTags,
	initial,
	busy = false,
	error,
	onClose,
	onSubmit,
	onDelete,
	onOpenTab,
}: Props) {
	const [title, setTitle] = useState(initial.title);
	const [notes, setNotes] = useState(initial.notes);
	const [listId, setListId] = useState(initial.listId || lists[0]?.id || '');
	const [tagIds, setTagIds] = useState<string[]>(initial.tagIds);
	const [tags, setTags] = useState<TaskTagDTO[]>(initialTags);
	const [tagDraft, setTagDraft] = useState('');
	const [tagError, setTagError] = useState('');
	const [tagActive, setTagActive] = useState(-1);
	const [confirmDelete, setConfirmDelete] = useState(false);

	useEffect(() => {
		setTitle(initial.title);
		setNotes(initial.notes);
		setListId(initial.listId || lists[0]?.id || '');
		setTagIds(initial.tagIds);
		setTags(initialTags);
		setTagDraft('');
		setTagError('');
		setTagActive(-1);
		setConfirmDelete(false);
	}, [initial, initialTags, lists]);

	const submit = () => {
		const next = title.trim();
		if (!next) {
			return;
		}
		onSubmit({ title: next, notes, listId, tagIds });
	};

	const matches = useMemo(() => {
		const q = tagDraft.trim().toLowerCase();
		if (!q) {
			return [];
		}
		return tags.filter((tag) => !tagIds.includes(tag.id) && tag.title.toLowerCase().includes(q));
	}, [tagDraft, tagIds, tags]);

	const selectTag = (tag: TaskTagDTO) => {
		if (!tagIds.includes(tag.id)) {
			setTagIds((prev) => [...prev, tag.id]);
		}
		setTagDraft('');
		setTagActive(-1);
		setTagError('');
	};

	const addTag = async (raw: string) => {
		const next = raw.trim();
		if (!next) {
			return;
		}
		setTagError('');
		const existing = tags.find((tag) => !tagIds.includes(tag.id) && tag.title.toLowerCase() === next.toLowerCase());
		if (existing) {
			selectTag(existing);
			return;
		}
		try {
			const tag = await window.hawaldar.upsertTaskTag({ title: next });
			setTags((prev) => (prev.some((item) => item.id === tag.id) ? prev : [...prev, tag]));
			setTagIds((prev) => (prev.includes(tag.id) ? prev : [...prev, tag.id]));
			setTagDraft('');
			setTagActive(-1);
		} catch (err) {
			setTagError(err instanceof Error ? err.message : String(err));
		}
	};

	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (busy) {
				return;
			}
			if (event.key === 'Escape') {
				event.preventDefault();
				if (tagDraft.trim()) {
					setTagDraft('');
					setTagActive(-1);
					return;
				}
				if (confirmDelete) {
					setConfirmDelete(false);
					return;
				}
				onClose();
			}
			if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
				event.preventDefault();
				submit();
			}
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	}, [busy, confirmDelete, onClose, tagDraft, title, notes, listId, tagIds]);

	const onTagKey = (event: ReactKeyboardEvent<HTMLInputElement>) => {
		if (event.key === 'ArrowDown' && matches.length > 0) {
			event.preventDefault();
			setTagActive((cur) => (cur + 1) % matches.length);
			return;
		}
		if (event.key === 'ArrowUp' && matches.length > 0) {
			event.preventDefault();
			setTagActive((cur) => (cur <= 0 ? matches.length - 1 : cur - 1));
			return;
		}
		if (event.key === 'Enter') {
			event.preventDefault();
			if (tagActive >= 0 && matches[tagActive]) {
				selectTag(matches[tagActive]);
				return;
			}
			void addTag(tagDraft);
		}
	};

	return (
		<div className="quit-overlay" role="presentation" onMouseDown={(event) => {
			if (event.target === event.currentTarget && !busy) {
				onClose();
			}
		}}>
			<section className="quit-card widget task-modal" role="dialog" aria-modal="true" aria-labelledby="task-modal-title">
				<h2 className="quit-copy" id="task-modal-title">
					{mode === 'create' ? 'New task' : 'Edit card'}
				</h2>
				<div className="field">
					<label htmlFor="task-modal-title-input">Title</label>
					<input
						id="task-modal-title-input"
						value={title}
						onChange={(e) => setTitle(e.target.value)}
						placeholder="Card title"
						autoFocus
					/>
				</div>
				<div className="field">
					<label htmlFor="task-modal-list">Stage</label>
					<Dropdown
						prefer="down"
						ariaLabel="Stage"
						value={listId}
						options={lists.map((list) => ({ value: list.id, label: list.title }))}
						onChange={setListId}
					/>
				</div>
				<div className="field">
					<label htmlFor="task-modal-tags">Tags</label>
					<div className="tag-picker">
						<div className="tag-editor">
							{tagIds.map((id) => {
								const tag = tags.find((item) => item.id === id);
								if (!tag) {
									return null;
								}
								return (
									<button
										key={id}
										type="button"
										className="tag-chip on"
										onClick={() => setTagIds((prev) => prev.filter((item) => item !== id))}
									>
										{tag.title}
										<CloseIcon size={14} />
									</button>
								);
							})}
							<input
								id="task-modal-tags"
								value={tagDraft}
								onChange={(e) => {
									setTagDraft(e.target.value);
									setTagActive(-1);
								}}
								onKeyDown={onTagKey}
								placeholder="Search or create tag"
								aria-label="Search or create tag"
								aria-autocomplete="list"
								aria-expanded={matches.length > 0}
							/>
						</div>
						{matches.length > 0 && (
							<div className="dd-menu dd-menu-down tag-picker-menu" role="listbox" aria-label="Matching tags">
								<div className="dd-list">
									{matches.map((tag, index) => (
										<button
											key={tag.id}
											type="button"
											role="option"
											aria-selected={index === tagActive}
											className={`dd-option${index === tagActive ? ' active' : ''}`}
											onMouseEnter={() => setTagActive(index)}
											onClick={() => selectTag(tag)}
										>
											<span className="dd-option-label">{tag.title}</span>
										</button>
									))}
								</div>
							</div>
						)}
					</div>
					{tagError && <p className="widget-help widget-error">{tagError}</p>}
				</div>
				<div className="field">
					<label htmlFor="task-modal-notes">Notes</label>
					<textarea
						id="task-modal-notes"
						value={notes}
						onChange={(e) => setNotes(e.target.value)}
						placeholder="Optional notes (markdown)"
						rows={5}
					/>
				</div>
				{error && <p className="widget-help widget-error">{error}</p>}
				{confirmDelete ? (
					<div className="widget-foot">
						<span className="widget-status">Delete this card? It cannot be undone.</span>
						<button type="button" className="btn" disabled={busy} onClick={() => setConfirmDelete(false)}>
							Cancel
						</button>
						<button type="button" className="btn btn-danger" disabled={busy} onClick={onDelete}>
							Delete
						</button>
					</div>
				) : (
					<div className="widget-foot">
						{mode === 'edit' && onDelete && (
							<button type="button" className="btn btn-danger" disabled={busy} onClick={() => setConfirmDelete(true)}>
								Delete
							</button>
						)}
						{mode === 'edit' && onOpenTab && (
							<button type="button" className="btn" disabled={busy} onClick={onOpenTab}>
								Open in tab
							</button>
						)}
						<span className="widget-status" />
						<button type="button" className="btn" disabled={busy} onClick={onClose}>
							Cancel
						</button>
						<button type="button" className="btn btn-primary" disabled={busy || !title.trim()} onClick={submit}>
							{mode === 'create' ? 'Create' : 'Save'}
						</button>
					</div>
				)}
			</section>
		</div>
	);
}
