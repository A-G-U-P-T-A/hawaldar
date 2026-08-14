import { describe, expect, it } from "vitest";
import { createReconToolRegistry, EXCLUDED_OFFENSIVE_TOOLS, RECON_TOOL_CATALOG } from "./catalog.js";
import { ToolRegistry } from "./registry.js";
import { RiskLevel, ToolSource } from "./types.js";
import type { ToolDefinition } from "./types.js";

function sampleTool(name: string): ToolDefinition {
  return {
    name,
    version: "1.0.0",
    description: "test",
    capabilities: ["test"],
    image: "example.local/test:1",
    command: name,
    inputSchema: { type: "object", properties: {} },
    outputSchema: { type: "object", properties: {} },
    platform: "linux",
    riskLevel: RiskLevel.LOW,
    requiresNetwork: false,
    requiresApproval: false,
    timeoutSeconds: 10,
    resourceLimits: { cpus: 1, memoryMb: 64, pids: 16 },
    source: ToolSource.PODMAN,
  };
}

describe("ToolRegistry", () => {
  it("registers, lists, and looks up tools", () => {
    const registry = new ToolRegistry();
    expect(registry.register(sampleTool("alpha")).ok).toBe(true);
    expect(registry.get("alpha")?.command).toBe("alpha");
    expect(registry.list()).toHaveLength(1);
    expect(registry.require("missing").ok).toBe(false);
  });

  it("rejects duplicate names", () => {
    const registry = new ToolRegistry();
    registry.register(sampleTool("alpha"));
    expect(registry.register(sampleTool("alpha")).ok).toBe(false);
  });
});

describe("recon catalog", () => {
  it("seeds recon tools and excludes exploitation frameworks", () => {
    const registry = createReconToolRegistry();
    expect(registry.get("nmap")?.capabilities).toContain("port-scan");
    expect(registry.listByCapability("http-probe").map((tool) => tool.name).sort()).toEqual([
      "httpx",
      "nuclei",
    ]);
    expect(registry.list()).toHaveLength(RECON_TOOL_CATALOG.length);
    for (const name of EXCLUDED_OFFENSIVE_TOOLS) {
      expect(registry.get(name)).toBeUndefined();
    }
  });
});
