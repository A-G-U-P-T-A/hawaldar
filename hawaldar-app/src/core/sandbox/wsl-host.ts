/**
 * Windows WSL helpers for user-clicked Podman setup only.
 * Never exposed to the model.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isExistingFile } from './podman-path';
import type { CommandOutputHandler } from './runner';

const CGROUP_V2_FLAG = 'cgroup_no_v1=all';
const NAME_RE = /^[a-zA-Z0-9._-]+$/;

export function wslBin(): string | undefined {
	const root = process.env.SystemRoot || 'C:\\Windows';
	const candidate = path.join(root, 'System32', 'wsl.exe');
	return isExistingFile(candidate) ? candidate : undefined;
}

export function wslConfigPath(): string {
	return path.join(os.homedir(), '.wslconfig');
}

/** True when .wslconfig already asks WSL for cgroup v2. */
export function wslConfigHasCgroupV2(text: string): boolean {
	return /cgroup_no_v1\s*=\s*all/i.test(text);
}

export function mergeWslCgroupV2(existing: string): string {
	if (wslConfigHasCgroupV2(existing)) {
		return existing;
	}
	const trimmed = existing.replace(/\s+$/, '');
	if (!trimmed) {
		return `[wsl2]\nkernelCommandLine=${CGROUP_V2_FLAG}\n`;
	}
	const wsl2 = trimmed.match(/^\[wsl2\][^\[]*/im);
	if (!wsl2) {
		return `${trimmed}\n\n[wsl2]\nkernelCommandLine=${CGROUP_V2_FLAG}\n`;
	}
	const block = wsl2[0];
	const cmdline = block.match(/^\s*kernelCommandLine\s*=\s*(.*)$/im);
	let nextBlock: string;
	if (cmdline) {
		const value = cmdline[1].trim();
		const merged = value ? `${value} ${CGROUP_V2_FLAG}` : CGROUP_V2_FLAG;
		nextBlock = block.replace(cmdline[0], `kernelCommandLine=${merged}`);
	} else {
		nextBlock = `${block.replace(/\s+$/, '')}\nkernelCommandLine=${CGROUP_V2_FLAG}\n`;
	}
	return trimmed.replace(block, nextBlock) + (trimmed.endsWith('\n') ? '' : '\n');
}

/**
 * Podman 6 + Fedora machine-os need cgroup v2. WSL 2.2.x defaults to v1, which
 * makes `unshare` systemd exit 255 and `podman` say "Cgroups v1 not supported".
 * Only called from user-clicked setup. Shuts WSL down if the file changes.
 */
export async function ensureWindowsCgroupV2(
	onOutput?: CommandOutputHandler,
): Promise<{ changed: boolean; detail: string }> {
	if (process.platform !== 'win32') {
		return { changed: false, detail: '' };
	}
	const file = wslConfigPath();
	let current = '';
	try {
		current = fs.readFileSync(file, 'utf8');
	} catch {
		current = '';
	}
	const next = mergeWslCgroupV2(current);
	if (next === current || (current && wslConfigHasCgroupV2(current))) {
		return { changed: false, detail: '' };
	}
	fs.writeFileSync(file, next.endsWith('\n') ? next : `${next}\n`, 'utf8');
	onOutput?.('Enabling cgroup v2 for WSL (required by the Linux VM)…', 'stdout');
	const shutdown = await runWsl(['--shutdown'], 60_000);
	return {
		changed: true,
		detail: shutdown.ok
			? 'WSL cgroup v2 enabled.'
			: `Wrote .wslconfig but wsl --shutdown failed: ${shutdown.detail}`,
	};
}

export async function terminateWslDistro(name: string): Promise<void> {
	if (process.platform !== 'win32' || !NAME_RE.test(name)) {
		return;
	}
	await runWsl(['--terminate', name], 30_000);
}

async function runWsl(
	args: string[],
	timeoutMs: number,
): Promise<{ ok: boolean; detail: string }> {
	const bin = wslBin();
	if (!bin) {
		return { ok: false, detail: 'wsl.exe was not found.' };
	}
	return new Promise((resolve) => {
		const child = spawn(bin, args, {
			windowsHide: true,
			shell: false,
		});
		let stdout = '';
		let stderr = '';
		let settled = false;
		const timer = setTimeout(() => {
			settled = true;
			child.kill('SIGKILL');
			resolve({ ok: false, detail: 'wsl timed out.' });
		}, timeoutMs);
		child.stdout.on('data', (chunk: Buffer | string) => {
			stdout += chunk.toString();
		});
		child.stderr.on('data', (chunk: Buffer | string) => {
			stderr += chunk.toString();
		});
		child.on('error', (error) => {
			if (settled) {
				return;
			}
			clearTimeout(timer);
			resolve({ ok: false, detail: error instanceof Error ? error.message : String(error) });
		});
		child.on('close', (code) => {
			if (settled) {
				return;
			}
			clearTimeout(timer);
			const detail = (stdout || stderr).trim() || `exit ${code ?? 1}`;
			resolve({ ok: code === 0, detail });
		});
	});
}
