import { useEffect } from 'react';

interface Props {
	busy?: boolean;
	detail?: string;
	onCancel: () => void;
	onDiscard: () => void;
	onSave: () => void;
}

export default function SaveChangesConfirm({ busy = false, detail, onCancel, onDiscard, onSave }: Props) {
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (busy) {
				return;
			}
			if (event.key === 'Escape') {
				event.preventDefault();
				onCancel();
			}
			if (event.key === 'Enter') {
				event.preventDefault();
				onSave();
			}
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	}, [busy, onCancel, onSave]);

	return (
		<div className="quit-overlay" role="presentation">
			<section className="quit-card widget" role="dialog" aria-modal="true" aria-labelledby="save-changes-title">
				<h2 className="quit-copy" id="save-changes-title">
					Do you want to save your changes?
				</h2>
				{detail && <p className="widget-help">{detail}</p>}
				<div className="widget-foot">
					<button type="button" className="btn" disabled={busy} onClick={onCancel}>
						Cancel
					</button>
					<button type="button" className="btn btn-danger" disabled={busy} onClick={onDiscard}>
						No
					</button>
					<button type="button" className="btn btn-primary" disabled={busy} onClick={onSave} autoFocus>
						Yes
					</button>
				</div>
			</section>
		</div>
	);
}
