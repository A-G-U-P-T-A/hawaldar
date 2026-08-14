import type { SandboxExecuteRequest, SandboxHandle, SandboxProvider, SandboxResult } from "@hawaldar/sandbox";
import { ErrorCode, HawaldarError, err, ok, type Result } from "@hawaldar/shared";
import type { ToolRegistry } from "@hawaldar/tool-registry";
import { evaluatePolicy } from "./evaluate.js";
import { PolicyDenialCode, type PolicyContext, type PolicyTarget } from "./types.js";

export interface GatedExecuteInput {
  readonly engagementId: string;
  readonly toolName: string;
  readonly target: PolicyTarget;
  readonly handle: SandboxHandle;
  readonly request: SandboxExecuteRequest;
}

export function createPolicyGate(registry: ToolRegistry, sandbox: SandboxProvider) {
  return {
    async execute(
      input: GatedExecuteInput,
      context: PolicyContext,
    ): Promise<Result<SandboxResult, HawaldarError>> {
      const tool = registry.require(input.toolName);
      if (!tool.ok) {
        return err(
          new HawaldarError(ErrorCode.POLICY_DENIED, tool.error.message, {
            code: PolicyDenialCode.UNKNOWN_TOOL,
            toolName: input.toolName,
          }),
        );
      }

      const decision = evaluatePolicy(
        {
          engagementId: input.engagementId,
          toolName: tool.value.name,
          target: input.target,
          capabilities: tool.value.capabilities,
          riskLevel: tool.value.riskLevel,
          requiresNetwork: tool.value.requiresNetwork,
          requiresApproval: tool.value.requiresApproval,
        },
        context,
      );

      if (!decision.allow) {
        return err(
          new HawaldarError(ErrorCode.POLICY_DENIED, decision.reason, {
            code: decision.code,
            toolName: input.toolName,
            target: input.target.value,
          }),
        );
      }

      const result = await sandbox.execute(input.handle, input.request);
      return ok(result);
    },
  };
}
