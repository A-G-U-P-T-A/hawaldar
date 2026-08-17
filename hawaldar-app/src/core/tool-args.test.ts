import assert from 'node:assert/strict';
import {
	coerceToolArgs,
	evidenceHasToolSnippet,
	evidenceLooksResearchOnly,
	reportFileSlug,
} from './tool-args.ts';

const empty = coerceToolArgs('finding-record', {}, ['http://127.0.0.1:3000']);
assert.equal(empty.title, 'Untitled finding');
assert.equal(empty.vulnClass, 'other');
assert.equal(empty.severity, 'info');
assert.match(String(empty.target), /127\.0\.0\.1/);

const bodyObj = coerceToolArgs('poc-request', {
	method: 'POST',
	url: 'http://[IP_ADDRESS]:3000/rest/user/login',
	body: { email: 'a@b.c', password: 'x' },
}, ['http://127.0.0.1:3000']);
assert.equal(bodyObj.url, 'http://127.0.0.1:3000/rest/user/login');
assert.equal(typeof bodyObj.body, 'string');
assert.match(String(bodyObj.body), /email/);

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
