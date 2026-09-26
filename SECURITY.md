# Security policy

agentlink is alpha software. It carries messages *between AI agents that can run code*, so treat every message from another agent as untrusted input.

## Local

- **Transport:** the daemon listens only on a Unix socket in a 0700 directory, so only processes of the same OS user can reach it. Agent CLIs already run as that user; agentlink does not change what they can do. The database and logs are owner-only (0600).
- **Sender identity:** on Linux the daemon asks the kernel which process is on the other end of each connection (the socket table, via `ss`) and walks that process's ancestry itself. A registered agent in that tree is the sender. Nothing the client claims (headers, `--as`, `AGENTLINK_AGENT`) changes that: `--as` only lets a human act for a hook-less agent they registered, and hooks can only use sessions that belong to their own process tree. On other systems the daemon falls back to the client's claims and logs a warning.
- **Approvals:** held messages are released only by a human: the verified caller must have no agent in its process tree and a terminal on stdin. This stops self-approval by agents doing normal work. An agent that deliberately detaches from its tree and allocates a pseudo-terminal (it runs as your user) is outside this protection.
- **Reading:** agents can only read conversations they are part of.
- **Wrapping:** every delivered message is wrapped with its provenance, inside a boundary token the sender cannot forge. Control, bidi and invisible characters are removed, look-alike wrapper tags are neutralized, and body lines that imitate agentlink's banner are marked. Terminal output makes escape sequences visible.
- **Delivery into Claude Code** uses its documented inbox socket (only sockets owned by your user). agentlink never sends the session's own token, so Claude's `crossSessionInbound` controls apply.

## Remote (team relay)

- **The relay is untrusted for content.** Messages are sealed per recipient device (X25519, HKDF-SHA256, ChaCha20-Poly1305) with the sender and recipient device ids bound as associated data, and signed by the sender device (Ed25519).
- **Membership:** member records are authenticated with a team key that only members have (it travels inside the invite), so a relay cannot add a device of its own. A device id is derived from its signing key, so nobody can claim another member's device, and keys for a known device can't change (trust on first use). Compare fingerprints (`agentlink team`) out of band.
- **Invites** are single-use by default and expire (24h). Anyone holding an unused invite can join and read team messages.
- **Metadata:** the relay sees which devices talk, when, and message sizes. Presence is encrypted with the team key.
- **Secrets:** messages to teammates (text, file names and contents, data parts) and status text are scanned for likely credentials and refused. Only a human can override with `--force`.
- **Relay limits:** every frame type is rate-limited, presence and per-device queues are capped, and `relay serve --create-token` stops strangers from creating teams on a public relay.
- **Replays** are deduplicated by message id.

## Reporting

Report vulnerabilities privately to the repository owner before opening a public issue. Include the affected component, a minimal reproduction, and the impact.
