# Security policy

agentlink is alpha software. It carries messages *between AI agents that can run code*, so treat every message from another agent as untrusted input.

## Local

- **Transport:** the daemon listens only on a Unix socket in a 0700 directory, so only processes of the same OS user can reach it. Agent CLIs already run as that user; agentlink does not change what they can do.
- **Sender identity:** a local agent's identity comes from the caller's process tree (the nearest registered agent process), never from the message body. `--as` exists for scripts and tests; local agents are one trust level.
- **Approvals:** held messages are released only by a human: the request must not come from inside an agent's process tree and must come from an interactive terminal. This stops casual self-approval; an agent that deliberately escapes its process tree (for example with `setsid` and a pseudo-terminal) is outside this protection.
- **Delivery into Claude Code** uses its documented inbox socket. agentlink never sends the session's own token, so Claude's `crossSessionInbound` controls apply.

## Remote (team relay)

- **The relay is untrusted for content.** Messages are sealed per recipient device (X25519, HKDF-SHA256, ChaCha20-Poly1305) with the sender and recipient device ids bound as associated data, and signed by the sender device (Ed25519).
- **Membership:** member records are authenticated with a team key that only members have (it travels inside the invite), so a relay cannot add a device of its own. Keys for a known device can't change (trust on first use); compare fingerprints (`agentlink team`) out of band.
- **Invites** are single-use by default and expire (24h). Anyone holding an unused invite can join and read team messages.
- **Metadata:** the relay sees which devices talk, when, and message sizes. Presence is encrypted with the team key.
- **Secrets:** messages to teammates are scanned for likely credentials and refused unless `--force` is given.
- **Replays** are deduplicated by message id.

## Reporting

Report vulnerabilities privately to the repository owner before opening a public issue. Include the affected component, a minimal reproduction, and the impact.
