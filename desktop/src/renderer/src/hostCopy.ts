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
		return 'Hawaldar locates Podman already on this system. It will not install packages with sudo.';
	}
	if (host.os === 'macos') {
		return 'Hawaldar will install Podman and start the VM.';
	}
	return 'Hawaldar will install Podman and start the VM. A permission prompt is normal.';
}

export function dockerIsAvailable(alternatives: EngineAlternativeDTO[] | undefined): boolean {
	return (alternatives || []).some((item) => item.engine === 'docker' && item.available && Boolean(item.path));
}
