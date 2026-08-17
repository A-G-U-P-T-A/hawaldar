import type { PodmanSetupProgress, PodmanStatusDTO, RuntimeStateDTO } from '../../preload/api';

export type RuntimePhase = 'unknown' | 'setup' | 'not_installed' | 'stopped' | 'running';

export interface RuntimeView {
	phase: RuntimePhase;
	showStepper: boolean;
	showSetup: boolean;
	showStart: boolean;
	showStop: boolean;
	showRestart: boolean;
	showAutoStart: boolean;
	machineLine: string;
	setupHint: boolean;
}

export function machineControlName(live: PodmanStatusDTO | null, cached: RuntimeStateDTO | null): string | undefined {
	return live?.machines.find((item) => item.running)?.name
		|| live?.machines[0]?.name
		|| cached?.machineName
		|| undefined;
}

function withMachineControls(view: RuntimeView, running: boolean): RuntimeView {
	if (running) {
		return { ...view, showStop: true, showRestart: true, showAutoStart: true };
	}
	return { ...view, showStart: true, showAutoStart: true };
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
		showAutoStart: false,
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
	const needsVm = Boolean(live?.host.needsLinuxVm);
	const listedRunning = machines.some((item) => item.running);
	const liveRunning = live
		? (engine === 'docker'
			? live.ok
			: listedRunning || (live.availability === 'ok' && needsVm && machines.length === 0))
		: false;
	const running = live ? liveRunning : Boolean(cached?.machineRunning);
	const machineName = machineControlName(live, cached) || 'podman-machine-default';
	const lastSetupOk = Boolean(
		cached?.lastSetupOk
		|| live?.availability === 'ok'
		|| machines.some((item) => Boolean(item.lastUp)),
	);
	const hasMachine = engine === 'podman' && (
		machines.length > 0
		|| Boolean(cached?.machineName)
		|| (needsVm && (live?.availability === 'ok' || live?.availability === 'machine_stopped' || lastSetupOk))
	);

	if (live) {
		if (live.availability === 'not_installed' || live.availability === 'no_machine') {
			return { ...hidden, phase: 'not_installed', showSetup: true, setupHint: true };
		}
		if (engine === 'docker') {
			return {
				...hidden,
				phase: running ? 'running' : 'stopped',
				machineLine: running ? 'Docker · running' : 'Docker · stopped',
			};
		}
		if (hasMachine && running) {
			return withMachineControls({
				...hidden,
				phase: 'running',
				machineLine: `${machineName} · running`,
			}, true);
		}
		if (hasMachine) {
			return withMachineControls({
				...hidden,
				phase: 'stopped',
				machineLine: `${machineName} · stopped`,
			}, false);
		}
		if (live.availability === 'ok') {
			return { ...hidden, phase: 'running', machineLine: 'native · running' };
		}
		return {
			...hidden,
			phase: 'stopped',
			showSetup: !lastSetupOk,
			machineLine: live.error || '',
			setupHint: !lastSetupOk,
		};
	}

	if (cached?.lastSetupOk || cached?.machineName) {
		if (engine === 'docker') {
			return {
				...hidden,
				phase: running ? 'running' : 'stopped',
				machineLine: running ? 'Docker · running' : 'Docker · stopped',
			};
		}
		return withMachineControls({
			...hidden,
			phase: running ? 'running' : 'stopped',
			machineLine: `${machineName} · ${running ? 'running' : 'stopped'}`,
		}, running);
	}

	return { ...hidden, phase: 'not_installed', showSetup: true, setupHint: true };
}
