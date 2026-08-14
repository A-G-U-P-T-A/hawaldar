import { describe, expect, it } from "vitest";
import { EngagementMode, type ScopeEntry } from "@hawaldar/engagement";
import { RiskLevel } from "@hawaldar/tool-registry";
import { evaluatePolicy } from "./evaluate.js";
import { PolicyDenialCode, type PolicyInvocation } from "./types.js";

function scope(value: string, direction: ScopeEntry["direction"] = "allow"): ScopeEntry {
  return {
    id: "s1",
    engagementId: "e1",
    direction,
    kind: "ip",
    value,
    createdAt: 0,
  };
}

function invocation(overrides: Partial<PolicyInvocation> = {}): PolicyInvocation {
  return {
    engagementId: "e1",
    toolName: "nmap",
    target: { kind: "ip", value: "127.0.0.1" },
    capabilities: ["port-scan"],
    riskLevel: RiskLevel.MEDIUM,
    requiresNetwork: true,
    requiresApproval: false,
    ...overrides,
  };
}

describe("evaluatePolicy", () => {
  it("allows an in-scope recon tool", () => {
    expect(
      evaluatePolicy(invocation(), {
        mode: EngagementMode.CTF_LAB,
        scope: [scope("127.0.0.1")],
        approvalGranted: false,
      }),
    ).toEqual({ allow: true });
  });

  it("denies a target the model cannot authorize", () => {
    const decision = evaluatePolicy(invocation({ target: { kind: "ip", value: "8.8.8.8" } }), {
      mode: EngagementMode.CTF_LAB,
      scope: [scope("127.0.0.1")],
      approvalGranted: false,
    });
    expect(decision).toMatchObject({ allow: false, code: PolicyDenialCode.OUT_OF_SCOPE });
  });

  it("denies excluded hosts even when a parent range is allowed", () => {
    const decision = evaluatePolicy(invocation({ target: { kind: "ip", value: "10.0.0.9" } }), {
      mode: EngagementMode.AUTHORIZED_PENTEST,
      scope: [
        { ...scope("10.0.0.0/24"), kind: "cidr" },
        scope("10.0.0.9", "deny"),
      ],
      approvalGranted: false,
    });
    expect(decision.allow).toBe(false);
  });

  it("blocks exploitation capabilities regardless of scope", () => {
    const decision = evaluatePolicy(invocation({ capabilities: ["exploit"] }), {
      mode: EngagementMode.CTF_LAB,
      scope: [scope("127.0.0.1")],
      approvalGranted: true,
    });
    expect(decision).toMatchObject({ allow: false, code: PolicyDenialCode.FORBIDDEN_CAPABILITY });
  });

  it("requires approval when the tool says so", () => {
    const decision = evaluatePolicy(invocation({ toolName: "nuclei", requiresApproval: true }), {
      mode: EngagementMode.AUTHORIZED_PENTEST,
      scope: [scope("127.0.0.1")],
      approvalGranted: false,
    });
    expect(decision).toMatchObject({ allow: false, code: PolicyDenialCode.APPROVAL_REQUIRED });
  });
});
