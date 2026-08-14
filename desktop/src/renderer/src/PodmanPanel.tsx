import { useCallback, useEffect, useRef, useState } from 'react';
import type { PodmanSetupProgress, PodmanStatusDTO, RuntimeStateDTO } from '../../preload/api';
import { dockerIsAvailable, hostCardLine, setupCtaDetail, WORKSPACE_DISPLAY_FALLBACK } from './hostCopy';
import PageShell from './PageShell';
import PodmanSetupSteps from './PodmanSetupSteps';
import RuntimeActions from './RuntimeActions';
import { machineControlName, resolveRuntimeView } from './runtimeView';

interface Props {
	onClose: () => void;
}

function bannerTitle(status: PodmanStatusDTO): string {
	const docker = status.engine === 'docker';
	switch (status.availability) {
		case 'ok':
			return docker ? 'Docker ready' : 'Runtime ready';
		case 'not_installed':
			return docker ? 'Docker CLI not found' : 'Container runtime not set up yet';
		case 'no_machine':
			return 'Linux VM not created yet';
		case 'machine_stopped':
			return docker ? 'Docker engine not running' : 'Podman machine stopped';
		default:
			return docker ? 'Docker error' : 'Podman error';
	}
}

function bannerDetail(status: PodmanStatusDTO): string {
	if (status.availability === 'ok') {
		return `Client ${status.version} · ${status.resolvedPath}`;
	}
	if (status.availability === 'no_machine') {
		return 'Set up Podman creates and starts the Linux VM.';
	}
	if (status.availability === 'machine_stopped') {
		if (status.engine === 'docker') {
			return status.host.os === 'linux'
				? 'Start the docker service, then refresh.'
				: 'Start Docker Desktop, then refresh.';
		}
		return 'Start the Linux VM before toggling tool services.';
	}
	if (status.version) {
		return `Client ${status.version}${status.error ? ` · ${status.error}` : ''}`;
	}
	return status.error || 'Something went wrong.';
}

function machineEmpty(status: PodmanStatusDTO): string {
	if (status.availability === 'not_installed') return 'No machines until the runtime is set up.';
	if (status.canInitMachine || (status.availability === 'machine_stopped' && status.machines.length === 0)) {
		return 'No machine yet.';
	}
	return 'No Podman machines (native runtime).';
}

function serviceState(started: boolean, imagePresent: boolean, engineReady: boolean, busy: boolean): string {
	if (busy) return '…';
	if (started) return engineReady && !imagePresent ? 'on · no image' : 'on';
	return engineReady && !imagePresent ? 'off · no image' : 'off';
}

export default function PodmanPanel({ onClose }: Props) {
	const [status, setStatus] = useState<PodmanStatusDTO | null>(null);
	const [cached, setCached] = useState<RuntimeStateDTO | null>(null);
	const [busy, setBusy] = useState<string | null>(null);
	const [message, setMessage] = useState('');
	const [pathDraft, setPathDraft] = useState('');
	const [setupProgress, setSetupProgress] = useState<PodmanSetupProgress | null>(null);
	const busyRef = useRef<string | null>(null);

	const applyStatus = (next: PodmanStatusDTO) => {
		setStatus(next);
		setPathDraft(next.resolvedPath);
		if (next.persisted) {
			setCached(next.persisted);
		}
	};

	const refresh = useCallback(async () => {
		const next = await window.hawaldar.getPodmanStatus();
		applyStatus(next);
	}, []);

	useEffect(() => {
		busyRef.current = busy;
	}, [busy]);

	useEffect(() => {
		void (async () => {
			const row = await window.hawaldar.getRuntimeState();
			setCached(row);
			if (row?.resolvedPath) {
				setPathDraft(row.resolvedPath);
			}
			await refresh();
		})();
		const timer = setInterval(() => {
			if (busyRef.current === 'setup') {
				return;
			}
			void refresh();
		}, 8_000);
		return () => clearInterval(timer);
	}, [refresh]);

	useEffect(() => {
		return window.hawaldar.onPodmanSetupProgress((ev) => {
			if (busyRef.current !== 'setup' && ev.step === 'ready' && !ev.failed) {
				return;
			}
			setSetupProgress(ev);
		});
	}, []);

	const withBusy = async (key: string, fn: () => Promise<void>) => {
		setBusy(key);
		setMessage('');
		try {
			await fn();
		} catch (error) {
			setMessage(error instanceof Error ? error.message : String(error));
		} finally {
			setBusy(null);
		}
	};

	if (!status && !cached) {
		return (
			<PageShell
				title="Podman"
				actions={<button type="button" className="btn" onClick={onClose}>Back to chat</button>}
			>
				<section className="widget">
					<p className="widget-help">Loading container runtime…</p>
				</section>
			</PageShell>
		);
	}

	const runtimeView = resolveRuntimeView({
		live: status,
		cached,
		setupBusy: busy === 'setup',
		setupProgress,
	});
	const docker = (status?.engine ?? cached?.engine) === 'docker';
	const podmanAlt = status?.alternatives.find((item) => item.engine === 'podman');
	const clientMissing = status?.availability === 'not_installed';
	const engineReady = Boolean(status?.ok);
	const showDockerSwitch = dockerIsAvailable(status?.alternatives) && !docker;
	const showPodmanSwitch = docker;
	const showMachineInit = Boolean(status && !docker && !clientMissing && (
		status.canInitMachine
		|| (status.availability === 'machine_stopped' && status.machines.length === 0)
	));

	const runSetup = () => {
		void withBusy('setup', async () => {
			setSetupProgress({ step: 'locating', message: 'Starting setup…' });
			if (docker && clientMissing) {
				applyStatus(await window.hawaldar.setContainerEngine('podman'));
			}
			const result = await window.hawaldar.setupPodman();
			applyStatus(result.status);
			setMessage(result.ok ? `✓ ${result.detail}` : result.detail);
			setSetupProgress(result.ok
				? null
				: { step: result.step, message: result.detail, failed: true });
		});
	};

	const runMachine = (action: 'start' | 'stop' | 'restart', name?: string) => {
		void withBusy(action, async () => {
			const result = await window.hawaldar.setPodmanMachine(
				action,
				name || machineControlName(status, cached),
			);
			applyStatus(result.status);
			setMessage(result.ok ? `✓ ${result.detail}` : result.detail);
			setSetupProgress(null);
		});
	};

	const switchEngine = (engine: 'podman' | 'docker') => {
		void withBusy('engine', async () => {
			const next = await window.hawaldar.setContainerEngine(engine);
			applyStatus(next);
			setMessage(next.ok
				? `✓ Using ${engine === 'docker' ? 'Docker' : 'Podman'}`
				: (next.error || `Switched to ${engine}`));
		});
	};

	return (
		<PageShell
			title="Podman"
			actions={(
				<>
					<button type="button" className="btn" disabled={Boolean(busy)} onClick={() => void withBusy('refresh', refresh)}>
						Refresh
					</button>
					<button type="button" className="btn" onClick={onClose}>Back to chat</button>
				</>
			)}
		>
			<section className="widget">
				<div className="widget-head">
					<h2 className="widget-title">Container runtime</h2>
					<div className="widget-actions">
						{showDockerSwitch && (
							<button
								type="button"
								className="btn-text"
								disabled={Boolean(busy)}
								onClick={() => switchEngine('docker')}
							>
								{busy === 'engine' ? 'Switching…' : 'Use Docker'}
							</button>
						)}
						{showPodmanSwitch && (
							<button
								type="button"
								className="btn-text"
								disabled={Boolean(busy)}
								onClick={() => switchEngine('podman')}
							>
								{busy === 'engine' ? 'Switching…' : podmanAlt?.available ? 'Use Podman' : 'Switch back to Podman'}
							</button>
						)}
					</div>
				</div>
				<div className="kv-list">
					{status && (
						<div className="kv-row">
							<span className="kv-label">Host</span>
							<span className="kv-value">{hostCardLine(status.host)}</span>
						</div>
					)}
					<div className="kv-row">
						<span className="kv-label">Workspace</span>
						<span className="kv-value mono">{status?.workspace?.displayPath ?? WORKSPACE_DISPLAY_FALLBACK}</span>
					</div>
					<div className="kv-row">
						<span className="kv-label">Engine</span>
						<span className="kv-value">
							{docker ? 'Docker' : 'Podman'}
							{engineReady && status?.version ? ` ${status.version}` : ''}
						</span>
					</div>
					{runtimeView.machineLine ? (
						<div className="kv-row">
							<span className="kv-label">Machine</span>
							<span className="kv-value">{runtimeView.machineLine}</span>
						</div>
					) : status ? (
						<div className="kv-row">
							<span className="kv-label">State</span>
							<span className="kv-value" title={`${bannerTitle(status)} · ${bannerDetail(status)}`}>
								{bannerTitle(status)} · {bannerDetail(status)}
							</span>
						</div>
					) : null}
				</div>
				{runtimeView.showStepper && <PodmanSetupSteps progress={setupProgress} />}
				{runtimeView.setupHint && status && (
					<p className="widget-help">{setupCtaDetail(status.host, docker && clientMissing)}</p>
				)}
				{message && (
					<p className={`widget-help${message.startsWith('✓') ? '' : ' widget-error'}`}>{message}</p>
				)}
				{runtimeView.phase !== 'setup' && (
					<details className="runtime-advanced">
						<summary>Advanced</summary>
						<div className="field">
							<label htmlFor="podman-path">{docker ? 'Docker path' : 'Podman path'}</label>
							<input
								id="podman-path"
								className="mono-input"
								value={pathDraft}
								onChange={(e) => setPathDraft(e.target.value)}
								placeholder={docker ? 'docker.exe path' : 'podman.exe path'}
								disabled={Boolean(busy)}
								spellCheck={false}
							/>
						</div>
						<div className="widget-foot">
							<button
								type="button"
								className="btn"
								disabled={Boolean(busy)}
								onClick={() => {
									void withBusy('apply-path', async () => {
										const next = await window.hawaldar.setPodmanPath(pathDraft.trim() || 'podman');
										applyStatus(next);
										setMessage(next.ok ? `✓ Using ${next.resolvedPath}` : (next.error || 'Path saved'));
									});
								}}
							>
								Apply
							</button>
							<button
								type="button"
								className="btn"
								disabled={Boolean(busy)}
								onClick={() => {
									void withBusy('browse', async () => {
										const result = await window.hawaldar.browsePodman();
										if (result.canceled || !result.status) {
											return;
										}
										applyStatus(result.status);
										setPathDraft(result.path || result.status.resolvedPath);
										setMessage(result.path ? `✓ ${result.path}` : '');
									});
								}}
							>
								Browse
							</button>
							<button
								type="button"
								className="btn"
								disabled={Boolean(busy)}
								onClick={() => {
									void withBusy('locate', async () => {
										const next = await window.hawaldar.locatePodman();
										applyStatus(next);
										setMessage(next.availability === 'not_installed'
											? (next.error || (next.engine === 'docker' ? 'Docker not found' : 'Podman not found'))
											: `✓ Found ${next.resolvedPath}`);
									});
								}}
							>
								{busy === 'locate' ? 'Looking…' : 'Locate'}
							</button>
						</div>
					</details>
				)}
				<div className="widget-foot">
					<RuntimeActions
						view={runtimeView}
						busy={Boolean(busy)}
						busyKey={busy}
						setupLabel={docker && clientMissing ? 'Set up Podman instead' : 'Set up Podman'}
						onSetup={runSetup}
						onStart={() => runMachine('start')}
						onStop={() => runMachine('stop')}
						onRestart={() => runMachine('restart')}
					/>
				</div>
			</section>

			{status && !docker && (
				<section className="widget">
					<div className="widget-head">
						<h2 className="widget-title">Machine</h2>
						<label className="inline-check">
							<input
								type="checkbox"
								checked={status.autoStartMachine}
								disabled={Boolean(busy) || clientMissing}
								onChange={(e) => {
									void withBusy('auto', async () => {
										applyStatus(await window.hawaldar.setAutoStartMachine(e.target.checked));
									});
								}}
							/>
							Auto-start
						</label>
					</div>
					<div className="table-wrap">
						<table className="data-table">
							<colgroup>
								<col className="col-tool" />
								<col />
								<col className="col-state" />
								<col className="col-action" />
							</colgroup>
							<thead>
								<tr>
									<th scope="col">Machine</th>
									<th scope="col">Specs</th>
									<th scope="col">State</th>
									<th scope="col" />
								</tr>
							</thead>
							<tbody>
								{status.machines.length === 0 && (
									<tr>
										<td colSpan={4} className="table-empty">{machineEmpty(status)}</td>
									</tr>
								)}
								{status.machines.map((machine) => {
									const specs = [
										machine.cpus ? `${machine.cpus} CPUs` : null,
										machine.memoryMiB ? `${machine.memoryMiB} MiB` : null,
										machine.lastUp,
									].filter(Boolean).join(' · ') || '—';
									return (
										<tr key={machine.name}>
											<td className="col-nowrap">{machine.name}</td>
											<td className="col-nowrap" title={specs}>{specs}</td>
											<td className="col-nowrap">{machine.running ? 'running' : 'stopped'}</td>
											<td className="col-action">
												{machine.running ? (
													<>
														<button
															type="button"
															className="btn btn-danger"
															disabled={Boolean(busy)}
															onClick={() => runMachine('stop', machine.name)}
														>
															{busy === 'stop' ? 'Working…' : 'Stop'}
														</button>
														<button
															type="button"
															className="btn"
															disabled={Boolean(busy)}
															onClick={() => runMachine('restart', machine.name)}
														>
															{busy === 'restart' ? 'Working…' : 'Restart'}
														</button>
													</>
												) : (
													<button
														type="button"
														className="btn"
														disabled={Boolean(busy)}
														onClick={() => runMachine('start', machine.name)}
													>
														{busy === 'start' ? 'Working…' : 'Start'}
													</button>
												)}
											</td>
										</tr>
									);
								})}
							</tbody>
						</table>
					</div>
					{showMachineInit && (
						<div className="widget-foot">
							<button
								type="button"
								className="btn btn-primary"
								disabled={Boolean(busy) || clientMissing}
								onClick={() => {
									void withBusy('machine-init', async () => {
										const result = await window.hawaldar.setPodmanMachine('init');
										applyStatus(result.status);
										setMessage(result.ok ? `✓ ${result.detail}` : result.detail);
									});
								}}
							>
								{busy === 'machine-init' ? 'Working…' : 'Initialize / start machine'}
							</button>
						</div>
					)}
				</section>
			)}

			{status && (
			<>
			<section className="widget">
				<div className="widget-head">
					<h2 className="widget-title">Tool services</h2>
				</div>
				<p className="widget-help">Default off. Toggle to pull the image and allow that agent.</p>
				<div className="table-wrap">
					<table className="data-table">
						<colgroup>
							<col className="col-tool" />
							<col />
							<col className="col-state" />
							<col className="col-check" />
						</colgroup>
						<thead>
							<tr>
								<th scope="col">Service</th>
								<th scope="col">Image</th>
								<th scope="col">State</th>
								<th scope="col">Toggle</th>
							</tr>
						</thead>
						<tbody>
							{status.services.length === 0 && (
								<tr>
									<td colSpan={4} className="table-empty">No tool services.</td>
								</tr>
							)}
							{status.services.map((service) => {
								const state = serviceState(
									service.started,
									service.imagePresent,
									engineReady,
									busy === `svc-${service.id}`,
								);
								return (
									<tr key={service.id}>
										<td className="col-nowrap" title={service.label}>{service.label}</td>
										<td className="col-nowrap mono" title={service.image}>{service.image}</td>
										<td className="col-nowrap" title={service.detail}>{state}</td>
										<td className="col-check">
											<input
												type="checkbox"
												checked={service.started}
												disabled={Boolean(busy) || clientMissing}
												aria-label={`Toggle ${service.label}`}
												onChange={(e) => {
													const started = e.target.checked;
													void withBusy(`svc-${service.id}`, async () => {
														const result = await window.hawaldar.setPodmanService(service.id, started);
														applyStatus(result.status);
														setMessage(result.ok ? `✓ ${result.detail}` : result.detail);
													});
												}}
											/>
										</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				</div>
			</section>

			<section className="widget">
				<div className="widget-head">
					<h2 className="widget-title">Containers</h2>
				</div>
				<div className="table-wrap">
					<table className="data-table">
						<colgroup>
							<col className="col-tool" />
							<col />
							<col className="col-state" />
							<col className="col-action" />
						</colgroup>
						<thead>
							<tr>
								<th scope="col">Container</th>
								<th scope="col">Image</th>
								<th scope="col">State</th>
								<th scope="col" />
							</tr>
						</thead>
						<tbody>
							{status.containers.length === 0 && (
								<tr>
									<td colSpan={4} className="table-empty">
										{engineReady ? 'No containers.' : 'No containers until the runtime is ready.'}
									</td>
								</tr>
							)}
							{status.containers.map((item) => (
								<tr key={item.id}>
									<td className="col-nowrap" title={item.name || item.id}>{item.name || item.id.slice(0, 12)}</td>
									<td className="col-nowrap mono" title={item.image}>{item.image}</td>
									<td className="col-nowrap">{item.state}{item.hawaldar ? ' · hawaldar' : ''}</td>
									<td className="col-action">
										{(item.state === 'running' || item.state === 'created') ? (
											<button
												type="button"
												className="btn"
												disabled={Boolean(busy)}
												onClick={() => {
													void withBusy(`ctr-${item.id}`, async () => {
														const result = await window.hawaldar.stopPodmanContainer(item.name || item.id);
														applyStatus(result.status);
														setMessage(result.ok ? `✓ stopped ${item.name || item.id}` : result.detail);
													});
												}}
											>
												Stop
											</button>
										) : null}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			</section>
			</>
			)}
		</PageShell>
	);
}
