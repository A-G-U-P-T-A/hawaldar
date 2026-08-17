import assert from 'node:assert/strict';
import {
	isZapUrlNotFound,
	pickZapTreeUrl,
	zapHostsEquivalent,
	zapScanUrlCandidates,
} from './zap-urls.ts';

assert.equal(zapHostsEquivalent('127.0.0.1', 'host.containers.internal'), true);
assert.equal(zapHostsEquivalent('localhost', 'host.docker.internal'), true);
assert.equal(zapHostsEquivalent('example.com', '127.0.0.1'), false);

const candidates = zapScanUrlCandidates(
	'http://host.containers.internal:3000',
	'http://127.0.0.1:3000/#/',
);
assert.ok(candidates.some((item) => item.includes('host.containers.internal')), candidates.join(','));
assert.ok(candidates.some((item) => item.includes('127.0.0.1')), candidates.join(','));
assert.ok(candidates.every((item) => !item.includes('#')), candidates.join(','));

const treeUrl = pickZapTreeUrl(
	['http://host.containers.internal:3000/', 'http://host.containers.internal:3000/rest/products/search'],
	'http://host.containers.internal:3000',
	'http://127.0.0.1:3000',
);
assert.equal(treeUrl, 'http://host.containers.internal:3000/');

assert.equal(isZapUrlNotFound({ code: 'url_not_found', message: 'URL Not Found in the Scan Tree' }, false), true);
assert.equal(isZapUrlNotFound({ scan: '0' }, true), false);

console.log('zap urls ok');
