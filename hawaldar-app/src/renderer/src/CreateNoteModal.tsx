import { useEffect, useState } from 'react';

interface Props {
	busy?: boolean;
	error?: string;
	onClose: () => void;
	onSubmit: (title: string) => void;
}

export default function CreateNoteModal({ busy = false, error, onClose, onSubmit }: Props) {
	const [title, setTitle] = useState('');

	const submit = () => {
		const next = title.trim();
		if (!next) {
			return;
		}
		onSubmit(next);
	};

	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (busy) {
				return;
			}
			if (event.key === 'Escape') {
				event.preventDefault();
				onClose();
			}
			if (event.key === 'Enter') {
				event.preventDefault();
				submit();
			}
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	}, [busy, onClose, title]);

	return (
		<div
			className="quit-overlay"
			role="presentation"
			onMouseDown={(event) => {
				if (event.target === event.currentTarget && !busy) {
					onClose();
				}
			}}
		>
			<section className="quit-card widget task-modal" role="dialog" aria-modal="true" aria-labelledby="create-note-title">
				<h2 className="quit-copy" id="create-note-title">New note</h2>
				<div className="field">
					<label htmlFor="create-note-input">Title</label>
					<input
						id="create-note-input"
						value={title}
						onChange={(e) => setTitle(e.target.value)}
						placeholder="Note title"
						autoFocus
					/>
				</div>
				{error && <p className="widget-help widget-error">{error}</p>}
				<div className="widget-foot">
					<span className="widget-status" />
					<button type="button" className="btn" disabled={busy} onClick={onClose}>
						Cancel
					</button>
					<button type="button" className="btn btn-primary" disabled={busy || !title.trim()} onClick={submit}>
						Create
					</button>
				</div>
			</section>
		</div>
	);
}
