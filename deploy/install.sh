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

# WSL: 1 or 2 (WSL 1 reports "Microsoft" in its kernel release; WSL 2 registers WSLInterop).
wsl=""
if grep -qiE 'microsoft-standard|wsl2' /proc/sys/kernel/osrelease 2>/dev/null || [ -e /proc/sys/fs/binfmt_misc/WSLInterop ]; then
  wsl=2
elif grep -qi microsoft /proc/sys/kernel/osrelease 2>/dev/null; then
  wsl=1
fi
if [ -n "$wsl" ]; then
  # WSL puts Windows' PATH after Linux's: a Windows Node.js can't run agentlink for WSL agents.
  for tool in node npm; do
    found="$(command -v "$tool" 2>/dev/null || command -v "$tool.exe" 2>/dev/null || true)"
    case "$found" in
      /mnt/*) fail "$tool is the Windows install ($found); agentlink inside WSL needs Node.js installed inside WSL, e.g. with nvm (https://github.com/nvm-sh/nvm): nvm install 24" ;;
    esac
  done
fi
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
if [ "$wsl" = 1 ]; then
  say ""
  say "! This is WSL 1: agentlink cannot check which agent is calling there. Switch the distro to"
  say "  WSL 2 (in Windows PowerShell: wsl --set-version <distro> 2)."
fi
say ""
say "Next:"
say "  agentlink setup                     # wire up every agent CLI on this machine (--dry-run to preview)"
say "  agentlink setup --join <code>       # …and join a team with the code someone gave you"
