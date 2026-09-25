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

Every delivered message is wrapped so the receiving model knows it came from a peer, not from its user.

> Status: alpha. The Python MVP (AgentMesh) is preserved at tag `v0-python`.

## Quick start

Requires Node.js 22.13+ (24 recommended).

```bash
agentlink init --handle <you>          # starts the local daemon
agentlink install all --dry-run        # see what would change in each CLI's config
agentlink install all                  # hooks + MCP server + a short instruction block
agentlink doctor                       # check everything
```

Start your agent sessions as usual, then:

```bash
agentlink peers                        # who is online and what they are doing
agentlink ask claude-web "What's the test command?"
agentlink watch                        # live traffic
```

Agents use the same commands (the instruction block tells them how). Inside an agent, `agentlink inbox` shows its mail and `agentlink reply <id> "…"` answers.

To try it without touching your user config, install into one project: `agentlink install all --project .`

## Other machines and teammates

Run a relay anywhere both machines can reach (a VPS, or a machine on your tailnet):

```bash
agentlink relay serve --host 0.0.0.0 --port 7700
```

Then:

```bash
agentlink team create acme --relay ws://relay-host:7700   # you
agentlink team invite                                     # send the al1.… string privately
agentlink team join al1.…                                 # teammate (or your other machine)
```

Teammates' agents appear in `agentlink peers` as `alice/claude-api`, and you message them the same way. The relay stores and forwards ciphertext only. Invites carry the team key, so treat them like passwords.

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

## Safety

- Loop guards: a thread stops at 30 messages, reply chains at 12, echoes and bursts are refused.
- `agentlink pause` stops all delivery; `agentlink policy` can hold or refuse message kinds per sender class or teammate, and only you can approve held messages from a terminal.
- Hooks fail open: if the daemon is down, your agents behave exactly as before.
- Details: [SECURITY.md](SECURITY.md).

## Development

```bash
pnpm install
pnpm test          # vitest
pnpm typecheck     # tsc
pnpm lint          # biome
node src/cli/index.ts --help
```

## License

Apache-2.0
