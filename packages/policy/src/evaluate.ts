import { EngagementMode, isAuthorizedTarget } from "@hawaldar/engagement";
import { PolicyDenialCode, type PolicyContext, type PolicyDecision, type PolicyInvocation } from "./types.js";

export const FORBIDDEN_CAPABILITIES = [
  "exploit",
  "persistence",
  "stealth",
  "destructive",
  "lateral-movement",
  "credential-dump",
] as const;

export function evaluatePolicy(
  invocation: PolicyInvocation,
  context: PolicyContext,
): PolicyDecision {
  if (
    context.mode !== EngagementMode.CTF_LAB &&
    context.mode !== EngagementMode.AUTHORIZED_PENTEST
  ) {
    return {
      allow: false,
      code: PolicyDenialCode.FORBIDDEN_CAPABILITY,
      reason: `Unsupported engagement mode: ${String(context.mode)}`,
    };
  }

  const forbidden = invocation.capabilities.filter((capability) =>
    (FORBIDDEN_CAPABILITIES as readonly string[]).includes(capability),
  );
  if (forbidden.length > 0) {
    return {
      allow: false,
      code: PolicyDenialCode.FORBIDDEN_CAPABILITY,
      reason: `Capability is outside recon policy: ${forbidden.join(", ")}`,
    };
  }

  if (!isAuthorizedTarget(context.scope, invocation.target)) {
    return {
      allow: false,
      code: PolicyDenialCode.OUT_OF_SCOPE,
      reason: `Target ${invocation.target.value} is not in engagement scope`,
    };
  }

  if (invocation.requiresApproval && !context.approvalGranted) {
    return {
      allow: false,
      code: PolicyDenialCode.APPROVAL_REQUIRED,
      reason: `Tool ${invocation.toolName} requires operator approval`,
    };
  }

  return { allow: true };
}
