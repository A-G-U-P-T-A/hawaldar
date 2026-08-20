import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FindingsStore, targetsMatch } from './findings-store.ts';

assert.equal(targetsMatch('http://127.0.0.1:3000', '127.0.0.1:3000'), true);
assert.equal(targetsMatch('https://127.0.0.1:3000/', '127.0.0.1:3000'), true);
assert.equal(targetsMatch('http://127.0.0.1:3000/rest/products/search', '127.0.0.1:3000'), true);
assert.equal(targetsMatch('127.0.0.1:3000', 'http://127.0.0.1:3000'), true);
assert.equal(targetsMatch('http://127.0.0.1:3000', '127.0.0.1:3001'), false);
assert.equal(targetsMatch('example.com', 'http://example.com/login'), true);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hw-findings-'));
const store = new FindingsStore(dir);
await store.ready;

const a = await store.upsert({
	title: 'SQL injection candidate: /rest/products/search',
	vulnClass: 'injection',
	status: 'hypothesis',
	target: 'http://127.0.0.1:3000',
	sessionId: 'chat-aaa',
	evidence: 'hypothesis from httpx',
	steps: ['Open search'],
});
const b = await store.upsert({
	title: 'SQL injection candidate: /rest/products/search',
	vulnClass: 'injection',
	status: 'hypothesis',
	target: 'http://127.0.0.1:3000',
	sessionId: 'chat-bbb',
	evidence: 'other chat',
	steps: ['Open search'],
});
assert.notEqual(a.id, b.id);
assert.equal((await store.list({ sessionId: 'chat-aaa' })).length, 1);
assert.equal((await store.list({ sessionId: 'chat-aaa' }))[0].id, a.id);
assert.equal((await store.list({ sessionId: 'chat-bbb' }))[0].id, b.id);
assert.equal((await store.list({ target: '127.0.0.1:3000' })).length, 2);
assert.equal((await store.list({ sessionId: 'missing' })).length, 0);

const again = await store.upsert({
	title: 'SQL injection candidate: /rest/products/search',
	vulnClass: 'injection',
	status: 'unconfirmed',
	target: 'http://127.0.0.1:3000',
	sessionId: 'chat-aaa',
	evidence: 'still this chat',
});
assert.equal(again.id, a.id);
assert.equal(again.status, 'unconfirmed');

const orphan = await store.upsert({
	title: 'Legacy Juice Shop XSS',
	vulnClass: 'xss',
	status: 'unconfirmed',
	target: 'http://127.0.0.1:3000',
	sessionId: '',
	evidence: 'recorded before chat mapping',
	steps: ['Open Juice Shop'],
});
assert.equal((await store.list({ sessionId: 'chat-aaa' })).length, 1);
assert.equal((await store.list({ sessionId: 'chat-aaa', includeUnassigned: true })).map((row) => row.id).sort().join(','), [a.id, orphan.id].sort().join(','));
assert.equal((await store.list({ sessionId: '' })).length, 1);
assert.equal((await store.list({ sessionId: '' }))[0].id, orphan.id);
assert.equal((await store.list()).some((row) => row.id === orphan.id), true);

console.log('findings-store ok');
