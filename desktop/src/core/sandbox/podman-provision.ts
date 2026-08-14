/**
 * First-run / in-app Podman provisioning. Main process only.
 * Never exposed to the model. Tool work still goes through runner.ts → the selected engine only.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { hostOs, resolveDockerPath } from './host-info';
import {
	bootstrapPodmanMachine,
	classifyMachineOpFailure,
	getDockerInfo,
	isIgnorableMachineNote,
	lastActionableMachineLine,
	listPodmanMachines,
	platformNeedsPodmanMachine,
	stripMachineNotes,
} from './podman-control';
import {
	augmentedPath,
	isExistingFile,
	resolvePodmanPath,
	stripQuotes,
	type PodmanResolveResult,
} from './podman-path';
import type { CommandResult } from './runner';
import { WORKSPACE_DISPLAY_PATH, ensureWorkspace } from './workspace';

export type PodmanSetupStep = 'locating' | 'installing' | 'starting_machine' | 'ready';

export interface PodmanSetupProgress {
	step: PodmanSetupStep;
	message: string;
	detail?: string;
	failed?: boolean;
}

export interface PodmanSetupResult {
	ok: boolean;
	detail: string;
	step: PodmanSetupStep;
	resolvedPath?: string;
}

const WINGET_PODMAN = 'RedHat.Podman';
const WINGET_PODMAN_DESKTOP = 'RedHat.Podman-Desktop';
const INSTALL_TIMEOUT_MS = 900_000;
const MACHINE_INIT_TIMEOUT_MS = 900_000;
const MACHINE_START_TIMEOUT_MS = 900_000;
const DOWNLOAD_TIMEOUT_MS = 180_000;

let inFlight = false;

export async function setupPodmanRuntime(options: {
	preferredPath?: string;
	engine?: 'podman' | 'docker';
	persistPath: (podmanPath: string) => Promise<void>;
	onProgress: (progress: PodmanSetupProgress) => void;
}): Promise<PodmanSetupResult> {
	if (inFlight) {
		return { ok: false, detail: 'Setup is already running.', step: 'installing' };
	}
	inFlight = true;
	const emit = options.onProgress;
	try {
		ensureWorkspace();
		if (options.engine === 'docker') {
			return await setupDockerRuntime(options.preferredPath, options.persistPath, emit);
		}

		emit({
			step: 'locating',
			message: locatingMessage(),
			detail: `Shared workspace ready · ${WORKSPACE_DISPLAY_PATH}`,
		});
		let resolved = resolvePodmanPath(options.preferredPath);
		if (resolved.path) {
			await persistResolved(options.persistPath, resolved.path);
			emit({
				step: 'installing',
				message: 'Using the Podman install already on this machine.',
				detail: resolved.path,
			});
			return finishMachine(resolved.path, emit);
		}

		if (process.platform === 'linux') {
			const docker = resolveDockerPath();
			const detail = docker.path
				? 'Podman was not found. Docker is on this machine — use Docker instead, or install Podman with your distro packages. Hawaldar will not run sudo.'
				: 'Neither Podman nor Docker was found. Install one with your distro packages, then click Locate. Hawaldar will not install them with sudo.';
			emit({ step: 'locating', message: detail, failed: true });
			return { ok: false, detail, step: 'locating' };
		}

		emit({
			step: 'installing',
			message: process.platform === 'win32'
				? 'Installing Podman via winget or the official MSI…'
				: 'Installing Podman with Homebrew…',
			detail: process.platform === 'win32'
				? 'Windows may ask for permission (UAC). Containers need WSL or Hyper-V.'
				: 'macOS will use a Podman machine (Linux VM) after install.',
		});

		const installed = await installRuntime(emit);
		if (!installed.ok) {
			emit({
				step: 'installing',
				message: installed.detail,
				detail: installed.hint,
				failed: true,
			});
			return { ok: false, detail: installed.detail, step: 'installing' };
		}

		resolved = await resolveAfterInstall(options.preferredPath);
		if (!resolved.path) {
			const detail = 'Podman was installed, but Hawaldar still cannot find podman.exe. Try Set up again in a moment, or Browse to the executable.';
			emit({ step: 'installing', message: detail, failed: true });
			return { ok: false, detail, step: 'installing' };
		}

		await persistResolved(options.persistPath, resolved.path);
		emit({ step: 'installing', message: 'Runtime installed.', detail: resolved.path });
		return finishMachine(resolved.path, emit);
	} catch (error) {
		const detail = classifyUnexpected(error);
		emit({ step: 'installing', message: detail, failed: true });
		return { ok: false, detail, step: 'installing' };
	} finally {
		inFlight = false;
	}
}

async function finishMachine(
	podmanPath: string,
	emit: (progress: PodmanSetupProgress) => void,
): Promise<PodmanSetupResult> {
	if (!platformNeedsPodmanMachine()) {
		ensureWorkspace();
		emit({ step: 'starting_machine', message: 'No Linux VM needed on this system.' });
		emit({ step: 'ready', message: 'Container runtime is ready. Shared workspace ready.' });
		return { ok: true, detail: 'Container runtime is ready. Shared workspace ready.', step: 'ready', resolvedPath: podmanPath };
	}

	emit({
		step: 'starting_machine',
		message: 'Starting the Linux VM…',
		detail: 'First-time setup can take several minutes.',
	});

	const machines = await listPodmanMachines(podmanPath);
	let lastLine = '';
	const onOutput = (chunk: string) => {
		const line = lastProgressLine(chunk);
		if (!line || line === lastLine) {
			return;
		}
		lastLine = line;
		emit({
			step: 'starting_machine',
			message: machines.length === 0
				? 'Creating the Linux VM…'
				: 'Starting the Linux VM…',
			detail: line.slice(0, 240),
		});
	};

	const result = await bootstrapPodmanMachine(podmanPath, {
		initTimeoutMs: MACHINE_INIT_TIMEOUT_MS,
		startTimeoutMs: MACHINE_START_TIMEOUT_MS,
		onOutput,
	});

	if (!result.ok) {
		const detail = classifyMachineFailure(result.detail);
		const extra = lastActionableMachineLine(result.detail);
		emit({
			step: 'starting_machine',
			message: detail,
			detail: extra && extra !== detail && !detail.includes(extra) ? extra.slice(0, 240) : undefined,
			failed: true,
		});
		return { ok: false, detail, step: 'starting_machine', resolvedPath: podmanPath };
	}

	ensureWorkspace();
	emit({ step: 'ready', message: 'Container runtime is ready. Shared workspace ready.', detail: result.detail });
	return { ok: true, detail: result.detail || 'Container runtime is ready. Shared workspace ready.', step: 'ready', resolvedPath: podmanPath };
}

async function installRuntime(
	emit: (progress: PodmanSetupProgress) => void,
): Promise<{ ok: boolean; detail: string; hint?: string }> {
	if (process.platform === 'win32') {
		return installWindows(emit);
	}
	if (process.platform === 'darwin') {
		return installMac(emit);
	}
	return {
		ok: false,
		detail: 'Hawaldar could not find Podman. On Linux it only locates an existing install — it will not sudo or pretend winget works.',
	};
}

async function setupDockerRuntime(
	preferredPath: string | undefined,
	persistPath: (podmanPath: string) => Promise<void>,
	emit: (progress: PodmanSetupProgress) => void,
): Promise<PodmanSetupResult> {
	emit({
		step: 'locating',
		message: 'Looking for an existing Docker CLI…',
		detail: `Shared workspace ready · ${WORKSPACE_DISPLAY_PATH}`,
	});
	const docker = resolveDockerPath(preferredPath);
	if (!docker.path) {
		const detail = 'Docker was not found. Hawaldar does not install Docker Desktop (size and license). Browse to an existing docker binary, or Set up Podman — that is the install this app owns.';
		emit({ step: 'locating', message: detail, failed: true });
		return { ok: false, detail, step: 'locating' };
	}

	await persistResolved(persistPath, docker.path);
	emit({
		step: 'installing',
		message: 'Using the Docker CLI already on this machine.',
		detail: docker.path,
	});

	const info = await getDockerInfo(docker.path);
	if (!info.ok) {
		const detail = process.platform === 'linux'
			? 'Docker CLI found, but the daemon is not running. Start the docker service, then refresh.'
			: 'Docker CLI found, but the engine is not running. Start Docker Desktop, then refresh.';
		emit({ step: 'starting_machine', message: detail, detail: info.error, failed: true });
		return { ok: false, detail, step: 'starting_machine', resolvedPath: docker.path };
	}

	ensureWorkspace();
	emit({ step: 'ready', message: 'Docker engine is ready. Shared workspace ready.', detail: docker.path });
	return { ok: true, detail: 'Docker engine is ready. Shared workspace ready.', step: 'ready', resolvedPath: docker.path };
}

function locatingMessage(): string {
	const os = hostOs();
	if (os === 'windows') {
		return 'Looking for Podman on this Windows machine…';
	}
	if (os === 'macos') {
		return 'Looking for Podman on this Mac…';
	}
	if (os === 'linux') {
		return 'Looking for a native Podman or Docker install…';
	}
	return 'Looking for an existing container runtime…';
}

async function installWindows(
	emit: (progress: PodmanSetupProgress) => void,
): Promise<{ ok: boolean; detail: string; hint?: string }> {
	const winget = whichWinget();
	const notes: string[] = [];
	let sawElevation = false;

	if (winget) {
		emit({
			step: 'installing',
			message: 'Installing Podman…',
			detail: 'Windows may ask for permission.',
		});
		const wingetResult = await runWinget(winget, WINGET_PODMAN, emit);
		if (wingetResult.ok || await resolveAfterInstall().then((r) => Boolean(r.path))) {
			return { ok: true, detail: 'Installed Podman.' };
		}
		if (isElevationFailure(wingetResult.exitCode, wingetResult.output)) {
			sawElevation = true;
		}
		notes.push(classifyInstallFailure('Package install', wingetResult.exitCode, wingetResult.output));
	} else {
		notes.push('Windows Package Manager was not available, so Hawaldar is using the official installer.');
	}

	emit({
		step: 'installing',
		message: 'Downloading the official Podman installer…',
	});
	const downloaded = await downloadOfficialInstaller(emit);
	if (downloaded.ok && downloaded.path) {
		emit({
			step: 'installing',
			message: 'Running the official installer…',
			detail: 'A permission prompt may appear.',
		});
		const ran = await runOfficialInstaller(downloaded.path, emit);
		if (ran.ok || await resolveAfterInstall().then((r) => Boolean(r.path))) {
			return { ok: true, detail: 'Installed Podman.' };
		}
		if (isElevationFailure(ran.exitCode, ran.output)) {
			sawElevation = true;
		}
		notes.push(ran.detail);
	} else {
		notes.push(downloaded.detail);
	}

	if (winget) {
		emit({
			step: 'installing',
			message: 'Trying Podman Desktop as a fallback…',
		});
		const desktop = await runWinget(winget, WINGET_PODMAN_DESKTOP, emit);
		if (desktop.ok || await resolveAfterInstall().then((r) => Boolean(r.path))) {
			return { ok: true, detail: 'Installed Podman Desktop (includes the runtime).' };
		}
		if (isElevationFailure(desktop.exitCode, desktop.output)) {
			sawElevation = true;
		}
		notes.push(classifyInstallFailure('Podman Desktop install', desktop.exitCode, desktop.output));
	}

	if (sawElevation) {
		return {
			ok: false,
			detail: 'Windows asked for administrator permission and it was cancelled or denied. Approve the prompt to finish setup.',
			hint: notes.filter(Boolean).slice(-2).join(' '),
		};
	}

	return {
		ok: false,
		detail: notes.filter(Boolean).slice(-3).join(' ') || 'Hawaldar could not install the container runtime.',
	};
}

async function installMac(
	emit: (progress: PodmanSetupProgress) => void,
): Promise<{ ok: boolean; detail: string }> {
	const brew = whichBrew();
	if (!brew) {
		return {
			ok: false,
			detail: 'Hawaldar could not find Homebrew, so it cannot install Podman automatically on this Mac.',
		};
	}
	emit({ step: 'installing', message: 'Installing Podman with Homebrew…' });
	const result = await runSetupCommand(brew, ['install', 'podman'], INSTALL_TIMEOUT_MS, (chunk) => {
		const line = lastMeaningfulLine(chunk);
		if (line) {
			emit({ step: 'installing', message: 'Installing Podman with Homebrew…', detail: line.slice(0, 240) });
		}
	});
	if (result.exitCode === 0 && !result.timedOut) {
		return { ok: true, detail: 'Installed Podman.' };
	}
	if (await resolveAfterInstall().then((r) => Boolean(r.path))) {
		return { ok: true, detail: 'Installed Podman.' };
	}
	return {
		ok: false,
		detail: classifyInstallFailure('Homebrew install', result.exitCode, joinOutput(result)),
	};
}

async function runWinget(
	winget: string,
	packageId: string,
	emit: (progress: PodmanSetupProgress) => void,
): Promise<{ ok: boolean; exitCode: number; output: string }> {
	const result = await runSetupCommand(
		winget,
		[
			'install',
			'-e',
			'--id',
			packageId,
			'--accept-package-agreements',
			'--accept-source-agreements',
			'--disable-interactivity',
		],
		INSTALL_TIMEOUT_MS,
		(chunk) => {
			const line = lastMeaningfulLine(chunk);
			if (line) {
				emit({ step: 'installing', message: `Installing ${packageId}…`, detail: line.slice(0, 240) });
			}
		},
	);
	const output = joinOutput(result);
	const already = /already installed|no available upgrade/i.test(output);
	const ok = !result.timedOut && (result.exitCode === 0 || already);
	return { ok, exitCode: result.exitCode, output };
}

async function downloadOfficialInstaller(
	emit: (progress: PodmanSetupProgress) => void,
): Promise<{ ok: boolean; path?: string; detail: string }> {
	try {
		const asset = await resolveInstallerUrl();
		const dir = path.join(os.tmpdir(), 'hawaldar-podman-setup');
		fs.mkdirSync(dir, { recursive: true });
		const dest = path.join(dir, asset.filename);
		emit({ step: 'installing', message: 'Downloading the official installer…', detail: asset.filename });

		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
		const res = await fetch(asset.url, {
			redirect: 'follow',
			signal: controller.signal,
			headers: { 'User-Agent': 'Hawaldar' },
		});
		clearTimeout(timer);
		if (!res.ok) {
			return { ok: false, detail: `Official installer download failed (HTTP ${res.status}).` };
		}
		const buf = Buffer.from(await res.arrayBuffer());
		if (buf.length < 1_000) {
			return { ok: false, detail: 'Official installer download was empty or blocked.' };
		}
		fs.writeFileSync(dest, buf);
		return { ok: true, path: dest, detail: dest };
	} catch (error) {
		const aborted = error instanceof Error && error.name === 'AbortError';
		return {
			ok: false,
			detail: aborted
				? 'Official installer download timed out.'
				: `Could not download the official installer (${error instanceof Error ? error.message : String(error)}).`,
		};
	}
}

async function resolveInstallerUrl(): Promise<{ url: string; filename: string }> {
	const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
	try {
		const api = await fetch('https://api.github.com/repos/containers/podman/releases/latest', {
			headers: { 'User-Agent': 'Hawaldar', Accept: 'application/vnd.github+json' },
		});
		if (api.ok) {
			const json = await api.json() as { assets?: Array<{ name: string; browser_download_url: string }> };
			const assets = json.assets || [];
			const prefer = [
				`podman-installer-windows-${arch}.msi`,
				`podman-installer-windows-${arch}.exe`,
			];
			for (const name of prefer) {
				const hit = assets.find((item) => item.name.toLowerCase() === name);
				if (hit) {
					return { url: hit.browser_download_url, filename: hit.name };
				}
			}
			const fuzzy = assets.find((item) => {
				const n = item.name.toLowerCase();
				return n.includes('windows') && n.includes(arch) && (n.endsWith('.msi') || n.endsWith('.exe'));
			});
			if (fuzzy) {
				return { url: fuzzy.browser_download_url, filename: fuzzy.name };
			}
		}
	} catch {
		// Fall through to the stable GitHub latest URL.
	}
	const filename = `podman-installer-windows-${arch}.msi`;
	return {
		url: `https://github.com/containers/podman/releases/latest/download/${filename}`,
		filename,
	};
}

async function runOfficialInstaller(
	installerPath: string,
	emit: (progress: PodmanSetupProgress) => void,
): Promise<{ ok: boolean; exitCode: number; output: string; detail: string }> {
	const logPath = path.join(os.tmpdir(), 'hawaldar-podman-setup', 'podman-msi.log');
	const onOutput = (chunk: string) => {
		const line = lastMeaningfulLine(chunk);
		if (line) {
			emit({ step: 'installing', message: 'Running the official installer…', detail: line.slice(0, 240) });
		}
	};

	if (installerPath.toLowerCase().endsWith('.msi')) {
		const msiexec = msiexecBin();
		if (!msiexec) {
			return { ok: false, exitCode: 1, output: '', detail: 'Windows installer service (msiexec) was not found.' };
		}
		const perUser = await runSetupCommand(
			msiexec,
			['/i', installerPath, '/qn', '/norestart', '/l*v', logPath, 'MSIINSTALLPERUSER=1', 'MACHINE_PROVIDER=wsl'],
			INSTALL_TIMEOUT_MS,
			onOutput,
		);
		if (msiSucceeded(perUser.exitCode) && !perUser.timedOut) {
			return { ok: true, exitCode: perUser.exitCode, output: joinOutput(perUser), detail: 'Installed Podman.' };
		}
		const machine = await runSetupCommand(
			msiexec,
			['/i', installerPath, '/qn', '/norestart', '/l*v', logPath, 'ALLUSERS=1', 'MACHINE_PROVIDER=wsl'],
			INSTALL_TIMEOUT_MS,
			onOutput,
		);
		const output = [joinOutput(perUser), joinOutput(machine), tailFile(logPath)].filter(Boolean).join('\n');
		if (msiSucceeded(machine.exitCode) && !machine.timedOut) {
			return { ok: true, exitCode: machine.exitCode, output, detail: 'Installed Podman.' };
		}
		return {
			ok: false,
			exitCode: machine.exitCode || perUser.exitCode,
			output,
			detail: classifyInstallFailure('Official installer', machine.exitCode || perUser.exitCode, output),
		};
	}

	const quiet = await runSetupCommand(
		installerPath,
		['/install', '/quiet', '/norestart'],
		INSTALL_TIMEOUT_MS,
		onOutput,
	);
	if ((quiet.exitCode === 0 || msiSucceeded(quiet.exitCode)) && !quiet.timedOut) {
		return { ok: true, exitCode: quiet.exitCode, output: joinOutput(quiet), detail: 'Installed Podman.' };
	}
	const nsis = await runSetupCommand(installerPath, ['/S'], INSTALL_TIMEOUT_MS, onOutput);
	const output = [joinOutput(quiet), joinOutput(nsis)].filter(Boolean).join('\n');
	if (nsis.exitCode === 0 && !nsis.timedOut) {
		return { ok: true, exitCode: nsis.exitCode, output, detail: 'Installed Podman.' };
	}
	return {
		ok: false,
		exitCode: nsis.exitCode || quiet.exitCode,
		output,
		detail: classifyInstallFailure('Official installer', nsis.exitCode || quiet.exitCode, output),
	};
}

function runSetupCommand(
	command: string,
	args: readonly string[],
	timeoutMs: number,
	onOutput?: (chunk: string) => void,
): Promise<CommandResult> {
	assertSetupBin(command);
	return new Promise((resolve, reject) => {
		const child = spawn(command, [...args], {
			windowsHide: true,
			shell: false,
			env: { ...process.env, PATH: augmentedPath() },
		});
		let stdout = '';
		let stderr = '';
		let settled = false;
		const timer = setTimeout(() => {
			settled = true;
			child.kill('SIGKILL');
			resolve({ exitCode: 124, stdout, stderr, timedOut: true });
		}, timeoutMs);
		child.stdout.on('data', (chunk: Buffer | string) => {
			const text = chunk.toString();
			stdout += text;
			onOutput?.(text);
		});
		child.stderr.on('data', (chunk: Buffer | string) => {
			const text = chunk.toString();
			stderr += text;
			onOutput?.(text);
		});
		child.on('error', (error) => {
			if (settled) {
				return;
			}
			clearTimeout(timer);
			const err = error as NodeJS.ErrnoException;
			if (err.code === 'ENOENT') {
				resolve({
					exitCode: 127,
					stdout,
					stderr: `${stderr}\n${classifyUnexpected(error)}`.trim(),
					timedOut: false,
				});
				return;
			}
			if (err.code === 'EACCES' || err.code === 'EPERM') {
				resolve({
					exitCode: 1223,
					stdout,
					stderr: `${stderr}\nWindows asked for administrator permission and it was cancelled or denied.`.trim(),
					timedOut: false,
				});
				return;
			}
			reject(error);
		});
		child.on('close', (code) => {
			if (settled) {
				return;
			}
			clearTimeout(timer);
			resolve({ exitCode: code ?? 1, stdout, stderr, timedOut: false });
		});
	});
}

function assertSetupBin(bin: string): void {
	const cleaned = stripQuotes(bin);
	if (!cleaned || /[\n\r;|&$`<>]/.test(cleaned)) {
		throw new Error('Invalid setup program path.');
	}
	if (!isExistingFile(cleaned)) {
		throw new Error(`Setup program not found: ${cleaned}`);
	}
}

function whichWinget(): string | undefined {
	const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
	const extras = [path.join(localAppData, 'Microsoft', 'WindowsApps')];
	return whichExecutable(['winget.exe', 'winget'], extras);
}

function whichBrew(): string | undefined {
	for (const candidate of ['/opt/homebrew/bin/brew', '/usr/local/bin/brew']) {
		if (isExistingFile(candidate)) {
			return candidate;
		}
	}
	return whichExecutable(['brew'], ['/opt/homebrew/bin', '/usr/local/bin']);
}

function msiexecBin(): string | undefined {
	const systemRoot = process.env.SystemRoot || 'C:\\Windows';
	const candidate = path.join(systemRoot, 'System32', 'msiexec.exe');
	return isExistingFile(candidate) ? candidate : undefined;
}

function whichExecutable(names: string[], extraDirs: string[]): string | undefined {
	const sep = process.platform === 'win32' ? ';' : ':';
	const dirs = [...extraDirs, ...(process.env.PATH || '').split(sep)];
	const seen = new Set<string>();
	for (const dir of dirs) {
		if (!dir) {
			continue;
		}
		const key = process.platform === 'win32' ? dir.toLowerCase() : dir;
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		for (const name of names) {
			const full = path.join(dir, name);
			if (isExistingFile(full)) {
				return full;
			}
		}
	}
	return undefined;
}

async function resolveAfterInstall(preferred?: string): Promise<PodmanResolveResult> {
	for (let i = 0; i < 8; i++) {
		const resolved = resolvePodmanPath(preferred);
		if (resolved.path) {
			return resolved;
		}
		await sleep(750);
	}
	return resolvePodmanPath(preferred);
}

async function persistResolved(persistPath: (podmanPath: string) => Promise<void>, podmanPath: string): Promise<void> {
	try {
		await persistPath(podmanPath);
	} catch {
		// Keep going with the resolved path even if settings persist fails.
	}
}

function msiSucceeded(code: number): boolean {
	return code === 0 || code === 3010 || code === 1641;
}

export function isElevationFailure(exitCode: number, output: string): boolean {
	if (exitCode === 1602 || exitCode === 1223 || exitCode === 1625) {
		return true;
	}
	return /access is denied|elevation|administrator|uac|0x80070005|user cancelled|user canceled|was cancelled|was canceled|install request was cancelled|failed to launch as admin|requires elevation/i.test(output);
}

function classifyInstallFailure(kind: string, exitCode: number, output: string): string {
	if (isElevationFailure(exitCode, output)) {
		return 'Windows asked for administrator permission and it was cancelled or denied. Approve the prompt to finish setup.';
	}
	if (/no package found|no applicable installer|failed to find|unable to find/i.test(output)) {
		return `${kind}: package was not found.`;
	}
	if (exitCode === 124 || /timed out/i.test(output)) {
		return `${kind} timed out.`;
	}
	const clipped = output.trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(-5).join(' ');
	return clipped
		? `${kind} failed (exit ${exitCode}): ${clipped.slice(0, 360)}`
		: `${kind} failed (exit ${exitCode}).`;
}

function classifyMachineFailure(detail: string): string {
	const cleaned = stripMachineNotes(detail);
	if (isElevationFailure(1, cleaned)) {
		return 'Windows asked for administrator permission and it was cancelled or denied. Approve the prompt to finish setup.';
	}
	return classifyMachineOpFailure(cleaned || detail);
}

function lastProgressLine(chunk: string): string {
	if (isIgnorableMachineNote(chunk) && !lastActionableMachineLine(chunk)) {
		return '';
	}
	const cleaned = stripMachineNotes(chunk);
	const lines = cleaned.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 2);
	return lines.at(-1) || '';
}

function classifyUnexpected(error: unknown): string {
	const err = error as NodeJS.ErrnoException;
	if (err?.code === 'ENOENT') {
		return 'A setup program was not found. Hawaldar will try another install method if you click Set up again.';
	}
	if (err?.code === 'EACCES' || err?.code === 'EPERM') {
		return 'Windows asked for administrator permission and it was cancelled or denied. Approve the prompt to finish setup.';
	}
	return error instanceof Error ? error.message : String(error);
}

function joinOutput(result: CommandResult): string {
	return `${result.stdout}\n${result.stderr}`.trim();
}

function tailFile(filePath: string, maxChars = 800): string {
	try {
		const text = fs.readFileSync(filePath, 'utf8');
		return text.slice(-maxChars).trim();
	} catch {
		return '';
	}
}

function lastMeaningfulLine(chunk: string): string {
	const lines = chunk.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 2);
	return lines.at(-1) || '';
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
