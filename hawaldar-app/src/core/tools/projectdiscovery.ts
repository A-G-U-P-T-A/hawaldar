import { isIPv4 } from 'node:net';
import * as path from 'node:path';
import { classifyTarget, evaluateScope, impliedConnectScanTargets, isLocalMachineTarget, MISSING_TARGET_REASON, skipReasonForTool } from '../policy';
import { looksLikeDockerBin } from '../sandbox/host-info';
import { podmanRun } from '../sandbox/podman';
import { imageFor, isToolEnabled, type HawaldarSettings } from '../settings';
import { rewriteLoopbackUrl } from './browser';
import { BUILTIN_SOURCE, TOOL_CATALOG } from './catalog';
import { scopedHost } from './http';

const DOMAIN_IDS = new Set([
	'subfinder',
	'subfinder-silent',
	'subfinder-sources',
	'amass',
	'amass-passive',
]);

const FFUF_IDS = new Set(['ffuf_dir', 'ffuf_vhost', 'ffuf_extensions']);

const FFUF_MATCH = ['-mc', '200,204,301,302,307,401,403', '-t', '10', '-timeout', '5'];

export async function runPdTool(
	settings: HawaldarSettings,
	id: string,
	target: string,
	impliedTargets: readonly string[] = [],
) {
	if (!isToolEnabled(settings, id)) {
		return fail(`${id} is disabled.`);
	}
	const spec = TOOL_CATALOG.find((tool) => tool.id === id);
	if (!spec) {
		return fail(`Unknown tool: ${id}`);
	}

	const raw = target.trim();
	if (!raw) {
		const hosts = impliedConnectScanTargets(impliedTargets, settings.scope);
		const list = DOMAIN_IDS.has(id)
			? hosts.filter((item) => classifyTarget(item) === 'domain')
			: hosts;
		if (list.length === 0) {
			return fail(DOMAIN_IDS.has(id)
				? 'No domain. Name a domain, or add one in Settings → Scope.'
				: MISSING_TARGET_REASON);
		}
		if (list.length === 1) {
			return runPdOnce(settings, id, list[0]);
		}
		const rows = [];
		for (const item of list) {
			rows.push({ ...await runPdOnce(settings, id, item), target: item });
		}
		const ok = rows.every((row) => row.ok);
		return {
			ok,
			stdout: rows.map((row) => `## ${row.target}\n${row.stdout || row.stderr}`).join('\n\n').slice(0, 20_000),
			stderr: rows.filter((row) => !row.ok).map((row) => `${row.target}: ${row.stderr}`).join('\n').slice(0, 4_000),
			exitCode: ok ? 0 : 1,
		};
	}

	return runPdOnce(settings, id, raw);
}

async function runPdOnce(settings: HawaldarSettings, id: string, target: string) {
	const spec = TOOL_CATALOG.find((tool) => tool.id === id);
	if (!spec) {
		return fail(`Unknown tool: ${id}`);
	}
	const skip = skipReasonForTool(id, target);
	if (skip) {
		return { ok: true, stdout: skip, stderr: '', exitCode: 0, source: BUILTIN_SOURCE, tool: id, target };
	}
	if (DOMAIN_IDS.has(id)) {
		if (isLocalMachineTarget(target)) {
			const reason = skipReasonForTool('subfinder', target) || `Skipped: ${target} is loopback — no public DNS or subdomains.`;
			return { ok: true, stdout: reason, stderr: '', exitCode: 0, source: BUILTIN_SOURCE, tool: id, target };
		}
		const decision = evaluateScope(settings.scope, target);
		if (!decision.allow) {
			return fail(decision.reason);
		}
		const args = domainArgs(id, target);
		if (!args) {
			return fail(`Unknown tool: ${id}`);
		}
		return run(settings, id, spec.agentId, spec.agentId, args, undefined, false);
	}

	let scoped: { host: string; url: string; port?: number };
	try {
		scoped = scopedHost(settings.scope, target);
	} catch (error) {
		return fail(error instanceof Error ? error.message : String(error));
	}

	const docker = looksLikeDockerBin(settings.podmanPath);
	const rewritten = rewriteLoopbackUrl(scoped.url, docker);
	const scanUrl = rewritten.href;
	const scanHost = rewritten.reachHostLoopback ? new URL(rewritten.href).hostname : scoped.host;

	if (FFUF_IDS.has(id)) {
		return runFfuf(settings, id, { host: scanHost, url: scanUrl }, rewritten.reachHostLoopback);
	}

	const argv = hostArgs(id, { host: scanHost, url: scanUrl, port: scoped.port });
	if (!argv) {
		return fail(`Unknown tool: ${id}`);
	}
	return run(settings, id, spec.agentId, spec.agentId, argv, undefined, rewritten.reachHostLoopback);
}

function domainArgs(id: string, target: string): string[] | undefined {
	switch (id) {
		case 'subfinder':
			return ['-d', target, '-silent'];
		case 'subfinder-silent':
			return ['-d', target, '-silent', '-nc'];
		case 'subfinder-sources':
			return ['-d', target, '-all', '-silent'];
		case 'amass':
		case 'amass-passive':
			return ['enum', '-passive', '-d', target, '-silent'];
		default:
			return undefined;
	}
}

function hostArgs(id: string, scoped: { host: string; url: string; port?: number }): string[] | undefined {
	switch (id) {
		case 'dnsx':
			return ['-a', '-aaaa', '-cname', '-resp', '-silent', '-d', scoped.host];
		case 'dnsx-a':
			return ['-a', '-resp', '-silent', '-d', scoped.host];
		case 'dnsx-cname':
			return ['-cname', '-resp', '-silent', '-d', scoped.host];
		case 'httpx':
			return ['-u', scoped.url, '-silent', '-status-code', '-title', '-tech-detect'];
		case 'httpx-title':
			return ['-u', scoped.url, '-silent', '-status-code', '-title'];
		case 'httpx-tech':
			return ['-u', scoped.url, '-silent', '-status-code', '-tech-detect'];
		case 'naabu':
			return scoped.port
				? ['-host', scoped.host, '-p', String(scoped.port), '-scan-type', 'c', '-silent']
				: ['-host', scoped.host, '-top-ports', '100', '-scan-type', 'c', '-silent'];
		case 'naabu-top-ports':
			return scoped.port
				? ['-host', scoped.host, '-p', String(scoped.port), '-scan-type', 'c', '-silent']
				: ['-host', scoped.host, '-top-ports', '1000', '-scan-type', 'c', '-silent'];
		case 'katana':
			return ['-u', scoped.url, '-d', '3', '-c', '20', '-jc', '-kf', 'all', '-fs', 'fqdn', '-silent'];
		case 'katana-depth':
			return ['-u', scoped.url, '-d', '4', '-c', '20', '-jc', '-kf', 'all', '-fs', 'fqdn', '-silent'];
		case 'katana-js':
			return ['-u', scoped.url, '-d', '2', '-c', '20', '-jc', '-kf', 'all', '-fs', 'fqdn', '-silent'];
		case 'nuclei':
			// -duc: templates are baked into the image; per-run update checks hit
			// codeload.github.com, which is unreachable from pasta-run containers
			// on WSL2 and only stalls the scan.
			return ['-u', scoped.url, '-tags', 'tech,dns,discovery', '-severity', 'info', '-silent', '-duc'];
		case 'nuclei-tech':
			return ['-u', scoped.url, '-tags', 'tech', '-severity', 'info', '-silent', '-duc'];
		case 'nuclei-severity-info':
			return [
				'-u', scoped.url,
				'-tags', 'tech,misconfig,discovery',
				'-severity', 'info,low',
				'-etags', 'cve,exploit,rce,sqli,lfi,ssrf,intrusive',
				'-silent',
				'-duc',
			];
		default:
			return undefined;
	}
}

function runFfuf(settings: HawaldarSettings, id: string, scoped: { host: string; url: string }, reachHostLoopback = false) {
	const wordlist = path.join(settings.extensionPath, 'media', 'wordlists', 'common-dirs.txt');
	const mounts = [{ source: wordlist, target: '/wordlist.txt', readonly: true }];
	const hostHeader = isIPv4(scoped.host) ? 'Host: FUZZ' : `Host: FUZZ.${scoped.host}`;
	const args =
		id === 'ffuf_vhost' ? ['-u', scoped.url, '-H', hostHeader, '-w', '/wordlist.txt', ...FFUF_MATCH]
			: id === 'ffuf_extensions' ? ['-u', `${scoped.url}/FUZZ`, '-w', '/wordlist.txt', '-e', '.html,.js,.json,.txt,.xml', ...FFUF_MATCH]
				: ['-u', `${scoped.url}/FUZZ`, '-w', '/wordlist.txt', ...FFUF_MATCH];
	return run(settings, id, 'ffuf', 'ffuf', args, mounts, reachHostLoopback);
}

async function run(
	settings: HawaldarSettings,
	id: string,
	agent: string,
	command: string,
	args: string[],
	mounts?: Array<{ source: string; target: string; readonly: boolean }>,
	reachHostLoopback = false,
) {
	const result = await podmanRun({
		podmanPath: settings.podmanPath,
		image: imageFor(settings, agent),
		entrypoint: pdBin(command),
		args,
		timeoutMs: TOOL_CATALOG.find((tool) => tool.id === id)?.timeoutMs ?? 180_000,
		network: 'target',
		reachHostLoopback,
		mounts,
	});
	let stdout = result.stdout.slice(0, 20_000);
	if (id === 'katana' || id === 'katana-depth' || id === 'katana-js') {
		stdout = dedupeKatanaUrls(result.stdout).slice(0, 20_000);
	}
	return {
		ok: result.exitCode === 0 && !result.timedOut,
		stdout,
		stderr: result.stderr.slice(0, 4_000),
		exitCode: result.exitCode,
		timedOut: result.timedOut,
		source: BUILTIN_SOURCE,
	};
}

function dedupeKatanaUrls(stdout: string): string {
	const seen = new Set<string>();
	const lines: string[] = [];
	for (const line of stdout.split(/\r?\n/)) {
		const key = line.trim();
		if (!key) {
			continue;
		}
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		lines.push(line);
	}
	return lines.join('\n');
}

function pdBin(command: string): string {
	return `/usr/local/bin/${command}`;
}

function fail(stderr: string) {
	return { ok: false, stdout: '', stderr, exitCode: 1 };
}
