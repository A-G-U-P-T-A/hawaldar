import { useEffect } from 'react';

interface Props {
	phase: 'ask' | 'stopping';
	onCancel: () => void;
	onConfirm: () => void;
}

export default function QuitConfirm({ phase, onCancel, onConfirm }: Props) {
	const stopping = phase === 'stopping';

	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (stopping) {
				return;
			}
			if (event.key === 'Escape') {
				event.preventDefault();
				onCancel();
			}
			if (event.key === 'Enter') {
				event.preventDefault();
				onConfirm();
			}
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	}, [stopping, onCancel, onConfirm]);

	return (
		<div className="quit-overlay" role="presentation">
			<section className="quit-card widget" role="dialog" aria-modal="true" aria-labelledby="quit-title">
				<h2 className="quit-copy" id="quit-title">
					{stopping ? 'Stopping container runtime…' : 'Are you sure you want to exit?'}
				</h2>
				{!stopping && (
					<p className="widget-help">Machines and the container runtime will be stopped.</p>
				)}
				<div className="widget-foot">
					<button type="button" className="btn" disabled={stopping} onClick={onCancel}>
						Cancel
					</button>
					<button type="button" className="btn btn-danger" disabled={stopping} onClick={onConfirm} autoFocus>
						Yes
					</button>
				</div>
			</section>
		</div>
	);
}
