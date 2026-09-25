# AGENTS.md: agentlink

agentlink lets AI coding agents message each other. It is built from a local daemon, a CLI, an MCP server, per-CLI adapters, and an end-to-end encrypted relay.

- Source of truth: `agentlink-plan.md`.
- Background research: `research/landscape-2026-09.md`.

## Commands

| Command | What it does |
|---|---|
| `pnpm install` | Install dependencies |
| `pnpm typecheck` | Run `tsc` (TypeScript 7, no emit) |
| `pnpm lint` | Run Biome; `pnpm format` auto-fixes |
| `pnpm test` | Unit tests |
| `pnpm test:integration` | Starts real daemons and relays in temp dirs |
| `pnpm test:security` | Security tests |
| `pnpm build` | Emits `dist/` |
| `pnpm dev -- <args>` | Runs `src/cli/index.ts` directly on Node 24 |

## Conventions

**Language and syntax**
- TypeScript, ESM, Node ≥22.13.
- The source runs directly under Node's type stripping, so only erasable syntax is allowed: no enums, no namespaces, no parameter properties.
- Relative imports use `.ts` extensions; `tsc` rewrites them to `.js` on build.
- Use `import type` for type-only imports.

**Dependencies**
- Keep them minimal: `zod`, `ws`, and the MCP SDK.
- Pin exact versions. Any new dependency must have been published at least 7 days ago.

**Input validation**
- Validate every external input with zod: envelopes, daemon request bodies, hook payloads, relay frames.

**Tests**
- Tests never touch the real `~/.agentlink` or real agent configs.
- Set `AGENTLINK_HOME` and `HOME` to temp directories.

**Hooks**
- Hooks must fail open: if the daemon is unreachable, exit 0 with no output.

**Security invariants**
- Identity comes from authentication, never from message bodies: PID ancestry locally, Ed25519 signatures remotely.
- Approvals are human-only (TTY or UI). They are never accepted from an agent, and never arrive as a message.
