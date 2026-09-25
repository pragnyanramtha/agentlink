/**
 * Append-only list of schema migrations. Never edit a shipped migration; add a new one.
 * Timestamps are ISO-8601 strings (UTC) so they sort and compare lexicographically.
 */
export const MIGRATIONS: string[] = [
  // 1: local mesh (M1)
  `
  CREATE TABLE meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    name_source TEXT NOT NULL DEFAULT 'auto',          -- auto | user
    tool TEXT NOT NULL,                                -- claude | codex | opencode | gemini | copilot | cursor | kiro | devin | generic | worker
    session_id TEXT,                                   -- the CLI's own session/thread id
    pid INTEGER,
    pid_start TEXT,                                    -- guards against PID reuse
    cwd TEXT,
    repo_root TEXT,
    repo_remote TEXT,
    branch TEXT,
    state TEXT NOT NULL,                               -- busy | idle | offline | stale
    state_at TEXT NOT NULL,
    capabilities TEXT NOT NULL DEFAULT '{}',           -- JSON: { midTurn, nextTurn, wake, push }
    adapter TEXT NOT NULL DEFAULT '{}',                -- JSON: adapter data (tmux pane, codex thread, …)
    status_text TEXT,
    muted INTEGER NOT NULL DEFAULT 0,
    stop_blocks INTEGER NOT NULL DEFAULT 0,            -- consecutive Stop-hook continuations
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL
  );
  CREATE INDEX agents_session ON agents(tool, session_id);
  CREATE INDEX agents_pid ON agents(pid);

  CREATE TABLE messages (
    id TEXT PRIMARY KEY,                               -- envelope.messageId
    thread_id TEXT NOT NULL,                           -- envelope.contextId
    reply_to TEXT,
    task_id TEXT,
    kind TEXT NOT NULL,
    from_addr TEXT NOT NULL,
    from_agent_id TEXT,                                -- local sending agent, if any
    trust TEXT NOT NULL,                               -- trust class as seen by local recipients
    envelope TEXT NOT NULL,                            -- full envelope JSON
    preview TEXT NOT NULL,
    echo_key TEXT NOT NULL,
    wait INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
  CREATE INDEX messages_thread ON messages(thread_id, created_at);
  CREATE INDEX messages_reply_to ON messages(reply_to);
  CREATE INDEX messages_from ON messages(from_agent_id, created_at);

  CREATE TABLE deliveries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    to_addr TEXT NOT NULL,
    to_agent_id TEXT,                                  -- local recipient agent
    state TEXT NOT NULL,                               -- queued | delivered | seen | acked | replied | held | refused | expired | failed | sent
    method TEXT,                                       -- hook | wake | push | cli | mcp | longpoll | relay
    note TEXT,
    created_at TEXT NOT NULL,
    delivered_at TEXT,
    seen_at TEXT,
    acked_at TEXT,
    replied_at TEXT,
    reply_id TEXT,
    decided_by TEXT,                                   -- for held deliveries: who approved/denied
    UNIQUE (message_id, to_addr)
  );
  CREATE INDEX deliveries_agent_state ON deliveries(to_agent_id, state);
  CREATE INDEX deliveries_state ON deliveries(state);

  CREATE TABLE wake_log (
    agent_id TEXT NOT NULL,
    sender TEXT NOT NULL,
    method TEXT NOT NULL,
    at TEXT NOT NULL
  );
  CREATE INDEX wake_log_agent ON wake_log(agent_id, at);

  CREATE TABLE claims (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    repo_key TEXT NOT NULL,                            -- repo remote, else repo root, else cwd
    pattern TEXT NOT NULL,
    reason TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    released_at TEXT
  );
  CREATE INDEX claims_repo ON claims(repo_key, released_at);

  CREATE TABLE policy_overrides (
    scope TEXT NOT NULL,                               -- trust class (user|local|teammate|external) or contact id
    kind TEXT NOT NULL,
    action TEXT NOT NULL,                              -- deliver | hold | refuse
    PRIMARY KEY (scope, kind)
  );

  CREATE TABLE thread_state (
    thread_id TEXT PRIMARY KEY,
    extra_allowance INTEGER NOT NULL DEFAULT 0          -- messages allowed beyond the cap (granted by a human)
  );
  `,
  // 2: team relay (M2)
  `
  CREATE TABLE outbox (
    id TEXT PRIMARY KEY,                               -- frame id
    frame TEXT NOT NULL,                               -- JSON relay frame waiting for a connection
    created_at TEXT NOT NULL
  );

  CREATE TABLE members (
    device_id TEXT PRIMARY KEY,
    handle TEXT NOT NULL,
    sign_pub TEXT NOT NULL,
    box_pub TEXT NOT NULL,
    device_name TEXT,
    first_seen TEXT NOT NULL                          -- TOFU: key changes for a device are refused
  );
  `,
];
