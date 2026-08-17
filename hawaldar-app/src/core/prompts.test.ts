import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PromptsStore } from './prompts.ts';

const resourcesRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../resources');
const prompts = new PromptsStore(resourcesRoot, path.join(os.tmpdir(), 'hawaldar-prompts-test'));

const research = prompts.instructionsFor('research', 'Research', 'Public documentation');
assert.equal(/run_workflow/i.test(research), false, 'research specialist must not see run_workflow');
assert.match(research, /PLAYBOOK STEPS/);
assert.doesNotMatch(research, /MUST run the playbook via/);
assert.doesNotMatch(research, /PARALLEL SPECIALISTS/);
assert.match(research, /runtime continues the next phase/i);

const orch = prompts.instructionsFor('orchestrator', 'Orchestrator', 'Supervisor');
assert.match(orch, /call tool id run_workflow/);
assert.match(orch, /ENGAGEMENT PIPELINE/);
assert.match(orch, /PARALLEL SPECIALISTS/);
assert.doesNotMatch(orch, /Slash \/full-engagement MUST run the playbook via run_workflow/);
assert.match(orch, /Slash \/full-engagement is a deterministic sequential playbook/);

const vuln = prompts.instructionsFor('vuln-xss', 'Vuln XSS', 'XSS-class detection');
assert.match(vuln, /agent-research/);
assert.doesNotMatch(vuln, /Tools: research-search, research-open/);
assert.match(vuln, /Never call research-search/);

console.log('prompts ok');
