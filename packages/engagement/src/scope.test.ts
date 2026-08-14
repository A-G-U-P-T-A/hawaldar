import { describe, expect, it } from "vitest";
import { isAuthorizedTarget } from "./scope.js";
import type { ScopeEntry } from "./types.js";

function entry(
  direction: ScopeEntry["direction"],
  kind: ScopeEntry["kind"],
  value: string,
): ScopeEntry {
  return {
    id: "1",
    engagementId: "e",
    direction,
    kind,
    value,
    createdAt: 0,
  };
}

describe("isAuthorizedTarget", () => {
  it("allows an IP listed in scope", () => {
    expect(
      isAuthorizedTarget([entry("allow", "ip", "127.0.0.1")], { kind: "ip", value: "127.0.0.1" }),
    ).toBe(true);
  });

  it("allows an IP inside an allowed CIDR", () => {
    expect(
      isAuthorizedTarget([entry("allow", "cidr", "10.0.0.0/24")], {
        kind: "ip",
        value: "10.0.0.15",
      }),
    ).toBe(true);
  });

  it("denies an IP outside CIDR", () => {
    expect(
      isAuthorizedTarget([entry("allow", "cidr", "10.0.0.0/24")], {
        kind: "ip",
        value: "10.0.1.15",
      }),
    ).toBe(false);
  });

  it("denies an excluded host even when the parent domain is allowed", () => {
    const scope = [entry("allow", "domain", "lab.local"), entry("deny", "host", "out.lab.local")];
    expect(isAuthorizedTarget(scope, { kind: "host", value: "app.lab.local" })).toBe(true);
    expect(isAuthorizedTarget(scope, { kind: "host", value: "out.lab.local" })).toBe(false);
  });

  it("denies anything with no allow rules", () => {
    expect(isAuthorizedTarget([], { kind: "ip", value: "127.0.0.1" })).toBe(false);
  });
});
