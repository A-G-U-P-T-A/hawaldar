import assert from 'node:assert/strict';
import {
	adaptWorkflowSteps,
	engagementAgentPrompt,
	gateReportingNarrative,
	groupIndependentSteps,
	isEmptyPlaybookOutput,
	isMissingToolHallucination,
	playbookStepUrl,
	pocFallbackJob,
	sanitizePlaybookAgentOutput,
	stepLooksLikeExploit,
	thisRunFacts,
} from './engagement.ts';
import { skipReasonForTool } from './policy.ts';

const prompt = engagementAgentPrompt({
	workflowId: 'vuln-detect',
	agentId: 'vuln-xss',
	target: 'http://127.0.0.1:3000',
	prior: '## httpx\nOWASP Juice Shop title',
});
assert.match(prompt, /Playbook step: workflow vuln-detect, agent vuln-xss/);
assert.match(prompt, /http:\/\/127\.0\.0\.1:3000/);
assert.match(prompt, /runtime continues the next playbook phase/);
assert.match(prompt, /agent-research/);
assert.match(prompt, /do not rediscover/i);
assert.doesNotMatch(prompt, /call run_workflow/i);
assert.doesNotMatch(prompt, /MUST run the playbook/);

const blob = 'TOOL "research-search" NOT FOUND. AVAILABLE TOOLS: RUNTIME STATUS. use agent-research';
assert.equal(isMissingToolHallucination(blob), true);
assert.match(sanitizePlaybookAgentOutput(blob, 'vuln-xss'), /requested a tool it does not have/);
assert.equal(sanitizePlaybookAgentOutput('Semgrep found one XSS sink.', 'research'), 'Semgrep found one XSS sink.');

const recon = adaptWorkflowSteps('recon-surface', [
	{ kind: 'tool', id: 'dns-resolve' },
	{ kind: 'tool', id: 'scan-top-ports' },
	{ kind: 'tool', id: 'naabu' },
	{ kind: 'tool', id: 'httpx' },
	{ kind: 'tool', id: 'subfinder' },
	{ kind: 'tool', id: 'katana' },
	{ kind: 'tool', id: 'scrapling-fetch' },
	{ kind: 'tool', id: 'browser-open' },
], 'http://127.0.0.1:3000');
const ids = recon.map((step) => step.id);
assert.ok(ids.includes('httpx'), ids.join(','));
assert.ok(ids.includes('katana'), ids.join(','));
assert.ok(ids.includes('scrapling-fetch'), ids.join(','));
assert.ok(ids.includes('browser-open'), ids.join(','));
assert.ok(ids.includes('juice-shop-status'), ids.join(','));
assert.ok(!ids.includes('dns-resolve'), ids.join(','));
assert.ok(!ids.includes('subfinder'), ids.join(','));
assert.ok(!ids.includes('scan-top-ports'), ids.join(','));
assert.ok(!ids.includes('naabu'), ids.join(','));
assert.ok(!ids.includes('httpx-tech'), ids.join(','));

const batches = groupIndependentSteps(recon);
assert.equal(batches[0].map((step) => step.id).join(','), 'juice-shop-status');
const parallel = batches.slice(1).flat().map((step) => step.id);
assert.deepEqual(parallel.sort(), ['browser-open', 'httpx', 'katana', 'scrapling-fetch'].sort());

const pre = adaptWorkflowSteps('pre-recon', [
	{ kind: 'tool', id: 'semgrep-list' },
	{ kind: 'tool', id: 'semgrep-scan' },
	{ kind: 'tool', id: 'semgrep-owasp' },
	{ kind: 'agent', id: 'research' },
], 'http://127.0.0.1:3000');
assert.deepEqual(pre.map((step) => step.id), ['semgrep-list', 'semgrep-scan', 'semgrep-owasp']);

const poc = adaptWorkflowSteps('poc-validate', [
	{ kind: 'agent', id: 'poc-injection' },
	{ kind: 'agent', id: 'poc-xss' },
	{ kind: 'agent', id: 'poc-ssrf' },
	{ kind: 'agent', id: 'poc-auth' },
], 'http://127.0.0.1:3000');
const pocIds = poc.map((step) => step.id);
assert.equal(pocIds[0], 'sqlmap-scan', pocIds.join(','));
assert.equal(pocIds[1], 'zap-spider', pocIds.join(','));
assert.equal(pocIds[2], 'zap-ascan', pocIds.join(','));
assert.ok(pocIds.includes('poc-injection'), pocIds.join(','));
assert.equal(stepLooksLikeExploit('sqlmap-scan'), false);
assert.equal(stepLooksLikeExploit('msfvenom'), true);

const vuln = adaptWorkflowSteps('vuln-detect', [
	{ kind: 'agent', id: 'vuln-injection' },
	{ kind: 'agent', id: 'vuln-xss' },
], 'http://127.0.0.1:3000');
const vulnIds = vuln.map((step) => step.id);
assert.ok(vulnIds.includes('nuclei-tech'), vulnIds.join(','));
assert.ok(vulnIds.includes('nuclei-severity-info'), vulnIds.join(','));
assert.ok(!vulnIds.includes('httpx-tech'), vulnIds.join(','));
assert.ok(vulnIds.includes('vuln-injection'), vulnIds.join(','));

assert.match(playbookStepUrl('sqlmap-scan', 'http://127.0.0.1:3000') || '', /\/rest\/products\/search/);
assert.equal(playbookStepUrl('zap-ascan', 'http://127.0.0.1:3000'), 'http://127.0.0.1:3000');

const remotePoc = adaptWorkflowSteps('poc-validate', [
	{ kind: 'agent', id: 'poc-injection' },
], 'https://example.com');
assert.deepEqual(remotePoc.map((step) => step.id), ['poc-injection']);

const pocBatches = groupIndependentSteps(poc.filter((step) => step.kind === 'agent'));
assert.equal(pocBatches.length, 1);
assert.deepEqual(pocBatches[0].map((step) => step.id), ['poc-injection', 'poc-xss', 'poc-ssrf', 'poc-auth']);

assert.match(skipReasonForTool('scan-top-ports', 'host.containers.internal', ['http://127.0.0.1:3000']) || '', /loopback web/);
assert.match(skipReasonForTool('naabu', 'http://127.0.0.1:3000') || '', /loopback web/);

assert.equal(isEmptyPlaybookOutput('(empty)'), true);
assert.equal(pocFallbackJob('poc-injection', 'http://127.0.0.1:3000')?.url, 'http://127.0.0.1:3000/rest/user/login');

const prior = [
	'## juice-shop-status',
	'ready at http://127.0.0.1:3000',
	'## httpx',
	'http://127.0.0.1:3000 [200] [OWASP Juice Shop]',
	'## katana',
	'http://host.containers.internal:3000/#/',
	'## scrapling-fetch',
	'status 200',
	'## browser-open',
	'status 200 Juice Shop',
].join('\n');
const facts = thisRunFacts(prior);
assert.equal(facts.targetReady, true);
assert.equal(facts.httpxOk, true);
assert.equal(facts.katanaOk, true);
const gated = gateReportingNarrative(
	'CRITICAL BLOCKER: target unreachable. Missing katana. Playwright missing. nmap showed Windows SMB 135/139/445.',
	prior,
	'| Title | Class | Status | Target |',
	'report saved',
);
assert.match(gated, /omitted because it contradicted/);
assert.doesNotMatch(gated, /CRITICAL BLOCKER/);
assert.doesNotMatch(gated, /Windows SMB/);
assert.doesNotMatch(gated, /Playwright missing/);

console.log('engagement ok');
