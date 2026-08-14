import type { EngagementMode, ScopeEntry, ScopeKind } from "@hawaldar/engagement";
import type { RiskLevel } from "@hawaldar/tool-registry";

export const PolicyDenialCode = {
  OUT_OF_SCOPE: "OUT_OF_SCOPE",
  APPROVAL_REQUIRED: "APPROVAL_REQUIRED",
  FORBIDDEN_CAPABILITY: "FORBIDDEN_CAPABILITY",
  UNKNOWN_TOOL: "UNKNOWN_TOOL",
} as const;

export type PolicyDenialCode = (typeof PolicyDenialCode)[keyof typeof PolicyDenialCode];

export interface PolicyTarget {
  readonly kind: ScopeKind;
  readonly value: string;
}

export interface PolicyInvocation {
  readonly engagementId: string;
  readonly toolName: string;
  readonly target: PolicyTarget;
  readonly capabilities: readonly string[];
  readonly riskLevel: RiskLevel;
  readonly requiresNetwork: boolean;
  readonly requiresApproval: boolean;
}

export interface PolicyContext {
  readonly mode: EngagementMode;
  readonly scope: readonly ScopeEntry[];
  readonly approvalGranted: boolean;
}

export type PolicyDecision =
  | { readonly allow: true }
  | { readonly allow: false; readonly code: PolicyDenialCode; readonly reason: string };
