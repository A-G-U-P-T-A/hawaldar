import * as fs from 'node:fs';
import * as path from 'node:path';
import { AGENT_ROLES } from './tools/catalog';

export interface SlashCommandDef {
	cmd: string;
	label: string;
	detail: string;
	insert?: string;
}

export interface PromptsConfig {
	system: string;
	orchestrator: string;
	specialist: string;
	/** Optional full instruction overrides keyed by agent id. */
	agents: Record<string, string>;
	slashCommands: SlashCommandDef[];
	welcome: string;
}

const DEFAULT_PROMPTS: PromptsConfig = {
	system: `You are Hawaldar, an authorized reconnaissance workstation.
Persisted Mastra memory threads are the source of truth for conversation state. Do not invent engagement evidence.
Never claim a vulnerability is confirmed without stored evidence.
Never attempt exploitation, persistence, stealth, credential dumping, or destructive actions.
Never execute host commands. Tools run only through the policy gate and Podman sandbox.
Only assess targets that are already in the engagement scope.
If a scan is requested and no gated tool is available yet, say so and ask for an in-scope target to record.`,
	orchestrator: `{{system}}

You are the Orchestrator. Delegate to specialists. Prefer tools over guesses.
Excluded: Metasploit, SQLMap, credential dump, stealth nmap, arbitrary shells.`,
	specialist: `{{system}}

You are the {{name}} agent. {{role}}. Use only your tools. Do not invent evidence.`,
	agents: {},
	slashCommands: [
		{ cmd: 'status', label: '/status', detail: 'Runtime, model, enabled tools' },
		{ cmd: 'readiness', label: '/readiness', detail: 'Probe Podman + tool images' },
		{ cmd: 'tools', label: '/tools', detail: 'List gated tools' },
		{ cmd: 'agents', label: '/agents', detail: 'List agents' },
		{ cmd: 'memory', label: '/memory', detail: 'List memory threads' },
		{ cmd: 'traces', label: '/traces', detail: 'Recent tool/agent traces' },
		{ cmd: 'clear', label: '/clear', detail: 'Start a new thread' },
		{ cmd: 'workflow', label: '/workflow', detail: 'Authorized recon workflow', insert: '/workflow ' },
	],
	welcome: 'Authorized reconnaissance. Policy and Podman gate every tool.\nAsk the orchestrator, or type / for commands.',
};

/** Slash subtitle. Never surface MCP repo names. */
function publicSlashDetail(text: string): string {
	if (/\bmcp\b/i.test(text) || /WireMCP|GhidraMCP/i.test(text)) return '';
	return text;
}

export function renderTemplate(template: string, vars: Record<string, string>): string {
	return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => vars[key] ?? '');
}

function readJsonFile(filePath: string): Partial<PromptsConfig> | null {
	try {
		if (!fs.existsSync(filePath)) {
			return null;
		}
		return JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<PromptsConfig>;
	} catch {
		return null;
	}
}

function mergePrompts(base: PromptsConfig, patch: Partial<PromptsConfig> | null): PromptsConfig {
	if (!patch) {
		return { ...base, agents: { ...base.agents }, slashCommands: [...base.slashCommands] };
	}
	return {
		system: typeof patch.system === 'string' && patch.system.trim() ? patch.system : base.system,
		orchestrator: typeof patch.orchestrator === 'string' && patch.orchestrator.trim()
			? patch.orchestrator
			: base.orchestrator,
		specialist: typeof patch.specialist === 'string' && patch.specialist.trim()
			? patch.specialist
			: base.specialist,
		agents: {
			...base.agents,
			...(patch.agents && typeof patch.agents === 'object' ? patch.agents : {}),
		},
		slashCommands: Array.isArray(patch.slashCommands) && patch.slashCommands.length > 0
			? patch.slashCommands.filter((item) => item && typeof item.cmd === 'string').map((item) => ({
				cmd: String(item.cmd).trim().toLowerCase(),
				label: String(item.label || `/${item.cmd}`),
				detail: publicSlashDetail(String(item.detail || '')),
				insert: item.insert ? String(item.insert) : undefined,
			}))
			: [...base.slashCommands],
		welcome: typeof patch.welcome === 'string' && patch.welcome.trim() ? patch.welcome : base.welcome,
	};
}

export class PromptsStore {
	readonly bundledPath: string;
	readonly userPath: string;

	constructor(resourcesRoot: string, dataDir: string) {
		this.bundledPath = path.join(resourcesRoot, 'prompts.json');
		this.userPath = path.join(dataDir, 'prompts.json');
	}

	read(): PromptsConfig {
		const bundled = mergePrompts(DEFAULT_PROMPTS, readJsonFile(this.bundledPath));
		return mergePrompts(bundled, readJsonFile(this.userPath));
	}

	write(patch: Partial<PromptsConfig>): PromptsConfig {
		const current = this.read();
		const next = mergePrompts(current, patch);
		fs.mkdirSync(path.dirname(this.userPath), { recursive: true });
		fs.writeFileSync(this.userPath, JSON.stringify({
			system: next.system,
			orchestrator: next.orchestrator,
			specialist: next.specialist,
			agents: next.agents,
			slashCommands: next.slashCommands,
			welcome: next.welcome,
		}, null, 2), 'utf8');
		return next;
	}

	/** Resolved slash list including specialist agents from catalog. */
	slashCommands(): SlashCommandDef[] {
		const config = this.read();
		const seen = new Set(config.slashCommands.map((item) => item.cmd));
		const extras: SlashCommandDef[] = [];
		for (const role of AGENT_ROLES) {
			if (role.id === 'orchestrator' || seen.has(role.id)) {
				continue;
			}
			extras.push({
				cmd: role.id,
				label: `/${role.id}`,
				detail: publicSlashDetail(role.role),
				insert: `/${role.id} `,
			});
		}
		return [
			...config.slashCommands.map((item) => ({ ...item, detail: publicSlashDetail(item.detail) })),
			...extras,
		];
	}

	/** Final system prompt string Mastra Agent.instructions expects. */
	instructionsFor(agentId: string, name: string, role: string): string {
		const config = this.read();
		const override = config.agents[agentId];
		if (typeof override === 'string' && override.trim()) {
			return renderTemplate(override, {
				system: config.system,
				name,
				role,
				agentId,
			}).trim();
		}
		const template = agentId === 'orchestrator' ? config.orchestrator : config.specialist;
		return renderTemplate(template, {
			system: config.system,
			name,
			role,
			agentId,
		}).trim();
	}
}
