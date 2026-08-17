import type { PodmanSetupProgress, PodmanSetupStep } from '../../preload/api';

const STEPS: Array<{ id: PodmanSetupStep; label: string }> = [
	{ id: 'locating', label: 'Locating' },
	{ id: 'installing', label: 'Installing' },
	{ id: 'starting_machine', label: 'Starting machine' },
	{ id: 'ready', label: 'Ready' },
];

const ORDER = STEPS.map((item) => item.id);

export default function PodmanSetupSteps({ progress }: { progress: PodmanSetupProgress | null }) {
	if (!progress) {
		return null;
	}
	const currentIdx = ORDER.indexOf(progress.step);
	const detail = setupLogDetail(progress.message, progress.detail);
	return (
		<div className="setup-progress">
			<ol className="setup-steps">
				{STEPS.map((item, index) => {
					let state = 'pending';
					if (index < currentIdx) {
						state = 'done';
					} else if (index === currentIdx) {
						state = progress.failed ? 'failed' : (item.id === 'ready' ? 'done' : 'current');
					}
					return (
						<li key={item.id} className={state}>
							<span className="setup-mark" aria-hidden>
								{state === 'done' ? '✓' : state === 'failed' ? '✗' : state === 'current' ? '●' : '○'}
							</span>
							{item.label}
						</li>
					);
				})}
			</ol>
			<p className="setup-log">
				{progress.message}
				{detail ? `\n${detail}` : ''}
			</p>
		</div>
	);
}

function setupLogDetail(message: string, detail?: string): string {
	if (!detail || detail === message || message.includes(detail)) {
		return '';
	}
	if (/rootless mode|podman machine set --rootful/i.test(detail)) {
		return '';
	}
	return detail;
}
