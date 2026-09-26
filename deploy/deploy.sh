#!/bin/sh
# Deploy agentlink to a server: the relay (systemd user service), Caddy (TLS + static files, Docker),
# an optional Cloudflare Tunnel connector (Docker), and the install script + package.
#
#   deploy/deploy.sh <user@host> <ssh-port> <direct-host>
#
#   direct-host   a name pointing at the server's IP; Caddy gets a Let's Encrypt certificate for it
#                 (e.g. 116-203-46-74.sslip.io)
#
# Optional environment:
#   PUBLIC_HOST     the name users should use (install script, docs); defaults to direct-host
#   CF_TUNNEL_ID    run a Cloudflare Tunnel for PUBLIC_HOST (create it first with
#                   `cloudflared tunnel create` and `cloudflared tunnel route dns <tunnel> <PUBLIC_HOST>`)
#   CF_CREDENTIALS  the tunnel's credentials file (default ~/.cloudflared/$CF_TUNNEL_ID.json)
#
# Needs pnpm locally, and Docker, Node.js >= 22.13 and passwordless sudo on the server.
set -eu

TARGET="${1:?usage: deploy/deploy.sh <user@host> <ssh-port> <direct-host>}"
PORT="${2:?ssh port}"
DIRECT_HOST="${3:?direct host name, e.g. 116-203-46-74.sslip.io}"
PUBLIC_HOST="${PUBLIC_HOST:-$DIRECT_HOST}"
CF_TUNNEL_ID="${CF_TUNNEL_ID:-}"
CF_CREDENTIALS="${CF_CREDENTIALS:-$HOME/.cloudflared/$CF_TUNNEL_ID.json}"
SSH="ssh -p $PORT $TARGET"

pnpm -s build
rm -rf .deploy && mkdir -p .deploy/dl
pnpm pack --pack-destination .deploy >/dev/null
mv .deploy/agentlink-*.tgz .deploy/dl/agentlink.tgz
(cd .deploy/dl && sha256sum agentlink.tgz > agentlink.tgz.sha256)
sed "s/__HOST__/$PUBLIC_HOST/g" deploy/install.sh > .deploy/install.sh
files=".deploy/dl/agentlink.tgz .deploy/dl/agentlink.tgz.sha256 .deploy/install.sh deploy/Caddyfile deploy/agentlink-relay.service"
if [ -n "$CF_TUNNEL_ID" ]; then
  [ -r "$CF_CREDENTIALS" ] || { echo "missing tunnel credentials $CF_CREDENTIALS" >&2; exit 1; }
  cat > .deploy/cloudflared.yml <<EOF
tunnel: $CF_TUNNEL_ID
credentials-file: /etc/cloudflared/agentlink.json
ingress:
  - hostname: $PUBLIC_HOST
    service: http://127.0.0.1:8080
  - service: http_status:404
EOF
  cp "$CF_CREDENTIALS" .deploy/cloudflared.json
  chmod 600 .deploy/cloudflared.json
  files="$files .deploy/cloudflared.yml .deploy/cloudflared.json"
fi
# shellcheck disable=SC2086
scp -q -P "$PORT" $files "$TARGET:/tmp/"

$SSH "DIRECT_HOST='$DIRECT_HOST' CF_TUNNEL_ID='$CF_TUNNEL_ID' sh -s" <<'REMOTE'
set -eu
# 1. The package, for this machine and for the install script.
npm install --global --prefix "$HOME/.local" --no-fund --no-audit /tmp/agentlink.tgz >/dev/null
sudo mkdir -p /srv/agentlink/dl /etc/caddy
sudo cp /tmp/agentlink.tgz /tmp/agentlink.tgz.sha256 /srv/agentlink/dl/
sudo cp /tmp/install.sh /srv/agentlink/install.sh
sudo cp /tmp/Caddyfile /etc/caddy/Caddyfile
sudo chmod -R a+rX /srv/agentlink /etc/caddy

# 2. The relay, on localhost only.
mkdir -p "$HOME/.config/systemd/user" "$HOME/.config/agentlink"
cp /tmp/agentlink-relay.service "$HOME/.config/systemd/user/agentlink-relay.service"
systemctl --user daemon-reload
systemctl --user enable agentlink-relay.service >/dev/null 2>&1
systemctl --user restart agentlink-relay.service

# 3. Caddy: automatic TLS for the direct name, plus the tunnel origin on 127.0.0.1:8080.
docker rm -f agentlink-caddy >/dev/null 2>&1 || true
docker run -d --name agentlink-caddy --restart unless-stopped --network host \
  -e AGENTLINK_HOST="$DIRECT_HOST" \
  -v /etc/caddy/Caddyfile:/etc/caddy/Caddyfile:ro \
  -v /srv/agentlink:/srv/agentlink:ro \
  -v agentlink_caddy_data:/data -v agentlink_caddy_config:/config \
  caddy:2.10 >/dev/null

# 4. Cloudflare Tunnel connector (only if configured).
if [ -n "$CF_TUNNEL_ID" ]; then
  sudo mkdir -p /etc/cloudflared
  sudo mv /tmp/cloudflared.yml /etc/cloudflared/config.yml
  sudo mv /tmp/cloudflared.json /etc/cloudflared/agentlink.json
  sudo chown -R 65532:65532 /etc/cloudflared
  sudo chmod 700 /etc/cloudflared
  sudo chmod 600 /etc/cloudflared/config.yml /etc/cloudflared/agentlink.json
  docker rm -f agentlink-cloudflared >/dev/null 2>&1 || true
  docker run -d --name agentlink-cloudflared --restart unless-stopped --network host \
    -v /etc/cloudflared:/etc/cloudflared:ro \
    cloudflare/cloudflared:2026.9.1 tunnel --no-autoupdate --config /etc/cloudflared/config.yml run >/dev/null
fi
rm -f /tmp/agentlink.tgz /tmp/agentlink.tgz.sha256 /tmp/install.sh /tmp/Caddyfile /tmp/agentlink-relay.service

sleep 4
echo "relay: $(systemctl --user is-active agentlink-relay.service)"
docker ps --filter name=agentlink- --format '{{.Names}}: {{.Status}}'
REMOTE

rm -rf .deploy
echo "Deployed. Check: curl -fsS https://$PUBLIC_HOST/health  and  curl -fsSL https://$PUBLIC_HOST/install.sh | head"
