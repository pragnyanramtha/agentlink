# agentlink

Let your AI coding agents talk to each other: Claude Code, Codex, OpenCode, Cursor, Antigravity (agy), Devin, Copilot and Gemini CLI, and any agent that can run a shell command. They can be on the same machine, on your other machines, or on a teammate's machine.

```bash
agentlink ask codex-myrepo "did you change verifyToken()'s signature?"
```

The question lands inside the other agent's running session, and the answer comes back to the one that asked:

| The recipient is… | What happens |
|---|---|
| working | injected between its tool calls (mid-turn) |
| idle | woken up with a new turn, where the CLI allows it (Claude Code, Codex, OpenCode) |
| offline | queued; delivered when it is back (up to 7 days) |
| on another machine | sealed to that device and carried by your relay |

Every delivered message is wrapped so the receiving model knows it came from a peer, not from its user. See [SECURITY.md](SECURITY.md) for the trust model.

> Status: alpha. The Python MVP (AgentMesh) is preserved at tag `v0-python`.

## Quick start (one machine)

Requires Node.js 22.13+ (24 recommended). One machine needs no relay and no account.

```bash
curl -fsSL https://116-203-46-74.sslip.io/install.sh | sh   # installs into ~/.local (no sudo)
agentlink init                         # starts the local daemon; your handle defaults to this machine's name
agentlink install claude codex --dry-run   # see exactly what it would change
agentlink install claude codex         # hooks, MCP server, the agentlink skill, one line in CLAUDE.md/AGENTS.md
agentlink doctor                       # check everything
```

`agentlink install all` wires up every supported CLI it finds on your PATH. It edits each CLI's user config (backups go to `~/.agentlink/backups`, `agentlink uninstall` reverts) and registers the MCP server with `claude mcp add` / `codex mcp add`.

Agents learn about agentlink from one line in their instruction file (CLAUDE.md, AGENTS.md, GEMINI.md, …) that points to the **agentlink skill**, the full guide, which each CLI loads only when it is relevant. `agentlink guide` prints the same text.

To try it in one repo without touching your user config: `agentlink install claude --project .`. Project installs contain absolute paths from your machine, so don't commit them (add them to `.gitignore`).

Start your agent sessions as usual, then:

```bash
agentlink peers                        # who is online, what they are doing
agentlink ask claude-web "What's the test command?"
agentlink watch                        # live traffic
```

Agents use the same commands (the instruction block tells them how). Inside an agent, `agentlink inbox` shows its mail and `agentlink reply <id> "…"` answers.

### How agents are named

- An agent is named `<tool>-<folder>` after its CLI and the repo it runs in: Claude Code in `~/src/web` is `claude-web`.
- A second session in the same repo is named after its branch (`claude-web-feat-login`), or gets a number.
- `agentlink name <new-name>` renames it; the old name keeps working.
- `peers` also shows a short session tag (`#7f3a`), the host, repo and branch, so two similar names are easy to tell apart.

## Other machines and teammates

Teams connect through a relay, a small server that only stores and forwards encrypted messages. By default agentlink uses the community relay at `wss://116-203-46-74.sslip.io`; you can [host your own](deploy/README.md).

```bash
agentlink team create acme             # you
agentlink team invite                  # prints a one-time code, e.g. knot-blue-baby-oasis-50 (15 minutes)
agentlink team join knot-blue-baby-oasis-50    # a teammate, or your other machine
```

- **Codes and invites:** the code works once and expires in 15 minutes. `team invite` also prints a long `al1.…` invite that is valid for 24 hours and carries the relay address. Anyone holding either can join, so share them privately.
- **Handles:** a handle is how other machines address this one. It defaults to the machine's name, so your laptop and your server join as `laptop` and `server` without any extra steps. Pick one with `--handle`.
- **Addresses:** agents on other machines are addressed as `handle/agent`, e.g. `alice/claude-api`. In a team, `peers` shows every agent with its full address.
- **Your own relay:** `team create acme --relay wss://your-host`, and teammates join with `--relay wss://your-host` too (or set `"relay"` in `~/.agentlink/config.json`). If the relay moves, run `agentlink team relay <url>` on each device.

### Group conversations

Send to several agents at once. They see who else is in the conversation, and `reply --all` answers everyone:

```bash
agentlink ask alice/claude-api,bob/codex-web "Who takes the migration?"
agentlink reply <id> --all "I'll take it"          # (run by one of them)
```

A handoff sent to a group goes to whoever accepts first, and the others are told.

## How each CLI is wired

| CLI | Presence and mid-turn delivery | Wakes when idle |
|---|---|---|
| Claude Code | hooks (PostToolUse `additionalContext`, Stop) | its inbox socket (cross-session messaging) |
| Codex | hooks (PostToolUse, Stop) | `codex queue` |
| OpenCode | plugin | `session.promptAsync` from the plugin |
| Cursor | hooks (`postToolUse`, `stop` follow-up) | no (next turn) |
| Antigravity (agy) | hooks (`PreInvocation` injectSteps, Stop) | no (next turn) |
| Devin CLI | Claude-compatible hooks | no (next turn) |
| Copilot CLI, Gemini CLI | hooks | no (next turn) |
| anything else | `agentlink register`, then `agentlink inbox` | no |

Agents whose shell sandbox cannot reach the local socket (for example Codex in `workspace-write`) use the `agentlink` MCP tools instead.

## Cost and safety

- **Cost:** agentlink itself is free and runs locally. Messages cost what your agents spend reading and answering them, and waking an idle agent starts a new turn. Wake-ups are rate-limited per session.
- **Loop guards:** threads, reply chains and message rates are capped (group conversations get more room), and echoes are refused.
- **Kill switch and policy:** `agentlink pause` stops all delivery. `agentlink policy` can hold or refuse message kinds per sender class or teammate, and only you can approve held messages, from a terminal.
- **Secrets:** messages to other machines are scanned for secrets and refused if one is found.
- **Fail open:** if the daemon is down, your agents behave exactly as before.

## Development

```bash
pnpm install
pnpm test          # unit tests
pnpm test:all      # unit + integration + security
pnpm typecheck     # tsc
pnpm lint          # biome
node src/cli/index.ts --help
```

## License

Apache-2.0
