import type { EngineAlternativeDTO, HostInfoDTO } from '../../preload/api';

export const WORKSPACE_DISPLAY_FALLBACK = '~/.hawaldar/workspace';

export function hostCardLine(host: HostInfoDTO): string {
	const specs = `${host.osLabel} · ${host.arch} · ${host.cpus} CPUs · ${host.memoryGiB} GB`;
	if (host.os === 'linux') {
		return `${specs} · native`;
	}
	return host.needsLinuxVm ? `${specs} · needs a Linux VM` : specs;
}

export function setupCtaDetail(host: HostInfoDTO, dockerMissing = false): string {
	if (dockerMissing) {
		return 'Hawaldar does not install Docker. Set up Podman, or browse to an existing Docker CLI.';
	}
	if (host.os === 'linux') {
		return 'Hawaldar requires Podman (or Docker if you already have it). Tools do not run without a container engine. The app locates Podman on this system — it will not install packages with sudo.';
	}
	if (host.os === 'macos') {
		return 'Hawaldar requires Podman. Without it, tools do not run. Use Set up Podman in the app — that installs Podman and starts the VM.';
	}
	return 'Hawaldar requires Podman. Without it, tools do not run. Use Set up Podman (winget or MSI). Windows needs WSL or Hyper-V. A permission prompt is normal.';
}

export function dockerIsAvailable(alternatives: EngineAlternativeDTO[] | undefined): boolean {
	return (alternatives || []).some((item) => item.engine === 'docker' && item.available && Boolean(item.path));
}
