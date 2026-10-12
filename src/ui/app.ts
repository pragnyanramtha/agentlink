// Browser script for the web UI (served as /app.js). Every node is built with createElement and
// textContent: message data never goes through an HTML parser.
export const JS = String.raw`(() => {
"use strict";
const $ = (sel, root) => (root || document).querySelector(sel);
const main = $("#main");
function add(el, c) {
  if (c == null || c === false) return;
  if (Array.isArray(c)) c.forEach((x) => add(el, x));
  else el.append(c.nodeType ? c : document.createTextNode(String(c)));
}
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const k in props || {}) {
    const v = props[k];
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = String(v);
    else if (k.slice(0, 2) === "on") el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  add(el, kids);
  return el;
}
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

const VIEWS = ["overview", "live", "threads", "search", "agents", "approvals"];
const TITLES = { overview: "Overview", live: "Live", threads: "Conversations", thread: "Conversation", search: "Search", agents: "Agents", approvals: "Approvals" };
const KINDS = ["info", "ask", "request", "handoff", "review_request", "review_result", "reply", "ack"];
const KIND_LABEL = { review_request: "review", review_result: "review result" };
const STATE_LABEL = { seen: "read" };
const STATE_ICON = { queued: "○", sent: "↗", delivered: "✓", seen: "✓✓", acked: "✔", replied: "↩", held: "⏸", refused: "⊘", expired: "⌛", failed: "✕" };
const S = { view: "", arg: "", seq: 0, ov: null, you: { handle: "", host: "" }, allAgents: [], live: [], liveIndex: new Map(), liveLoaded: false, liveKind: "", threadsOpen: false, threadLimit: 50, showOffline: false, search: { q: "", from: "", to: "", kind: "", since: "" }, searchLimit: 30, searchSeq: 0, replyTo: null, backoff: 1000, expired: false };
const label = (k) => KIND_LABEL[k] || String(k);
// The session's API key arrives once in the fragment (never sent to a server); keep it in
// storage scoped to this origin, unlike cookies, which every port on 127.0.0.1 shares.
let KEY = "";
const fromLogin = /^#k=([A-Za-z0-9_-]{43})$/.exec(location.hash);
if (fromLogin) {
  KEY = fromLogin[1];
  try { localStorage.setItem("agentlink.key", KEY); } catch {}
  history.replaceState(null, "", location.pathname + "#/overview");
} else {
  try { KEY = localStorage.getItem("agentlink.key") || ""; } catch {}
}
// A newer login (another tab) replaces the cookie and the stored key together.
const key = () => { try { return localStorage.getItem("agentlink.key") || KEY; } catch { return KEY; } };

// ---------------------------------------------------------------- api
async function api(path, body) {
  const opts = { credentials: "same-origin", headers: { accept: "application/json", "x-agentlink-key": key() } };
  if (body !== undefined) {
    opts.method = "POST";
    opts.headers["content-type"] = "application/json";
    opts.headers["x-agentlink-ui"] = "1";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch("/api/v1/" + path, opts);
  if (res.status === 401) { expired(); throw new Error("Your session has ended"); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data.error && data.error.message) || "Request failed (" + res.status + ")");
  return data;
}

// ---------------------------------------------------------------- small pieces
function ago(iso) {
  const t = Date.parse(iso);
  if (!t) return "";
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return m + " min ago";
  const hr = Math.round(m / 60);
  if (hr < 24) return hr + " h ago";
  const d = Math.round(hr / 24);
  return d < 7 ? d + " d ago" : new Date(t).toLocaleDateString();
}
const timeEl = (iso) => h("time", { datetime: iso, title: iso ? new Date(iso).toLocaleString() : null, class: "ago", text: ago(iso) });
const kindBadge = (k) => h("span", { class: "badge k-" + String(k).replace(/[^a-z_]/g, ""), text: label(k) });
const size = (b) => (b > 1048576 ? (b / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(b / 1024)) + " KB");
function chip(d) {
  const st = String(d.state);
  const name = STATE_LABEL[st] || st;
  return h("span", { class: "chip s-" + st.replace(/[^a-z]/g, ""), "data-d": String(Number(d.id)), title: d.note || name },
    h("span", { "aria-hidden": "true", text: STATE_ICON[st] || "•" }), h("span", { class: "mono", text: d.to }), h("span", { text: name }));
}
function head(title, sub, ...actions) {
  return h("div", { class: "head" }, h("div", null, h("h1", { text: title }), sub ? h("div", { class: "sub" }, sub) : null),
    actions.filter(Boolean).length ? h("div", { class: "row-btns" }, actions) : null);
}
const empty = (title, text) => h("div", { class: "empty" }, h("strong", { text: title }), text);
const section = (title) => h("h2", { text: title });
function announce(text) { const el = $("#announce"); el.textContent = ""; setTimeout(() => { el.textContent = text; }, 30); }
function toast(text, bad) {
  const el = h("div", { class: "toast" + (bad ? " bad" : ""), role: bad ? "alert" : "status", text });
  $("#toasts").append(el);
  setTimeout(() => el.remove(), bad ? 6000 : 3000);
}
function highlight(s) {
  const out = [];
  String(s).split("«").forEach((part, i) => {
    const j = part.indexOf("»");
    if (i === 0 || j < 0) out.push(i === 0 ? part : "«" + part);
    else out.push(h("mark", { text: part.slice(0, j) }), part.slice(j + 1));
  });
  return out;
}
function dialog(build) {
  const dlg = h("dialog", null);
  dlg.addEventListener("close", () => dlg.remove());
  dlg.append(build(dlg));
  document.body.append(dlg);
  dlg.showModal();
  return dlg;
}
function confirmDialog(title, text, ok, danger) {
  return new Promise((resolve) => {
    let answer = false;
    const dlg = dialog((d) => h("div", { class: "dlg", role: "document" }, h("h2", { text: title }), h("p", { class: "muted", text }),
      h("div", { class: "actions" }, h("button", { class: "btn", type: "button", onclick: () => d.close() }, "Cancel"),
        h("button", { class: "btn " + (danger ? "danger" : "primary"), type: "button", "data-ok": "", onclick: () => { answer = true; d.close(); } }, ok))));
    dlg.addEventListener("close", () => resolve(answer));
    $("[data-ok]", dlg).focus();
  });
}

// ---------------------------------------------------------------- live store
function entryOf(m, deliveries) { return { m, d: new Map((deliveries || []).map((d) => [d.id, d])) }; }
async function loadLive() {
  const res = await api("log?limit=80");
  S.live = res.messages.slice().reverse().map((r) => entryOf(r.message, r.deliveries));
  S.liveIndex = new Map(S.live.map((e) => [e.m.id, e]));
  S.liveLoaded = true;
}
const recipients = (e) => [...new Set([...e.d.values()].map((d) => d.to))].join(", ") || "…";
function liveCard(e, register) {
  const m = e.m;
  const toEl = h("span", { class: "trunc", text: recipients(e) });
  const chips = h("div", { class: "chips" }, [...e.d.values()].map(chip));
  const card = h("a", { class: "item", href: "#/thread/" + encodeURIComponent(m.thread), "data-nav": "", "data-key": "m" + m.id },
    h("div", { class: "line" }, kindBadge(m.kind), h("span", { class: "who", text: m.from }), h("span", { class: "arrow", text: "→" }), toEl, h("span", { class: "grow" }), timeEl(m.createdAt)),
    m.re ? h("div", { class: "small muted trunc", text: "↪ re " + m.re.from + ": " + m.re.preview }) : null,
    h("div", { class: "preview", text: m.preview }), chips);
  if (register) Object.assign(e, { chips, toEl });
  return card;
}
const kindMatches = (e) => !S.liveKind || e.m.kind === S.liveKind;
function addLive(m) {
  if (S.liveIndex.has(m.id)) return;
  const e = entryOf(m);
  S.live.unshift(e);
  S.liveIndex.set(m.id, e);
  if (S.live.length > 300) S.liveIndex.delete(S.live.pop().m.id);
  if (S.view !== "live") return;
  const feed = $("#feed");
  if (!feed) return route(true);
  if (!kindMatches(e)) return;
  const card = liveCard(e, true);
  card.classList.add("new");
  feed.prepend(card);
}
function onDelivery(d) {
  const e = S.liveIndex.get(d.messageId);
  if (!e) return;
  const isNew = !e.d.has(d.id);
  e.d.set(d.id, d);
  if (!e.chips || !e.chips.isConnected) return;
  const c = chip(d);
  c.classList.add("flash");
  const old = e.chips.querySelector('[data-d="' + Number(d.id) + '"]');
  if (old) old.replaceWith(c); else e.chips.append(c);
  if (isNew) e.toEl.textContent = recipients(e);
}

// ---------------------------------------------------------------- views
function legend(t) {
  return h("div", { class: "legend" }, ["busy", "idle", "offline"].map((k) => h("span", null, h("i", { class: "dot " + k }), (t[k] || 0) + " " + k)));
}
function stat(lbl, num, sub, href, warn) {
  return h(href ? "a" : "div", { class: "card stat" + (warn ? " warn" : ""), href },
    h("div", { class: "label", text: lbl }), h("div", { class: "num trunc", text: String(num) }), sub ? h("div", { class: "small muted" }, sub) : null);
}
async function viewOverview() {
  const [ov, ag] = await Promise.all([api("overview"), api("agents?all=1")]);
  setOverview(ov);
  S.allAgents = ag.agents;
  const L = ov.agents.local, R = ov.agents.remote, team = ov.team;
  const out = [head("Overview", "@" + ov.handle + " on " + ov.host + " · agentlink " + ov.version,
    ov.paused ? null : h("button", { class: "btn", type: "button", onclick: () => control("pause") }, "⏸ Pause delivery"))];
  if (ov.paused) {
    out.push(h("div", { class: "banner", role: "status" },
      h("div", null, h("strong", { text: "Delivery is paused." }), " Messages are kept, but nothing is delivered until you resume."),
      h("button", { class: "btn primary", type: "button", onclick: () => control("resume") }, "▶ Resume")));
  }
  out.push(h("div", { class: "grid" },
    stat("Agents on this machine", L.busy + L.idle, legend(L), "#/agents"),
    stat("Teammates' agents", team ? R.busy + R.idle : "–", team ? legend(R) : "Not in a team", "#/agents"),
    stat("Unread for you", ov.unread, "messages to @" + ov.handle, "#/threads"),
    stat("Waiting on you", ov.todo, "asks and requests to answer", "#/threads"),
    stat("Held for approval", ov.held || 0, ov.held ? "review them now" : "nothing held", "#/approvals", ov.held > 0),
    team
      ? stat("Team", team.name, h("span", { class: "line" }, h("i", { class: "dot " + (team.connected ? "live" : "down") }), (team.connected ? "relay connected" : "relay offline") + " · " + team.membersOnline + "/" + team.members + " online"))
      : stat("Team", "Solo", "Create or join one: agentlink team create <name>")));
  const hosts = new Map();
  for (const a of ag.agents) {
    const key = a.host || (a.local ? ov.host : a.member) || "unknown";
    const t = hosts.get(key) || { busy: 0, idle: 0, offline: 0, tag: a.local ? "this machine" : "@" + a.member };
    t[a.state === "busy" || a.state === "idle" ? a.state : "offline"]++;
    hosts.set(key, t);
  }
  out.push(section("Machines"), hosts.size
    ? h("div", { class: "grid wide" }, [...hosts].map(([host, t]) => h("div", { class: "card" },
        h("div", { class: "line" }, h("strong", { class: "grow trunc", text: host }), h("span", { class: "badge", text: t.tag })), h("div", { class: "small" }, legend(t)))))
    : empty("No agents yet", "Agents appear once their CLI is set up (agentlink install all) and a session starts."));
  const recent = S.live.slice(0, 5);
  out.push(section("Recent activity"), recent.length
    ? h("div", { class: "list" }, recent.map((e) => liveCard(e, false)), h("a", { href: "#/live", class: "small" }, "Open the live feed →"))
    : empty("No messages yet", "Messages between your agents show up here. Start one with New message."));
  out.push(h("p", { class: "small muted", text: "Storage: " + ov.db.messages + " messages · " + size(ov.db.bytes) + (ov.outbox ? " · " + ov.outbox + " waiting to send" : "") }));
  return out;
}
async function viewLive() {
  if (!S.liveLoaded) await loadLive();
  const filter = h("select", { "aria-label": "Filter by kind", onchange: (ev) => { S.liveKind = ev.target.value; route(true); } },
    h("option", { value: "", text: "All kinds" }), KINDS.map((k) => h("option", { value: k, text: label(k), selected: S.liveKind === k })));
  const shown = S.live.filter(kindMatches);
  return [head("Live", "Every message as it happens; delivery receipts update in place.", filter),
    shown.length || !S.liveKind ? h("div", { class: "list", id: "feed", role: "feed", "aria-label": "Messages" }, shown.map((e) => liveCard(e, true))) : null,
    shown.length ? null : empty(S.liveKind ? "No " + label(S.liveKind) + " messages yet" : "Quiet for now", "New messages between your agents appear here in real time.")];
}
async function viewThreads() {
  const res = await api("threads?limit=" + S.threadLimit + (S.threadsOpen ? "&open=1" : ""));
  const seg = h("div", { class: "seg", role: "group", "aria-label": "Show" }, [["All", false], ["Open", true]].map(([t, v]) =>
    h("button", { type: "button", "aria-pressed": String(S.threadsOpen === v), onclick: () => { S.threadsOpen = v; route(true); } }, t)));
  const rows = res.threads.map((t) => h("a", { class: "item", href: "#/thread/" + encodeURIComponent(t.thread), "data-nav": "", "data-key": "t" + t.thread },
    h("div", { class: "line" }, h("span", { class: "subject grow", text: t.subject || "(no text)" }),
      t.unread ? h("span", { class: "badge k-ask", text: t.unread + " unread" }) : null,
      t.open ? h("span", { class: "badge k-request", text: "open" }) : null, timeEl(t.lastAt)),
    h("div", { class: "preview small muted" }, h("span", { class: "who", text: t.lastFrom + ": " }), t.lastPreview),
    h("div", { class: "line small muted" }, h("span", { class: "chips" }, t.participants.slice(0, 6).map((p) => h("span", { class: "chip mono", text: p }))),
      h("span", { text: t.messages + (t.messages === 1 ? " message" : " messages") }))));
  return [head("Conversations", "Threads by last activity. Open means someone still owes an answer.", seg),
    rows.length ? h("div", { class: "list" }, rows) : empty(S.threadsOpen ? "No open conversations" : "No conversations yet",
      S.threadsOpen ? "Nothing is waiting on an answer." : "A conversation starts when an agent (or you) sends a message."),
    res.threads.length >= S.threadLimit && S.threadLimit < 100
      ? h("div", { class: "more" }, h("button", { class: "btn", type: "button", onclick: () => { S.threadLimit = 100; route(true); } }, "Load more")) : null];
}
function bubble(x, prev, me) {
  const m = x.message;
  return h("article", { class: "bubble" + (m.from === me ? " mine" : "") + (S.replyTo && S.replyTo.id === m.id ? " target" : ""), id: "m-" + m.id, tabindex: "-1", "data-nav": "", "data-key": "b" + m.id, "aria-label": label(m.kind) + " from " + m.from },
    h("div", { class: "line" }, h("span", { class: "who", text: m.from }), kindBadge(m.kind), timeEl(m.createdAt), h("span", { class: "grow" }),
      h("button", { class: "btn ghost small", type: "button", onclick: () => setReplyTo(m) }, "Reply")),
    m.re && (!prev || prev.message.id !== m.re.id) ? h("button", { class: "quote", type: "button", onclick: () => jump(m.re.id), text: "↪ " + m.re.from + ": " + m.re.preview }) : null,
    h("div", { class: "body", text: x.text }),
    h("div", { class: "chips" }, x.deliveries.map(chip), h("span", { class: "mono small muted", title: "message id", text: m.id })));
}
function jump(id) {
  const el = document.getElementById("m-" + id);
  if (el) { el.scrollIntoView({ block: "center", behavior: "smooth" }); el.focus({ preventScroll: true }); }
}
function paintThread(res) {
  const me = "@" + S.you.handle;
  const msgs = res.messages;
  S.threadIds = new Set(msgs.map((x) => x.message.id));
  if (!S.replyTo || !S.threadIds.has(S.replyTo.id)) {
    const others = msgs.filter((x) => x.message.from !== me);
    const pool = others.length ? others : msgs;
    S.replyTo = pool.length ? pool[pool.length - 1].message : null;
  }
  S.participants = [...new Set(msgs.flatMap((x) => [x.message.from].concat(x.deliveries.map((d) => d.to))))];
  return msgs.map((x, i) => bubble(x, msgs[i - 1], me));
}
async function refreshThread() {
  const box = $("#thread");
  if (!box) return;
  const res = await api("threads/" + encodeURIComponent(S.arg)).catch(() => null);
  if (!res || S.view !== "thread") return;
  const atEnd = window.innerHeight + window.scrollY >= document.body.scrollHeight - 80;
  box.replaceChildren(...paintThread(res));
  paintReplying();
  if (atEnd) window.scrollTo(0, document.body.scrollHeight);
}
function paintReplying() {
  const el = $("#replying");
  if (!el) return;
  const m = S.replyTo;
  el.replaceChildren(m ? h("span", { class: "trunc", text: "Replying to " + m.from + ": " + m.preview }) : "Nothing to reply to");
  document.querySelectorAll(".bubble").forEach((b) => b.classList.toggle("target", !!m && b.id === "m-" + m.id));
}
function setReplyTo(m) { S.replyTo = m; paintReplying(); $("#reply-text").focus(); }
function composer(me) {
  const ta = h("textarea", { id: "reply-text", placeholder: "Write a reply… (Ctrl+Enter sends)", "aria-label": "Reply text" });
  const kind = h("select", { "aria-label": "Kind" }, ["reply", "ask", "info"].map((k) => h("option", { value: k, text: label(k) })));
  const all = h("input", { type: "checkbox" });
  const send = h("button", { class: "btn primary", type: "button" }, "Send");
  const go = async () => {
    const text = ta.value.trim();
    if (!text || !S.replyTo) return;
    send.disabled = true;
    try {
      await api("messages", { kind: kind.value, replyTo: S.replyTo.id, text, replyAll: all.checked || undefined });
      ta.value = "";
      toast("Sent");
      refreshThread();
    } catch (e) { toast(e.message, true); } finally { send.disabled = false; }
  };
  send.addEventListener("click", go);
  ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); go(); } });
  const many = (S.participants || []).filter((p) => p !== me).length > 1;
  return h("div", { class: "composer" }, h("div", { class: "replying", id: "replying" }), ta,
    h("div", { class: "bar" }, kind, many ? h("label", { class: "small line" }, all, "Reply to everyone") : null, h("span", { class: "grow" }), send));
}
async function viewThread() {
  const res = await api("threads/" + encodeURIComponent(S.arg));
  const bubbles = paintThread(res);
  const first = res.messages[0];
  const out = [h("a", { href: "#/threads", class: "small" }, "← Conversations"),
    head(first ? first.message.preview : "Conversation", h("span", null, S.participants.join(", ") + " · ", h("span", { class: "mono", text: res.thread }))),
    h("div", { class: "thread", id: "thread" }, bubbles), composer("@" + S.you.handle)];
  setTimeout(paintReplying, 0);
  return out;
}
function viewSearch() {
  const s = S.search;
  const q = h("input", { type: "search", class: "search", id: "q", placeholder: "Search messages…", "aria-label": "Search messages", value: s.q, autocomplete: "off" });
  const from = h("input", { placeholder: "From", list: "agent-names", "aria-label": "From", value: s.from });
  const to = h("input", { placeholder: "To", list: "agent-names", "aria-label": "To", value: s.to });
  const kind = h("select", { "aria-label": "Kind" }, h("option", { value: "", text: "Any kind" }), KINDS.map((k) => h("option", { value: k, text: label(k), selected: s.kind === k })));
  const since = h("select", { "aria-label": "Since" }, [["", "Any time"], ["1h", "Last hour"], ["24h", "Last 24 hours"], ["7d", "Last 7 days"], ["30d", "Last 30 days"]]
    .map(([v, t]) => h("option", { value: v, text: t, selected: s.since === v })));
  const names = h("datalist", { id: "agent-names" }, candidates().map((c) => h("option", { value: c.value })));
  const results = h("div", { id: "results", "aria-live": "polite" });
  const run = debounce(() => {
    S.search = { q: q.value, from: from.value.trim(), to: to.value.trim(), kind: kind.value, since: since.value };
    S.searchLimit = 30;
    doSearch(results);
  }, 250);
  [q, from, to].forEach((el) => el.addEventListener("input", run));
  [kind, since].forEach((el) => el.addEventListener("change", run));
  doSearch(results);
  return [head("Search", "Words match as prefixes. Narrow by sender, recipient, kind or time."), q, h("div", { class: "filters" }, from, to, kind, since), names, results];
}
async function doSearch(box) {
  const s = S.search, p = new URLSearchParams();
  if (s.q.trim()) p.set("q", s.q.trim());
  for (const k of ["from", "to", "kind", "since"]) if (s[k]) p.set(k, s[k]);
  p.set("limit", String(S.searchLimit));
  const seq = ++S.searchSeq;
  try {
    const res = await api("search?" + p);
    if (seq !== S.searchSeq) return;
    const rows = res.results.map((r) => h("a", { class: "item", href: "#/thread/" + encodeURIComponent(r.thread), "data-nav": "", "data-key": "s" + r.id },
      h("div", { class: "line" }, kindBadge(r.kind), h("span", { class: "who", text: r.from }), h("span", { class: "arrow", text: "→" }),
        h("span", { class: "trunc grow", text: r.to.join(", ") || "—" }), timeEl(r.createdAt)),
      h("div", { class: "preview" }, highlight(r.snippet)),
      h("div", { class: "line small muted" }, h("span", { text: "~" + r.tokens + " tokens" }), h("span", { class: "mono", text: r.thread }))));
    const more = rows.length >= S.searchLimit && S.searchLimit < 100;
    box.replaceChildren(
      h("p", { class: "small muted", text: (s.q.trim() ? (rows.length + (more ? "+" : "") + " results") : "Most recent messages") + (res.fts ? "" : " · simple matching (no full-text index)") }),
      rows.length ? h("div", { class: "list" }, rows) : empty("No matches", s.q ? "Try fewer or shorter words, or widen the filters." : "No messages match these filters."),
      more ? h("div", { class: "more" }, h("button", { class: "btn", type: "button", onclick: () => { S.searchLimit = 100; doSearch(box); } }, "Load more")) : "");
  } catch (e) {
    if (seq === S.searchSeq) box.replaceChildren(empty("Search failed", e.message));
  }
}
function repoName(r) { return r ? String(r).replace(/^[a-z]+:\/\/(www\.)?github\.com\//, "").replace(/^git@github\.com:/, "").replace(/\.git$/, "") : ""; }
function agentCard(a) {
  const row = (k, v) => [h("dt", { text: k }), h("dd", { text: v, title: v })];
  return h("div", { class: "card agent", tabindex: "0", "data-nav": "", "data-key": "a" + a.id },
    h("div", { class: "line" }, h("i", { class: "dot " + String(a.state).replace(/[^a-z]/g, ""), title: a.state }), h("span", { class: "name trunc grow", text: a.name }),
      h("span", { class: "badge", text: a.tool }), a.muted ? h("span", { class: "badge k-request", text: "muted" }) : null),
    h("dl", { class: "meta" }, row("State", a.state + (a.stateAt ? " · " + ago(a.stateAt) : "")),
      a.repo ? row("Repo", repoName(a.repo) + (a.branch ? " @ " + a.branch : "")) : null,
      row("Host", a.host || "—"), a.reach ? row("Reach", String(a.reach)) : null, a.local ? row("Wakes via", a.wakeVia || "next turn") : null),
    a.status ? h("div", { class: "status", text: a.status }) : null,
    h("div", { class: "row-btns" }, h("button", { class: "btn small", type: "button", onclick: () => compose([a.local ? a.name : a.address]) }, "Message"),
      a.local ? h("button", { class: "btn small", type: "button", onclick: () => control(a.muted ? "unmute" : "mute", a.name) }, a.muted ? "Unmute" : "Mute") : null));
}
async function viewAgents() {
  const [res, cl] = await Promise.all([api("agents" + (S.showOffline ? "?all=1" : "")), api("claims")]);
  const local = res.agents.filter((a) => a.local), groups = new Map();
  for (const a of res.agents) if (!a.local) groups.set(a.member, (groups.get(a.member) || []).concat(a));
  const toggle = h("label", { class: "small line" }, h("input", { type: "checkbox", checked: S.showOffline, onchange: (e) => { S.showOffline = e.target.checked; route(true); } }), "Show offline");
  const out = [head("Agents", res.agents.length + (S.showOffline ? " known" : " online") + (res.team ? " · team " + res.team : ""), toggle),
    section("This machine · " + res.you.host),
    local.length ? h("div", { class: "grid wide" }, local.map(agentCard)) : empty(S.showOffline ? "No local agents" : "No local agents online", "Start a Claude Code, Codex or OpenCode session after agentlink install all.")];
  for (const [member, list] of groups) out.push(section("@" + member), h("div", { class: "grid wide" }, list.map(agentCard)));
  if (res.team && !groups.size) out.push(section("Teammates"), empty("No teammates' agents online", "They appear while a teammate's agent session runs."));
  if (cl.claims.length) {
    out.push(section("File claims"), h("div", { class: "list" }, cl.claims.map((c) => h("div", { class: "item line" },
      h("span", { class: "mono grow trunc", text: c.pattern }), h("span", { class: "who", text: c.agent }), c.reason ? h("span", { class: "muted trunc", text: c.reason }) : null,
      h("span", { class: "small muted", text: "until " + new Date(c.expiresAt).toLocaleTimeString() })))));
  }
  return out;
}
async function viewApprovals() {
  const res = await api("approvals");
  if (S.ov) { S.ov.held = res.items.length; badges(); }
  const cards = res.items.map((i) => h("div", { class: "card", tabindex: "0", "data-nav": "", "data-key": "h" + i.delivery.id },
    h("div", { class: "line" }, kindBadge(i.message.kind), h("span", { class: "who", text: i.message.from }), h("span", { class: "arrow", text: "→" }),
      h("span", { class: "grow trunc", text: i.delivery.to }), timeEl(i.message.createdAt)),
    h("div", { class: "line small muted" }, h("span", { text: "trust: " + i.message.trust }), h("span", { class: "mono", text: "#" + i.delivery.id + " · " + i.message.id })),
    h("div", { class: "fulltext", text: i.text }),
    i.attachments && i.attachments.length ? h("p", { class: "small muted", text: i.attachments.length + " attachment(s): see agentlink read " + i.message.id }) : null,
    h("div", { class: "row-btns" }, h("button", { class: "btn primary", type: "button", onclick: () => decide(i, "approve") }, "Approve…"),
      h("button", { class: "btn danger", type: "button", onclick: () => decide(i, "deny") }, "Deny…"))));
  return [head("Approvals", "Messages held by your policy wait here until you approve or deny them."),
    cards.length ? h("div", { class: "list" }, cards) : empty("Nothing is waiting for approval", "Messages your policy holds (agentlink policy) appear here.")];
}

// ---------------------------------------------------------------- actions
async function decide(i, decision) {
  const yes = decision === "approve";
  const ok = await confirmDialog((yes ? "Approve" : "Deny") + " this " + label(i.message.kind) + "?",
    "From " + i.message.from + " to " + i.delivery.to + ". " + (yes ? "It is delivered right away." : "It will not be delivered."), yes ? "Approve" : "Deny", !yes);
  if (!ok) return;
  try {
    await api("approvals/" + Number(i.delivery.id), { decision });
    toast(yes ? "Approved; delivering" : "Denied");
    route(true);
  } catch (e) { toast(e.message, true); }
}
async function control(action, agent) {
  if (action === "pause" && !(await confirmDialog("Pause all delivery?", "Messages are kept but not delivered, and agents see nothing new until you resume.", "Pause", true))) return;
  try {
    await api("control", agent ? { action, agent } : { action });
    toast(agent ? agent + " " + action + "d" : "Delivery " + action + "d");
    refreshCounts();
    route(true);
  } catch (e) { toast(e.message, true); }
}
function candidates() {
  const out = [], seen = new Set();
  const push = (value, hint, state) => { if (!seen.has(value)) { seen.add(value); out.push({ value, hint, state }); } };
  for (const a of S.allAgents) {
    push(a.local ? a.name : a.address, a.tool + (a.local ? "" : " · @" + a.member), a.state);
    if (!a.local && a.member) push("@" + a.member, "teammate (person)", "idle");
  }
  return out;
}
function compose(prefill) {
  const chosen = (prefill || []).filter(Boolean);
  let options = [], active = -1;
  const chips = h("span", { class: "chips" });
  const input = h("input", { role: "combobox", "aria-autocomplete": "list", "aria-expanded": "false", "aria-controls": "compose-suggest", "aria-label": "Recipients", placeholder: "agent, teammate/agent or @person", autocomplete: "off" });
  const list = h("ul", { class: "suggest", id: "compose-suggest", role: "listbox", hidden: true });
  const text = h("textarea", { "aria-label": "Message", placeholder: "What should they know or do? (Ctrl+Enter sends)" });
  const kind = h("select", { "aria-label": "Kind" }, ["info", "ask", "request", "handoff", "review_request"].map((k) => h("option", { value: k, text: label(k) })));
  const err = h("div", { class: "small", role: "alert" });
  const paint = () => chips.replaceChildren(...chosen.map((to, i) => h("span", { class: "to-chip" }, to,
    h("button", { type: "button", "aria-label": "Remove " + to, onclick: () => { chosen.splice(i, 1); paint(); input.focus(); } }, "×"))));
  const suggest = () => {
    const q = input.value.trim().toLowerCase();
    options = q ? candidates().filter((c) => c.value.toLowerCase().includes(q) && !chosen.includes(c.value)).slice(0, 7) : [];
    active = options.length ? 0 : -1;
    list.replaceChildren(...options.map((o, i) => h("li", { role: "option", id: "opt-" + i, "aria-selected": String(i === active), onmousedown: (e) => { e.preventDefault(); pick(o.value); } },
      h("i", { class: "dot " + String(o.state).replace(/[^a-z]/g, "") }), h("span", { class: "mono", text: o.value }), h("span", { class: "muted small", text: o.hint }))));
    list.hidden = !options.length;
    input.setAttribute("aria-expanded", String(!!options.length));
    if (active >= 0) input.setAttribute("aria-activedescendant", "opt-0"); else input.removeAttribute("aria-activedescendant");
  };
  const pick = (v) => { v = v.trim(); if (v && !chosen.includes(v)) chosen.push(v); input.value = ""; paint(); suggest(); };
  const move = (d) => {
    if (!options.length) return;
    active = (active + d + options.length) % options.length;
    [...list.children].forEach((li, i) => li.setAttribute("aria-selected", String(i === active)));
    input.setAttribute("aria-activedescendant", "opt-" + active);
  };
  input.addEventListener("input", () => {
    if (input.value.includes(",")) { const parts = input.value.split(","); const last = parts.pop(); parts.forEach(pick); input.value = last; }
    suggest();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); move(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
    else if ((e.key === "Enter" || e.key === "Tab") && options[active]) { e.preventDefault(); pick(options[active].value); }
    else if (e.key === "Enter" && input.value.trim()) { e.preventDefault(); pick(input.value); }
    else if (e.key === "Backspace" && !input.value && chosen.length) { chosen.pop(); paint(); }
    else if (e.key === "Escape" && !list.hidden) { e.preventDefault(); options = []; list.hidden = true; }
  });
  input.addEventListener("blur", () => setTimeout(() => { list.hidden = true; }, 100));
  const dlg = dialog((d) => {
    const send = h("button", { class: "btn primary", type: "button" }, "Send");
    const go = async () => {
      if (input.value.trim()) pick(input.value);
      err.textContent = "";
      if (!chosen.length) { err.textContent = "Add at least one recipient."; return input.focus(); }
      if (!text.value.trim()) { err.textContent = "Write a message first."; return text.focus(); }
      send.disabled = true;
      try {
        const res = await api("messages", { to: chosen, kind: kind.value, text: text.value.trim() });
        d.close();
        toast("Sent · " + res.deliveries.map((x) => x.to + ": " + (STATE_LABEL[x.state] || x.state)).join(", "));
      } catch (e) { err.textContent = e.message; } finally { send.disabled = false; }
    };
    send.addEventListener("click", go);
    text.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); go(); } });
    return h("div", { class: "dlg" }, h("h2", { text: "New message" }),
      h("div", null, h("div", { class: "small muted", text: "To" }), h("div", { class: "to-box" }, chips, input, list)),
      h("label", null, "Kind", kind), h("label", null, "Message", text), err,
      h("div", { class: "actions" }, h("span", { class: "small muted grow", text: "Sent as you (@" + S.you.handle + ")" }), h("button", { class: "btn", type: "button", onclick: () => d.close() }, "Cancel"), send));
  });
  dlg.setAttribute("aria-label", "New message");
  paint();
  (chosen.length ? text : input).focus();
}
function help() {
  const keys = [["/", "Search"], ["j / k", "Next / previous item"], ["Enter", "Open"], ["Esc", "Back / leave a field"], ["c", "New message"], ["1 – 6", "Switch view"], ["?", "This help"]];
  dialog((d) => h("div", { class: "dlg" }, h("h2", { text: "Keyboard shortcuts" }),
    h("div", { class: "keys" }, keys.map(([k, v]) => [h("kbd", { text: k }), h("span", { text: v })])),
    h("div", { class: "actions" }, h("button", { class: "btn", type: "button", onclick: () => d.close() }, "Close"))));
}

// ---------------------------------------------------------------- shell
function badges() {
  const ov = S.ov;
  const set = (view, n, hot) => {
    const el = $('.nav a[data-view="' + view + '"] .count');
    el.textContent = n ? String(n) : "";
    el.hidden = !n;
    el.classList.toggle("hot", !!(hot && n));
  };
  set("threads", ov.unread, false);
  set("approvals", ov.held || 0, true);
  $("#who").textContent = "@" + ov.handle + " · " + ov.host;
  $("#paused").hidden = !ov.paused;
}
function setOverview(ov) { S.ov = ov; S.you = { handle: ov.handle, host: ov.host }; badges(); }
async function refreshCounts() { try { setOverview(await api("overview")); } catch {} }
function expired() {
  if (S.expired) return;
  S.expired = true;
  if (S.es) S.es.close();
  clearTimeout(S.retry);
  setConn("down", 0, "Signed out");
  main.replaceChildren(h("div", { class: "center card" }, h("h1", { text: "Session ended" }),
    h("p", { class: "muted" }, "Run ", h("code", { text: "agentlink ui" }), " in a terminal to open a new one.")));
}
function setConn(state, ms, text) {
  const el = $("#conn");
  const msg = text || (state === "live" ? "Live" : state === "connecting" ? "Connecting…" : "Disconnected · retrying in " + Math.ceil(ms / 1000) + "s");
  $(".dot", el).className = "dot " + state;
  $("span", el).textContent = msg;
  el.title = msg;
  $("#offline").hidden = state !== "down";
  $("#offline-text").textContent = msg;
  clearInterval(S.tick);
  if (state === "down" && !text) {
    const until = Date.now() + ms;
    S.tick = setInterval(() => {
      const left = Math.max(0, Math.ceil((until - Date.now()) / 1000));
      const m2 = "Disconnected · retrying in " + left + "s";
      $("span", el).textContent = m2;
      $("#offline-text").textContent = m2;
    }, 1000);
  }
}
function connect() {
  clearTimeout(S.retry);
  if (S.expired) return;
  setConn("connecting");
  const es = new EventSource("/api/v1/events?k=" + encodeURIComponent(key()));
  S.es = es;
  es.onopen = () => {
    const again = S.connectedOnce;
    S.connectedOnce = true;
    S.backoff = 1000;
    setConn("live");
    if (again) { refreshCounts(); loadLive().then(() => route(true), () => {}); }
  };
  es.onmessage = (e) => { let ev; try { ev = JSON.parse(e.data); } catch { return; } onEvent(ev); };
  es.onerror = () => {
    es.close();
    if (S.expired) return;
    const wait = S.backoff;
    S.backoff = Math.min(S.backoff * 2, 30000);
    setConn("down", wait);
    S.retry = setTimeout(connect, wait);
    api("overview").catch(() => {});
  };
}
const soon = debounce(() => {
  refreshCounts();
  if (S.agentsDirty) { S.agentsDirty = false; api("agents?all=1").then((r) => { S.allAgents = r.agents; }, () => {}); }
  if (["overview", "agents", "threads", "approvals"].includes(S.view)) route(true);
  else if (S.view === "thread") refreshThread();
}, 400);
function onEvent(ev) {
  if (ev.type === "message" && ev.message) {
    addLive(ev.message);
    announce("New " + label(ev.message.kind) + " from " + ev.message.from);
  } else if (ev.type === "delivery" && ev.delivery) onDelivery(ev.delivery);
  else if (ev.type === "agent") S.agentsDirty = true;
  else if (ev.type === "notice" && ev.text) toast(ev.text, ev.level === "warn");
  soon();
}
async function render(fn, fresh) {
  const seq = ++S.seq;
  const active = document.activeElement;
  const key = active && active.getAttribute ? active.getAttribute("data-key") : null;
  main.setAttribute("aria-busy", "true");
  try {
    const nodes = await fn();
    if (seq !== S.seq || S.expired) return;
    main.replaceChildren(...[].concat(nodes).filter(Boolean));
    if (key) { const el = [...main.querySelectorAll("[data-key]")].find((x) => x.getAttribute("data-key") === key); if (el) el.focus({ preventScroll: true }); }
    if (fresh) { main.focus({ preventScroll: true }); window.scrollTo(0, S.view === "thread" ? document.body.scrollHeight : 0); }
    if (S.view === "search" && S.focusSearch) { S.focusSearch = false; $("#q").focus(); }
  } catch (e) {
    if (seq === S.seq && !S.expired) main.replaceChildren(head(TITLES[S.view] || "agentlink"), empty("Could not load this view", e.message));
  } finally { main.removeAttribute("aria-busy"); }
}
function route(soft) {
  const parts = (location.hash.replace(/^#\/?/, "") || "overview").split("/");
  let view = parts[0], arg = "";
  try { arg = decodeURIComponent(parts.slice(1).join("/")); } catch {}
  if (!(view === "thread" && arg) && !VIEWS.includes(view)) view = "overview";
  const fresh = !soft && (view !== S.view || arg !== S.arg);
  if (fresh && view === "thread") S.replyTo = null;
  S.view = view;
  S.arg = arg;
  const current = view === "thread" ? "threads" : view;
  document.querySelectorAll(".nav a").forEach((a) => { if (a.getAttribute("data-view") === current) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current"); });
  document.title = TITLES[view] + " · agentlink";
  const fn = { overview: viewOverview, live: viewLive, threads: viewThreads, thread: viewThread, search: viewSearch, agents: viewAgents, approvals: viewApprovals }[view];
  render(fn, fresh);
}
function navMove(d) {
  const items = [...main.querySelectorAll("[data-nav]")];
  if (!items.length) return;
  const i = items.indexOf(document.activeElement);
  const next = items[i < 0 ? (d > 0 ? 0 : items.length - 1) : Math.max(0, Math.min(items.length - 1, i + d))];
  next.focus();
  next.scrollIntoView({ block: "nearest" });
}
document.addEventListener("keydown", (e) => {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || document.querySelector("dialog[open]")) return;
  const t = e.target;
  const typing = t && t.closest && t.closest("input, textarea, select");
  if (e.key === "Escape") {
    if (typing) t.blur();
    else if (S.view === "thread") location.hash = "#/threads";
    return;
  }
  if (typing) return;
  if (e.key === "/") {
    e.preventDefault();
    if (S.view === "search") $("#q").focus();
    else { S.focusSearch = true; location.hash = "#/search"; }
  } else if (e.key === "j" || e.key === "k") { e.preventDefault(); navMove(e.key === "j" ? 1 : -1); }
  else if (e.key === "c") { e.preventDefault(); compose(); }
  else if (e.key === "?") help();
  else if (/^[1-6]$/.test(e.key)) location.hash = "#/" + VIEWS[Number(e.key) - 1];
});

const THEMES = ["system", "light", "dark"];
let theme = "system";
try { theme = localStorage.getItem("agentlink.theme") || "system"; } catch {}
if (!THEMES.includes(theme)) theme = "system";
function applyTheme() {
  document.documentElement.setAttribute("data-theme", theme);
  const b = $("#theme");
  b.textContent = (theme === "dark" ? "☾ " : theme === "light" ? "☀ " : "◐ ") + theme[0].toUpperCase() + theme.slice(1) + " theme";
  b.setAttribute("aria-label", "Theme: " + theme + ". Click to change.");
}
$("#theme").addEventListener("click", () => {
  theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
  try { localStorage.setItem("agentlink.theme", theme); } catch {}
  applyTheme();
});
$("#compose").addEventListener("click", () => compose());
$("#help").addEventListener("click", help);
applyTheme();
window.addEventListener("hashchange", () => route());
setInterval(() => document.querySelectorAll("time.ago").forEach((el) => { el.textContent = ago(el.getAttribute("datetime")); }), 30000);
Promise.all([refreshCounts(), loadLive().catch(() => {}), api("agents?all=1").then((r) => { S.allAgents = r.agents; }, () => {})]).then(() => route());
connect();
})();
`;
