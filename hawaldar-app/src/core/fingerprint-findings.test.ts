import assert from 'node:assert/strict';
import { parseFingerprintFindings } from './tools/fingerprint-findings.ts';

const httpx = parseFingerprintFindings(
	'httpx-tech',
	'http://host.containers.internal:3000/ [200] [OWASP Juice Shop] [Express]',
	'http://127.0.0.1:3000',
);
assert.ok(httpx.some((item) => item.vulnClass === 'version' && /Juice Shop/i.test(item.title)), JSON.stringify(httpx));
assert.ok(httpx.some((item) => item.vulnClass === 'version' && /Express/i.test(item.title)), JSON.stringify(httpx));
assert.ok(httpx.some((item) => item.vulnClass === 'injection' && /products\/search/.test(item.target)), JSON.stringify(httpx));
assert.ok(httpx.some((item) => item.vulnClass === 'xss'), JSON.stringify(httpx));
assert.ok(httpx.some((item) => item.vulnClass === 'auth' && /login/.test(item.target)), JSON.stringify(httpx));
assert.ok(httpx.some((item) => item.vulnClass === 'idor'), JSON.stringify(httpx));

const nuclei = parseFingerprintFindings(
	'nuclei-tech',
	'[owasp-juice-shop-detect] [http] [info] http://127.0.0.1:3000/ Node.js',
	'http://127.0.0.1:3000',
);
assert.ok(nuclei.some((item) => /Node\.js/i.test(item.title)), JSON.stringify(nuclei));

const cve = parseFingerprintFindings(
	'nuclei-severity-info',
	'template hit CVE-2023-12345 on the target',
	'http://127.0.0.1:3000',
);
assert.ok(cve.some((item) => item.title.includes('CVE-2023-12345') && item.vulnClass === 'version'), JSON.stringify(cve));

assert.deepEqual(parseFingerprintFindings('katana', 'OWASP Juice Shop', 'http://127.0.0.1:3000'), []);

console.log('fingerprint-findings ok');
