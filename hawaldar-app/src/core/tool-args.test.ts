import assert from 'node:assert/strict';
import { z } from 'zod';
import {
	coerceToolArgs,
	evidenceHasToolSnippet,
	evidenceLooksResearchOnly,
	INVALID_TOOL_ARGS,
	reportFileSlug,
	wrapToolInputSchema,
} from './tool-args.ts';

const empty = coerceToolArgs('finding-record', {}, ['http://127.0.0.1:3000']);
assert.equal(empty.title, 'Untitled finding');
assert.equal(empty.vulnClass, 'other');
assert.equal(empty.severity, 'info');
assert.match(String(empty.target), /127\.0\.0\.1/);
assert.deepEqual(empty.steps, []);

const live = coerceToolArgs('finding-record', {
	id: 'sql-injection-candidate-rest-products-search',
	title: 'SQL injection candidate: /rest/products/search',
	vulnClass: 'injection',
	severity: 'medium',
	status: 'hypothesis',
	steps: 3,
	evidence: { status: 200, url: 'http://[IP_ADDRESS]:3000/rest/products/search' },
}, ['http://127.0.0.1:3000']);
assert.deepEqual(live.steps, []);
assert.equal(live.vulnClass, 'injection');
assert.equal(live.class, 'injection');
assert.equal(typeof live.evidence, 'string');
assert.match(String(live.evidence), /127\.0\.0\.1/);

const classAlias = coerceToolArgs('finding-record', {
	title: 'Auth bypass',
	class: 'auth',
	severity: 'high',
	steps: 'Open /#/administration',
}, ['http://127.0.0.1:3000']);
assert.equal(classAlias.vulnClass, 'auth');
assert.deepEqual(classAlias.steps, ['Open /#/administration']);

const bodyObj = coerceToolArgs('poc-request', {
	method: 'POST',
	url: 'http://[IP_ADDRESS]:3000/rest/user/login',
	body: { email: 'a@b.c', password: 'x' },
}, ['http://127.0.0.1:3000']);
assert.equal(bodyObj.url, 'http://127.0.0.1:3000/rest/user/login');
assert.equal(typeof bodyObj.body, 'string');
assert.match(String(bodyObj.body), /email/);

const schema = z.object({
	title: z.string(),
	vulnClass: z.enum(['injection', 'xss', 'ssrf', 'auth', 'csrf', 'ssti', 'idor', 'version', 'other']).optional(),
	severity: z.enum(['critical', 'high', 'medium', 'low', 'info']).optional(),
	steps: z.array(z.string()).optional(),
	evidence: z.string().optional(),
	target: z.string().optional(),
});
const wrapped = wrapToolInputSchema(z, 'finding-record', schema);
const parsed = wrapped.parse({
	title: 'SQL injection candidate: /rest/products/search',
	vulnClass: 'injection',
	severity: 'medium',
	status: 'hypothesis',
	steps: 3,
	evidence: { status: 200 },
});
assert.deepEqual(parsed.steps, []);
assert.equal(typeof parsed.evidence, 'string');
assert.equal(parsed[INVALID_TOOL_ARGS], undefined);

const slug = reportFileSlug('http://[IP_ADDRESS]:3000', ['http://127.0.0.1:3000']);
assert.equal(slug.includes('ip-address'), false);
assert.match(slug, /127-0-0-1/);

assert.equal(evidenceHasToolSnippet('GET /rest/admin 200'), false);
assert.equal(
	evidenceHasToolSnippet('{"action":"request","status":200,"bodyExcerpt":"{\\"authentication\\":true}"}'),
	true,
);
assert.equal(evidenceLooksResearchOnly('According to OWASP, Juice Shop has XSS. has evidence: true'), true);

console.log('tool-args ok');
