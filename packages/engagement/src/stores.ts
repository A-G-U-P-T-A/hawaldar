import { eq, desc } from "drizzle-orm";
import { ErrorCode, HawaldarError, err, ok, type Result } from "@hawaldar/shared";
import type { HawaldarDatabase } from "./db.js";
import { newId, nowMs } from "./ids.js";
import {
  agentDecisions,
  checkpoints,
  evidence,
  engagements,
  findings,
  hypotheses,
  scopeEntries,
  scripts,
  toolExecutions,
} from "./schema.js";
import {
  EngagementStatus,
  type CheckpointRecord,
  type CreateEngagementInput,
  type EngagementMode,
  type EngagementRecord,
  type EngagementStatus as EngagementStatusType,
  type EvidenceRecord,
  type FindingRecord,
  type FindingStatus,
  type ScopeDirection,
  type ScopeEntry,
  type ScopeKind,
  type ToolExecutionRecord,
  type ToolExecutionStatus,
} from "./types.js";
import { engagementWorkspace, ensureWorkspace } from "./workspace.js";

function parseJsonObject(raw: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }
  return parsed as Record<string, unknown>;
}

function toScopeEntry(row: typeof scopeEntries.$inferSelect): ScopeEntry {
  return {
    id: row.id,
    engagementId: row.engagementId,
    direction: row.direction as ScopeDirection,
    kind: row.kind as ScopeKind,
    value: row.value,
    createdAt: row.createdAt,
  };
}

function toEngagement(
  row: typeof engagements.$inferSelect,
  scope: readonly ScopeEntry[],
): EngagementRecord {
  return {
    id: row.id,
    name: row.name,
    mode: row.mode as EngagementMode,
    status: row.status as EngagementStatusType,
    workspacePath: row.workspacePath,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    pausedAt: row.pausedAt,
    scope,
  };
}

export function createEngagementStore(db: HawaldarDatabase) {
  function loadScope(engagementId: string): ScopeEntry[] {
    return db
      .select()
      .from(scopeEntries)
      .where(eq(scopeEntries.engagementId, engagementId))
      .all()
      .map(toScopeEntry);
  }

  return {
    create(input: CreateEngagementInput): Result<EngagementRecord, HawaldarError> {
      if (input.targets.length === 0) {
        return err(
          new HawaldarError(
            ErrorCode.CONFIG_INVALID,
            "An engagement requires at least one in-scope target",
          ),
        );
      }

      const id = newId();
      const createdAt = nowMs();
      const workspace = ensureWorkspace(engagementWorkspace(input.dataDir, id));

      db.insert(engagements)
        .values({
          id,
          name: input.name,
          mode: input.mode,
          status: EngagementStatus.CREATED,
          workspacePath: workspace.root,
          createdAt,
          updatedAt: createdAt,
          pausedAt: null,
        })
        .run();

      const scopeRows = [
        ...input.targets.map((target) => ({
          id: newId(),
          engagementId: id,
          direction: "allow" as const,
          kind: target.kind,
          value: target.value,
          createdAt,
        })),
        ...(input.excluded ?? []).map((target) => ({
          id: newId(),
          engagementId: id,
          direction: "deny" as const,
          kind: target.kind,
          value: target.value,
          createdAt,
        })),
      ];

      db.insert(scopeEntries).values(scopeRows).run();

      const created = this.get(id);
      if (!created) {
        return err(
          new HawaldarError(ErrorCode.PERSISTENCE_FAILURE, "Engagement was not readable after insert"),
        );
      }
      return ok(created);
    },

    get(id: string): EngagementRecord | undefined {
      const row = db.select().from(engagements).where(eq(engagements.id, id)).get();
      if (!row) {
        return undefined;
      }
      return toEngagement(row, loadScope(id));
    },

    list(): EngagementRecord[] {
      return db
        .select()
        .from(engagements)
        .all()
        .map((row) => toEngagement(row, loadScope(row.id)));
    },

    setStatus(id: string, status: EngagementStatusType): EngagementRecord | undefined {
      const updatedAt = nowMs();
      const pausedAt = status === EngagementStatus.PAUSED ? updatedAt : null;
      db.update(engagements)
        .set({ status, updatedAt, pausedAt })
        .where(eq(engagements.id, id))
        .run();
      return this.get(id);
    },
  };
}

export function createFindingStore(db: HawaldarDatabase) {
  return {
    create(input: {
      engagementId: string;
      title: string;
      summary: string;
      nodeId?: string;
      status?: FindingStatus;
    }): FindingRecord {
      const createdAt = nowMs();
      const record: FindingRecord = {
        id: newId(),
        engagementId: input.engagementId,
        nodeId: input.nodeId ?? null,
        status: input.status ?? "suspected",
        title: input.title,
        summary: input.summary,
        createdAt,
        updatedAt: createdAt,
      };
      db.insert(findings).values(record).run();
      return record;
    },

    setStatus(id: string, status: FindingStatus): FindingRecord | undefined {
      db.update(findings).set({ status, updatedAt: nowMs() }).where(eq(findings.id, id)).run();
      const row = db.select().from(findings).where(eq(findings.id, id)).get();
      return row
        ? {
            ...row,
            status: row.status as FindingStatus,
          }
        : undefined;
    },

    list(engagementId: string): FindingRecord[] {
      return db
        .select()
        .from(findings)
        .where(eq(findings.engagementId, engagementId))
        .all()
        .map((row) => ({ ...row, status: row.status as FindingStatus }));
    },
  };
}

export function createEvidenceStore(db: HawaldarDatabase) {
  return {
    add(input: {
      engagementId: string;
      kind: string;
      uri: string;
      findingId?: string;
      metadata?: Readonly<Record<string, unknown>>;
    }): EvidenceRecord {
      const record: EvidenceRecord = {
        id: newId(),
        engagementId: input.engagementId,
        findingId: input.findingId ?? null,
        kind: input.kind,
        uri: input.uri,
        metadata: input.metadata ?? {},
        createdAt: nowMs(),
      };
      db.insert(evidence)
        .values({
          ...record,
          metadata: JSON.stringify(record.metadata),
        })
        .run();
      return record;
    },

    list(engagementId: string): EvidenceRecord[] {
      return db
        .select()
        .from(evidence)
        .where(eq(evidence.engagementId, engagementId))
        .all()
        .map((row) => ({
          ...row,
          metadata: parseJsonObject(row.metadata),
        }));
    },
  };
}

export function createToolExecutionStore(db: HawaldarDatabase) {
  return {
    start(input: {
      engagementId: string;
      toolName: string;
      request: Readonly<Record<string, unknown>>;
    }): ToolExecutionRecord {
      const record: ToolExecutionRecord = {
        id: newId(),
        engagementId: input.engagementId,
        toolName: input.toolName,
        status: "started",
        request: input.request,
        stdout: "",
        stderr: "",
        exitCode: null,
        startedAt: nowMs(),
        finishedAt: null,
      };
      db.insert(toolExecutions)
        .values({
          ...record,
          request: JSON.stringify(record.request),
        })
        .run();
      return record;
    },

    finish(
      id: string,
      input: {
        status: Exclude<ToolExecutionStatus, "started">;
        stdout: string;
        stderr: string;
        exitCode: number | null;
      },
    ): ToolExecutionRecord | undefined {
      db.update(toolExecutions)
        .set({
          status: input.status,
          stdout: input.stdout,
          stderr: input.stderr,
          exitCode: input.exitCode,
          finishedAt: nowMs(),
        })
        .where(eq(toolExecutions.id, id))
        .run();
      const row = db.select().from(toolExecutions).where(eq(toolExecutions.id, id)).get();
      return row
        ? {
            ...row,
            status: row.status as ToolExecutionStatus,
            request: parseJsonObject(row.request),
          }
        : undefined;
    },

    list(engagementId: string): ToolExecutionRecord[] {
      return db
        .select()
        .from(toolExecutions)
        .where(eq(toolExecutions.engagementId, engagementId))
        .all()
        .map((row) => ({
          ...row,
          status: row.status as ToolExecutionStatus,
          request: parseJsonObject(row.request),
        }));
    },
  };
}

export function createCheckpointStore(db: HawaldarDatabase) {
  return {
    save(input: {
      engagementId: string;
      kind: string;
      payload: Readonly<Record<string, unknown>>;
    }): CheckpointRecord {
      const record: CheckpointRecord = {
        id: newId(),
        engagementId: input.engagementId,
        kind: input.kind,
        payload: input.payload,
        createdAt: nowMs(),
      };
      db.insert(checkpoints)
        .values({
          ...record,
          payload: JSON.stringify(record.payload),
        })
        .run();
      return record;
    },

    latest(engagementId: string): CheckpointRecord | undefined {
      const row = db
        .select()
        .from(checkpoints)
        .where(eq(checkpoints.engagementId, engagementId))
        .orderBy(desc(checkpoints.createdAt))
        .get();
      return row
        ? {
            ...row,
            payload: parseJsonObject(row.payload),
          }
        : undefined;
    },
  };
}

export function createHypothesisStore(db: HawaldarDatabase) {
  return {
    create(input: { engagementId: string; statement: string; confidence: number }): {
      id: string;
    } {
      const createdAt = nowMs();
      const id = newId();
      db.insert(hypotheses)
        .values({
          id,
          engagementId: input.engagementId,
          statement: input.statement,
          status: "open",
          confidence: input.confidence,
          createdAt,
          updatedAt: createdAt,
        })
        .run();
      return { id };
    },
  };
}

export function createDecisionStore(db: HawaldarDatabase) {
  return {
    record(input: { engagementId: string; agent: string; decision: string; rationale: string }): void {
      db.insert(agentDecisions)
        .values({
          id: newId(),
          engagementId: input.engagementId,
          agent: input.agent,
          decision: input.decision,
          rationale: input.rationale,
          createdAt: nowMs(),
        })
        .run();
    },
  };
}

export function createScriptStore(db: HawaldarDatabase) {
  return {
    record(input: {
      engagementId: string;
      hash: string;
      creatorAgent: string;
      sourcePath: string;
    }): string {
      const id = newId();
      db.insert(scripts)
        .values({
          id,
          engagementId: input.engagementId,
          hash: input.hash,
          creatorAgent: input.creatorAgent,
          sourcePath: input.sourcePath,
          createdAt: nowMs(),
        })
        .run();
      return id;
    },
  };
}
