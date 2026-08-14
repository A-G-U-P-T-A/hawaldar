import { and, eq } from "drizzle-orm";
import { newId, nowMs, schema, type HawaldarDatabase } from "@hawaldar/engagement";
import type { AddEdgeInput, GraphEdge, GraphEdgeType, GraphNode, GraphNodeType, UpsertNodeInput } from "./types.js";

function parseJsonObject(raw: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }
  return parsed as Record<string, unknown>;
}

function toNode(row: typeof schema.graphNodes.$inferSelect): GraphNode {
  return {
    id: row.id,
    engagementId: row.engagementId,
    type: row.type as GraphNodeType,
    canonicalKey: row.canonicalKey,
    label: row.label,
    data: parseJsonObject(row.data),
    firstSeenAt: row.firstSeenAt,
    lastSeenAt: row.lastSeenAt,
  };
}

function toEdge(row: typeof schema.graphEdges.$inferSelect): GraphEdge {
  return {
    id: row.id,
    engagementId: row.engagementId,
    sourceId: row.sourceId,
    targetId: row.targetId,
    type: row.type as GraphEdgeType,
    data: parseJsonObject(row.data),
    createdAt: row.createdAt,
  };
}

export function createGraphStore(db: HawaldarDatabase) {
  return {
    upsertNode(input: UpsertNodeInput): GraphNode {
      const existing = db
        .select()
        .from(schema.graphNodes)
        .where(
          and(
            eq(schema.graphNodes.engagementId, input.engagementId),
            eq(schema.graphNodes.canonicalKey, input.canonicalKey),
          ),
        )
        .get();

      const seenAt = nowMs();
      const data = JSON.stringify(input.data ?? {});

      if (existing) {
        db.update(schema.graphNodes)
          .set({
            type: input.type,
            label: input.label,
            data,
            lastSeenAt: seenAt,
          })
          .where(eq(schema.graphNodes.id, existing.id))
          .run();
        const updated = db
          .select()
          .from(schema.graphNodes)
          .where(eq(schema.graphNodes.id, existing.id))
          .get();
        if (!updated) {
          throw new Error("graph node disappeared during upsert");
        }
        return toNode(updated);
      }

      const row = {
        id: newId(),
        engagementId: input.engagementId,
        type: input.type,
        canonicalKey: input.canonicalKey,
        label: input.label,
        data,
        firstSeenAt: seenAt,
        lastSeenAt: seenAt,
      };
      db.insert(schema.graphNodes).values(row).run();
      return toNode(row);
    },

    addEdge(input: AddEdgeInput): GraphEdge {
      const existing = db
        .select()
        .from(schema.graphEdges)
        .where(
          and(
            eq(schema.graphEdges.engagementId, input.engagementId),
            eq(schema.graphEdges.sourceId, input.sourceId),
            eq(schema.graphEdges.targetId, input.targetId),
            eq(schema.graphEdges.type, input.type),
          ),
        )
        .get();

      if (existing) {
        return toEdge(existing);
      }

      const row = {
        id: newId(),
        engagementId: input.engagementId,
        sourceId: input.sourceId,
        targetId: input.targetId,
        type: input.type,
        data: JSON.stringify(input.data ?? {}),
        createdAt: nowMs(),
      };
      db.insert(schema.graphEdges).values(row).run();
      return toEdge(row);
    },

    listNodes(engagementId: string): GraphNode[] {
      return db
        .select()
        .from(schema.graphNodes)
        .where(eq(schema.graphNodes.engagementId, engagementId))
        .all()
        .map(toNode);
    },

    listEdges(engagementId: string): GraphEdge[] {
      return db
        .select()
        .from(schema.graphEdges)
        .where(eq(schema.graphEdges.engagementId, engagementId))
        .all()
        .map(toEdge);
    },
  };
}
