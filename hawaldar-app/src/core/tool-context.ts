import { AsyncLocalStorage } from 'node:async_hooks';

export interface ToolExecContext {
	impliedTargets: string[];
	readOnlyMemory?: boolean;
}

export const toolExecContext = new AsyncLocalStorage<ToolExecContext>();

export function currentToolContext(): ToolExecContext | undefined {
	return toolExecContext.getStore();
}
