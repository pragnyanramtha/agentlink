// Web UI script, part 1: DOM helpers, icons, formatting, the API client and the shared store.
// Every node is built with createElement/textContent; message data never meets an HTML parser.
export const CORE = String.raw`
const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
function add(el, c) {
  if (c == null || c === false) return;
  if (Array.isArray(c)) c.forEach((x) => add(el, x));
  else el.append(c.nodeType ? c : document.createTextNode(String(c)));
}
// h(tag, props | className, ...children): a string in place of props is the class name.
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (typeof props === "string") props = { class: props };
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
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const uniq = (xs) => [...new Set(xs)];

// ---------------------------------------------------------------- icons (one 1.5px stroke family)
const SVGNS = "http://www.w3.org/2000/svg";
const C = (x, y, r) => "M" + (x - r) + " " + y + "a" + r + " " + r + " 0 1 0 " + 2 * r + " 0a" + r + " " + r + " 0 1 0 " + -2 * r + " 0";
const ICONS = {
  radar: [C(12, 12, 9), C(12, 12, 4.5), "M12 12l6.4-6.4", C(12, 12, 0.6)],
  graph: [C(6, 6.5, 2.2), C(18, 8, 2.2), C(9.5, 18, 2.2), "M8.1 6.9l7.7.8M6.6 8.6l2.2 7.3M16.6 9.8l-5.6 6.6"],
  threads: ["M4 5h11a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H9l-4 3v-3H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z", "M19 9h1a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-1v3l-3-3h-4"],
  agents: [C(7, 9, 2.6), C(7, 17, 2.6), "M12.5 8h8M12.5 11h5M12.5 16h8M12.5 19h5"],
  search: [C(11, 11, 6.5), "M16 16l4.5 4.5"],
  approvals: ["M5 4h14v16H5z", "M8.5 12.5l2.5 2.5 4.5-5.5"],
  compose: ["M4 20h4L19 9l-4-4L4 16v4z", "M13.5 6.5l4 4"],
  command: ["M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6z"],
  contrast: [C(12, 12, 8.5), "M12 3.5v17", "M12 7l4.5-2.5M12 11l7-4M12 15l8-4M12 19l5-3"],
  help: [C(12, 12, 9), "M9.6 9.4a2.5 2.5 0 1 1 3.4 2.4c-.6.3-1 .8-1 1.5v.7", "M12 17v.1"],
  close: ["M6 6l12 12M18 6L6 18"],
  split: ["M3.5 5h17v14h-17z", "M12 5v14"],
  left: ["M3.5 5h17v14h-17z", "M9 5v14"],
  right: ["M3.5 5h17v14h-17z", "M15 5v14"],
  menu: ["M4 7h16M4 12h16M4 17h16"],
  pause: ["M9 5.5v13M15 5.5v13"],
  play: ["M8 5.5l10.5 6.5L8 18.5z"],
  freeze: ["M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9"],
  plus: ["M12 5v14M5 12h14"],
  minus: ["M5 12h14"],
  fit: ["M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"],
  link: ["M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1", "M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"],
  send: ["M4 12l16-8-6 16-3-7z", "M11 13l9-9"],
  machine: ["M4 5h16v11H4z", "M9 20h6M12 16v4"],
  chev: ["M9 6l6 6-6 6"],
  user: [C(12, 8, 3.5), "M5 20c.8-3.6 3.6-5.5 7-5.5s6.2 1.9 7 5.5"],
  clock: [C(12, 12, 8.5), "M12 7.5V12l3 2"],
  hash: ["M5 9h14M5 15h14M10 4L8 20M16 4l-2 16"],
  reply: ["M10 8L5 12l5 4", "M5 12h9a5 5 0 0 1 5 5v1"],
  team: [C(9, 9, 3), C(17, 10, 2.4), "M3.5 19c.6-3.2 2.8-5 5.5-5s4.9 1.8 5.5 5", "M15 14.6c2.6-.4 4.6 1.2 5.2 4"],
  inbox: ["M4 13l2.5-8h11L20 13v6H4z", "M4 13h4.5l1 2h5l1-2H20"],
  more: [C(6, 12, 0.8), C(12, 12, 0.8), C(18, 12, 0.8)],
};
function icon(name, cls) {
  const svg = document.createElementNS(SVGNS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", "i" + (cls ? " " + cls : ""));
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  for (const d of ICONS[name] || []) {
    const p = document.createElementNS(SVGNS, "path");
    p.setAttribute("d", d);
    svg.append(p);
  }
  return svg;
}

// ---------------------------------------------------------------- vocabulary
const KINDS = ["info", "ask", "request", "handoff", "review_request", "review_result", "reply", "ack"];
const KCODE = { info: "INF", ask: "ASK", request: "REQ", handoff: "HND", review_request: "REV", review_result: "RES", reply: "RPL", ack: "ACK" };
const KLABEL = { info: "info", ask: "ask", request: "request", handoff: "handoff", review_request: "review request", review_result: "review result", reply: "reply", ack: "acknowledgement" };
const KMEAN = { info: "for your information", ask: "a question", request: "asks for work", handoff: "passes work on", review_request: "asks for a review", review_result: "a review", reply: "an answer", ack: "accepts or declines" };
const ANSWERED = new Set(["ask", "request", "handoff", "review_request"]);
const STATE_LABEL = { queued: "queued", sent: "sent", delivered: "delivered", seen: "read", acked: "acknowledged", replied: "replied", held: "held", refused: "refused", expired: "expired", failed: "failed" };
const STATE_ICON = { queued: "○", sent: "↗", delivered: "✓", seen: "✓✓", acked: "✔", replied: "↩", held: "⏸", refused: "⊘", expired: "⌛", failed: "✕" };
const HARNESS = ["claude", "codex", "opencode", "gemini", "copilot", "cursor", "kiro", "devin", "agy", "worker", "generic"];
const GLYPH = { claude: "C", codex: "X", opencode: "O", gemini: "G", copilot: "P", cursor: "U", kiro: "K", devin: "D", agy: "A", worker: "W", generic: "•" };
const kcls = (k) => "k-" + String(k).replace(/[^a-z_]/g, "");
const scls = (s) => String(s || "").replace(/[^a-z]/g, "");
const toolOf = (a) => (a && HARNESS.includes(a.tool) ? a.tool : "generic");
const kcode = (k) => KCODE[k] || String(k).slice(0, 3).toUpperCase();
const klabel = (k) => KLABEL[k] || String(k);
const callsign = (id) => String(id || "").slice(0, 12).toUpperCase();
// A flight's callsign: its kind and the last four characters of its id (ASK·7Z45).
const tail4 = (id) => String(id || "").slice(-4).toUpperCase();
const csign = (m) => kcode(m.kind) + "·" + tail4(m.id);

// ---------------------------------------------------------------- formatting (Intl)
const T_HMS = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
const T_HM = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const T_FULL = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" });
const T_DAY = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const RTF = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const NF = new Intl.NumberFormat();
const ts = (iso) => (typeof iso === "number" ? iso : Date.parse(iso || "")) || 0;
const hms = (iso) => { const t = ts(iso); return t ? T_HMS.format(t) : "--:--:--"; };
function stamp(iso) {
  const t = ts(iso);
  if (!t) return "";
  return Date.now() - t < 20 * 3600000 ? T_HM.format(t) : T_DAY.format(t) + " " + T_HM.format(t);
}
function ago(iso) {
  const t = ts(iso);
  if (!t) return "";
  const s = Math.round((t - Date.now()) / 1000);
  if (Math.abs(s) < 45) return "just now";
  const m = Math.round(s / 60);
  if (Math.abs(m) < 60) return RTF.format(m, "minute");
  const hr = Math.round(m / 60);
  if (Math.abs(hr) < 24) return RTF.format(hr, "hour");
  const d = Math.round(hr / 24);
  return Math.abs(d) < 7 ? RTF.format(d, "day") : T_DAY.format(t);
}
const timeEl = (iso, cls) => h("time", { datetime: iso, title: ts(iso) ? T_FULL.format(ts(iso)) : null, class: cls || "ago", text: ago(iso) });
// Age chips ("held 9m") darken to ember as the wait grows; the 30 s clock repaints them.
function paintAge(el) {
  const ms = Date.now() - ts(el.getAttribute("data-t")), m = Math.floor(ms / 60000);
  el.textContent = el.getAttribute("data-p") + " " + (m < 1 ? "<1m" : m < 60 ? m + "m" : Math.floor(m / 60) + "h");
  el.className = "age" + (ms >= 900000 ? " a3" : ms >= 300000 ? " a2" : "");
}
function ageEl(prefix, iso) { const el = h("span", { "data-t": iso, "data-p": prefix, title: ts(iso) ? T_FULL.format(ts(iso)) : null }); paintAge(el); return el; }
const plural = (n, one, many) => NF.format(n) + " " + (n === 1 ? one : many || one + "s");
const size = (b) => (b > 1048576 ? (b / 1048576).toFixed(1) + "\u00a0MB" : Math.max(1, Math.round(b / 1024)) + "\u00a0KB");

// ---------------------------------------------------------------- session key + API
// The session's API key arrives once in the fragment (never sent to a server); keep it in
// storage scoped to this origin, unlike cookies, which every port on 127.0.0.1 shares.
let KEY = "";
const fromLogin = /^#k=([A-Za-z0-9_-]{43})$/.exec(location.hash);
if (fromLogin) {
  KEY = fromLogin[1];
  try { localStorage.setItem("agentlink.key", KEY); } catch {}
  history.replaceState(null, "", location.pathname + "#/airspace");
} else {
  try { KEY = localStorage.getItem("agentlink.key") || ""; } catch {}
}
// A newer login (another tab) replaces the cookie and the stored key together.
const key = () => { try { return localStorage.getItem("agentlink.key") || KEY; } catch { return KEY; } };
async function api(path, body) {
  const opts = { credentials: "same-origin", headers: { accept: "application/json", "x-agentlink-key": key() } };
  if (body !== undefined) {
    opts.method = "POST";
    opts.headers["content-type"] = "application/json";
    opts.headers["x-agentlink-ui"] = "1";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch("/api/v1/" + path, opts);
  if (res.status === 401) { expired(); throw new Error("Your session has ended. Run agentlink ui for a new link."); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const err = new Error((data.error && data.error.message) || "Request failed (" + res.status + "). Try again."); err.status = res.status; throw err; }
  return data;
}

// ---------------------------------------------------------------- preferences
const PREF_KEY = "agentlink.tower";
// exBy: the explorer's open state you chose per width (n: under 1280, a: Airspace under 1600, w: wide).
const PREFS = { exBy: {}, inspector: true, split: false, hideKinds: [], freeze: false, showOffline: false, threadsOpen: false, graphWindow: "1h", graphThreads: false, gList: null, airTab: "strips", tabs: ["airspace"], panes: ["airspace", null], filter: "", closedMachines: [] };
try { Object.assign(PREFS, JSON.parse(localStorage.getItem(PREF_KEY) || "{}")); } catch {}
if (!PREFS.exBy || typeof PREFS.exBy !== "object") PREFS.exBy = {};
if (PREFS.explorer === false && PREFS.exBy.w == null) PREFS.exBy.w = false;
if (!Array.isArray(PREFS.hideKinds)) PREFS.hideKinds = [];
delete PREFS.explorer; delete PREFS.kind;
// Tabs that failed to open (a conversation that is gone) stay out of the saved layout.
const BADTABS = new Set();
const savePrefs = debounce(() => {
  const ok = (id) => !BADTABS.has(id);
  try { localStorage.setItem(PREF_KEY, JSON.stringify(Object.assign({}, PREFS, { tabs: PREFS.tabs.filter(ok), panes: PREFS.panes.map((p) => (ok(p) ? p : null)) }))); } catch {}
}, 200);

// ---------------------------------------------------------------- store
const CAP_MSGS = 400;
const S = {
  you: { handle: "", host: "" }, ov: null, team: null, agents: [], idx: new Map(),
  msgs: new Map(), order: [], threads: [], titles: new Map(), held: [], tinfo: new Map(), texts: new Map(),
  sel: null, hl: null, iso: null, backoff: 1000, expired: false, conn: "connecting",
};
function setAgents(list) {
  S.agents = list;
  S.idx = new Map();
  for (const a of list) {
    a.key = a.address || a.name;
    a.short = a.local ? a.name : a.address || a.name;
    S.idx.set(a.name, a);
    if (a.address) S.idx.set(a.address, a);
  }
}
function agentOf(addr) {
  if (!addr) return undefined;
  const hit = S.idx.get(addr);
  if (hit) return hit;
  const pre = S.you.handle + "/";
  return S.you.handle && addr.indexOf(pre) === 0 ? S.idx.get(addr.slice(pre.length)) : undefined;
}
const keyOf = (addr) => { const a = agentOf(addr); return a ? a.key : String(addr || ""); };
const isYou = (addr) => addr === "@" + S.you.handle;
function nameOf(addr) {
  const a = agentOf(addr);
  if (a) return a.short;
  const pre = S.you.handle + "/";
  return S.you.handle && String(addr).indexOf(pre) === 0 ? String(addr).slice(pre.length) : String(addr || "?");
}
const identityOf = (a) => (a ? [a.harness || a.tool, a.modelShort].filter(Boolean).join(" · ") : "");
function upsert(m, ds, live) {
  let e = S.msgs.get(m.id);
  if (e) { for (const d of ds || []) e.d.set(d.id, d); return e; }
  e = { m, d: new Map((ds || []).map((d) => [d.id, d])), live: !!live, at: Date.now(), sentAt: null };
  S.msgs.set(m.id, e);
  if (!S.titles.has(m.thread) && !m.re) S.titles.set(m.thread, m.preview);
  if (!m.re && !S.tinfo.has(m.thread)) { S.tinfo.set(m.thread, e); if (S.tinfo.size > 600) S.tinfo.delete(S.tinfo.keys().next().value); }
  if (!S.order.length || m.createdAt >= S.order[0].m.createdAt) S.order.unshift(e);
  else {
    const i = S.order.findIndex((x) => x.m.createdAt < m.createdAt);
    if (i < 0) S.order.push(e); else S.order.splice(i, 0, e);
  }
  while (S.order.length > CAP_MSGS) S.msgs.delete(S.order.pop().m.id);
  return e;
}
function ingestLog(rows) { for (const r of rows.slice().reverse()) upsert(r.message, r.deliveries, false); }
function applyDelivery(d) {
  const e = S.msgs.get(d.messageId);
  if (!e) return null;
  const prev = e.d.get(d.id);
  if (d.state === "sent" && !e.sentAt) e.sentAt = new Date().toISOString();
  e.d.set(d.id, d);
  return { e, prev };
}
const recipients = (e) => uniq([...e.d.values()].map((d) => d.to));
const involves = (e, k) => keyOf(e.m.from) === k || [...e.d.values()].some((d) => keyOf(d.to) === k);
const titleOf = (thread) => S.titles.get(thread) || (S.threads.find((t) => t.thread === thread) || {}).subject || "Conversation";

// A conversation's state for anyone looking, not only you: the server's reading when it sends
// one, else the same rules over the messages at hand. Every label and class comes from here, so
// a list row, the note and the explorer cannot disagree.
const OPEN_D = new Set(["queued", "sent", "delivered", "seen"]);
const rowsOf = (list) => list.map((x) => (x.message ? { m: x.message, ds: x.deliveries } : { m: x.m, ds: [...x.d.values()] }));
function convState(t, rows) {
  t = t || {};
  let st = t.state, aw = [...(t.awaiting || [])], held = t.held || 0;
  if (!st && rows && rows.length) {
    let you = false;
    for (const r of rows) {
      held += r.ds.filter((d) => d.state === "held").length;
      if (!ANSWERED.has(r.m.kind) || r.ds.some((d) => d.state === "replied" || d.state === "acked")) continue;
      for (const d of r.ds) if (OPEN_D.has(d.state)) { if (isYou(d.to)) you = true; else aw.push(d.to); }
    }
    aw = uniq(aw);
    st = held ? "held" : you ? "waiting_on_you" : aw.length ? "awaiting" : "answered";
  } else if (!st) st = t.needsAnswer ? "waiting_on_you" : t.waiting || t.open ? "awaiting" : "answered";
  const who = aw.length ? nameOf(aw[0]) + (aw.length > 1 ? " +" + (aw.length - 1) : "") : "a reply";
  const label = st === "held" ? (held > 1 ? held + " held" : "held") : st === "waiting_on_you" ? "waiting on you" : st === "awaiting" ? "awaiting " + who : "answered";
  return { st, label, cls: { held: "held", waiting_on_you: "you", awaiting: "await" }[st] || "done", aw };
}
function threadState(id, t) {
  t = t || S.threads.find((x) => x.thread === id);
  const v = views.get("thread/" + id), d = v && v.data;
  if (d && d.state) return convState(d);
  if (t && t.state) return convState(t);
  if (d) return convState(t, rowsOf(d.messages));
  const mine = S.order.filter((e) => e.m.thread === id);
  return convState(t, mine.length ? rowsOf(mine) : null);
}
function statePill(cs) { return h("span", "pill " + cs.cls, cs.label); }

// Where a message is in its flight: QUEUED ▸ SENT ▸ DLVR ▸ SEEN ▸ RPLD, for all its recipients.
const RANK = { queued: 0, held: 0, sent: 1, delivered: 2, seen: 3, acked: 4, replied: 4 };
const BAD = new Set(["refused", "expired", "failed"]);
function flight(e) {
  const ds = [...e.d.values()];
  const live = ds.filter((d) => !BAD.has(d.state));
  const bad = ds.filter((d) => BAD.has(d.state));
  const held = ds.some((d) => d.state === "held");
  const answers = ANSWERED.has(e.m.kind);
  const min = live.length ? Math.min(...live.map((d) => RANK[d.state] ?? 0)) : -1;
  const latest = (pick) => { let best = 0; for (const d of live) { const t = ts(pick(d)); if (!t) return 0; best = Math.max(best, t); } return best; };
  const acked = live.length > 0 && live.every((d) => d.state === "acked");
  const steps = [
    { code: "QUEUED", t: ts(e.m.createdAt), r: 0 },
    { code: held ? "HELD" : "SENT", t: held ? 0 : ts(e.sentAt) || latest((d) => d.deliveredAt || d.seenAt), r: 1 },
    { code: "DLVR", t: latest((d) => d.deliveredAt || d.seenAt || d.repliedAt || d.ackedAt), r: 2 },
    { code: "SEEN", t: latest((d) => d.seenAt || d.repliedAt || d.ackedAt), r: 3 },
    { code: acked ? "ACK" : "RPLD", t: latest((d) => d.repliedAt || d.ackedAt), r: 4, na: !answers },
  ];
  const goal = answers ? 4 : 3;
  const cells = steps.map((s) => {
    let st = "todo";
    if (s.na) st = "na";
    else if (!live.length && bad.length) st = s.r === 0 ? "done" : s.r === 1 ? "bad" : "todo";
    else if (held && s.r === 1) st = "bad";
    else if (min >= s.r) st = "done";
    else if (min + 1 === s.r) st = "now";
    return { code: s.code, t: st === "done" ? s.t || (s.r === 0 ? ts(e.m.createdAt) : 0) : 0, st };
  });
  const landed = live.length > 0 && min >= goal && !held;
  const diverted = !live.length && bad.length > 0;
  return { cells, held, landed: landed || diverted, diverted, bad: bad.length, total: ds.length, min };
}

// ---------------------------------------------------------------- feedback
// The one live region for traffic: only what needs you (held mail, questions for you) is spoken.
function announce(text) { const el = $("#announce"); el.textContent = ""; setTimeout(() => { el.textContent = text; }, 40); }
function toast(text, bad) {
  const el = h("div", { class: "toast" + (bad ? " bad" : ""), role: bad ? "alert" : "status", text });
  $("#toasts").append(el);
  setTimeout(() => el.remove(), bad ? 6000 : 3200);
}
function dialog(build, cls) {
  const back = document.activeElement;
  const dlg = h("dialog", cls || null);
  dlg.addEventListener("close", () => { dlg.remove(); if (back && back.isConnected && back.focus) back.focus({ preventScroll: true }); });
  dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });
  dlg.append(build(dlg));
  document.body.append(dlg);
  dlg.showModal();
  return dlg;
}
// Cancel has the focus: Enter on a confirmation never approves, denies or pauses by accident.
function confirmDialog(title, text, ok, danger, detail) {
  return new Promise((resolve) => {
    let answer = false;
    const dlg = dialog((d) => h("div", "dlg", h("h2", { text: title }), h("div", { class: "dlg-b", id: "dlg-d" }, detail || null, h("p", { class: "muted", text })),
      h("div", "acts", h("button", { class: "btn", type: "button", "data-no": "", onclick: () => d.close() }, "Cancel"),
        h("button", { class: "btn " + (danger ? "danger" : "primary"), type: "button", onclick: () => { answer = true; d.close(); } }, ok))));
    dlg.setAttribute("aria-label", title);
    dlg.setAttribute("aria-describedby", "dlg-d");
    dlg.addEventListener("close", () => resolve(answer));
    $("[data-no]", dlg).focus();
  });
}
function empty(title, text, action) { return h("div", "empty", h("strong", { text: title }), h("span", null, text), action || null); }
function highlight(s) {
  const out = [];
  String(s).split("«").forEach((part, i) => {
    const j = part.indexOf("»");
    if (i === 0 || j < 0) out.push(i === 0 ? part : "«" + part);
    else out.push(h("mark", { text: part.slice(0, j) }), part.slice(j + 1));
  });
  return out;
}
function stateDot(state) { const s = scls(state) || "offline"; return h("i", { class: "st " + s, title: s, "aria-hidden": "true" }); }
function glyph(a) {
  const t = toolOf(a), g = h("span", { class: "hg", "aria-hidden": "true", title: (a && a.harness) || t, text: GLYPH[t] });
  g.style.setProperty("--h", "var(--h-" + t + ")");
  return g;
}
function kindCode(k) { return h("span", { class: "kcode " + kcls(k), title: klabel(k), text: kcode(k) }); }
function chip(d) {
  const st = scls(d.state);
  return h("span", { class: "chip s-" + st, "data-d": String(Number(d.id)), title: (d.note || STATE_LABEL[st] || st) + (d.method ? " · via " + d.method : "") },
    h("span", { "aria-hidden": "true", text: STATE_ICON[st] || "•" }), h("span", { text: nameOf(d.to) }), h("span", { text: STATE_LABEL[st] || st }));
}
`;
