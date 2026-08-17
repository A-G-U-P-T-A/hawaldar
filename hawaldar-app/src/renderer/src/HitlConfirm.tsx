import { useEffect } from 'react';
import type { HitlKind } from '../../preload/api';
import { useI18n } from './i18n';

interface Props {
	title: string;
	explanation: string;
	kind?: HitlKind;
	serviceId?: string;
	busy?: boolean;
	onCancel: () => void;
	onApprove: () => void;
}

const KIND_KEY: Record<HitlKind, string> = {
	podman: 'hitl.kind.podman',
	'tool-image': 'hitl.kind.tool-image',
	'poc-probe': 'hitl.kind.poc-probe',
};

export default function HitlConfirm({ title, explanation, kind, serviceId, busy = false, onCancel, onApprove }: Props) {
	const { t } = useI18n();
	const kindKey = kind && KIND_KEY[kind];
	const heading = typeof title === 'string' ? title : String(title ?? 'Approval required');
	const body = typeof explanation === 'string' ? explanation : String(explanation ?? '');

	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (busy || event.key !== 'Escape') {
				return;
			}
			event.preventDefault();
			onCancel();
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	}, [busy, onCancel]);

	return (
		<div className="quit-overlay" role="presentation">
			<section className="quit-card widget hitl-card" role="dialog" aria-modal="true" aria-labelledby="hitl-title">
				<div className="hitl-head">
					<span className="hitl-shield" aria-hidden>
						<svg viewBox="0 0 16 16" fill="currentColor">
							<path d="M8 1.6 3 3.7v3.5c0 3.1 2.1 5.9 5 7.2 2.9-1.3 5-4.1 5-7.2V3.7L8 1.6zm2.7 5-3.2 3.4a.75.75 0 0 1-1.1 0L5.2 8.7a.75.75 0 1 1 1.1-1l1.2 1.3L9.6 5.5a.75.75 0 1 1 1.1 1z" />
						</svg>
					</span>
					<div className="hitl-head-text">
						<div className="hitl-eyebrow">
							{t('hitl.approvalRequired')}
							{kindKey ? <span className={`hitl-kind hitl-kind-${kind}`}>{t(kindKey)}</span> : null}
							{serviceId ? <code className="hitl-service">{serviceId}</code> : null}
						</div>
						<h2 className="quit-copy" id="hitl-title">
							{heading}
						</h2>
					</div>
				</div>
				<p className="widget-help">{body}</p>
				<div className="widget-foot">
					<button type="button" className="btn" disabled={busy} onClick={onCancel}>
						{t('hitl.decline')}
					</button>
					<button type="button" className="btn btn-primary" disabled={busy} onClick={onApprove} autoFocus>
						{t('hitl.approve')}
					</button>
				</div>
			</section>
		</div>
	);
}
