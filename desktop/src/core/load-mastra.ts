export async function loadMastra(): Promise<MastraModules> {
	const [core, agent, tools, workflows, libsql, memory, loggers, observability, zod] = await Promise.all([
		import('@mastra/core'),
		import('@mastra/core/agent'),
		import('@mastra/core/tools'),
		import('@mastra/core/workflows'),
		import('@mastra/libsql'),
		import('@mastra/memory'),
		import('@mastra/loggers'),
		import('@mastra/observability'),
		import('zod'),
	]);
	return {
		Mastra: pick(core as Record<string, unknown>, 'Mastra'),
		Agent: pick(agent as Record<string, unknown>, 'Agent'),
		createTool: pick(tools as Record<string, unknown>, 'createTool'),
		createStep: pick(workflows as Record<string, unknown>, 'createStep'),
		createWorkflow: pick(workflows as Record<string, unknown>, 'createWorkflow'),
		LibSQLStore: pick(libsql as Record<string, unknown>, 'LibSQLStore'),
		Memory: pick(memory as Record<string, unknown>, 'Memory'),
		PinoLogger: pick(loggers as Record<string, unknown>, 'PinoLogger'),
		Observability: pick(observability as Record<string, unknown>, 'Observability'),
		MastraStorageExporter: pick(observability as Record<string, unknown>, 'MastraStorageExporter'),
		SensitiveDataFilter: pick(observability as Record<string, unknown>, 'SensitiveDataFilter'),
		z: pick(zod as Record<string, unknown>, 'z'),
	};
}

export interface MastraModules {
	Mastra: any;
	Agent: any;
	createTool: any;
	createStep: any;
	createWorkflow: any;
	LibSQLStore: any;
	Memory: any;
	PinoLogger: any;
	Observability: any;
	MastraStorageExporter: any;
	SensitiveDataFilter: any;
	z: any;
}

function pick(mod: Record<string, unknown>, name: string): any {
	if (mod[name]) {
		return mod[name];
	}
	const nested = mod.default as Record<string, unknown> | undefined;
	if (nested?.[name]) {
		return nested[name];
	}
	throw new Error(`Mastra export missing: ${name}`);
}
