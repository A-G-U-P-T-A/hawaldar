export const ToolSource = {
  PODMAN: "podman",
  MCP: "mcp",
  BROWSER: "browser",
  SCRIPT: "script",
} as const;

export type ToolSource = (typeof ToolSource)[keyof typeof ToolSource];

export const RiskLevel = {
  LOW: "low",
  MEDIUM: "medium",
  HIGH: "high",
} as const;

export type RiskLevel = (typeof RiskLevel)[keyof typeof RiskLevel];

export interface JsonSchemaProperty {
  readonly type: "string" | "number" | "boolean" | "array" | "object";
  readonly description?: string;
}

export interface JsonObjectSchema {
  readonly type: "object";
  readonly required?: readonly string[];
  readonly properties: Readonly<Record<string, JsonSchemaProperty>>;
}

export interface ResourceLimits {
  readonly cpus: number;
  readonly memoryMb: number;
  readonly pids: number;
}

export interface ToolDefinition {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly capabilities: readonly string[];
  readonly image: string;
  readonly command: string;
  readonly inputSchema: JsonObjectSchema;
  readonly outputSchema: JsonObjectSchema;
  readonly platform: "linux";
  readonly riskLevel: RiskLevel;
  readonly requiresNetwork: boolean;
  readonly requiresApproval: boolean;
  readonly timeoutSeconds: number;
  readonly resourceLimits: ResourceLimits;
  readonly source: ToolSource;
}

export interface SandboxCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly workingDirectory: string;
}

export interface ToolAdapter {
  readonly definition: ToolDefinition;
  toSandboxCommand(input: Readonly<Record<string, unknown>>): SandboxCommand;
}
