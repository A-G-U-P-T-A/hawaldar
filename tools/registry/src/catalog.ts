import type { JsonObjectSchema, ResourceLimits, ToolDefinition } from "./types.js";
import { RiskLevel, ToolSource } from "./types.js";
import { ToolRegistry } from "./registry.js";

const defaultLimits: ResourceLimits = { cpus: 1, memoryMb: 512, pids: 128 };

const targetInput: JsonObjectSchema = {
  type: "object",
  required: ["target"],
  properties: {
    target: { type: "string", description: "In-scope host, IP, domain, or URL" },
  },
};

const observationOutput: JsonObjectSchema = {
  type: "object",
  properties: {
    observations: { type: "array", description: "Normalized recon observations" },
  },
};

function podmanTool(
  name: string,
  input: Omit<ToolDefinition, "name" | "platform" | "source" | "inputSchema" | "outputSchema"> & {
    inputSchema?: JsonObjectSchema;
  },
): ToolDefinition {
  return {
    ...input,
    name,
    platform: "linux",
    source: ToolSource.PODMAN,
    inputSchema: input.inputSchema ?? targetInput,
    outputSchema: observationOutput,
  };
}

export const RECON_TOOL_CATALOG: readonly ToolDefinition[] = [
  podmanTool("nmap", {
    version: "7.95",
    description: "Host discovery and port/service enumeration",
    capabilities: ["host-discovery", "port-scan", "service-fingerprint"],
    image: "docker.io/instrumentisto/nmap:7.95",
    command: "nmap",
    riskLevel: RiskLevel.MEDIUM,
    requiresNetwork: true,
    requiresApproval: false,
    timeoutSeconds: 300,
    resourceLimits: { cpus: 1, memoryMb: 256, pids: 64 },
  }),
  podmanTool("nuclei", {
    version: "3.3.9",
    description: "Template-based vulnerability and misconfiguration detection",
    capabilities: ["http-probe", "misconfiguration-scan"],
    image: "docker.io/projectdiscovery/nuclei:v3.3.9",
    command: "nuclei",
    riskLevel: RiskLevel.MEDIUM,
    requiresNetwork: true,
    requiresApproval: true,
    timeoutSeconds: 600,
    resourceLimits: { cpus: 1, memoryMb: 512, pids: 128 },
  }),
  podmanTool("ffuf", {
    version: "2.1.0",
    description: "Web content and parameter discovery",
    capabilities: ["content-discovery", "parameter-discovery"],
    image: "ghcr.io/ffuf/ffuf:v2.1.0",
    command: "ffuf",
    riskLevel: RiskLevel.MEDIUM,
    requiresNetwork: true,
    requiresApproval: true,
    timeoutSeconds: 600,
    resourceLimits: defaultLimits,
  }),
  podmanTool("httpx", {
    version: "1.6.10",
    description: "HTTP probe and technology fingerprinting",
    capabilities: ["http-probe", "technology-fingerprint"],
    image: "docker.io/projectdiscovery/httpx:v1.6.10",
    command: "httpx",
    riskLevel: RiskLevel.LOW,
    requiresNetwork: true,
    requiresApproval: false,
    timeoutSeconds: 180,
    resourceLimits: { cpus: 1, memoryMb: 256, pids: 64 },
  }),
  podmanTool("dnsx", {
    version: "1.2.2",
    description: "DNS resolution and record enumeration",
    capabilities: ["dns-resolve"],
    image: "docker.io/projectdiscovery/dnsx:v1.2.2",
    command: "dnsx",
    riskLevel: RiskLevel.LOW,
    requiresNetwork: true,
    requiresApproval: false,
    timeoutSeconds: 120,
    resourceLimits: { cpus: 1, memoryMb: 128, pids: 32 },
  }),
  podmanTool("subfinder", {
    version: "2.7.0",
    description: "Passive subdomain discovery",
    capabilities: ["subdomain-enum"],
    image: "docker.io/projectdiscovery/subfinder:v2.7.0",
    command: "subfinder",
    riskLevel: RiskLevel.LOW,
    requiresNetwork: true,
    requiresApproval: false,
    timeoutSeconds: 180,
    resourceLimits: { cpus: 1, memoryMb: 256, pids: 64 },
  }),
  podmanTool("amass", {
    version: "4.2.0",
    description: "Attack-surface mapping via OSINT and DNS",
    capabilities: ["subdomain-enum", "attack-surface"],
    image: "docker.io/caffix/amass:v4.2.0",
    command: "amass",
    riskLevel: RiskLevel.MEDIUM,
    requiresNetwork: true,
    requiresApproval: true,
    timeoutSeconds: 600,
    resourceLimits: { cpus: 1, memoryMb: 512, pids: 128 },
  }),
  podmanTool("tshark", {
    version: "4.4.0",
    description: "Packet capture inspection for lab traffic",
    capabilities: ["pcap-inspect"],
    image: "docker.io/mccutchen/tshark:latest",
    command: "tshark",
    riskLevel: RiskLevel.LOW,
    requiresNetwork: false,
    requiresApproval: false,
    timeoutSeconds: 180,
    resourceLimits: defaultLimits,
    inputSchema: {
      type: "object",
      required: ["pcapPath"],
      properties: {
        pcapPath: { type: "string", description: "Engagement-workspace pcap path" },
      },
    },
  }),
  {
    name: "playwright",
    version: "1.55.0",
    description: "Authorized browser reconnaissance and observation capture",
    capabilities: ["browser-navigate", "dom-inspect", "http-capture"],
    image: "mcr.microsoft.com/playwright:v1.55.0-noble",
    command: "playwright",
    inputSchema: {
      type: "object",
      required: ["url"],
      properties: {
        url: { type: "string", description: "In-scope URL" },
      },
    },
    outputSchema: observationOutput,
    platform: "linux",
    riskLevel: RiskLevel.LOW,
    requiresNetwork: true,
    requiresApproval: false,
    timeoutSeconds: 180,
    resourceLimits: { cpus: 1, memoryMb: 1024, pids: 256 },
    source: ToolSource.BROWSER,
  },
];

export const EXCLUDED_OFFENSIVE_TOOLS = ["metasploit", "sqlmap"] as const;

export function createReconToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of RECON_TOOL_CATALOG) {
    const registered = registry.register(tool);
    if (!registered.ok) {
      throw registered.error;
    }
  }
  return registry;
}
