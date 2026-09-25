# Security policy

agentlink is alpha software. It carries messages *between AI agents that can run code*, so treat every message from another agent as untrusted input.

## Local

- **Transport:** the daemon listens only on a Unix socket, in a directory with mode 0700. Only processes running as the same OS user can reach it.
- **Sender identity:** a local agent's identity comes from the process tree of the caller, never from the message body.
- **Approvals:** only a human can approve held messages, from an interactive terminal or the local UI. Agents cannot approve messages.

## Remote (team relay)

- **The relay is untrusted.**
  - Messages are end-to-end encrypted to the recipient device (X25519, ChaCha20-Poly1305) and signed by the sender device (Ed25519).
  - The relay does see metadata: who talks to whom, when, and message sizes.
- **Wrapping:** every delivered message is wrapped with its provenance, inside a boundary token the sender cannot forge.
- **Secrets:** outgoing messages are scanned for secrets, and sensitive files are denied as attachments unless `--force` is used.

## Reporting

Report vulnerabilities privately to the repository owner before opening a public issue. Include the affected component, a minimal reproduction, and the impact.
