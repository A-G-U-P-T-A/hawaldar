export const GraphNodeType = {
  ASSET: "asset",
  DOMAIN: "domain",
  SUBDOMAIN: "subdomain",
  IP: "ip",
  HOST: "host",
  PORT: "port",
  SERVICE: "service",
  TECHNOLOGY: "technology",
  URL: "url",
  ENDPOINT: "endpoint",
  PARAMETER: "parameter",
  CREDENTIAL: "credential",
  SESSION: "session",
} as const;

export type GraphNodeType = (typeof GraphNodeType)[keyof typeof GraphNodeType];

export const GraphEdgeType = {
  RESOLVES_TO: "resolves_to",
  HAS_HOST: "has_host",
  HAS_PORT: "has_port",
  RUNS_SERVICE: "runs_service",
  USES_TECHNOLOGY: "uses_technology",
  EXPOSES_URL: "exposes_url",
  HAS_ENDPOINT: "has_endpoint",
  HAS_PARAMETER: "has_parameter",
  AUTHENTICATES: "authenticates",
  PART_OF: "part_of",
} as const;

export type GraphEdgeType = (typeof GraphEdgeType)[keyof typeof GraphEdgeType];

export interface GraphNode {
  readonly id: string;
  readonly engagementId: string;
  readonly type: GraphNodeType;
  readonly canonicalKey: string;
  readonly label: string;
  readonly data: Readonly<Record<string, unknown>>;
  readonly firstSeenAt: number;
  readonly lastSeenAt: number;
}

export interface GraphEdge {
  readonly id: string;
  readonly engagementId: string;
  readonly sourceId: string;
  readonly targetId: string;
  readonly type: GraphEdgeType;
  readonly data: Readonly<Record<string, unknown>>;
  readonly createdAt: number;
}

export interface UpsertNodeInput {
  readonly engagementId: string;
  readonly type: GraphNodeType;
  readonly canonicalKey: string;
  readonly label: string;
  readonly data?: Readonly<Record<string, unknown>>;
}

export interface AddEdgeInput {
  readonly engagementId: string;
  readonly sourceId: string;
  readonly targetId: string;
  readonly type: GraphEdgeType;
  readonly data?: Readonly<Record<string, unknown>>;
}
