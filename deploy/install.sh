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
if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "$tmp/agentlink.tgz" | cut -d' ' -f1)"
elif command -v shasum >/dev/null 2>&1; then
  actual="$(shasum -a 256 "$tmp/agentlink.tgz" | cut -d' ' -f1)"   # macOS
else
  fail "need sha256sum or shasum to check the download"
fi
[ "$expected" = "$actual" ] || fail "checksum mismatch (expected $expected, got $actual)"

say "Installing into $PREFIX…"
force=""
if [ -e "$PREFIX/bin/agentlink" ] || [ -L "$PREFIX/bin/agentlink" ]; then
  case "$(readlink "$PREFIX/bin/agentlink" 2>/dev/null)" in
    *node_modules/agentlink*) ;;  # an earlier install from this script: npm updates it
    *)
      say "  replacing $PREFIX/bin/agentlink (was: $(readlink "$PREFIX/bin/agentlink" 2>/dev/null || echo a file))"
      force="--force"
      ;;
  esac
fi
npm install --global --prefix "$PREFIX" --no-fund --no-audit $force "$tmp/agentlink.tgz" >/dev/null
BIN="$PREFIX/bin/agentlink"
[ -x "$BIN" ] || fail "install finished but $BIN is missing"

say ""
say "✓ agentlink $("$BIN" --version) installed at $BIN"
case ":$PATH:" in
  *":$PREFIX/bin:"*) ;;
  *) say "  Add it to your PATH:  export PATH=\"$PREFIX/bin:\$PATH\"  (and put that in your shell profile)";;
esac
if [ "$(uname -s)" = "Linux" ] && ! command -v ss >/dev/null 2>&1; then
  say ""
  say "! 'ss' is missing (package iproute2). Without it agentlink cannot check which agent is"
  say "  calling and trusts what callers claim. Install it, e.g.: sudo apt install iproute2"
fi
say ""
say "Next:"
say "  agentlink setup                     # wire up every agent CLI on this machine (--dry-run to preview)"
say "  agentlink setup --join <code>       # …and join a team with the code someone gave you"
