export const EngagementMode = {
  CTF_LAB: "CTF_LAB",
  AUTHORIZED_PENTEST: "AUTHORIZED_PENTEST",
} as const;

export type EngagementMode = (typeof EngagementMode)[keyof typeof EngagementMode];

export const EngagementStatus = {
  CREATED: "created",
  ACTIVE: "active",
  PAUSED: "paused",
  COMPLETED: "completed",
  FAILED: "failed",
} as const;

export type EngagementStatus = (typeof EngagementStatus)[keyof typeof EngagementStatus];

export const ScopeKind = {
  DOMAIN: "domain",
  IP: "ip",
  CIDR: "cidr",
  HOST: "host",
} as const;

export type ScopeKind = (typeof ScopeKind)[keyof typeof ScopeKind];

export const ScopeDirection = {
  ALLOW: "allow",
  DENY: "deny",
} as const;

export type ScopeDirection = (typeof ScopeDirection)[keyof typeof ScopeDirection];

export const FindingStatus = {
  SUSPECTED: "suspected",
  INVESTIGATING: "investigating",
  VALIDATED: "validated",
  FALSE_POSITIVE: "false_positive",
  ACCEPTED: "accepted",
  FIXED: "fixed",
  RETEST_REQUIRED: "retest_required",
} as const;

export type FindingStatus = (typeof FindingStatus)[keyof typeof FindingStatus];

export const ToolExecutionStatus = {
  STARTED: "started",
  SUCCEEDED: "succeeded",
  FAILED: "failed",
} as const;

export type ToolExecutionStatus =
  (typeof ToolExecutionStatus)[keyof typeof ToolExecutionStatus];

export interface ScopeEntryInput {
  readonly kind: ScopeKind;
  readonly value: string;
}

export interface CreateEngagementInput {
  readonly name: string;
  readonly mode: EngagementMode;
  readonly dataDir: string;
  readonly targets: readonly ScopeEntryInput[];
  readonly excluded?: readonly ScopeEntryInput[];
}

export interface ScopeEntry {
  readonly id: string;
  readonly engagementId: string;
  readonly direction: ScopeDirection;
  readonly kind: ScopeKind;
  readonly value: string;
  readonly createdAt: number;
}

export interface EngagementRecord {
  readonly id: string;
  readonly name: string;
  readonly mode: EngagementMode;
  readonly status: EngagementStatus;
  readonly workspacePath: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly pausedAt: number | null;
  readonly scope: readonly ScopeEntry[];
}

export interface FindingRecord {
  readonly id: string;
  readonly engagementId: string;
  readonly nodeId: string | null;
  readonly status: FindingStatus;
  readonly title: string;
  readonly summary: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface EvidenceRecord {
  readonly id: string;
  readonly engagementId: string;
  readonly findingId: string | null;
  readonly kind: string;
  readonly uri: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly createdAt: number;
}

export interface ToolExecutionRecord {
  readonly id: string;
  readonly engagementId: string;
  readonly toolName: string;
  readonly status: ToolExecutionStatus;
  readonly request: Readonly<Record<string, unknown>>;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly startedAt: number;
  readonly finishedAt: number | null;
}

export interface CheckpointRecord {
  readonly id: string;
  readonly engagementId: string;
  readonly kind: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly createdAt: number;
}
