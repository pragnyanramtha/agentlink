#!/bin/sh
# Deploy agentlink to a server: TLS proxy (Caddy, Docker), the relay (systemd user service), and
# the install script + package. Run from the repository root:
#   deploy/deploy.sh ubuntu@116.203.46.74 33789 116-203-46-74.sslip.io
# Needs: pnpm locally; Docker, Node >= 22.13 and passwordless sudo on the server.
set -eu

TARGET="${1:?usage: deploy/deploy.sh <user@host> <ssh-port> <public-host-name>}"
PORT="${2:?ssh port}"
HOST="${3:?public host name, e.g. 116-203-46-74.sslip.io}"
SSH="ssh -p $PORT $TARGET"

pnpm -s build
rm -rf .deploy && mkdir -p .deploy/dl
pnpm pack --pack-destination .deploy >/dev/null
mv .deploy/agentlink-*.tgz .deploy/dl/agentlink.tgz
(cd .deploy/dl && sha256sum agentlink.tgz > agentlink.tgz.sha256)
sed "s/__HOST__/$HOST/g" deploy/install.sh > .deploy/install.sh

scp -q -P "$PORT" .deploy/dl/agentlink.tgz .deploy/dl/agentlink.tgz.sha256 .deploy/install.sh \
  deploy/Caddyfile deploy/agentlink-relay.service "$TARGET:/tmp/"

$SSH "HOST='$HOST' sh -s" <<'REMOTE'
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

# 3. TLS proxy (automatic certificates), restarted on boot by Docker.
docker rm -f agentlink-caddy >/dev/null 2>&1 || true
docker run -d --name agentlink-caddy --restart unless-stopped --network host \
  -e AGENTLINK_HOST="$HOST" \
  -v /etc/caddy/Caddyfile:/etc/caddy/Caddyfile:ro \
  -v /srv/agentlink:/srv/agentlink:ro \
  -v agentlink_caddy_data:/data -v agentlink_caddy_config:/config \
  caddy:2.10 >/dev/null

sleep 3
systemctl --user is-active agentlink-relay.service
docker ps --filter name=agentlink-caddy --format '{{.Status}}'
REMOTE

echo "Deployed. Check: curl -fsS https://$HOST/health  and  curl -fsSL https://$HOST/install.sh | head"
