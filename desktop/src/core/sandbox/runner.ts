import { spawn } from 'node:child_process';
import { looksLikeDockerBin } from './host-info';
import { assertPodmanBin, augmentedPath, podmanBin, stripQuotes } from './podman-path';

export interface CommandResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	timedOut: boolean;
}

export type CommandOutputHandler = (chunk: string, stream: 'stdout' | 'stderr') => void;

/**
 * Only this module may spawn a process for tool work, and only for the container engine CLI
 * (Podman or Docker). Never uses a host shell. Docker paths are spawned as-is; Podman names
 * resolve through podmanBin when PATH is incomplete. In-app setup uses a separate provisioner.
 */
export function runCommand(
	command: string,
	args: readonly string[],
	timeoutMs: number,
	onOutput?: CommandOutputHandler,
): Promise<CommandResult> {
	const cleaned = stripQuotes(command);
	assertPodmanBin(cleaned);
	const bin = looksLikeDockerBin(cleaned) ? cleaned : podmanBin(cleaned);
	return new Promise((resolve, reject) => {
		const child = spawn(bin, [...args], {
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
			onOutput?.(text, 'stdout');
		});
		child.stderr.on('data', (chunk: Buffer | string) => {
			const text = chunk.toString();
			stderr += text;
			onOutput?.(text, 'stderr');
		});
		child.on('error', (error) => {
			if (settled) {
				return;
			}
			clearTimeout(timer);
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
