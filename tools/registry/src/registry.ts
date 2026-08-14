import { ErrorCode, HawaldarError, err, ok, type Result } from "@hawaldar/shared";
import type { ToolDefinition } from "./types.js";

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  register(definition: ToolDefinition): Result<ToolDefinition, HawaldarError> {
    if (this.tools.has(definition.name)) {
      return err(
        new HawaldarError(ErrorCode.TOOL_FAILURE, `Tool already registered: ${definition.name}`, {
          name: definition.name,
        }),
      );
    }
    this.tools.set(definition.name, definition);
    return ok(definition);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  require(name: string): Result<ToolDefinition, HawaldarError> {
    const tool = this.tools.get(name);
    if (!tool) {
      return err(new HawaldarError(ErrorCode.TOOL_FAILURE, `Unknown tool: ${name}`, { name }));
    }
    return ok(tool);
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  listByCapability(capability: string): ToolDefinition[] {
    return this.list().filter((tool) => tool.capabilities.includes(capability));
  }
}
