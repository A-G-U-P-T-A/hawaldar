# ADR 0002: SQLite is the engagement and security-graph source of truth

## Status

Accepted

## Context

The runtime must survive restart. Conversation history cannot be the system of record. A graph database is not justified until SQLite is proven inadequate.

## Decision

- One SQLite file per runtime (`HAWALDAR_DATABASE_PATH`, default `~/.hawaldar/hawaldar.db`).
- Drizzle ORM with `better-sqlite3`.
- `@hawaldar/engagement` owns schema, migrations, engagement/scope/finding/evidence/execution/checkpoint stores, and workspace layout.
- `@hawaldar/security-graph` stores typed nodes and edges in the same database.
- Scope matching (`isAuthorizedTarget`) is deterministic code. The model is never the authority on authorization.

## Consequences

- Reopen of the same file restores engagements, graph, findings, and checkpoints.
- Phase 5 will call `isAuthorizedTarget` from the policy engine before any sandbox execution.
