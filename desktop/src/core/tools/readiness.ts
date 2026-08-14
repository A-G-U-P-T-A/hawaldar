import { imageExists } from '../sandbox/podman-control';
import { podmanRun, podmanVersion } from '../sandbox/podman';
import { classifySpawnError, engineBin, podmanInstallHint } from '../sandbox/podman-path';
import type { HawaldarSettings } from '../settings';
import { TOOL_CATALOG, type ToolSpec } from './catalog';
import type { CustomToolDef } from './custom';

export interface ReadinessCheck {
	id: string;
	label: string;
	ok: boolean;
	detail: string;
}

const PROBES: Record<string, { command: string; args: string[] }> = {
	nmap: { command: 'nmap', args: ['--version'] },
	tshark: { command: 'tshark', args: ['--version'] },
	ghidra: { command: 'analyzeHeadless', args: ['-help'] },
	radare: { command: 'r2', args: ['-v'] },
	binwalk: { command: 'binwalk', args: ['-h'] },
	subfinder: { command: 'subfinder', args: ['-version'] },
	dnsx: { command: 'dnsx', args: ['-version'] },
	httpx: { command: 'httpx', args: ['-version'] },
	naabu: { command: 'naabu', args: ['-version'] },
	katana: { command: 'katana', args: ['-version'] },
	nuclei: { command: 'nuclei', args: ['-version'] },
	amass: { command: 'amass', args: ['-version'] },
	ffuf: { command: 'ffuf', args: ['-V'] },
};

export async function checkToolReadiness(
	settings: HawaldarSettings,
	customTools: CustomToolDef[],
): Promise<ReadinessCheck[]> {
	const checks: ReadinessCheck[] = [];

	const engine = settings.containerEngine === 'docker' ? 'docker' : 'podman';
	const bin = engineBin(engine, settings.podmanPath);
	try {
		const version = await podmanVersion(bin);
		const ok = version.exitCode === 0 && !version.timedOut;
		checks.push({
			id: 'podman',
			label: engine === 'docker' ? 'Docker' : 'Podman',
			ok,
			detail: ok
				? `${version.stdout.trim() || version.stderr.trim()} · ${bin}`
				: (version.stderr.trim() || version.stdout.trim() || `exit ${version.exitCode}`),
		});
		if (!ok) {
			return checks;
		}
	} catch (error) {
		checks.push({
			id: 'podman',
			label: 'Podman',
			ok: false,
			detail: `${classifySpawnError(error)} ${podmanInstallHint()}`,
		});
		return checks;
	}

	const images = new Map<string, { agentId: string; image: string; probe?: { command: string; args: string[] } }>();
	for (const tool of TOOL_CATALOG) {
		const image = settings.toolImages[tool.agentId] || tool.image;
		if (!images.has(tool.agentId)) {
			images.set(tool.agentId, { agentId: tool.agentId, image, probe: PROBES[tool.agentId] });
		}
	}
	for (const tool of customTools) {
		const key = `custom:${tool.id}`;
		if (!images.has(tool.agentId) && !images.has(key)) {
			images.set(key, {
				agentId: tool.agentId,
				image: settings.toolImages[tool.agentId] || tool.image,
			});
		}
	}

	for (const [key, item] of images) {
		const exists = await imageExists(bin, item.image);
		if (!exists) {
			checks.push({
				id: key,
				label: key.startsWith('custom:') ? key.slice(7) : item.agentId,
				ok: false,
				detail: `Image missing: ${item.image}. Toggle the service on to build or pull it.`,
			});
			continue;
		}

		if (!item.probe) {
			checks.push({
				id: key,
				label: item.agentId,
				ok: true,
				detail: `Image present: ${item.image}`,
			});
			continue;
		}

		try {
			const result = await podmanRun({
				podmanPath: bin,
				image: item.image,
				command: item.probe.command,
				args: item.probe.args,
				timeoutMs: 45_000,
				network: 'none',
			});
			const text = (result.stdout || result.stderr).trim().split(/\r?\n/)[0] || `exit ${result.exitCode}`;
			// Many CLIs print version to stdout and exit 0; some --help exit 0/1/2 still means binary works.
			const ok = !result.timedOut && (result.exitCode === 0 || result.exitCode === 1 || result.exitCode === 2);
			checks.push({
				id: key,
				label: key.startsWith('custom:') ? key.slice(7) : item.agentId,
				ok,
				detail: ok ? text.slice(0, 180) : (result.stderr || result.stdout || `exit ${result.exitCode}`).slice(0, 180),
			});
		} catch (error) {
			checks.push({
				id: key,
				label: key.startsWith('custom:') ? key.slice(7) : item.agentId,
				ok: false,
				detail: error instanceof Error ? error.message : String(error),
			});
		}
	}

	return checks;
}

export function builtinToolSummaries(settings: HawaldarSettings): Array<ToolSpec & { imageResolved: string }> {
	return TOOL_CATALOG.map((tool) => ({
		...tool,
		enabled: settings.enabledTools.includes(tool.id),
		imageResolved: settings.toolImages[tool.agentId] || tool.image,
	}));
}
