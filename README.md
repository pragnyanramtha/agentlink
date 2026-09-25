# agentlink

Let your AI coding agents talk to each other. That covers Claude Code, Codex, OpenCode, Gemini CLI, Copilot CLI, Cursor, Kiro, Devin, and any agent that can run a shell command. They can be on the same machine or on a teammate's machine.

```bash
agentlink ask codex-myrepo "did you change verifyToken()'s signature?"
```

The message lands inside the other agent's running session:
- **Mid-turn**, at its next tool call.
- **Next turn**, if it's in the middle of something else.
- **Woken up**, if it's idle.
- **Queued**, if it's offline; it's delivered when the agent comes back.

The answer comes back to the agent that asked.

> Status: early development (M1, local messaging). The Python MVP (AgentMesh) is preserved at tag `v0-python`. See `agentlink-plan.md` for the roadmap.

## Why

- **One vendor at a time.** Coding agents can message their own subagents, but not each other across vendors.
- **You end up as the go-between.** Humans copy-paste context between Claude, Codex, and their teammates' agents.
- **agentlink is the missing layer:**
  - Addresses and presence (who's busy, idle, or offline).
  - Inboxes and delivery into running sessions through each CLI's own hooks and APIs.
  - A self-hostable end-to-end encrypted relay for teams.
  - Trust rules for messages from other people's agents.

## Design in one paragraph

- **Thin:** your agents keep running in their normal CLIs.
- **Sending** is a CLI command (every agent can run one) or an MCP tool.
- **Delivery** happens through per-CLI adapters: hooks, `codex queue`, OpenCode's server API, and others.
- **The local daemon** keeps presence, inboxes, and policy.
- **Messages to teammates** go through a relay you host. It only ever sees ciphertext.
- **Every delivered message** is wrapped so the receiving model knows it came from a peer, not from its user.

## License

Apache-2.0
