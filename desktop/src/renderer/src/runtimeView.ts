import type { PodmanSetupProgress, PodmanStatusDTO, RuntimeStateDTO } from '../../preload/api';

export type RuntimePhase = 'unknown' | 'setup' | 'not_installed' | 'stopped' | 'running';

export interface RuntimeView {
	phase: RuntimePhase;
	showStepper: boolean;
	showSetup: boolean;
	showStart: boolean;
	showStop: boolean;
	showRestart: boolean;
	machineLine: string;
	setupHint: boolean;
}

export function machineControlName(live: PodmanStatusDTO | null, cached: RuntimeStateDTO | null): string | undefined {
	return live?.machines.find((item) => item.running)?.name
		|| live?.machines[0]?.name
		|| cached?.machineName
		|| undefined;
}

export function resolveRuntimeView(opts: {
	live: PodmanStatusDTO | null;
	cached: RuntimeStateDTO | null;
	setupBusy: boolean;
	setupProgress: PodmanSetupProgress | null;
}): RuntimeView {
	const { live, cached, setupBusy, setupProgress } = opts;
	const hidden: RuntimeView = {
		phase: 'unknown',
		showStepper: false,
		showSetup: false,
		showStart: false,
		showStop: false,
		showRestart: false,
		machineLine: '',
		setupHint: false,
	};

	if (setupBusy) {
		return { ...hidden, phase: 'setup', showStepper: true };
	}

	if (setupProgress?.failed) {
		return {
			...hidden,
			phase: 'setup',
			showStepper: true,
			showSetup: true,
			setupHint: true,
		};
	}

	const engine = live?.engine ?? cached?.engine ?? 'podman';
	const machines = live?.machines ?? [];
	const liveRunning = live
		? (engine === 'docker' ? live.ok : machines.some((item) => item.running))
		: false;
	const running = live ? liveRunning : Boolean(cached?.machineRunning);
	const machineName = machineControlName(live, cached) || 'podman-machine-default';
	const lastSetupOk = Boolean(
		cached?.lastSetupOk
		|| live?.availability === 'ok'
		|| machines.some((item) => Boolean(item.lastUp)),
	);

	if (live) {
		if (live.availability === 'not_installed') {
			return { ...hidden, phase: 'not_installed', showSetup: true, setupHint: true };
		}
		if (live.availability === 'no_machine') {
			return { ...hidden, phase: 'not_installed', showSetup: true, setupHint: true };
		}
		if (live.availability === 'ok') {
			if (engine === 'docker') {
				return { ...hidden, phase: 'running', machineLine: 'Docker · running' };
			}
			if (machines.length === 0) {
				return { ...hidden, phase: 'running', machineLine: 'native · running' };
			}
			return {
				...hidden,
				phase: 'running',
				showStop: true,
				showRestart: true,
				machineLine: `${machineName} · running`,
			};
		}
		if (live.availability === 'machine_stopped') {
			if (engine === 'docker') {
				return { ...hidden, phase: 'stopped', machineLine: 'Docker · stopped' };
			}
			return {
				...hidden,
				phase: 'stopped',
				showSetup: !lastSetupOk,
				showStart: machines.length > 0,
				machineLine: `${machineName} · stopped`,
				setupHint: !lastSetupOk,
			};
		}
		return {
			...hidden,
			phase: 'stopped',
			showSetup: !lastSetupOk,
			showStart: engine === 'podman' && machines.length > 0,
			machineLine: live.error || '',
			setupHint: !lastSetupOk,
		};
	}

	if (cached?.lastSetupOk || cached?.machineName) {
		if (running && engine !== 'docker') {
			return {
				...hidden,
				phase: 'running',
				showStop: true,
				showRestart: true,
				machineLine: `${machineName} · running`,
			};
		}
		if (engine === 'docker') {
			return {
				...hidden,
				phase: running ? 'running' : 'stopped',
				machineLine: running ? 'Docker · running' : 'Docker · stopped',
			};
		}
		return {
			...hidden,
			phase: 'stopped',
			showSetup: !cached.lastSetupOk,
			showStart: true,
			machineLine: `${machineName} · stopped`,
			setupHint: !cached.lastSetupOk,
		};
	}

	return { ...hidden, phase: 'not_installed', showSetup: true, setupHint: true };
}
