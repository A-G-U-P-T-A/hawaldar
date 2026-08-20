import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	isAllowedAppNavigation,
	isExternalHref,
	isRendererOriginBlob,
	shouldPreventAppNavigation,
} from './app-navigation.ts';

const renderer = 'http://127.0.0.1:5173/';
const failedBlob = 'blob:http://127.0.0.1:5173/d62f6c35-a344-49b6-81a2-26120d77ddbe';
const pdfGuest = 'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html';

assert.equal(isAllowedAppNavigation('http://127.0.0.1:5173/', { rendererUrl: renderer, isMainFrame: true }), true);
assert.equal(isAllowedAppNavigation('http://127.0.0.1:5173/src/renderer/index.html', { rendererUrl: renderer }), true);
assert.equal(isAllowedAppNavigation('file:///C:/Hawaldar/out/renderer/index.html', { isMainFrame: true }), true);
assert.equal(isAllowedAppNavigation('file:///C:/Hawaldar/out/renderer/splash.html', { isMainFrame: true }), true);
assert.equal(isAllowedAppNavigation('app://./index.html', { isMainFrame: true }), true);
assert.equal(isAllowedAppNavigation('about:blank', { isMainFrame: false }), true);

assert.equal(isRendererOriginBlob(failedBlob, renderer), true);
assert.equal(isRendererOriginBlob('blob:http://127.0.0.1:3000/abc', renderer), false);

// Previous incomplete fix: blob allowed only when isMainFrame === false.
// Electron still blocked the report because will-navigate hardcoded true and
// will-frame-navigate sometimes omits the flag. These must stay allowed.
assert.equal(isAllowedAppNavigation(failedBlob, { rendererUrl: renderer, isMainFrame: true }), true);
assert.equal(isAllowedAppNavigation(failedBlob, { rendererUrl: renderer, isMainFrame: false }), true);
assert.equal(isAllowedAppNavigation(failedBlob, { rendererUrl: renderer }), true);
assert.equal(shouldPreventAppNavigation({ url: failedBlob, rendererUrl: renderer, isMainFrame: true }), false);
assert.equal(shouldPreventAppNavigation({ url: failedBlob, rendererUrl: renderer, isMainFrame: false }), false);
assert.equal(shouldPreventAppNavigation({ url: failedBlob, rendererUrl: renderer }), false);

// PDF MimeHandler guest's *own* main frame is chrome-extension://. Allowing
// only isMainFrame === false still preventDefault'd the guest and the window
// then logged ERR_BLOCKED_BY_CLIENT on the embedder blob: subframe.
assert.equal(isAllowedAppNavigation(pdfGuest, { isMainFrame: true }), true);
assert.equal(isAllowedAppNavigation(pdfGuest, { isMainFrame: false }), true);
assert.equal(shouldPreventAppNavigation({ url: pdfGuest, isMainFrame: true }), false);
assert.equal(shouldPreventAppNavigation({ url: failedBlob, isGuestContents: true, isMainFrame: true }), false);

assert.equal(isAllowedAppNavigation('http://127.0.0.1:3000/', { rendererUrl: renderer, isMainFrame: true }), false);
assert.equal(isAllowedAppNavigation('http://127.0.0.1:3000/', { rendererUrl: renderer, isMainFrame: false }), false);
assert.equal(shouldPreventAppNavigation({ url: 'http://127.0.0.1:3000/', rendererUrl: renderer, isMainFrame: true }), true);
assert.equal(shouldPreventAppNavigation({ url: 'http://127.0.0.1:3000/', rendererUrl: renderer, isMainFrame: false }), true);
assert.equal(isAllowedAppNavigation('https://example.com/', { rendererUrl: renderer, isMainFrame: true }), false);
assert.equal(isAllowedAppNavigation('http://localhost:3000/', { rendererUrl: renderer }), false);
assert.equal(isAllowedAppNavigation('blob:http://127.0.0.1:3000/abc', { rendererUrl: renderer, isMainFrame: true }), false);

assert.equal(isAllowedAppNavigation('http://127.0.0.1:5174/', { rendererUrl: 'http://127.0.0.1:5174/' }), true);
assert.equal(isAllowedAppNavigation('http://127.0.0.1:5173/', { rendererUrl: 'http://127.0.0.1:5174/' }), false);

assert.equal(isExternalHref('http://127.0.0.1:3000/'), true);
assert.equal(isExternalHref('mailto:ops@example.com'), true);
assert.equal(isExternalHref('file:///tmp/x'), false);
assert.equal(isExternalHref('javascript:alert(1)'), false);

const viewer = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../renderer/src/ReportViewer.tsx'), 'utf8');
assert.doesNotMatch(viewer, /<iframe/);
assert.doesNotMatch(viewer, /createObjectURL/);
assert.match(viewer, /getDocument/);
assert.match(viewer, /pdfjs-dist/);

console.log('app-navigation ok');
