import { useState, type ReactNode } from 'react';
import { useI18n } from './i18n';
import type { RuntimeView } from './runtimeView';

interface Props {
	view: RuntimeView;
	busy: boolean;
	busyKey?: string | null;
	setupLabel: string;
	onSetup: () => void;
	onStart: () => void;
	onStop: () => void;
	onRestart: () => void;
	autoStart?: boolean;
	onAutoStart?: (enabled: boolean) => void;
	extra?: ReactNode;
}

export default function RuntimeActions({
	view,
	busy,
	busyKey,
	setupLabel,
	onSetup,
	onStart,
	onStop,
	onRestart,
	autoStart = false,
	onAutoStart,
	extra,
}: Props) {
	const { t } = useI18n();
	const [clearing, setClearing] = useState(false);
	const [clearMsg, setClearMsg] = useState('');
	if (view.phase === 'setup' && !view.showSetup) {
		return extra ? <>{extra}</> : null;
	}
	return (
		<div className="runtime-actions">
			{view.showSetup && (
				<button type="button" className="btn btn-primary" disabled={busy} onClick={onSetup}>
					{busyKey === 'setup' ? t('runtime.working') : setupLabel}
				</button>
			)}
			{view.showStart && (
				<button type="button" className="btn btn-primary" disabled={busy} onClick={onStart}>
					{busyKey === 'start' ? t('runtime.working') : t('runtime.start')}
				</button>
			)}
			{view.showStop && (
				<button type="button" className="btn btn-danger" disabled={busy} onClick={onStop}>
					{busyKey === 'stop' ? t('runtime.working') : t('runtime.stop')}
				</button>
			)}
			{view.showRestart && (
				<button type="button" className="btn" disabled={busy} onClick={onRestart}>
					{busyKey === 'restart' ? t('runtime.working') : t('runtime.restart')}
				</button>
			)}
			{view.showAutoStart && onAutoStart && (
				<label className="inline-check">
					<input
						type="checkbox"
						checked={autoStart}
						disabled={busy}
						onChange={(e) => onAutoStart(e.target.checked)}
					/>
					{t('runtime.autoStart')}
				</label>
			)}
			<button
				type="button"
				className="btn"
				disabled={busy || clearing}
				title={t('runtime.clearApprovalsTitle')}
				onClick={() => {
					void (async () => {
						setClearing(true);
						setClearMsg('');
						try {
							const n = await window.hawaldar.clearHitlApprovals();
							setClearMsg(n === 0
								? t('runtime.noApprovals')
								: t(n === 1 ? 'runtime.cleared' : 'runtime.clearedPlural', { count: n }));
						} catch (error) {
							setClearMsg(error instanceof Error ? error.message : String(error));
						} finally {
							setClearing(false);
						}
					})();
				}}
			>
				{clearing ? t('runtime.clearing') : t('runtime.clearApprovals')}
			</button>
			{clearMsg ? <span className="widget-help">{clearMsg}</span> : null}
			{extra}
		</div>
	);
}
