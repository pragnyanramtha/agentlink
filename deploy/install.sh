#!/bin/sh
# agentlink installer: downloads the package from this server, checks it, installs it for the
# current user (no sudo), and prints the next steps.
#   curl -fsSL https://__HOST__/install.sh | sh
set -eu

HOST="__HOST__"
BASE="https://$HOST/dl"
PREFIX="${AGENTLINK_PREFIX:-$HOME/.local}"

say() { printf '%s\n' "$*"; }
fail() { printf 'agentlink install: %s\n' "$*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || fail "Node.js 22.13 or newer is required (https://nodejs.org, or: nvm install 24)"
command -v npm >/dev/null 2>&1 || fail "npm is required (it comes with Node.js)"
node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)' \
  || fail "Node.js $(node -v) is too old; agentlink needs 22.13 or newer (nvm install 24)"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
say "Downloading agentlink from $HOST…"
curl -fsSL "$BASE/agentlink.tgz" -o "$tmp/agentlink.tgz"
curl -fsSL "$BASE/agentlink.tgz.sha256" -o "$tmp/agentlink.tgz.sha256"
expected="$(cut -d' ' -f1 "$tmp/agentlink.tgz.sha256")"
actual="$(sha256sum "$tmp/agentlink.tgz" 2>/dev/null | cut -d' ' -f1 || shasum -a 256 "$tmp/agentlink.tgz" | cut -d' ' -f1)"
[ "$expected" = "$actual" ] || fail "checksum mismatch (expected $expected, got $actual)"

say "Installing into $PREFIX…"
npm install --global --prefix "$PREFIX" --no-fund --no-audit "$tmp/agentlink.tgz" >/dev/null
BIN="$PREFIX/bin/agentlink"
[ -x "$BIN" ] || fail "install finished but $BIN is missing"

say ""
say "✓ agentlink $("$BIN" --version) installed at $BIN"
case ":$PATH:" in
  *":$PREFIX/bin:"*) ;;
  *) say "  Add it to your PATH:  export PATH=\"$PREFIX/bin:\$PATH\"  (and put that in your shell profile)";;
esac
say ""
say "Next:"
say "  agentlink init                      # start the local daemon"
say "  agentlink install claude codex      # wire up the agent CLIs you use (--dry-run to preview)"
say "  agentlink team join <code>          # join a team with the code someone gave you"
say "  agentlink team create <name>        # or start your own team"
