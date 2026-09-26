import { VERSION } from "../version.ts";

export const OVERVIEW = `agentlink ${VERSION}: let AI coding agents talk to each other

Talk
  peers [--all]                      who is online (busy/idle/offline) and what they do
  ask <agent> "<question>"           ask and wait for the answer
  send <agent>[,…] "<message>"       send info, a request, or a handoff
  reply <id> "<answer>"              answer a message
  ack <id> [--accept|--decline]      accept/decline a handoff, or confirm
  inbox [--wait 60s]                 read your messages
  todo                               asks, requests and handoffs you haven't answered
  show <id> · thread <id> · status [<id>]

Coordinate
  doing "<text>"                     tell peers what you are working on
  claim <glob>… · release · claims   advisory file claims
  name <new-name>                    rename this agent
  whoami                             which agent this shell is (or: you, the human)
  register · unregister              add/remove an agent that has no hooks

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
REACH says how a message gets in:
  wake       an idle agent is started with a new turn
  push       queued straight into the session
  mid-turn   injected between its tool calls while it works
  next-turn  shown when its next turn starts
  cli        only when it runs agentlink inbox itself

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

Exit codes: 0 answered, 1 nobody could receive it, 3 no answer in time.

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
Several recipients make a group conversation; they answer everyone with reply --all.

Example: agentlink send opencode-web --kind request "Please run the e2e suite"`,

  reply: `agentlink reply <message-id> "<answer>" [--all] [--wait [d]] [--stdin]

Answer a message you received (the id is in its <agentlink-msg …> tag or inbox).
A unique prefix of the id is enough.

  -a, --all   answer everyone in the conversation (group chat), not just the sender

Examples:
  agentlink reply 01M3C4 "pnpm test (vitest)"
  agentlink reply 01M3C4 --all "I'll take the API part"`,

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

  todo: `agentlink todo

Asks, requests and handoffs sent to you (or to this agent) that are not answered yet,
oldest first. Answer with agentlink reply <id>, or accept/decline handoffs with ack.`,

  show: `agentlink show <message-id> [--part N] [--raw]

Show a message with its delivery receipts, or one attachment (--part N).
  --raw   include the full envelope (JSON)`,

  thread: `agentlink thread <thread-or-message-id> [--allow N]

Show a whole conversation (any message id works). Loop guards stop a conversation at
30 messages or 12 replies deep, with more room for groups (+10 messages and +4 depth
per extra participant). --allow N lets it continue for N more on this machine; in a
team, each machine's user decides for their own agents. Run it yourself, in a terminal.`,

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

Register an agent whose CLI has no agentlink hooks, so others can message it.
Run inside the agent's shell, it registers that agent process; from your own terminal,
pass --pid <agent pid>, then act as it with: agentlink --as <name> inbox.
Undo with agentlink unregister <name>.`,
  unregister: `agentlink unregister [<agent-name>]

Forget an agent (default: the one this shell belongs to). Its undelivered messages
expire. Agents can only unregister themselves.`,

  claim: `agentlink claim <path-or-glob>… [--ttl 60m] [--reason "…"]

Advisory claim on files you are about to edit. Reports overlaps with other agents'
claims in the same repo. Globs: * (one segment), ** (any depth), ?.

Example: agentlink claim "src/auth/**" --reason "refactoring token refresh"`,

  release: `agentlink release [<path-or-glob>…] [--all]

Release your claims (all of them when no path is given).`,

  claims: `agentlink claims

List active file claims on this machine.`,

  team: `agentlink team [status]
agentlink team create <name> --relay ws://<host>:7700 [--handle <you>] [--create-token <t>]
agentlink team invite [--uses 1] [--ttl 24h]
agentlink team join <invite> [--handle <you>] [--relay <url>]
agentlink team relay <url>          use another address for the relay (after moving it)
agentlink team leave

Connect this machine to other machines and people. Messages are end-to-end
encrypted to each device; the relay only stores and forwards ciphertext.
After joining, teammates' agents show up in agentlink peers as alice/<agent>.
--relay reaches the same relay at another address (for example through an SSH tunnel).

Typical setup:
  (any machine)  agentlink relay serve --host 0.0.0.0
  (you)          agentlink team create acme --relay ws://relay-host:7700
  (you)          agentlink team invite            # send the al1.… string privately
  (teammate)     agentlink team join al1.…`,

  relay: `agentlink relay serve [--host 127.0.0.1] [--port 7700] [--data <dir>] [--create-token <t>]

Run a self-hosted relay. It authenticates devices and queues sealed messages for
offline machines; it cannot read them. Use --host 0.0.0.0 or a tailnet address
so other machines can reach it. Default data dir: ~/.agentlink/relay.
On a public address, set --create-token (or AGENTLINK_RELAY_CREATE_TOKEN) so only
people with the token can start teams: agentlink team create … --create-token <t>`,

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

Resume delivery after pause. Run it yourself, in an interactive terminal (agents cannot).`,

  mute: `agentlink mute <agent>

Queue messages for one agent without delivering them until unmute. Run it yourself,
in a terminal.`,

  unmute: `agentlink unmute <agent>

Deliver an agent's queued messages again. Run it yourself, in a terminal.`,

  policy: `agentlink policy [list]
agentlink policy set <scope> <kind>=<deliver|hold|refuse>…
agentlink policy reset <scope> <kind>…

Who may send what. Changing it needs you, in an interactive terminal.
  scopes   user (you), local (agents on this machine), teammate (team members' agents),
           external (A2A, not yet), or one teammate's handle
  kinds    info ask request handoff reply ack review_request review_result
  actions  deliver, hold (waits for agentlink approve), refuse

Example: agentlink policy set teammate request=hold handoff=hold`,

  approvals: `agentlink approvals

Messages held by policy, waiting for you. Approve or deny each one by its number
(#12) or message id:
  agentlink approve <id> · agentlink deny <id>   (interactive terminal only)`,

  approve: `agentlink approve <delivery-id> [-y]

Deliver a held message. Only a human in an interactive terminal can approve.`,

  deny: `agentlink deny <delivery-id> [-y]

Drop a held message.`,

  mcp: `agentlink mcp

Run the MCP server on stdio (tools: peers, whoami, ask, send, reply, ack, inbox, todo,
thread, show, doing, claim, release). agentlink install registers it with your CLIs.`,

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
