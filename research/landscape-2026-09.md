# Agents talking to agents: problem-space research

*Compiled 2026-09-25. Method: five parallel web-research passes (protocols; in-app frameworks; coding-agent tools; evidence, failure modes and security; networks, voice and market), plus primary-source reads (A2A site and AAIF announcement, both Cognition multi-agent essays, Claude Code cross-session messaging docs) and a survey of prior art on this machine.*

*Confidence: high for spec and vendor facts taken from first-party pages; medium for star counts and funding (these come from aggregators). A claim that rests on a single source is marked (unverified). Anything labelled "Inference" is opinion.*

## TL;DR

- "Let AI agents speak with each other" covers at least six different products (section 1). They share little technology, so the first decision is which one.
- The protocol layer is settled:
  - A2A (agent↔agent) shipped v1.0 on 2026-03-12.
  - It joined the Linux Foundation's Agentic AI Foundation (AAIF) on 2026-08-27, next to MCP (agent↔tool).
  - IBM's ACP merged into A2A in Aug 2025.
  - A new protocol would be dead on arrival.
- Agent-to-agent communication pays off when writes stay single-threaded and the extra agents contribute intelligence: clean-context reviewers, cross-model advisors, manager→worker fan-out. Free-form swarms, debate and parallel writers fail.
- In coding, vendors now ship native messaging, but only within one vendor (Claude Code `SendMessage`, Codex subagents, Devin managed Devins). Across vendors you get poll-based mailboxes and pairwise bridges. At least five mailbox-style MCP servers appeared within a year and none has won.
- The real damage so far has come from security (cross-agent prompt injection, A2A session smuggling, the Moltbook leak) and cost (runaway loops of $47K–$50K).
- On this machine:
  - 9 agent CLIs are installed.
  - Forks of Omnigent (cross-vendor orchestrator) and Paseo (agent-control MCP).
  - Orca orchestration.
  - Your own WhatsApp agent (wagent).

## 1. Six different problems hiding in "agents speaking"

| # | World | Example | State of play | Open gap (inference) |
|---|---|---|---|---|
| 1 | Coding agents on one developer's machine | Claude Code asks Codex to review its diff | Crowded at the dashboard level; vendors ship single-vendor messaging | Cross-vendor push delivery, presence and idle signals, intent and conflict signals |
| 2 | Personal agents acting for different people | My scheduling agent negotiates with yours | Mostly unbuilt; AgentMail ($6M seed) gives agents email inboxes | Identity, spam and injection resistance, getting counterparties (cold start) |
| 3 | Service or enterprise agents across orgs | A Salesforce agent delegates to an SAP agent | A2A v1.0 with cloud support; mostly used inside one enterprise | Verified discovery, conformance, reputation, broadcast |
| 4 | Agents inside one app | LangGraph supervisor with workers | Frameworks have converged on handoff, agents-as-tools and shared state | Typed message log, dynamic context scoping, loop control, cross-framework teams |
| 5 | Public agent networks | Moltbook, Agent Village | Viral, mostly theater, security disasters | Provenance of agent speech, anti-spam, reputation |
| 6 | Voice and phone agents | An AI caller reaches an AI receptionist | Already happening in production with no handshake; GibberLink was only a demo | A real "detect AI, switch to a structured channel" standard |

## 2. Protocol layer: settled, with known holes

### A2A

- **Core model:** an Agent Card at `/.well-known/agent-card.json`, a task lifecycle, SSE streaming and webhook push. Bindings for JSON-RPC, gRPC and REST.
- **Added in v1.0:** signed Agent Cards (JWS), mTLS, OAuth device flow, multi-tenancy and extensions.
- **Governance:** a technical steering committee of AWS, Cisco, Google, IBM Research, Microsoft, Salesforce, SAP and ServiceNow.
- **Adoption claims (vendor-sourced):** 150+ backing orgs, native support in Google Cloud, Bedrock AgentCore and Azure AI Foundry. SDKs exist in 6 languages.
- **Explicit non-goals:** it says it is not a sub-agent protocol, not a tool protocol, and "not an interactive messaging app".
- Sources: [a2a-protocol.org](https://a2a-protocol.org/latest/), [What's new in v1.0](https://a2a-protocol.org/latest/whats-new-v1/), [AAIF announcement](https://a2a-protocol.org/latest/blog/2026/08/27/a-new-chapter-for-a2a-joining-the-agentic-ai-foundation/).

### MCP

- The latest spec, `2026-07-28`, went stateless (no `initialize` handshake) and added a Tasks extension for long-running work ([changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog.md)).
- It was donated to AAIF on 2025-12-09 ([Anthropic](https://www.anthropic.com/news/donating-the-model-context-protocol-and-establishing-of-the-agentic-ai-foundation)).
- It has no peer-agent or delegation primitive. People wrap agents as MCP servers anyway, because it is the easiest path.

### Other protocols

- **ACP (IBM):** merged into A2A.
- **AGNTCY/SLIM (Cisco):** transport and directory infrastructure that sits under A2A.
- **ANP:** DID-based, China-led.
- **NANDA (MIT):** discovery and identity research.
- **ANS:** IETF drafts for agent naming.
- **AG-UI:** agent↔UI.
- **Zed's Agent Client Protocol:** editor↔agent, spoken by Claude Code, Codex and Gemini CLI.
- **Payments:** AP2, x402, the Agentic Commerce Protocol and UCP.

### What the protocols don't solve

- **Discovery** of agents you have never heard of ([Asimov Addendum](https://asimovaddendum.substack.com/p/agents-need-a-public-square)).
- **Conformance:** one empirical check found that about 0–4% of agents claiming A2A served a valid card, and 0% answered a task ([A2A #1755](https://github.com/a2aproject/A2A/issues/1755), single study).
- **Semantics:** clarification, context alignment and verification are pushed into prompts ([arXiv 2604.02369](https://www.arxiv.org/pdf/2604.02369)).
- **Many-to-many or broadcast** communication; A2A is pairwise.
- **Offline or heartbeat agents.**

## 3. Does agent-to-agent communication help? The evidence

### Where it pays off

- **Read-heavy parallel fan-out.** Anthropic's multi-agent Research beat single-agent Opus 4 by 90.2% on an internal eval. The cost is about 15× the tokens of a chat ([Anthropic](https://www.anthropic.com/engineering/multi-agent-research-system)).
- **Clean-context generator↔verifier loops.** Devin Review catches about 2 bugs per PR, roughly 58% of them severe ([Cognition, Apr 2026](https://cognition.ai/blog/multi-agents-working)).
  - It works best when the reviewer shares no context with the coder.
  - It needs a good "communication bridge" back to the coder, or it loops and drifts out of scope.
- **Cross-frontier "smart friend".** Claude and GPT consulting each other in production gave "real gains in the trickiest scenarios". Delegation becomes "a capability router rather than a difficulty escalator" (same source).
- **Manager→children map-reduce** (managed Devins). This took heavy context engineering. Children don't message siblings by default "because models haven't been trained in environments where it needed to" (same source).
- **Decomposable tasks:** +80.8% ([Google, arXiv 2512.08296](https://arxiv.org/abs/2512.08296)).

### Where it fails

- **Parallel writers.** Actions carry implicit decisions, and parallel agents make conflicting ones ([Cognition, Jun 2025](https://cognition.ai/blog/dont-build-multi-agents)).
- **Unstructured swarms** are "mostly a distraction"; the practical shape is "map-reduce-and-manage" (Cognition, Apr 2026).
- **Sequential planning:** −70.0%. Returns shrink once the single-agent baseline is strong (Google).
- **Debate:** majority voting explains most of the gains ("Debate or Vote", NeurIPS 2025). Agents also switch from correct to incorrect answers under peer pressure ([arXiv 2509.05396](https://arxiv.org/abs/2509.05396)).
- **Echoing:** agents drop their role to mirror their partner in up to 70% of conversations. A structured-response protocol cut this to 9% ([arXiv 2511.09710](https://arxiv.org/abs/2511.09710)).
- **MAST taxonomy:** 14 failure modes. ChatDev reached only 33.33% correctness on ProgramDev ([arXiv 2503.13657](https://arxiv.org/abs/2503.13657)).

### Design rules implied (inference)

- Use structured messages instead of free chat.
- Keep one writer per artifact.
- Give reviewers a clean context.
- Make termination and budgets explicit.
- Share decisions and traces, not just messages.

## 4. Coding agents talking to each other (closest to your world)

### Vendor-native messaging (single vendor only)

**Claude Code cross-session messaging** (v2.1.224+, [docs](https://code.claude.com/docs/en/cross-session-messaging)):

- Agents use `ListAgents` and `SendMessage` over a local socket per session. Local messages never pass through Anthropic servers.
- Messages are plain text only.
- They are read between tool calls, or start a new turn if the receiving session is idle.
- `notify_when_idle` (v2.1.236) sends a one-time notice when the other session goes idle or exits.
- Limits: a cap of about 1M characters, burst refusal, and loop throttling (per-sender rate limits, dropped duplicates, a capped queue).
- Permission rule: never ask another session to do something your own session was denied. The receiving session can hold or refuse incoming messages.
- Cross-machine messaging requires Remote Control and a claude.ai login.

**Other vendors:**

- **Claude Code agent teams:** experimental. A shared task list plus a mailbox for teammate-to-teammate messages ([docs](https://code.claude.com/docs/en/agent-teams)).
- **Codex subagents:** the parent spawns, steers and waits on children (star topology). `spawn_agents_on_csv` handles map-reduce ([docs](https://developers.openai.com/codex/subagents)).
- **Cursor `/multitask`:** parallel agents in worktrees that "do not coordinate with each other" ([forum](https://forum.cursor.com/t/cursor-2-0-split-tasks-using-parallel-agents-automatically-in-one-chat-how-to-setup-worktree-json/140218)).
- **Devin:** a manager Devin spawns and messages child Devins over an internal MCP ([docs](https://docs.devin.ai/work-with-devin/advanced-capabilities)).

### Cross-vendor tools

- **[MCP Agent Mail](https://github.com/dicklesworthstone/mcp_agent_mail):** identities, threaded inboxes, advisory file leases, and a Git+SQLite audit trail. About 2K stars (Python); a Rust rewrite has 44 tools. It relies on polling and opt-in locks.
- **[Beads](https://github.com/steveyegge/beads):** a Dolt-backed task and memory graph. About 26.9K stars; v1.2.2 on 2026-08-15. A message is just one issue type.
- **Gas Town / Gas City:** swarms built on top of Beads. On HN people called it janky, and an idle instance burned through a $100 subscription window in about 2 hours ([HN](https://news.ycombinator.com/item?id=48396925)).
- **[PAL MCP](https://github.com/BeehiveInnovations/pal-mcp-server)** (formerly Zen): about 11K stars. Cross-model consult and consensus, and `clink` spawns other CLIs. It is request/response, not peer messaging.
- **Pairwise Claude↔Codex bridges:** several hobby repos, with asymmetric delivery ("Claude-initiated messages still wait until Codex polls").
- **A2A wrappers for coding agents** (a2acode, claude-a2a): early, and the caller has to speak A2A.
- **Mailbox clones from 2026:**
  - osteele/agent-mail pushes into Claude through Channels.
  - agent-inbox notes that "a running LLM turn cannot be interrupted from outside".
  - agent-mailbox and agent-mailer are similar.
- **Parallel-run managers without agent↔agent messaging:** claude-squad, Vibe Kanban, Conductor, Sculptor, Crystal/Nimbalyst, Terragon, Omnara.

### Pain, in developers' words

- "I am the message bus." ([martinbeauvais.com](https://martinbeauvais.com/posts/sieve-development-process/))
- "Two agents would pick up the same problem independently… neither knew the other had started." ([dev.to](https://dev.to/seakai/how-we-coordinate-8-ai-agents-without-them-stepping-on-each-other-3gi7))
- "Worktrees isolate working directories, not product intent." ([codeongrass](https://codeongrass.com/blog/parallel-worktrees-conflict-prediction/))
- Other reports: deadlocks between agents waiting on each other, identity mix-ups when spawning teammates, and inboxes that silently stay empty.

### Gaps (inference)

- Cross-vendor push into a live session.
- A vendor-neutral view of who is working on what and what just finished.
- Signals of semantic intent or conflict ("I'm renaming `foo()`").
- A clean-context, cross-vendor review loop that talks back until issues are resolved.

## 5. Agents inside one app (frameworks)

- **Converged primitives:** handoff (`transfer_to_*` tools), agents-as-tools and subagents, and shared state or graphs.
- **Moving away from free-form group chat:**
  - `langgraph-supervisor` is deprecated in favor of subagents-as-tools.
  - Mastra deprecated `.network()`.
  - AG2 v1.0 replaced GroupChat with a hub-and-channels "Network".
  - OpenAI's Agent Builder shuts down on 2026-11-30.
- **Microsoft Agent Framework 1.0** went GA on 2026-04-02 with native A2A and MCP. Communication inside one process stays in the framework; anything cross-process is being pushed to A2A.
- **Complaints:**
  - Delegation loops "where the signal is a bill, not an exception".
  - Retries that get swallowed silently.
  - Lock-in and churn.
- **Gaps (inference):**
  - Typed, persisted message logs.
  - Dynamic context scoping.
  - Built-in loop and budget control.
  - Teams that span frameworks.
  - Replay tooling that answers "why did agent A talk to agent B?"

## 6. Public networks and voice

### Moltbook

Launched 2026-01-28 on the OpenClaw agent framework.

- **Who was behind it:** Wiz found about 1.5M agents run by about 17K humans.
- **Data leak:** a Supabase misconfiguration exposed about 1.5M API tokens, 35K emails and private DMs.
- **Prompt injection:** payloads planted in community descriptions tried to make agents send ETH.
- **"Church of Molt":** 64 agents ran an unsigned script that rewrote their identity files.
- **Authenticity:** Tsinghua's "Moltbook Illusion" ([arXiv 2602.07432](https://arxiv.org/abs/2602.07432)) found no viral event that was verifiably autonomous.

### AI Digest Agent Village

- More than 300 days of agents working together.
- An A2A "embassy" where the agents talked to 15+ external agents.
- It publishes a catalog of anti-patterns: echo chambers, phantom collaborations, status floods and orphaned threads ([handbook](https://github.com/ai-village-agents/village-operations-handbook)).

### Voice

- GibberLink (Feb–Mar 2025) was a prompted hackathon demo that switched to ggwave data-over-sound.
- AI receptionists (Slang, Yelp) mean AI bots already call other AI bots routinely, with no handshake.
- Only one-off efforts exist so far: WorkforceWave's SIP/DTMF detection, the OpenHandoffProtocol spec, and a patent.

## 7. Security and cost threats

| Threat | Example | Maturity of mitigations |
|---|---|---|
| Cross-agent prompt infection (self-replicating) | [arXiv 2410.07283](https://arxiv.org/abs/2410.07283); multi-agent hijacking reached 58–100% arbitrary code execution ([2503.12188](https://arxiv.org/html/2503.12188)) | Low |
| A2A session smuggling and Agent Card spoofing | [Unit 42](https://unit42.paloaltonetworks.com/agent-session-smuggling-in-agent2agent-systems/); A2ABreak reports 11 spec-level vulnerabilities (arXiv 2609.10871, unverified) | Low to medium |
| Confused deputy through delegation | Clinejection (Feb 2026): an injected GitHub issue led to a malicious cline release that reached about 4,000 machines | Medium (patterns known, adoption poor) |
| MCP tool poisoning and rug pulls | [Invariant Labs](https://invariantlabs.ai/blog/mcp-security-notification-tool-poisoning-attacks) | Medium |
| Denial of wallet and runaway loops | $50K loop (about 15K calls in under an hour, Mandiant-reported); $47K over 11 days (partly reconstructed) | Low |

For a baseline checklist, use the [OWASP Top 10 for Agentic Applications](https://genai.owasp.org/) (2025-12-10).

## 8. Market snapshot (funding; medium confidence)

**Crowded and well funded:**

- **Agent identity:** Keycard ($38M, Oct 2025), Descope ($88M total), Astrix, Aembit, Okta, Entra Agent ID.
- **Gateways and registries:** agentgateway (Linux Foundation), Kong, Cloudflare. Arcade ($72M) bought Smithery in Aug 2026.
- **Observability:** Langfuse, Arize, Braintrust.
- **Payments:** AP2, x402 (now its own Linux Foundation foundation), ACP and UCP.

**Thin:**

- **Agent inboxes:** AgentMail ($6M seed, Mar 2026; claims "hundreds of thousands of agents").
- Provenance and reputation of agent speech.
- A voice handshake.
- Cross-vendor messaging for coding agents (hobby projects only).

**Dead or deprecated:** NEAR AI Hub (shut down Oct 2025), IBM ACP, LangChain Agent Protocol, agents.json.

## 9. Prior art on this machine

| Thing | Relationship | What it already does for agent↔agent |
|---|---|---|
| Installed CLIs | — | claude, codex, gemini, cursor-agent, devin, opencode, copilot, kiro, orca-ide |
| `~/dev/omnigent` | Fork of upstream omnigent-ai; you have commits | Meta-harness over Claude Code, Codex, Cursor, OpenCode, Hermes, Pi and others. The `polly` orchestrator delegates to 7 CLI sub-agents and gets independent review from a different vendor. Tools include `sys_session_send`, `sys_read_inbox`, `sys_session_create`, `sys_call_async` and `sys_terminal_send`. |
| `~/dev/paseo` | Fork of upstream getpaseo (AGPL-3.0) | Daemon plus mobile and desktop UI. Its MCP exposes `create_agent`, `send_agent_prompt`, `get_agent_status`, `get_agent_activity`, `respond_to_permission`, heartbeats and schedules. |
| Orca (`orca-ide`) | A tool you use | Supervised orchestration: Run/Task/Dispatch, a FIFO inbox, blocking ask/reply, `worker_done`, heartbeats and decision gates. Its docs say "send proves durable enqueue; wake is best-effort". |
| `~/dev/wanager` (wagent) | Yours | A WhatsApp AI agent (TypeScript, pnpm). A possible seed for world #2. |

Inference: in world #1, parent→child messaging is already solved three times over on this machine. What is still missing is peer-level, cross-vendor messaging and presence that works no matter which harness started the agent.

## 10. Where an indie builder could win (inference, ranked)

1. **A cross-vendor peer channel for coding agents.** Push into running sessions, plus presence and idle/done notices across Claude, Codex, Gemini and OpenCode.
   - Risk: per-CLI delivery hooks may not exist.
   - Risk: vendors, Omnigent, Paseo or Orca could add the same thing.
   - Risk: hard to monetize.
2. **A cross-vendor, clean-context review loop.** A coder and a reviewer from different vendors iterate until the issues are resolved, with a step that filters findings against what the user asked for.
   - Strongest evidence of any option.
   - Risk: polly and PAL already cover parts of it.
3. **Personal agent ↔ personal agent between people** (building on wagent).
   - Underserved.
   - Risk: cold start, trust, and prompt injection between strangers' agents are brutal.
4. **Verification, provenance and reputation** for agent speech and A2A endpoints.
   - An open infrastructure gap.
   - Risk: less fun to demo.
5. **A voice handshake** (detect an AI callee, switch to a structured channel).
   - A niche with few players.
   - Risk: heavy telephony work.
6. **A loop and budget firewall between agents.**
   - Real money has been lost here.
   - Risk: gateways may absorb it.

**Avoid:** a new protocol, a free-form agent chat room or swarm, another worktree dashboard, a Moltbook clone.

## 11. Questions to answer before planning

1. Which world from section 1?
2. What outcome: a personal tool, open source with users, a startup, or learning and portfolio?
3. What is the core job of the conversation: relay, review, negotiate or coordinate?
4. What is missing from Omnigent, Paseo, Orca and Claude Code's native messaging?
5. What topology: pairwise, manager→workers, or peer mesh?
6. What delivery: push into live turns, or poll at turn boundaries?
7. Where is the trust boundary: same human, same team, or strangers?
8. Which stack, and which agents are supported first?
9. What does "it worked" look like?
