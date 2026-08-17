import assert from 'node:assert/strict';
import {
	definedToolResult,
	ensurePocApproval,
	parseHitlResume,
	releaseHitlWaiter,
} from './hitl-gate.ts';

const defined = definedToolResult('Waiting for operator approval.');
assert.equal(defined.ok, false);
assert.equal(defined.stderr, 'Waiting for operator approval.');
assert.equal(typeof defined.stdout, 'string');
assert.equal(defined.exitCode, 0);

let suspendCalled = false;
const approved = await ensurePocApproval(
	{ title: 'Approve PoC probe?', explanation: 'poc-request GET http://127.0.0.1:3000/rest/products/search?q=test' },
	{
		askHitl: async () => true,
		hitlContext: {
			agent: {
				suspend: async () => {
					suspendCalled = true;
					throw new Error('Mastra suspend should not run');
				},
			},
		},
	},
);
assert.deepEqual(approved, { status: 'ok' });
assert.equal(suspendCalled, false);

const declined = await ensurePocApproval(
	{ title: 'Approve PoC probe?', explanation: 'test' },
	{ askHitl: async () => false },
);
assert.equal(declined.status, 'declined');

const noIpc = await ensurePocApproval(
	{ title: 'Approve PoC probe?', explanation: 'test' },
	{
		hitlContext: {
			agent: {
				suspend: async () => {
					suspendCalled = true;
					return { ok: false };
				},
			},
		},
	},
);
assert.equal(noIpc.status, 'declined', 'missing askHitl must decline, never Mastra suspend');
assert.equal(suspendCalled, false);

const resumed = await ensurePocApproval(
	{ title: 'Approve PoC probe?', explanation: 'test' },
	{
		hitlContext: {
			agent: { resumeData: { approved: true, kind: 'poc-probe' } },
		},
	},
);
assert.deepEqual(resumed, { status: 'ok' });

assert.deepEqual(parseHitlResume({ approved: true, kind: 'poc-probe' }), {
	approved: true,
	kind: 'poc-probe',
	serviceId: undefined,
});

const order: string[] = [];
await new Promise<void>((done) => {
	releaseHitlWaiter((ok) => {
		assert.equal(ok, true);
		order.push('waiter');
		done();
	}, true);
	order.push('ipc-returned');
});
assert.deepEqual(order, ['ipc-returned', 'waiter']);

console.log('hitl ok');
