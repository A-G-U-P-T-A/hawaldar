import { imageExists } from '../sandbox/podman-control';
import { podmanRun, podmanVersion } from '../sandbox/podman';
import { classifySpawnError, engineBin, podmanInstallHint } from '../sandbox/podman-path';
import type { HawaldarSettings } from '../settings';
import {
	isServiceControlTool,
	resolveCatalogServiceImage,
	serviceLane,
	SERVICE_LANE_META,
	SERVICE_LANE_ORDER,
	TOOL_CATALOG,
	type ServiceLane,
	type ToolSpec,
} from './catalog';
import type { CustomToolDef } from './custom';

export interface ReadinessCheck {
	id: string;
	label: string;
	ok: boolean;
	detail: string;
	group: ServiceLane | 'engine';
	groupLabel: string;
	groupHint: string;
	webLab: boolean;
}

const ENGINE_GROUP = {
	group: 'engine' as const,
	groupLabel: 'Engine',
	groupHint: 'Podman or Docker must be ready before any tool image can run.',
	webLab: true,
};

const PD_BINS = new Set(['subfinder', 'dnsx', 'httpx', 'naabu', 'katana', 'nuclei', 'amass', 'ffuf']);

const PROBES: Record<string, { command: string; args: string[] }> = {
	nmap: { command: 'nmap', args: ['--version'] },
	tshark: { command: 'tshark', args: ['--version'] },
	ghidra: { command: 'analyzeHeadless', args: ['-help'] },
	radare: { command: 'r2', args: ['-v'] },
	binwalk: { command: 'binwalk', args: ['-h'] },
	subfinder: { command: 'subfinder', args: ['-version'] },
	dnsx: { command: 'dnsx', args: ['-version'] },
	dns: { command: 'dig', args: ['-v'] },
	httpx: { command: 'httpx', args: ['-version'] },
	naabu: { command: 'naabu', args: ['-version'] },
	katana: { command: 'katana', args: ['-version'] },
	nuclei: { command: 'nuclei', args: ['-version'] },
	amass: { command: 'amass', args: ['-version'] },
	ffuf: { command: 'ffuf', args: ['-V'] },
	browser: { command: 'node', args: ['--version'] },
	research: { command: 'node', args: ['--version'] },
	scrapling: { command: 'python', args: ['--version'] },
	semgrep: { command: 'semgrep', args: ['--version'] },
	sqlmap: { command: 'sqlmap', args: ['--version'] },
};

const CRASH_RE = /Traceback \(most recent call last\)|^\s*panic:|fatal error:|ModuleNotFoundError|ImportError:|Segmentation fault/im;
const HELP_RE = /\b(usage|options|commands)\s*:/i;

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
			...ENGINE_GROUP,
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
			...ENGINE_GROUP,
		});
		return checks;
	}

	const images = new Map<string, { agentId: string; image: string; probe?: { command: string; args: string[] } }>();
	for (const tool of TOOL_CATALOG) {
		if (isServiceControlTool(tool.id) || !tool.image) {
			continue;
		}
		const image = resolveCatalogServiceImage(tool.agentId, settings.toolImages[tool.agentId], tool.image);
		if (!images.has(tool.agentId)) {
			images.set(tool.agentId, { agentId: tool.agentId, image, probe: PROBES[tool.agentId] });
		}
	}
	for (const tool of customTools) {
		const key = `custom:${tool.id}`;
		if (!images.has(tool.agentId) && !images.has(key)) {
			images.set(key, {
				agentId: tool.agentId,
				image: resolveCatalogServiceImage(tool.agentId, settings.toolImages[tool.agentId], tool.image),
			});
		}
	}

	for (const [key, item] of images) {
		const label = key.startsWith('custom:') ? key.slice(7) : item.agentId;
		const group = annotateGroup(item.agentId);
		const exists = await imageExists(bin, item.image);
		if (!exists) {
			checks.push({
				id: key,
				label,
				ok: false,
				detail: missingImageDetail(item.agentId, item.image, group.group === 'engine' ? 'other' : group.group),
				...group,
			});
			continue;
		}

		if (!item.probe) {
			checks.push({
				id: key,
				label,
				ok: true,
				detail: `Image present: ${item.image}`,
				...group,
			});
			continue;
		}

		try {
			const result = await podmanRun({
				podmanPath: bin,
				image: item.image,
				entrypoint: PD_BINS.has(item.probe.command) ? `/usr/local/bin/${item.probe.command}` : item.probe.command,
				args: item.probe.args,
				timeoutMs: 45_000,
				network: 'none',
			});
			const judged = judgeProbe(result.stdout, result.stderr, result.exitCode, result.timedOut);
			checks.push({
				id: key,
				label,
				ok: judged.ok,
				detail: judged.detail,
				...group,
			});
		} catch (error) {
			checks.push({
				id: key,
				label,
				ok: false,
				detail: error instanceof Error ? error.message : String(error),
				...group,
			});
		}
	}

	return checks;
}

export function formatReadinessMarkdown(checks: ReadinessCheck[]): string {
	if (checks.length === 0) {
		return 'No readiness checks.';
	}
	const order = ['engine', ...SERVICE_LANE_ORDER] as Array<ServiceLane | 'engine'>;
	const lines: string[] = [];
	for (const group of order) {
		const rows = checks.filter((item) => item.group === group);
		if (rows.length === 0) {
			continue;
		}
		const meta = rows[0];
		const suffix = meta.group === 'engine' || meta.webLab
			? ''
			: meta.group === 'web-optional'
				? ' — optional for Juice Shop'
				: ' — not required for a localhost web lab';
		lines.push(`### ${meta.groupLabel}${suffix}`);
		if (meta.groupHint) {
			lines.push(`_${meta.groupHint}_`);
		}
		for (const item of rows) {
			lines.push(`- ${item.ok ? '✓' : '✗'} **${item.label}** — ${item.detail}`);
		}
		lines.push('');
	}
	return lines.join('\n').trim();
}

export function builtinToolSummaries(settings: HawaldarSettings): Array<ToolSpec & { imageResolved: string }> {
	return TOOL_CATALOG.map((tool) => ({
		...tool,
		enabled: settings.enabledTools.includes(tool.id),
		imageResolved: resolveCatalogServiceImage(tool.agentId, settings.toolImages[tool.agentId], tool.image),
	}));
}

function annotateGroup(agentId: string): Pick<ReadinessCheck, 'group' | 'groupLabel' | 'groupHint' | 'webLab'> {
	const lane = serviceLane(agentId);
	const meta = SERVICE_LANE_META[lane];
	return {
		group: lane,
		groupLabel: meta.label,
		groupHint: meta.hint,
		webLab: meta.webLab,
	};
}

function missingImageDetail(agentId: string, image: string, lane: ServiceLane): string {
	if (lane === 'web-lab') {
		return `Image missing: ${image}. Toggle ${agentId} on in Runtime → Tool services to build or pull it (needed for Juice Shop).`;
	}
	if (lane === 'web-optional') {
		return `Image missing: ${image}. Optional for Juice Shop. Toggle ${agentId} on in Runtime → Tool services to build it.`;
	}
	return `Image missing: ${image}. Not required for a localhost web lab — leave ${agentId} off.`;
}

/** Exported for the version/crash heuristics (katana JSON, semgrep traceback). */
export function judgeProbe(
	stdout: string,
	stderr: string,
	exitCode: number,
	timedOut?: boolean,
): { ok: boolean; detail: string } {
	const full = `${stdout}\n${stderr}`.trim();
	if (timedOut) {
		return { ok: false, detail: 'Version probe timed out.' };
	}
	if (looksLikeCrash(full)) {
		return { ok: false, detail: summarizeCrash(full) };
	}
	const exitOk = exitCode === 0 || exitCode === 1 || exitCode === 2;
	if (!exitOk) {
		return { ok: false, detail: (stderr || stdout || `exit ${exitCode}`).trim().slice(0, 180) };
	}
	const version = extractVersionLabel(full);
	if (version) {
		return { ok: true, detail: version.slice(0, 180) };
	}
	if (HELP_RE.test(full) || /analyzeHeadless/i.test(full)) {
		return { ok: true, detail: firstUsefulLine(full).slice(0, 180) };
	}
	const preview = firstUsefulLine(full);
	if (!preview || preview === '{' || preview === '[' || preview === '}' || preview === ']') {
		return { ok: false, detail: 'Version probe did not return a version string. Rebuild the image from Runtime → Tool services.' };
	}
	return { ok: false, detail: `Version probe output was not a version: ${preview.slice(0, 160)}` };
}

function looksLikeCrash(text: string): boolean {
	return CRASH_RE.test(text);
}

function summarizeCrash(text: string): string {
	const errLine = text.split(/\r?\n/).map((line) => line.trim()).find((line) => (
		/^(?:[A-Za-z_]?[A-Za-z]+(?:Error|Exception)|Error|Exception|panic):/.test(line)
	));
	if (errLine) {
		return `Probe crashed: ${errLine.slice(0, 160)}`;
	}
	if (/Traceback \(most recent call last\)/i.test(text)) {
		return 'Probe crashed (Python traceback). Rebuild the image from Runtime → Tool services.';
	}
	return `Probe crashed: ${firstUsefulLine(text).slice(0, 160)}`;
}

function extractVersionLabel(text: string): string | null {
	const trimmed = text.trim();
	if (!trimmed) {
		return null;
	}
	const jsonVersion = versionFromJson(trimmed);
	if (jsonVersion) {
		return jsonVersion;
	}
	for (const line of trimmed.split(/\r?\n/)) {
		const value = line.trim();
		if (!value || value === '{' || value === '[' || value === '}' || value === ']') {
			continue;
		}
		if (/traceback|error|exception|panic/i.test(value) && !/version/i.test(value)) {
			continue;
		}
		const banner = value.match(/current\s+version[:\s]+(v?\d[\w.+-]*)/i);
		if (banner) {
			return value.length <= 80 ? value : `v${banner[1]}`.replace(/^vv/, 'v');
		}
		if (/\d+\.\d+/.test(value) && value.length <= 120 && !value.startsWith('{') && !/traceback|exception|error:/i.test(value)) {
			return value;
		}
	}
	const embedded = trimmed.match(/"version"\s*:\s*"([^"]+)"/i);
	if (embedded) {
		return embedded[1];
	}
	return null;
}

function versionFromJson(text: string): string | null {
	const start = text.search(/[{\[]/);
	if (start < 0) {
		return null;
	}
	const slice = text.slice(start).trim();
	if (!slice.startsWith('{') && !slice.startsWith('[')) {
		return null;
	}
	try {
		const parsed = JSON.parse(slice) as unknown;
		const found = findVersionField(parsed);
		return found ? String(found) : null;
	} catch {
		const inner = slice.match(/"version"\s*:\s*"([^"]+)"/i);
		return inner ? inner[1] : null;
	}
}

function findVersionField(value: unknown, depth = 0): string | null {
	if (depth > 4 || value == null) {
		return null;
	}
	if (typeof value === 'string') {
		return /v?\d+\.\d+/.test(value) ? value : null;
	}
	if (Array.isArray(value)) {
		for (const item of value) {
			const found = findVersionField(item, depth + 1);
			if (found) {
				return found;
			}
		}
		return null;
	}
	if (typeof value !== 'object') {
		return null;
	}
	const rec = value as Record<string, unknown>;
	for (const key of ['version', 'Version', 'currentVersion', 'CurrentVersion']) {
		if (typeof rec[key] === 'string' && rec[key]) {
			return rec[key] as string;
		}
	}
	for (const nested of Object.values(rec)) {
		const found = findVersionField(nested, depth + 1);
		if (found) {
			return found;
		}
	}
	return null;
}

function firstUsefulLine(text: string): string {
	for (const line of text.split(/\r?\n/)) {
		const value = line.trim();
		if (!value || value === '{' || value === '[' || value === '}' || value === ']') {
			continue;
		}
		if (/^Traceback \(most recent call last\)/i.test(value)) {
			continue;
		}
		return value;
	}
	return text.trim().split(/\r?\n/)[0] || '';
}
