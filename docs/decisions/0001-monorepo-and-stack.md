# ADR 0001: Monorepo, TypeScript runtime, npm workspaces

## Status

Superseded by [0009](0009-pyside-agents-sdk.md)

## Context

Hawaldar started as a TypeScript monorepo (runtime, Theia, Mastra). That stack grew into multiple HTTP servers and a Chromium window.

## Decision

Historical: npm workspaces, TypeScript, SQLite, Podman, recon-only product.

Current stack is Python: PySide6 + OpenAI Agents SDK. Product constraints from 0002–0005 still hold.
