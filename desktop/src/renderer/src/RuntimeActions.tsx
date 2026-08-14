import type { ReactNode } from 'react';
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
	extra,
}: Props) {
	if (view.phase === 'setup' && !view.showSetup) {
		return extra ? <>{extra}</> : null;
	}
	return (
		<>
			{view.showSetup && (
				<button type="button" className="btn btn-primary" disabled={busy} onClick={onSetup}>
					{busyKey === 'setup' ? 'Working…' : setupLabel}
				</button>
			)}
			{view.showStart && (
				<button type="button" className="btn btn-primary" disabled={busy} onClick={onStart}>
					{busyKey === 'start' ? 'Working…' : 'Start'}
				</button>
			)}
			{view.showStop && (
				<button type="button" className="btn btn-danger" disabled={busy} onClick={onStop}>
					{busyKey === 'stop' ? 'Working…' : 'Stop'}
				</button>
			)}
			{view.showRestart && (
				<button type="button" className="btn" disabled={busy} onClick={onRestart}>
					{busyKey === 'restart' ? 'Working…' : 'Restart'}
				</button>
			)}
			{extra}
		</>
	);
}
