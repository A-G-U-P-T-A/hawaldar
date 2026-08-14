/** Hawaldar minimal container images. Built on demand when a Podman service is toggled on.
 * Tags: localhost/hawaldar/<service>:min
 */

export const MIN_IMAGE_PREFIX = 'localhost/hawaldar/';
export const MIN_IMAGE_TAG = 'min';

export function minImageFor(serviceId: string): string {
	return `${MIN_IMAGE_PREFIX}${serviceId}:${MIN_IMAGE_TAG}`;
}

/** Services that ship a custom minimal Containerfile under resources/containers/<id>/. */
export const BUILTIN_MIN_SERVICES = [
	'nmap',
	'tshark',
	'ghidra',
	'radare',
	'binwalk',
	'subfinder',
	'dnsx',
	'httpx',
	'naabu',
	'katana',
	'nuclei',
	'amass',
	'ffuf',
] as const;

export function hasMinContainerfile(serviceId: string): boolean {
	return (BUILTIN_MIN_SERVICES as readonly string[]).includes(serviceId);
}

export function containerContextRel(serviceId: string): string {
	return `containers/${serviceId}`;
}
