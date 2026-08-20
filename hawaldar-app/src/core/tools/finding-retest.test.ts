import assert from 'node:assert/strict';
import { USER_DECLINED } from '../hitl-gate.ts';
import type { FindingRecord } from '../findings-store.ts';
import { asProbeRunResult, evaluateRetest, resolveRetestTool, retestToolInput } from './finding-retest.ts';

function finding(partial: Partial<FindingRecord>): FindingRecord {
	return {
		id: 'finding-test',
		title: 'SQL injection candidate',
		vulnClass: 'injection',
		severity: 'high',
		status: 'confirmed',
		target: 'http://127.0.0.1:3000',
		description: '',
		steps: ['Open search'],
		evidence: 'status 200',
		request: { method: 'GET', url: 'http://127.0.0.1:3000/rest/products/search', status: 200, tool: 'poc-request' },
		impact: '',
		remediation: '',
		references: [],
		source: 'poc',
		sessionId: 'chat-aaa',
		runId: 'run-1',
		reportId: '',
		informedAt: 0,
		createdAt: 1,
		updatedAt: 1,
		...partial,
	};
}

assert.equal(asProbeRunResult(undefined).ok, false);
assert.equal(asProbeRunResult({ ok: true, stdout: 'status 401' }).stdout, 'status 401');

const stored = finding({});
assert.equal(resolveRetestTool(stored), 'poc-request');
assert.equal(retestToolInput(stored)?.url, stored.request.url);

const declined = evaluateRetest(stored, { ok: false, stderr: USER_DECLINED });
assert.equal(declined.verdict, 'aborted');

const fixedHttp = evaluateRetest(stored, { ok: true, stdout: '"status": 401' });
assert.equal(fixedHttp.verdict, 'fixed');

const stillOpen = evaluateRetest(stored, { ok: true, stdout: '"status": 200' });
assert.equal(stillOpen.verdict, 'still-open');

const xss = finding({
	vulnClass: 'xss',
	request: { url: 'http://127.0.0.1:3000/#x', tool: 'poc-xss-canary', payload: 'window.__hwPocFired=1' },
});
assert.equal(evaluateRetest(xss, { ok: true, stdout: '"fired": 0' }).verdict, 'fixed');
assert.equal(evaluateRetest(xss, { ok: true, stdout: '"fired": 1' }).verdict, 'still-open');

const sql = finding({
	request: { url: 'http://127.0.0.1:3000/rest/products/search', tool: 'sqlmap-scan' },
});
assert.equal(evaluateRetest(sql, { ok: true, stdout: 'all tested parameters do not appear to be injectable' }).verdict, 'fixed');
assert.equal(evaluateRetest(sql, { ok: true, stdout: "parameter 'q' is vulnerable" }).verdict, 'still-open');

const auth = finding({
	vulnClass: 'auth',
	request: { url: 'http://127.0.0.1:3000/rest/user/login', tool: 'poc-request', status: 200 },
});
assert.equal(evaluateRetest(auth, { ok: true, stdout: '"status": 403' }).verdict, 'fixed');

assert.equal(resolveRetestTool(finding({ request: { tool: 'msfvenom', url: 'http://127.0.0.1:3000' } })), undefined);

console.log('finding-retest ok');
