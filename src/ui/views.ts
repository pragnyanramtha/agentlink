// Web UI script, part 4: the document views (conversations, conversation note, search, agents,
// agent note, approvals) and the actions behind them (compose, approve/deny, pause, mute).
export const VIEWS = String.raw`
function pageView(render, narrow) {
  const v = { visible: false, stale: true };
  const body = h("div", "page" + (narrow ? " narrow" : ""), h("div", { class: "skel", "aria-busy": "true", "aria-label": "Loading…" }, h("i"), h("i"), h("i")));
  v.el = h("div", "view", body);
  let seq = 0;
  v.refresh = async () => {
    if (!v.visible) { v.stale = true; return; }
    v.stale = false;
    const my = ++seq;
    const act = document.activeElement;
    const fk = act && body.contains(act) ? act.getAttribute("data-key") : null;
    try {
      const nodes = await render(v);
      if (my !== seq || S.expired) return;
      body.replaceChildren(...[].concat(nodes).filter(Boolean));
    } catch (e) {
      if (my === seq && !S.expired) body.replaceChildren(empty("Could not load this view", e.message));
    }
    if (fk) { const el = body.querySelector('[data-key="' + CSS.escape(fk) + '"]'); if (el) el.focus({ preventScroll: true }); }
  };
  v.soon = debounce(() => v.refresh(), 450);
  v.show = () => { v.visible = true; if (v.stale) v.refresh(); };
  v.hide = () => { v.visible = false; };
  return v;
}
const vhead = (title, sub, ...acts) => h("div", "vh", h("h1", { text: title }), sub ? h("span", "sub", sub) : null, acts.filter(Boolean).length ? h("div", "acts", acts) : null);
const sec = (title, n) => h("h2", "sec", title, n != null ? h("span", "muted", String(n)) : null);
function segBtns(label, opts, cur, onpick) {
  return h("div", { class: "seg", role: "group", "aria-label": label }, opts.map(([t, val]) => h("button", { type: "button", "aria-pressed": String(cur === val), onclick: () => onpick(val) }, t)));
}
const BT3 = "\x60\x60\x60";
function inline(s) {
  const parts = String(s).split("\x60");
  if (parts.length < 3 || parts.length % 2 === 0) return s;
  return parts.map((seg, i) => (i % 2 ? h("code", { text: seg }) : seg));
}
function richText(text) {
  const out = [];
  String(text || "").split(BT3).forEach((p, i, all) => {
    if (i % 2 && i < all.length - 1) {
      const nl = p.indexOf("\n");
      const code = nl >= 0 && /^[\w+#.-]*$/.test(p.slice(0, nl).trim()) ? p.slice(nl + 1) : p;
      out.push(h("pre", null, h("code", { text: code.replace(/\n$/, "") })));
    } else for (const para of (i % 2 ? BT3 + p : p).split(/\n{2,}/)) if (para.trim()) out.push(h("p", null, inline(para.replace(/^\n+|\n+$/g, ""))));
  });
  return out.length ? out : [h("p", "muted", "(no text)")];
}
function threadRow(t) {
  return h("a", { class: "row", href: "#/thread/" + encodeURIComponent(t.thread), "data-nav": "", "data-key": "t" + t.thread },
    h("div", "line", h("span", "subj trunc grow", t.subject || "(no text)"),
      t.unread ? h("span", "pill unread", t.unread + " unread") : null, statePill(threadState(t.thread, t)),
      timeEl(t.lastAt)),
    h("div", "small muted trunc", h("span", "who", nameOf(t.lastFrom)), " ", t.lastPreview),
    h("div", "line small", h("span", "chips grow", t.participants.slice(0, 6).map((p) => h("span", "chip", h("span", { text: nameOf(p) })))),
      h("span", "muted m", plural(t.messages, "message"))));
}

// ---------------------------------------------------------------- conversations
function ThreadsView() {
  let limit = 50;
  const v = pageView(async () => {
    const res = await api("threads?limit=" + limit + (PREFS.threadsOpen ? "&open=1" : ""));
    for (const t of res.threads) S.titles.set(t.thread, t.subject);
    return [vhead("Conversations", "By last activity. Open means someone still owes an answer.",
      segBtns("Show", [["All", false], ["Open", true]], !!PREFS.threadsOpen, (val) => { PREFS.threadsOpen = val; savePrefs(); v.refresh(); paintExplorer(); })),
    res.threads.length ? h("div", "list", res.threads.map(threadRow))
      : empty(PREFS.threadsOpen ? "No open conversations" : "No conversations yet", PREFS.threadsOpen ? "Nothing is waiting on an answer." : "A conversation starts when an agent, or you, sends a message.", h("button", { class: "btn sm", type: "button", onclick: () => compose() }, icon("compose"), "New message")),
    res.threads.length >= limit && limit < 100 ? h("div", "more", h("button", { class: "btn", type: "button", onclick: () => { limit = 100; v.refresh(); } }, "Load more")) : null];
  });
  v.onMessage = () => v.soon();
  return v;
}

// ---------------------------------------------------------------- conversation note
function ThreadView(id) {
  const v = { visible: false, stale: true, data: null, replyTo: null };
  const top = h("div", null, h("div", { class: "skel", "aria-busy": "true", "aria-label": "Loading…" }, h("i"), h("i")));
  const list = h("div", "callouts");
  const replying = h("div", "replying");
  const ta = h("textarea", { name: "reply", placeholder: "Write a reply… (Ctrl+Enter sends)", "aria-label": "Reply text", autocomplete: "off" });
  const kind = h("select", { "aria-label": "Kind", name: "kind" }, ["reply", "ask", "info"].map((k) => h("option", { value: k, text: klabel(k) })));
  const all = h("input", { type: "checkbox", name: "all" });
  const allBox = h("label", "check", all, "Reply to everyone");
  const send = h("button", { class: "btn primary", type: "button" }, icon("send"), "Send reply");
  const err = h("div", { class: "err", role: "alert" });
  const composer = h("form", { class: "composer", "aria-label": "Reply", onsubmit: (e) => { e.preventDefault(); go(); } }, replying, ta,
    h("div", "bar", kind, allBox, h("span", "hint grow", "Sent as you"), send), err);
  const article = h("article", "page narrow", top, list, composer);
  v.el = h("div", "view", article);
  async function go() {
    const text = ta.value.trim();
    err.textContent = "";
    if (!v.replyTo) { err.textContent = "Pick a message to reply to (Reply on any message)."; return; }
    if (!text) { err.textContent = "Write a reply first."; ta.focus(); return; }
    send.disabled = true;
    try {
      await api("messages", { kind: kind.value, replyTo: v.replyTo.id, text, replyAll: all.checked || undefined });
      ta.value = "";
      toast("Reply sent");
      v.refresh();
    } catch (e) { err.textContent = e.message; } finally { send.disabled = false; }
  }
  send.addEventListener("click", (e) => { e.preventDefault(); go(); });
  ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); go(); } });
  function setReply(m, focus) {
    v.replyTo = m;
    const held = m && v.undeliv && v.undeliv.has(m.id);
    replying.replaceChildren(...[icon("reply"), h("span", "trunc", m ? "Replying to " + nameOf(m.from) + ": " + m.preview : "Nothing delivered to reply to yet"),
      held ? h("span", "warn", "Not delivered yet: its recipients have not seen it.") : null].filter(Boolean));
    for (const el of list.children) el.classList.toggle("target", !!m && el.id === "m-" + m.id);
    if (focus) ta.focus();
  }
  function jump(mid) {
    const el = document.getElementById("m-" + mid);
    if (el) { el.scrollIntoView({ block: "center", behavior: MOTION.matches ? "auto" : "smooth" }); el.focus({ preventScroll: true }); }
  }
  function callout(x, prev, me, replies) {
    const m = x.message, to = uniq(x.deliveries.map((d) => d.to)), a = agentOf(m.from);
    const kids = replies.get(m.id) || [];
    return h("section", { class: "callout " + kcls(m.kind) + (m.from === me ? " mine" : ""), id: "m-" + m.id, tabindex: "-1", "data-nav": "", "data-key": "b" + m.id, "aria-label": klabel(m.kind) + " from " + nameOf(m.from) },
      h("header", "co-h", kindCode(m.kind), a ? glyph(a) : null, h("span", { class: "who", text: nameOf(m.from), title: a && a.identity ? a.identity : null }),
        to.length ? h("span", "to trunc", "▸ " + to.map(nameOf).join(", ")) : null, timeEl(m.createdAt),
        h("span", "acts", h("button", { class: "btn ghost sm", type: "button", onclick: () => setReply(m, true) }, icon("reply"), "Reply"))),
      m.re && (!prev || prev.message.id !== m.re.id) ? h("button", { class: "co-re", type: "button", onclick: () => jump(m.re.id) }, icon("link"), h("span", { text: "re " + nameOf(m.re.from) + ": " + m.re.preview })) : null,
      h("div", "co-body", richText(x.text)),
      h("footer", "co-f", h("div", "chips", x.deliveries.map(chip)),
        kids.map((k) => h("button", { class: "btn ghost sm", type: "button", onclick: () => jump(k.id), title: "Jump to this answer" }, icon("link"), kcode(k.kind) + " from " + nameOf(k.from))),
        h("span", "grow"), h("span", { class: "co-id", title: m.id, text: callsign(m.id) })));
  }
  function paint(res) {
    const msgs = res.messages, me = "@" + S.you.handle;
    const first = msgs[0], last = msgs[msgs.length - 1];
    if (first) { S.titles.set(res.thread, first.message.preview); S.tinfo.set(res.thread, { m: first.message, d: new Map(first.deliveries.map((d) => [d.id, d])) }); }
    const parts = uniq(msgs.flatMap((x) => [x.message.from, ...x.deliveries.map((d) => d.to)]));
    const kinds = uniq(msgs.map((x) => x.message.kind));
    const prop = (ic, k, val) => [h("dt", null, icon(ic), k), h("dd", null, val)];
    top.replaceChildren(
      h("h1", "note-title", first ? first.message.preview : "Conversation"),
      h("dl", "props",
        prop("team", "participants", h("span", "chips", parts.map((p) => { const a = agentOf(p); return a ? h("a", { class: "chip", href: "#/agent/" + encodeURIComponent(a.key) }, glyph(a), h("span", { text: nameOf(p) })) : h("span", "chip", h("span", { text: nameOf(p) })); }))),
        prop("clock", "started", first ? [stamp(first.message.createdAt), " ", h("span", "muted", "(" + ago(first.message.createdAt) + ")")] : "none"),
        prop("clock", "last activity", last ? [stamp(last.message.createdAt), " ", h("span", "muted", "(" + ago(last.message.createdAt) + ")")] : "none"),
        prop("inbox", "status", statePill(threadState(id))),
        prop("threads", "messages", String(msgs.length)),
        prop("hash", "kinds", h("span", "chips", kinds.map(kindCode))),
        prop("link", "conversation", h("span", { class: "m", title: res.thread, text: callsign(res.thread) }))));
    const replies = new Map();
    for (const x of msgs) if (x.message.replyTo) (replies.get(x.message.replyTo) || replies.set(x.message.replyTo, []).get(x.message.replyTo)).push(x.message);
    list.replaceChildren(...msgs.map((x, i) => callout(x, msgs[i - 1], me, replies)));
    const ids = new Set(msgs.map((x) => x.message.id));
    // Never default to a message its recipients have not seen (held, refused, failed).
    const undeliv = (x) => x.deliveries.length > 0 && x.deliveries.every((d) => d.state === "held" || BAD.has(d.state));
    v.undeliv = new Set(msgs.filter(undeliv).map((x) => x.message.id));
    if (!v.replyTo || !ids.has(v.replyTo.id)) {
      const ok = msgs.filter((x) => !undeliv(x)), others = ok.filter((x) => x.message.from !== me);
      const pool = others.length ? others : ok;
      v.replyTo = pool.length ? pool[pool.length - 1].message : null;
    }
    allBox.hidden = parts.filter((p) => p !== me).length < 2;
    setReply(v.replyTo, false);
  }
  let seq = 0, painted = false;
  v.refresh = async () => {
    if (!v.visible) { v.stale = true; return; }
    v.stale = false;
    const my = ++seq;
    try {
      const res = await api("threads/" + encodeURIComponent(id));
      if (my !== seq) return;
      const atEnd = v.el.scrollTop + v.el.clientHeight >= v.el.scrollHeight - 120;
      v.data = res; v.error = null; composer.hidden = false;
      paint(res);
      if (!painted || atEnd) v.el.scrollTop = v.el.scrollHeight;
      painted = true;
      paintInspector();
      renderTabs();
    } catch (e) {
      if (my !== seq) return;
      // A conversation that no longer exists is not saved as a tab for next time.
      v.error = e.message; v.data = null;
      if (e.status === 400 || e.status === 404) { BADTABS.add("thread/" + id); savePrefs(); }
      top.replaceChildren(empty("Could not open this conversation", e.message)); list.replaceChildren(); composer.hidden = true;
      paintInspector(); renderTabs();
    }
  };
  v.soon = debounce(() => v.refresh(), 350);
  v.show = () => { v.visible = true; if (v.stale) v.refresh(); };
  v.hide = () => { v.visible = false; };
  v.onMessage = (e) => { if (v.data && e.m.thread === v.data.thread) v.soon(); };
  v.onDelivery = (e) => { if (v.data && e.m.thread === v.data.thread) v.soon(); };
  v.jump = jump;
  return v;
}

// ---------------------------------------------------------------- search
function SearchView() {
  const v = { visible: false };
  const s = S.search || (S.search = { q: "", from: "", to: "", kind: "", since: "" });
  let limit = 30, seq = 0;
  const q = h("input", { type: "search", name: "q", placeholder: "Words or prefixes…", value: s.q, autocomplete: "off", spellcheck: "false" });
  const from = h("input", { type: "text", name: "from", placeholder: "Any sender…", list: "agent-names", value: s.from, autocomplete: "off", spellcheck: "false" });
  const to = h("input", { type: "text", name: "to", placeholder: "Any recipient…", list: "agent-names", value: s.to, autocomplete: "off", spellcheck: "false" });
  const kind = h("select", { name: "kind" }, h("option", { value: "", text: "Any kind" }), KINDS.map((k) => h("option", { value: k, text: klabel(k), selected: s.kind === k })));
  const since = h("select", { name: "since" }, [["", "Any time"], ["1h", "Last hour"], ["24h", "Last 24 hours"], ["7d", "Last 7 days"], ["30d", "Last 30 days"]].map(([val, t]) => h("option", { value: val, text: t, selected: s.since === val })));
  const field = (label, el) => h("label", "field", h("span", { text: label }), el);
  const names = h("datalist", { id: "agent-names" });
  const results = h("div", { "aria-live": "polite" });
  const run = debounce(() => { Object.assign(s, { q: q.value, from: from.value.trim(), to: to.value.trim(), kind: kind.value, since: since.value }); limit = 30; doSearch(); }, 250);
  [q, from, to].forEach((el) => el.addEventListener("input", run));
  [kind, since].forEach((el) => el.addEventListener("change", run));
  v.el = h("div", "view", h("div", "page", vhead("Search", "Every message this machine has seen. Narrow by sender, recipient, kind or time."),
    h("div", { class: "filters", role: "search" }, field("Search", q), field("From", from), field("To", to), field("Kind", kind), field("Since", since)), names, results));
  async function doSearch() {
    const p = new URLSearchParams();
    if (s.q.trim()) p.set("q", s.q.trim());
    for (const k of ["from", "to", "kind", "since"]) if (s[k]) p.set(k, s[k]);
    p.set("limit", String(limit));
    const my = ++seq;
    try {
      const res = await api("search?" + p);
      if (my !== seq) return;
      const rows = res.results.map((r) => h("a", { class: "row", href: "#/thread/" + encodeURIComponent(r.thread), "data-nav": "", "data-key": "s" + r.id },
        h("div", "line", kindCode(r.kind), h("span", "who", nameOf(r.from)), h("span", { class: "muted", "aria-hidden": "true", text: "▸" }),
          h("span", "trunc grow small", r.to.map(nameOf).join(", ") || "nobody"), timeEl(r.createdAt)),
        h("div", "small", highlight(r.snippet)),
        h("div", "line small muted m", h("span", { text: "~" + NF.format(r.tokens) + " tokens" }), h("span", { text: callsign(r.id) }))));
      const more = rows.length >= limit && limit < 100;
      results.replaceChildren(
        h("p", "small muted", (s.q.trim() ? rows.length + (more ? "+" : "") + " results" : "Most recent messages") + (res.fts ? "" : ". Simple matching (no full-text index).")),
        rows.length ? h("div", "list", rows) : empty("No matches", s.q ? "Try fewer or shorter words, or widen the filters." : "No messages match these filters."),
        more ? h("div", "more", h("button", { class: "btn", type: "button", onclick: () => { limit = 100; doSearch(); } }, "Load more")) : "");
    } catch (e) { if (my === seq) results.replaceChildren(empty("Search failed", e.message)); }
  }
  v.show = () => {
    v.visible = true;
    names.replaceChildren(...candidates().map((c) => h("option", { value: c.value })));
    if (S.searchQ != null) { q.value = S.searchQ; s.q = S.searchQ; S.searchQ = null; }
    doSearch();
    if (S.focusSearch) { S.focusSearch = false; q.focus(); q.select(); }
  };
  v.hide = () => { v.visible = false; };
  v.focus = () => { q.focus(); q.select(); };
  return v;
}

// ---------------------------------------------------------------- agents
function AgentsView() {
  const v = pageView(async () => {
    const [res, cl] = await Promise.all([api("agents" + (PREFS.showOffline ? "?all=1" : "")), api("claims").catch(() => ({ claims: [] }))]);
    const list = res.agents.map((a) => Object.assign(a, { key: a.address || a.name, short: a.local ? a.name : a.address || a.name }));
    const groups = new Map([["local", []]]);
    for (const a of list) { const g = a.local ? "local" : "@" + a.member; (groups.get(g) || groups.set(g, []).get(g)).push(a); }
    const toggle = h("label", "check", h("input", { type: "checkbox", name: "offline", checked: !!PREFS.showOffline, onchange: (e) => { PREFS.showOffline = e.target.checked; savePrefs(); v.refresh(); fan("onAgents"); } }), "Show offline");
    const out = [vhead("Agents", plural(list.length, "agent") + (PREFS.showOffline ? " known" : " online") + (res.team ? ", team " + res.team : ""), toggle)];
    for (const [g, as] of groups) {
      if (g !== "local" && !as.length) continue;
      out.push(sec(g === "local" ? "This machine, " + res.you.host : g, as.length));
      out.push(as.length ? agentTable(as) : empty(PREFS.showOffline ? "No agents on this machine" : "No agents online here", "Start a Claude Code, Codex or OpenCode session after running agentlink install all."));
    }
    if (res.team && groups.size === 1) out.push(sec("Teammates"), empty("No teammates' agents online", "They appear while a teammate's agent session runs."));
    if (cl.claims.length) {
      out.push(sec("File claims", cl.claims.length), h("div", "list", cl.claims.map((c) => h("div", "row",
        h("div", "line", h("span", "m grow trunc", c.pattern), h("span", "who", nameOf(c.agent)), h("span", "ago", "until " + T_HM.format(ts(c.expiresAt)))),
        c.reason ? h("div", "small muted", c.reason) : null))));
    }
    return out;
  });
  v.onAgents = () => v.soon();
  return v;
}
function agentTable(list) {
  return h("table", "tbl", h("thead", null, h("tr", null, ["Agent", "Model", "Project", "Session", "State", ""].map((t) => h("th", { scope: "col", class: t === "Session" ? "c-ses" : null, text: t })))),
    h("tbody", null, list.map((a) => h("tr", null,
      h("td", null, h("span", "nm", glyph(a), h("a", { href: "#/agent/" + encodeURIComponent(a.key), "data-nav": "", "data-key": "a" + a.key, title: a.identity || a.short, text: a.short }), a.muted ? h("span", "pill muted", "muted") : null)),
      h("td", { class: "m", text: a.modelShort || a.harness || "unknown", title: a.model || null }),
      h("td", { class: "m", text: (a.dir || a.project || "none") + (a.branch ? " @ " + a.branch : ""), title: a.dir || a.project || null }),
      h("td", { class: "m c-ses", text: a.title || "untitled", title: a.title || null }),
      h("td", "m", h("span", "line", stateDot(a.state), a.state + (a.stateAt ? ", " + ago(a.stateAt) : ""))),
      h("td", "acts-c", h("div", "acts", h("button", { class: "btn sm", type: "button", onclick: () => compose([a.local ? a.name : a.address]) }, "Message"),
        a.local ? h("button", { class: "btn sm ghost", type: "button", onclick: () => control(a.muted ? "unmute" : "mute", a.name) }, a.muted ? "Unmute" : "Mute") : null))))));
}

// ---------------------------------------------------------------- agent note
function AgentView(key) {
  const v = pageView(async () => {
    let a = agentOf(key);
    if (!a) { await loadAgents(); a = agentOf(key); }
    if (!a) return [empty("Agent not found", "It may have been removed, or its session ended long ago. Open Agents to see who is around.")];
    const conv = await api("threads?limit=20&with=" + encodeURIComponent(a.local ? a.name : a.address)).catch(() => ({ threads: [] }));
    for (const t of conv.threads) S.titles.set(t.thread, t.subject);
    v.conv = conv.threads;
    const prop = (ic, k, val) => (val ? [h("dt", null, icon(ic), k), h("dd", null, val)] : null);
    const traffic = S.order.filter((e) => involves(e, a.key)).slice(0, 20);
    return [
      h("h1", "note-title line", glyph(a), h("span", "trunc", a.short)),
      h("div", "vh", h("span", "line", stateDot(a.state), h("span", "m", a.state + (a.stateAt ? " since " + stamp(a.stateAt) : ""))), a.muted ? h("span", "pill muted", "muted") : null,
        h("div", "acts", h("button", { class: "btn primary sm", type: "button", onclick: () => compose([a.local ? a.name : a.address]) }, icon("compose"), "Message"),
          a.local ? h("button", { class: "btn sm", type: "button", onclick: () => control(a.muted ? "unmute" : "mute", a.name) }, a.muted ? "Unmute" : "Mute") : null)),
      h("dl", "props",
        prop("agents", "harness", a.harness || a.tool), prop("hash", "model", a.model ? a.modelShort + (a.model !== a.modelShort ? " (" + a.model + ")" : "") : null),
        prop("machine", a.local ? "folder" : "project", (a.dir || a.project) ? (a.dir || a.project) + (a.branch ? " @ " + a.branch : "") : null),
        prop("threads", "session", a.title ? "“" + a.title + "”" : null), prop("machine", "host", a.host), prop("hash", "tag", a.tag ? "#" + a.tag : null),
        prop("link", "address", h("span", "m", a.address || a.name)), prop("send", "wakes via", a.local ? a.wakeVia || "next turn" : a.reach ? String(a.reach) : null),
        prop("clock", "last seen", a.lastSeenAt ? stamp(a.lastSeenAt) + " (" + ago(a.lastSeenAt) + ")" : null), prop("inbox", "status", a.status)),
      sec("Recent traffic", traffic.length),
      traffic.length ? h("div", "list", traffic.map((e) => h("a", { class: "row", href: "#/thread/" + encodeURIComponent(e.m.thread), "data-nav": "", "data-key": "r" + e.m.id },
        h("div", "line", kindCode(e.m.kind), h("span", "who trunc", nameOf(e.m.from) + " ▸ " + recipients(e).map(nameOf).join(", ")), h("span", "grow"), timeEl(e.m.createdAt)),
        h("div", "small muted trunc", e.m.preview)))) : empty("No recent traffic", "Messages to or from this agent show up here as they happen."),
      sec("Conversations", conv.threads.length),
      conv.threads.length ? h("div", "list", conv.threads.map(threadRow)) : empty("No conversations yet", "Start one with Message."),
    ];
  }, true);
  v.key = key;
  v.onMessage = (e) => { if (involves(e, key)) v.soon(); };
  v.onAgents = () => v.soon();
  return v;
}

// ---------------------------------------------------------------- approvals
function heldCard(i, after) {
  return h("div", { class: "card held", tabindex: "-1", "data-nav": "", "data-key": "h" + i.delivery.id },
    h("div", "line", kindCode(i.message.kind), h("span", "who", nameOf(i.message.from)), h("span", { class: "muted", "aria-hidden": "true", text: "▸" }),
      h("span", "who grow trunc", nameOf(i.delivery.to)), timeEl(i.message.createdAt)),
    h("div", "line small muted m", h("span", { text: "trust: " + i.message.trust }), h("span", { text: "#" + i.delivery.id }), h("span", { text: callsign(i.message.id) })),
    h("div", "fulltext", i.text),
    i.attachments && i.attachments.length ? h("p", "small muted", plural(i.attachments.length, "attachment") + ": see agentlink read " + i.message.id) : null,
    h("div", "acts", h("button", { class: "btn primary", type: "button", onclick: () => decide(i, "approve").then((ok) => ok && after && after()) }, "Approve…"),
      h("button", { class: "btn danger", type: "button", onclick: () => decide(i, "deny").then((ok) => ok && after && after()) }, "Deny…")));
}
function ApprovalsView() {
  const v = pageView(async () => {
    const res = await api("approvals");
    S.held = res.items;
    return [vhead("Approvals", "Your policy holds these messages until you approve or deny them."),
      res.items.length ? h("div", null, res.items.map((i) => heldCard(i, null))) : empty("Nothing is waiting for approval", "Messages your policy holds (agentlink policy) appear here, and circle their recipient on the Airspace scope.")];
  }, true);
  v.onHeld = () => v.soon();
  return v;
}
async function reviewHeld(mid) {
  try {
    const res = await api("approvals");
    const items = res.items.filter((i) => i.message.id === mid);
    if (!items.length) { toast("Nothing is held for this message any more."); return; }
    const dlg = dialog((d) => h("div", "dlg", h("h2", { text: "Held " + klabel(items[0].message.kind) + " " + csign(items[0].message) }),
      items.map((i) => heldCard(i, () => d.close())),
      h("div", "acts", h("button", { class: "btn", type: "button", onclick: () => d.close() }, "Close"))));
    dlg.setAttribute("aria-label", "Review held message");
  } catch (e) { toast(e.message, true); }
}
async function decide(i, decision) {
  const yes = decision === "approve";
  // The confirmation repeats what you are deciding on: route, kind and the full text.
  const detail = h("div", "dlg-msg", h("div", "line small", kindCode(i.message.kind), h("span", "who", nameOf(i.message.from)), h("span", { class: "muted", "aria-hidden": "true", text: "▸" }), h("span", "who trunc", nameOf(i.delivery.to))),
    h("div", "fulltext", i.text || i.message.preview));
  const ok = await confirmDialog((yes ? "Approve" : "Deny") + " this " + klabel(i.message.kind) + "?",
    "From " + nameOf(i.message.from) + " to " + nameOf(i.delivery.to) + ". " + (yes ? "It is delivered right away." : "It will not be delivered."), yes ? "Approve" : "Deny", !yes, detail);
  if (!ok) return false;
  try {
    await api("approvals/" + Number(i.delivery.id), { decision });
    toast(yes ? "Approved; delivering" : "Denied");
    soonHeld(); soonCounts();
    return true;
  } catch (e) { toast(e.message, true); return false; }
}
async function control(action, agent) {
  if (action === "pause" && !(await confirmDialog("Pause all delivery?", "Messages are kept but not delivered, and agents see nothing new until you resume.", "Pause delivery", true))) return;
  try {
    await api("control", agent ? { action, agent } : { action });
    toast(agent ? agent + " " + action + "d" : "Delivery " + action + "d");
    soonCounts();
    if (agent) soonAgents();
  } catch (e) { toast(e.message, true); }
}
function candidates() {
  const out = [], seen = new Set();
  const push = (value, hint, state) => { if (!seen.has(value)) { seen.add(value); out.push({ value, hint, state }); } };
  for (const a of S.agents) {
    push(a.local ? a.name : a.address, identityOf(a) + (a.local ? "" : ", @" + a.member), a.state);
    if (!a.local && a.member) push("@" + a.member, "teammate (person)", "idle");
  }
  return out;
}
function compose(prefill) {
  const chosen = (prefill || []).filter(Boolean);
  let options = [], active = -1;
  const chips = h("span", "chips");
  const input = h("input", { type: "text", name: "to", role: "combobox", "aria-autocomplete": "list", "aria-expanded": "false", "aria-controls": "compose-suggest", "aria-label": "Recipients", placeholder: "agent, teammate/agent or @person…", autocomplete: "off", spellcheck: "false" });
  const list = h("ul", { class: "suggest", id: "compose-suggest", role: "listbox", hidden: true, "aria-label": "Suggestions" });
  const text = h("textarea", { name: "message", "aria-label": "Message", placeholder: "What should they know or do? (Ctrl+Enter sends)", autocomplete: "off" });
  const kind = h("select", { name: "kind", "aria-label": "Kind" }, ["info", "ask", "request", "handoff", "review_request"].map((k) => h("option", { value: k, text: kcode(k) + "  " + klabel(k) })));
  const err = h("div", { class: "err", role: "alert" });
  const paint = () => chips.replaceChildren(...chosen.map((to, i) => h("span", "to-chip", to,
    h("button", { type: "button", "aria-label": "Remove " + to, onclick: () => { chosen.splice(i, 1); paint(); input.focus(); } }, icon("close")))));
  const suggest = () => {
    const q = input.value.trim().toLowerCase();
    options = q ? candidates().filter((c) => c.value.toLowerCase().includes(q) && !chosen.includes(c.value)).slice(0, 7) : [];
    active = options.length ? 0 : -1;
    list.replaceChildren(...options.map((o, i) => h("li", { role: "option", id: "opt-" + i, "aria-selected": String(i === active), onmousedown: (e) => { e.preventDefault(); pick(o.value); } },
      stateDot(o.state), h("span", "m", o.value), h("span", "muted small trunc", o.hint))));
    list.hidden = !options.length;
    input.setAttribute("aria-expanded", String(!!options.length));
    if (active >= 0) input.setAttribute("aria-activedescendant", "opt-0"); else input.removeAttribute("aria-activedescendant");
  };
  const pick = (val) => { val = val.trim(); if (val && !chosen.includes(val)) chosen.push(val); input.value = ""; paint(); suggest(); };
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
  input.addEventListener("blur", () => setTimeout(() => { list.hidden = true; input.setAttribute("aria-expanded", "false"); }, 120));
  const dlg = dialog((d) => {
    const send = h("button", { class: "btn primary", type: "button" }, icon("send"), "Send message");
    const go = async () => {
      if (input.value.trim()) pick(input.value);
      err.textContent = "";
      if (!chosen.length) { err.textContent = "Add at least one recipient."; return input.focus(); }
      if (!text.value.trim()) { err.textContent = "Write a message first."; return text.focus(); }
      send.disabled = true;
      try {
        const res = await api("messages", { to: chosen, kind: kind.value, text: text.value.trim() });
        d.close();
        toast("Message sent: " + res.deliveries.map((x) => nameOf(x.to) + " " + (STATE_LABEL[x.state] || x.state)).join(", "));
      } catch (e) { err.textContent = e.message; } finally { send.disabled = false; }
    };
    send.addEventListener("click", go);
    text.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); go(); } });
    return h("div", "dlg", h("h2", { text: "New message" }),
      h("div", "field", h("span", { text: "To" }), h("div", "to-box", chips, input, list)),
      h("label", "field", h("span", { text: "Kind" }), kind), h("label", "field", h("span", { text: "Message" }), text), err,
      h("div", "acts", h("span", "small muted grow", "Sent as you (@" + S.you.handle + ")"), h("button", { class: "btn", type: "button", onclick: () => d.close() }, "Cancel"), send));
  });
  dlg.setAttribute("aria-label", "New message");
  paint();
  (chosen.length ? text : input).focus();
}
`;
