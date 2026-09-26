# Hosting an agentlink server

One small Linux server runs everything a team needs:

| Part | What it does | How it runs |
|---|---|---|
| Relay | Stores and forwards sealed messages, holds them for offline machines, redeems invite codes. Cannot read messages. | `agentlink relay serve` on `127.0.0.1:7700`, a systemd user service (`agentlink-relay.service`) |
| TLS proxy | `wss://` and `https://` with automatic Let's Encrypt certificates | Caddy in Docker (`agentlink-caddy`, restarts on boot) |
| Install script | `curl -fsSL https://<host>/install.sh \| sh` downloads the package from the server, checks its SHA-256, installs into `~/.local` | Static files in `/srv/agentlink`, served by Caddy |

The community relay is `116-203-46-74.sslip.io`. sslip.io maps that name to the IP address, so it gets a real certificate without buying a domain; switch to your own domain by pointing a DNS name at the server and deploying with that name.

## Deploy or update

From the repository root, with SSH access to the server (Docker, Node.js ≥ 22.13, and passwordless sudo there):

```bash
deploy/deploy.sh ubuntu@116.203.46.74 33789 116-203-46-74.sslip.io
```

It builds the package, uploads it with the install script and the configs, installs agentlink on the server, restarts the relay, and (re)starts Caddy. Run it again to ship a new version; relay data in `~/.agentlink/relay` is kept.

Check it:

```bash
curl -fsS https://116-203-46-74.sslip.io/health
curl -fsSL https://116-203-46-74.sslip.io/install.sh | head
```

## Public or private

- **Public (default):** anyone can create a team, within quotas: 5 new teams per address per hour, 100 devices per team, 500 MB queued per team, 10,000 teams in total. Every message frame is rate-limited, and invite-code lookups are limited per address.
- **Private:** put `AGENTLINK_RELAY_CREATE_TOKEN=<secret>` in `~/.config/agentlink/relay.env` on the server and restart the relay (`systemctl --user restart agentlink-relay`). Creating a team then needs `agentlink team create <name> --create-token <secret>`; joining still only needs an invite.

## Operating notes

- **Logs:** `journalctl --user -u agentlink-relay -f` (relay), `docker logs -f agentlink-caddy` (TLS proxy).
- **Backups:** `~/.agentlink/relay/relay.db` holds the team rosters, pending invites and queued ciphertext. Losing it means teams re-join; message contents are never on the server in the clear.
- **Moving the relay:** copy `relay.db` to the new server, deploy there, then run `agentlink team relay wss://<new-host>` on each device.
- **Ports:** only 80 and 443 (and SSH) need to be reachable; the relay itself listens on localhost.
