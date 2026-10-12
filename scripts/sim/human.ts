// A person at a terminal: one daemon request from a process outside every agent's tree, run by
// the worker under `script` (a pseudo-terminal on stdin), so human-only routes accept it when
// the daemon checks callers with the kernel. Prints the JSON result between markers.
//   SIM_HUMAN='{"socket":…,"method":"POST","path":"/v1/control","body":{…}}' node scripts/sim/human.ts
import { ancestry } from "../../src/core/proc.ts";
import { b64, unixRequest } from "./lib.ts";

const req = JSON.parse(process.env.SIM_HUMAN ?? "{}") as {
  socket: string;
  method: string;
  path: string;
  body?: unknown;
};
const chain = ancestry(process.pid).map((p) => ({
  pid: p.pid,
  ppid: p.ppid,
  ...(p.start ? { start: p.start } : {}),
  cmd: p.cmd.slice(0, 4),
}));
const res = await unixRequest(req.socket, req.method, req.path, req.body, {
  "x-agentlink-caller": b64({ pid: process.pid, chain, tty: Boolean(process.stdin.isTTY) }),
});
process.stdout.write(`\n@@SIM@@${JSON.stringify(res)}@@END@@\n`);
