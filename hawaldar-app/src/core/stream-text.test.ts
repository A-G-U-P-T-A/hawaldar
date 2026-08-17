import assert from 'node:assert/strict';
import { appendStreamDelta, extractStreamTextDelta, isResumeIntent, mastraMemoryOptions } from './stream-text.ts';

assert.equal(appendStreamDelta('Hello,', ' world'), 'Hello, world');
assert.equal(appendStreamDelta('', 'Hi'), 'Hi');
assert.equal(appendStreamDelta('Hi,', " I'm"), "Hi, I'm");
assert.equal(extractStreamTextDelta({ type: 'text-delta', payload: { text: ' world' } }), ' world');
assert.equal(extractStreamTextDelta({ type: 'text-delta', payload: { text: ' ' } }), ' ');
assert.equal(isResumeIntent('retry'), true);
assert.equal(isResumeIntent('try again'), true);
assert.equal(isResumeIntent('Hi, scan juice shop'), false);

const recall = mastraMemoryOptions('t1', 'hawaldar', { readOnly: true, skipRecall: true });
assert.equal(recall.options?.readOnly, true);
assert.equal(recall.options?.lastMessages, false);
assert.equal(recall.options?.semanticRecall, false);
console.log('stream-text ok');
