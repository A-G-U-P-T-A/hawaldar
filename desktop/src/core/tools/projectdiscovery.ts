import { isIPv4 } from 'node:net';
import * as path from 'node:path';
import { evaluateScope } from '../policy';
import { podmanRun } from '../sandbox/podman';
import { imageFor, isToolEnabled, type HawaldarSettings } from '../settings';
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

export async function runPdTool(settings: HawaldarSettings, id: string, target: string) {
	if (!isToolEnabled(settings, id)) {
		return fail(`${id} is disabled.`);
	}
	const spec = TOOL_CATALOG.find((tool) => tool.id === id);
	if (!spec) {
		return fail(`Unknown tool: ${id}`);
	}

	if (DOMAIN_IDS.has(id)) {
		const decision = evaluateScope(settings.scope, target);
		if (!decision.allow) {
			return fail(decision.reason);
		}
		const args = domainArgs(id, target);
		if (!args) {
			return fail(`Unknown tool: ${id}`);
		}
		return run(settings, id, spec.agentId, spec.agentId, args);
	}

	let scoped: { host: string; url: string };
	try {
		scoped = scopedHost(settings.scope, target);
	} catch (error) {
		return fail(error instanceof Error ? error.message : String(error));
	}

	if (FFUF_IDS.has(id)) {
		return runFfuf(settings, id, scoped);
	}

	const argv = hostArgs(id, scoped);
	if (!argv) {
		return fail(`Unknown tool: ${id}`);
	}
	return run(settings, id, spec.agentId, spec.agentId, argv);
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

function hostArgs(id: string, scoped: { host: string; url: string }): string[] | undefined {
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
			return ['-host', scoped.host, '-top-ports', '100', '-scan-type', 'c', '-silent'];
		case 'naabu-top-ports':
			return ['-host', scoped.host, '-top-ports', '1000', '-scan-type', 'c', '-silent'];
		case 'katana':
			return ['-u', scoped.url, '-d', '2', '-silent', '-jc'];
		case 'katana-depth':
			return ['-u', scoped.url, '-d', '3', '-fs', 'fqdn', '-silent'];
		case 'katana-js':
			return ['-u', scoped.url, '-d', '1', '-fs', 'fqdn', '-silent', '-jc'];
		case 'nuclei':
			return ['-u', scoped.url, '-tags', 'tech,dns,discovery', '-severity', 'info', '-silent'];
		case 'nuclei-tech':
			return ['-u', scoped.url, '-tags', 'tech', '-severity', 'info', '-silent'];
		case 'nuclei-severity-info':
			return [
				'-u', scoped.url,
				'-tags', 'tech,misconfig,discovery',
				'-severity', 'info,low',
				'-etags', 'cve,exploit,rce,sqli,lfi,ssrf,intrusive',
				'-silent',
			];
		default:
			return undefined;
	}
}

function runFfuf(settings: HawaldarSettings, id: string, scoped: { host: string; url: string }) {
	const wordlist = path.join(settings.extensionPath, 'media', 'wordlists', 'common-dirs.txt');
	const mounts = [{ source: wordlist, target: '/wordlist.txt', readonly: true }];
	const hostHeader = isIPv4(scoped.host) ? 'Host: FUZZ' : `Host: FUZZ.${scoped.host}`;
	const args =
		id === 'ffuf_vhost' ? ['-u', scoped.url, '-H', hostHeader, '-w', '/wordlist.txt', ...FFUF_MATCH]
			: id === 'ffuf_extensions' ? ['-u', `${scoped.url}/FUZZ`, '-w', '/wordlist.txt', '-e', '.html,.js,.json,.txt,.xml', ...FFUF_MATCH]
				: ['-u', `${scoped.url}/FUZZ`, '-w', '/wordlist.txt', ...FFUF_MATCH];
	return run(settings, id, 'ffuf', 'ffuf', args, mounts);
}

async function run(
	settings: HawaldarSettings,
	id: string,
	agent: string,
	command: string,
	args: string[],
	mounts?: Array<{ source: string; target: string; readonly: boolean }>,
) {
	const result = await podmanRun({
		podmanPath: settings.podmanPath,
		image: imageFor(settings, agent),
		command,
		args,
		timeoutMs: TOOL_CATALOG.find((tool) => tool.id === id)?.timeoutMs ?? 180_000,
		network: 'target',
		mounts,
	});
	return {
		ok: result.exitCode === 0 && !result.timedOut,
		stdout: result.stdout.slice(0, 20_000),
		stderr: result.stderr.slice(0, 4_000),
		exitCode: result.exitCode,
		timedOut: result.timedOut,
		source: BUILTIN_SOURCE,
	};
}

function fail(stderr: string) {
	return { ok: false, stdout: '', stderr, exitCode: 1 };
}
