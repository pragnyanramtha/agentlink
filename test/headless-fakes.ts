import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Stand-ins for agent CLIs (never the real ones): they record argv, cwd, env and stdin per run
 * (AGENTLINK_RUN), then print the JSONL their real counterpart prints. Modes (file "mode"):
 * ok (default), sleep (until signalled), fail (no output, exit 1), probe (calls the daemon as
 * itself: GET /v1/approvals and POST /v1/headless, recording the HTTP statuses), orphan (answers,
 * leaving a SIGTERM-ignoring grandchild), slow-agents (`claude agents` takes 3s).
 */
const SCRIPT = String.raw`#!/bin/bash
dir="$(cd "$(dirname "$0")" && pwd)"
name="$(basename "$0")"
mode="$(cat "$dir/mode" 2>/dev/null)"
if [ "$name" = claude ] && [ "$1" = agents ]; then
  [ "$mode" = slow-agents ] && { touch "$dir/agents-called"; sleep 3; }
  cat "$dir/claude-agents" 2>/dev/null || echo '[]'; exit 0
fi
run="$AGENTLINK_RUN"
trap 'echo INT > "$dir/$run.sig"; exit 130' INT
printf '%s\n' "$@" > "$dir/$run.argv"
pwd > "$dir/$run.cwd"
env > "$dir/$run.env"
echo $$ > "$dir/$run.pid"
cat > "$dir/$run.stdin"
if [ "$mode" = fail ]; then echo "fake: not logged in" >&2; exit 1; fi
# orphan: leaves a grandchild behind that ignores SIGTERM and holds stdout open
if [ "$mode" = orphan ]; then
  bash -c 'trap "" TERM; echo $$ > "$0"; exec sleep 30' "$dir/$run.orphan" &
  until [ -s "$dir/$run.orphan" ]; do sleep 0.05; done
fi
case "$name" in
  claude) echo '{"type":"system","subtype":"init","session_id":"ignored"}' ;;
  codex) echo '{"type":"thread.started","thread_id":"0199a213-81c0-7800-8aa1-bbab2a035a53"}' ;;
  opencode) echo '{"type":"step_start","sessionID":"ses_fakesession01","part":{}}' ;;
esac
if [ "$mode" = probe ]; then
  python3 - "$AGENTLINK_HOME/run/agentlink.sock" > "$dir/$run.probe" <<'PY'
import socket, sys, base64, json
def req(method, path, body):
    caller = base64.urlsafe_b64encode(json.dumps({"pid": 0, "chain": [], "tty": True}).encode()).decode().rstrip("=")
    s = socket.socket(socket.AF_UNIX); s.connect(sys.argv[1])
    b = json.dumps(body)
    s.sendall(("%s %s HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nX-Agentlink-Caller: %s\r\nContent-Length: %d\r\nConnection: close\r\n\r\n%s" % (method, path, caller, len(b), b)).encode())
    data = b""
    while True:
        c = s.recv(65536)
        if not c: break
        data += c
    return data.decode().split(" ")[1]
# approvals need a person but no terminal: only the agent identity stops this one
print(req("GET", "/v1/approvals", {}), req("POST", "/v1/headless", {"enabled": False}))
PY
fi
if [ "$mode" = sleep ]; then
  sleep 30 &
  wait $!
  exit 0
fi
case "$name" in
  claude) echo '{"type":"result","subtype":"success","is_error":false,"result":"the answer is 42","total_cost_usd":0.01,"usage":{"input_tokens":10,"output_tokens":5},"permission_denials":[{"tool_name":"Edit"}]}' ;;
  codex) echo '{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"the answer is 42"}}'
         echo '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":5}}' ;;
  opencode) echo '{"type":"text","sessionID":"ses_fakesession01","part":{"type":"text","text":"the answer is 42"}}'
            echo '{"type":"step_finish","sessionID":"ses_fakesession01","part":{"tokens":{"input":10,"output":5},"cost":0.01}}' ;;
esac
`;

const HARNESSES = ["claude", "codex", "opencode"] as const;

export interface FakeBins {
  dir: string;
  mode(mode: "ok" | "sleep" | "fail" | "probe" | "orphan" | "slow-agents"): void;
  /** What a run recorded: argv (lines), cwd, env, stdin, pid, sig, probe. */
  read(run: string, what: string): string | undefined;
  argv(run: string): string[];
  cleanup(): void;
}

export function fakeBins(): FakeBins {
  const dir = mkdtempSync(join(tmpdir(), "agentlink-bins-"));
  const saved: Record<string, string | undefined> = {};
  for (const h of HARNESSES) {
    const path = join(dir, h);
    writeFileSync(path, SCRIPT);
    chmodSync(path, 0o755);
    const key = `AGENTLINK_${h.toUpperCase()}_BIN`;
    saved[key] = process.env[key];
    process.env[key] = path;
  }
  const read = (run: string, what: string) => {
    const path = join(dir, `${run}.${what}`);
    return existsSync(path) ? readFileSync(path, "utf8") : undefined;
  };
  return {
    dir,
    mode: (mode) => writeFileSync(join(dir, "mode"), mode),
    read,
    argv: (run) => (read(run, "argv") ?? "").split("\n").slice(0, -1),
    cleanup() {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
