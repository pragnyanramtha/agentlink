import { VERSION } from "../version.ts";

export const OVERVIEW = `agentlink ${VERSION}: let AI coding agents talk to each other

Talk
  peers [--all]                      who is online (busy/idle/offline) and what they do
  ask <agent> "<question>"           ask and wait for the answer
  send <agent>[,…] "<message>"       send info, a request, or a handoff
  reply <id> "<answer>"              answer a message
  ack <id> [--accept|--decline]      accept/decline a handoff, or confirm
  inbox [--wait 60s]                 read your messages
  show <id> · thread <id> · status [<id>]

Coordinate
  doing "<text>"                     tell peers what you are working on
  claim <glob>… · release · claims   advisory file claims
  name <new-name>                    rename this agent
  register                           register an agent that has no hooks

Teams (other machines, other people)
  team [create|invite|join|leave]    end-to-end encrypted team over a relay
  relay serve                        run a relay (self-hosted)

Setup & control
  init · install <tool…|all> · uninstall · doctor
  daemon start|stop|restart|status|logs · watch · log
  pause · resume · mute <agent> · unmute <agent>
  policy · approvals · approve <id> · deny <id>

Run "agentlink <command> --help" for details. Global flags: --json, --as <agent>, --home <dir>.
Agent names look like claude-myrepo; teammates' agents look like alice/codex-api.`;

const H: Record<string, string> = {
  peers: `agentlink peers [--all]

List the agents you can message: this machine's and your teammates' (alice/…).
REACH says how a message gets in: wake (starts an idle agent), push, mid-turn
(injected between tool calls) or next-turn.

  -a, --all     include offline agents

Example: agentlink peers`,

  ask: `agentlink ask <agent>[,<agent>…] "<question>" [--timeout 110s] [--no-wait] [--stdin]

Send a question and wait for the answer, which is printed. If none comes in time,
it is delivered to you later automatically (or see: agentlink inbox).
An idle recipient is woken when its CLI allows it (Claude Code, Codex, OpenCode).

  --timeout <d>   how long to wait (default 110s; e.g. 30s, 5m)
  --no-wait       send and return immediately
  -t, --thread    continue an existing thread
  --stdin         read the question (or extra context) from stdin
  --force         send to teammates even if it looks like it contains a secret

Examples:
  agentlink ask codex-api "What's the test command?"
  git diff | agentlink ask claude-web --stdin "Anything wrong with this diff?"
  agentlink ask alice/claude-api "Is the /v2 endpoint deployed?"`,

  send: `agentlink send <agent>[,<agent>…] "<message>" [--kind info|ask|request|handoff] [--wait [d]]

Send a message. Kinds:
  info      FYI, no answer expected (default; never wakes an idle agent)
  ask       a question (prefer: agentlink ask)
  request   asks the recipient to do something
  handoff   hands work over (recipient accepts/declines with agentlink ack)

  -k, --kind      message kind
  -w, --wait [d]  wait for an answer (default 110s)
  -t, --thread    continue an existing thread
  --ttl <d>       expire if undelivered (default 7 days; e.g. 30m)
  --stdin         read the message from stdin
  --force         send to teammates even if it looks like it contains a secret

Recipients: agent names, alice/agent (teammate), @alice (teammate's inbox),
@<you> (your own inbox), repo:<git remote> (every agent in that repo).

Example: agentlink send opencode-web --kind request "Please run the e2e suite"`,

  reply: `agentlink reply <message-id> "<answer>" [--wait [d]] [--stdin]

Answer a message you received (the id is in its <agentlink-msg …> tag or inbox).
A unique prefix of the id is enough.

Example: agentlink reply 01M3C4 "pnpm test (vitest)"`,

  ack: `agentlink ack <message-id> [--accept|--decline] ["note"]

Acknowledge a message: accept or decline a handoff, or confirm you processed it.

Example: agentlink ack 01M3C4 --accept "Taking it; ETA 20 min"`,

  inbox: `agentlink inbox [--all] [--peek] [--wait [d]] [-n N] [--format text|inject]

Show your unread messages and mark them read. Run inside an agent session it shows
that agent's mail; in your own terminal it shows messages sent to you (@you).

  -a, --all      include already-read messages
  --peek         do not mark them read
  -w, --wait     wait for a message to arrive (default 60s)
  -n, --limit    how many (default 20)
  --format       inject = the tagged format agents receive (default when piped)`,

  show: `agentlink show <message-id> [--part N] [--raw]

Show a message with its delivery receipts, or one attachment (--part N).
  --raw   include the full envelope (JSON)`,

  thread: `agentlink thread <thread-or-message-id> [--allow N]

Show a whole conversation. Threads between agents stop at 30 messages (loop guard);
--allow N lets one continue for N more (run it yourself, in a terminal).`,

  status: `agentlink status [<message-id>]

Delivery receipts: queued → sent → delivered → seen → replied/acked (or held,
refused, expired, failed). Without an id: your recent messages.`,

  log: `agentlink log [-n 30]

Recent messages on this machine with their delivery states.`,

  watch: `agentlink watch [--json]

Live view of agent traffic: agents changing state, messages, deliveries. Ctrl-C stops.`,

  whoami: `agentlink whoami

Which agent this shell belongs to (or that you are the human), and your handle.`,

  name: `agentlink name <new-name> [--agent <current-name>]

Rename this agent (lowercase letters, digits, . _ -). Taking the name of an offline
agent inherits its queued messages.`,

  doing: `agentlink doing "<what you are working on>" | --clear

Set the status line other agents see in agentlink peers.`,

  register: `agentlink register [--tool generic] [--name <name>] [--pid <pid>]

Register an agent whose CLI has no agentlink hooks, so others can message it. It
finds its agent process in the process tree (or use --pid). It then reads its mail
with agentlink inbox.`,

  claim: `agentlink claim <path-or-glob>… [--ttl 60m] [--reason "…"]

Advisory claim on files you are about to edit. Reports overlaps with other agents'
claims in the same repo. Globs: * (one segment), ** (any depth), ?.

Example: agentlink claim "src/auth/**" --reason "refactoring token refresh"`,

  release: `agentlink release [<path-or-glob>…] [--all]

Release your claims (all of them when no path is given).`,

  claims: `agentlink claims

List active file claims on this machine.`,

  team: `agentlink team [status]
agentlink team create <name> --relay ws://<host>:7700 [--handle <you>]
agentlink team invite [--uses 1] [--ttl 24h]
agentlink team join <invite> [--handle <you>]
agentlink team leave

Connect this machine to other machines and people. Messages are end-to-end
encrypted to each device; the relay only stores and forwards ciphertext.
After joining, teammates' agents show up in agentlink peers as alice/<agent>.

Typical setup:
  (any machine)  agentlink relay serve --host 0.0.0.0
  (you)          agentlink team create acme --relay ws://relay-host:7700
  (you)          agentlink team invite            # send the al1.… string privately
  (teammate)     agentlink team join al1.…`,

  relay: `agentlink relay serve [--host 127.0.0.1] [--port 7700] [--data <dir>]

Run a self-hosted relay. It authenticates devices and queues sealed messages for
offline machines; it cannot read them. Use --host 0.0.0.0 or a tailnet address
so other machines can reach it. Default data dir: ~/.agentlink/relay.`,

  init: `agentlink init [--handle <you>]

Set your handle (how teammates address you) and start the daemon.`,

  install: `agentlink install <tool…|all> [--project <dir>] [--dry-run] [--no-mcp]

Wire agentlink into agent CLIs: hooks (presence + message delivery), the MCP server,
and a short instruction block. Existing hooks are kept; every file is backed up
under ~/.agentlink/backups. Tools: claude codex opencode cursor devin agy copilot gemini.

  -p, --project <dir>   install into one project instead of your user config
  -n, --dry-run         show the changes as a diff, change nothing
  --no-mcp              skip MCP server registration

Examples:
  agentlink install all --dry-run
  agentlink install claude codex
  agentlink install all --project .`,

  uninstall: `agentlink uninstall <tool…|all> [--project <dir>] [--dry-run]

Remove what agentlink install added (only agentlink's entries).`,

  doctor: `agentlink doctor [--project <dir>]

Check the daemon, the launcher, PATH, and each agent CLI's wiring; shows recent
hook errors. Exit code 1 if something needs attention.`,

  daemon: `agentlink daemon start|stop|restart|status|logs [-f]

The daemon starts on its own when needed (first hook or command). It listens only
on a private Unix socket (~/.agentlink/run/agentlink.sock).`,

  pause: `agentlink pause

Stop delivering messages to every agent (they are queued). Any agent may pause.`,

  resume: `agentlink resume

Resume delivery after pause. Only you (in a terminal) can resume.`,

  mute: `agentlink mute <agent>

Queue messages for one agent without delivering them until unmute.`,

  unmute: `agentlink unmute <agent>`,

  policy: `agentlink policy [list]
agentlink policy set <scope> <kind>=<deliver|hold|refuse>…
agentlink policy reset <scope> <kind>…

Who may send what. Scopes: user, local, teammate, external, or a teammate's handle.
Held messages wait for your approval (agentlink approvals).

Example: agentlink policy set teammate request=hold handoff=hold`,

  approvals: `agentlink approvals

Messages held by policy, waiting for you. Approve or deny each one:
  agentlink approve <id> · agentlink deny <id>   (interactive terminal only)`,

  approve: `agentlink approve <delivery-id> [-y]

Deliver a held message. Only a human in an interactive terminal can approve.`,

  deny: `agentlink deny <delivery-id> [-y]

Drop a held message.`,

  mcp: `agentlink mcp

Run the MCP server on stdio (tools: peers, ask, send, reply, ack, inbox, show, doing,
claim, release). agentlink install registers it with your CLIs.`,

  hook: `agentlink hook <tool> <event> [json]

Internal: called by agent CLI hooks. Always exits 0 so your agent never breaks.`,

  version: `agentlink version`,
  help: `agentlink help [command]`,
};

H.tell = H.send as string;

export function commandHelp(name: string): string | undefined {
  return H[name];
}

export function wantsHelp(argv: string[]): boolean {
  const end = argv.indexOf("--");
  const head = end >= 0 ? argv.slice(0, end) : argv;
  return head.includes("--help") || head.includes("-h");
}
