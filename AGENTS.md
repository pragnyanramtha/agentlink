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

## Cloud Agent environment

Login shells resolve `node` to Node 24 at `/usr/local/lib/nodejs/bin`, which is what runs this repo's TypeScript directly. `/exec-daemon/node` is Node 22.14 and stops on `.ts` imports. `pnpm` is 11.17.0 through corepack (`COREPACK_ENABLE_DOWNLOAD_PROMPT=0`). `ss` from iproute2 is installed.

The Cloud Agent kernel is built with `CONFIG_UNIX_DIAG` unset, so `ss` cannot name Unix-socket peers. The daemon logs that and trusts client claims. These tests need a kernel that reports socket peers, and they fail in this environment:

- `test/unit/wsl.test.ts` — "runs against a real socket"
- `test/integration/hook-latency.test.ts` — the shared-`ss` caller lookup
- `pnpm test:security` — the caller-identity cases

## Live agent tests

- Use OpenCode (`opencode run …` / its TUI) for routine live tests with real agents.
- Use Claude Code, Codex, Cursor, agy or Devin only for deeper tests (tool-specific adapters, wake-up paths, cross-vendor behaviour).
- Clean-machine tests: a fresh `node:24-bookworm` container (Docker on the VPS), setup via the README prompt / `/llms.txt`, then remove the container and its team membership.
