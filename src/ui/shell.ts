// Web UI script, part 5: the shell. Ribbon, explorer, tabbed (optionally split) workspace,
// inspector, status bar, command palette, keyboard, theme, the live event stream and boot.
export const SHELL = String.raw`
const app = $("#app");
const SINGLE = ["airspace", "graph", "threads", "agents", "approvals", "search"];
const META = { airspace: ["Airspace", "radar"], graph: ["Graph", "graph"], threads: ["Conversations", "threads"], agents: ["Agents", "agents"], approvals: ["Approvals", "approvals"], search: ["Search", "search"] };
const views = new Map();
S.paneTab = [null, null];
S.focusPane = 0;
S.exGrp = new Set();
const panesEl = $("#panes");
const paneEls = [0, 1].map((i) => h("section", { class: "pane", id: "pane-" + i, role: "tabpanel", "aria-label": i ? "Right pane" : "Main pane" }));
paneEls.forEach((p, i) => p.addEventListener("pointerdown", () => { if (S.focusPane !== i && PREFS.split) focusPane(i); }, true));
panesEl.append(paneEls[0]);

function fan(method, ...args) {
  for (const v of views.values()) if (typeof v[method] === "function") { try { v[method](...args); } catch (err) { console.error(err); } }
}
const typeOf = (id) => String(id).split("/")[0];
const argOf = (id) => String(id).slice(typeOf(id).length + 1);
const validId = (id) => typeof id === "string" && (SINGLE.includes(id) || /^(thread|agent)\/.{1,200}$/.test(id));
// A conversation's tab reads "{kind} {peer}" (ASK codex-web); its subject is the tooltip.
function threadTab(arg) {
  const e = S.tinfo.get(arg);
  if (e) { const to = recipients(e)[0]; return { k: e.m.kind, peer: nameOf(isYou(e.m.from) && to ? to : e.m.from) }; }
  const t = S.threads.find((x) => x.thread === arg), p = t && (t.participants.find((x) => !isYou(x)) || t.participants[0]);
  return { k: "", peer: p ? nameOf(p) : "" };
}
function tabTitle(id) {
  const t = typeOf(id);
  if (META[t]) return META[t][0];
  if (t === "thread") { const x = threadTab(argOf(id)); return x.peer ? (x.k ? kcode(x.k) + " " : "") + x.peer : titleOf(argOf(id)); }
  const a = agentOf(argOf(id));
  return a ? a.short : argOf(id);
}
function tabLabel(id) {
  const x = typeOf(id) === "thread" && threadTab(argOf(id));
  return h("span", "trunc", x && x.k && x.peer ? h("b", "kc " + kcls(x.k), kcode(x.k) + " ") : null, x && x.k && x.peer ? x.peer : tabTitle(id));
}
function tabIcon(id) {
  const t = typeOf(id);
  if (META[t]) return icon(META[t][1]);
  if (t === "thread") return icon("threads");
  return glyph(agentOf(argOf(id)));
}
function makeView(id) {
  const t = typeOf(id), arg = argOf(id);
  if (t === "airspace") return Airspace();
  if (t === "graph") return Graph();
  if (t === "threads") return ThreadsView();
  if (t === "agents") return AgentsView();
  if (t === "approvals") return ApprovalsView();
  if (t === "search") return SearchView();
  if (t === "thread") return ThreadView(arg);
  return AgentView(arg);
}
function unmount(p) {
  const old = S.paneTab[p];
  if (!old) return;
  const v = views.get(old);
  if (v) { v.scroll = v.el.scrollTop; if (v.hide) v.hide(); v.el.remove(); }
  S.paneTab[p] = null;
}
function mount(p, id) {
  if (S.paneTab[p] === id) return;
  if (p === 0 && S.paneTab[0]) S.prevTab = S.paneTab[0];
  unmount(p);
  let v = views.get(id);
  if (!v) { v = makeView(id); views.set(id, v); }
  paneEls[p].append(v.el);
  S.paneTab[p] = id;
  v.el.scrollTop = v.scroll || 0;
  if (v.show) v.show();
}
function focusPane(p) {
  S.focusPane = p;
  paneEls.forEach((el, i) => el.classList.toggle("focus", i === p && PREFS.split));
  syncChrome();
}
function hashFor(id) { const t = typeOf(id); return "#/" + (SINGLE.includes(t) ? t : t + "/" + encodeURIComponent(argOf(id))); }
function syncChrome() {
  const id = S.paneTab[S.focusPane];
  PREFS.panes = [S.paneTab[0], PREFS.split ? S.paneTab[1] : null];
  savePrefs();
  if (id && location.hash !== hashFor(id)) history.pushState(null, "", hashFor(id));
  const t = id ? typeOf(id) : "";
  const cur = t === "thread" ? "threads" : t === "agent" ? "agents" : t;
  $$(".ribbon [data-view]").forEach((a) => { if (a.getAttribute("data-view") === cur) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current"); });
  document.title = (id ? tabTitle(id) + " · " : "") + "agentlink";
  renderTabs();
  paintInspector();
  applyExplorer();
  paintExplorer();
}
function openTab(id, opts) {
  if (!validId(id)) id = "airspace";
  const p = opts && opts.pane != null ? opts.pane : S.focusPane;
  if (PREFS.split && S.paneTab[1 - p] === id) { focusPane(1 - p); return; }
  if (!PREFS.tabs.includes(id)) {
    const at = PREFS.tabs.indexOf(S.paneTab[p]);
    PREFS.tabs.splice(at < 0 ? PREFS.tabs.length : at + 1, 0, id);
  }
  mount(p, id);
  focusPane(p);
  if (window.matchMedia("(max-width: 600px)").matches) closeDrawers();
}
function closeTab(id) {
  const i = PREFS.tabs.indexOf(id);
  if (i < 0) return;
  PREFS.tabs.splice(i, 1);
  for (const p of [0, 1]) {
    if (S.paneTab[p] !== id) continue;
    unmount(p);
    const pool = PREFS.tabs.filter((t) => t !== S.paneTab[1 - p]);
    if (p === 1 && !pool.length) { toggleSplit(false); continue; }
    if (!pool.length) { PREFS.tabs.push("airspace"); pool.push("airspace"); }
    mount(p, pool[Math.min(i, pool.length - 1)]);
  }
  const v = views.get(id);
  if (v) { if (v.destroy) v.destroy(); v.el.remove(); views.delete(id); }
  syncChrome();
}
function cycleTab(d) {
  const tabs = PREFS.tabs.filter((t) => !PREFS.split || t !== S.paneTab[1 - S.focusPane]);
  if (tabs.length < 2) return;
  const i = tabs.indexOf(S.paneTab[S.focusPane]);
  openTab(tabs[(i + d + tabs.length) % tabs.length]);
}
function toggleSplit(force) {
  const on = typeof force === "boolean" ? force : !PREFS.split;
  if (on === PREFS.split) return;
  PREFS.split = on;
  if (on) {
    const left = S.paneTab[0];
    let right = S.prevTab && S.prevTab !== left && PREFS.tabs.includes(S.prevTab) ? S.prevTab : PREFS.tabs.find((t) => t !== left);
    if (!right) { right = left === "threads" ? "airspace" : "threads"; PREFS.tabs.push(right); }
    panesEl.append(paneEls[1]);
    mount(1, right);
  } else {
    unmount(1);
    paneEls[1].remove();
    S.focusPane = 0;
  }
  panesEl.classList.toggle("split", on);
  $("#tb-split").setAttribute("aria-pressed", String(on));
  focusPane(S.focusPane);
}
function openRight(id) {
  if (!PREFS.split) toggleSplit(true);
  if (S.paneTab[0] === id) { const other = S.paneTab[1]; unmount(1); unmount(0); mount(0, other || "airspace"); }
  if (!PREFS.tabs.includes(id)) PREFS.tabs.push(id);
  mount(1, id);
  focusPane(1);
}
function renderTabs() {
  const box = $("#tabs");
  const hadFocus = box.contains(document.activeElement);
  const sel = S.paneTab[S.focusPane];
  box.replaceChildren(...PREFS.tabs.map((id, i) => {
    const on = id === sel, other = PREFS.split && S.paneTab[1 - S.focusPane] === id, title = tabTitle(id), tip = typeOf(id) === "thread" ? title + ": " + titleOf(argOf(id)) : title;
    const shown = on || other ? (S.paneTab[0] === id ? 0 : 1) : S.focusPane;
    const b = h("button", { class: "tab-b", role: "tab", type: "button", id: "tab-" + i, "aria-selected": String(on), "aria-controls": "pane-" + shown, tabindex: on ? "0" : "-1", title: tip + (other ? " (other pane)" : ""),
      onclick: (e) => (e.shiftKey ? openRight(id) : openTab(id)),
      onmousedown: (e) => { if (e.button === 1) e.preventDefault(); },
      onauxclick: (e) => { if (e.button === 1) { e.preventDefault(); closeTab(id); } },
      onkeydown: (e) => {
        const tabs = $$(".tab-b", box), j = tabs.indexOf(e.currentTarget);
        let next = -1;
        if (e.key === "ArrowRight") next = (j + 1) % tabs.length;
        else if (e.key === "ArrowLeft") next = (j - 1 + tabs.length) % tabs.length;
        else if (e.key === "Home") next = 0;
        else if (e.key === "End") next = tabs.length - 1;
        else if (e.key === "Delete") { e.preventDefault(); closeTab(id); return; }
        if (next >= 0) { e.preventDefault(); openTab(PREFS.tabs[next]); const nb = $$(".tab-b", box)[next]; if (nb) nb.focus(); }
      } }, tabIcon(id), tabLabel(id));
    const x = h("button", { class: "x", type: "button", tabindex: "-1", "aria-label": "Close " + title, title: "Close (Alt+W)", onclick: () => closeTab(id) }, icon("close"));
    return h("div", { class: "tab" + (on ? " sel" : "") + (other ? " other" : ""), role: "presentation" }, b, x);
  }));
  if (hadFocus) { const s = $(".tab.sel .tab-b", box); if (s) s.focus({ preventScroll: true }); }
  const s = $(".tab.sel", box);
  if (s && s.scrollIntoView) s.scrollIntoView({ block: "nearest", inline: "nearest" });
  tabFade();
}
// Tabs that do not fit fade at the edge they continue past, and the ⋯ menu lists them all.
function tabFade() {
  const b = $("#tabs"), over = b.scrollWidth > b.clientWidth + 2;
  b.classList.toggle("fl", over && b.scrollLeft > 2);
  b.classList.toggle("fr", over && b.scrollLeft + b.clientWidth < b.scrollWidth - 2);
  $("#tb-more").hidden = !over;
}
function tabMenu() {
  const dlg = dialog((d) => h("div", "dlg", h("h2", { text: "Open tabs" }),
    h("ul", "links tabmenu", PREFS.tabs.map((id) => h("li", null,
      h("button", { type: "button", "aria-current": id === S.paneTab[S.focusPane] ? "true" : null, onclick: () => { d.close(); openTab(id); } }, tabIcon(id), tabLabel(id), typeOf(id) === "thread" && threadTab(argOf(id)).k ? h("span", "c trunc", titleOf(argOf(id))) : null),
      h("button", { type: "button", class: "x", "aria-label": "Close " + tabTitle(id), onclick: (e) => { e.currentTarget.parentNode.remove(); closeTab(id); const n = $(".tabmenu button", d); if (n) n.focus(); else d.close(); } }, icon("close"))))),
    h("div", "acts", h("button", { class: "btn", type: "button", onclick: () => d.close() }, "Close"))));
  dlg.setAttribute("aria-label", "Open tabs");
  ($("[aria-current]", dlg) || $("button", dlg)).focus();
}

// ---------------------------------------------------------------- explorer
const filterIn = h("input", { type: "search", name: "filter", placeholder: "Filter agents and conversations…", "aria-label": "Filter the explorer", value: PREFS.filter || "", autocomplete: "off", spellcheck: "false" });
filterIn.addEventListener("input", debounce(() => { PREFS.filter = filterIn.value; savePrefs(); paintExplorer(); }, 120));
const exMachines = h("div"), exConvs = h("div"), exConvSeg = h("span");
function buildExplorer() {
  $("#explorer").replaceChildren(
    h("div", "side-h", h("h2", { text: "Explorer" }), h("span", "grow"), h("button", { class: "tb", type: "button", "aria-label": "Hide explorer (E)", title: "Hide explorer (E)", onclick: () => toggleExplorer() }, icon("left"))),
    h("div", { class: "side-b", onmouseleave: () => hilite(null) }, h("label", "filter", filterIn),
      h("div", "grp", "Machines"), exMachines,
      h("div", "grp", "Conversations", exConvSeg), exConvs));
}
// Plain clicks open a tab here; Ctrl/Cmd/middle-click keep the browser's own behaviour.
const tabLink = (id) => (e) => { if (e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) { e.preventDefault(); openTab(id); } };
function paintExplorer() {
  const act = document.activeElement, fk = act && $("#explorer").contains(act) ? act.getAttribute("data-key") : null;
  const q = (PREFS.filter || "").trim().toLowerCase();
  const cur = S.paneTab[S.focusPane] || "";
  const match = (...xs) => !q || xs.some((x) => String(x || "").toLowerCase().includes(q));
  const groups = [{ id: "local", name: "this machine", host: S.you.host, list: S.agents.filter((a) => a.local) }];
  const members = ((S.team && S.team.members) || []).filter((m) => !m.self);
  for (const hd of uniq([...members.map((m) => m.handle), ...S.agents.filter((a) => !a.local).map((a) => a.member)]).filter(Boolean)) {
    const m = members.find((x) => x.handle === hd && x.host);
    groups.push({ id: "@" + hd, name: "@" + hd, host: m ? m.host : "", list: S.agents.filter((a) => !a.local && a.member === hd) });
  }
  exMachines.replaceChildren(...groups.map((g) => {
    const shown = g.list.filter((a) => (liveAgent(a) || PREFS.showOffline) && match(a.short, a.harness, a.modelShort, a.project, a.title, a.host)).sort(byName);
    const det = h("details", { open: !PREFS.closedMachines.includes(g.id) },
      h("summary", { "data-key": "m" + g.id }, icon("chev", "chev"), icon(g.id === "local" ? "machine" : "team"), h("span", "trunc", g.name), h("span", "sub trunc grow", g.host || ""), h("span", "sub", String(shown.length))),
      h("ul", "tree", shown.length ? shown.map((a) => h("li", null, h("a", Object.assign({ class: "ti" + (cur === "agent/" + a.key ? " on" : ""), href: hashFor("agent/" + a.key), "data-key": "x" + a.key, title: a.identity || a.short, onclick: tabLink("agent/" + a.key) }, hoverOn(() => hlAgent(a.key))),
        stateDot(a.state), h("span", "sr-only", a.state + ": "), h("span", "trunc", a.local ? a.name : a.name.split("/").pop()), h("span", "sub trunc grow", a.modelShort || a.harness || ""), a.muted ? h("span", "sub", "muted") : null)))
        : h("li", "side-empty", q ? "No matches" : "No agents online")));
    det.addEventListener("toggle", () => { const s = new Set(PREFS.closedMachines); if (det.open) s.delete(g.id); else s.add(g.id); PREFS.closedMachines = [...s]; savePrefs(); });
    return h("div", "tree", det);
  }));
  exConvSeg.replaceChildren(segBtns("Show conversations", [["All", false], ["Open", true]], !!PREFS.threadsOpen, (val) => { PREFS.threadsOpen = val; savePrefs(); paintExplorer(); const tv = views.get("threads"); if (tv) tv.soon(); }));
  const ths = S.threads.filter((t) => (!PREFS.threadsOpen || threadState(t.thread, t).st !== "answered") && match(t.subject, t.lastPreview, ...t.participants)).slice(0, 40);
  // Conversations with the same subject (one question asked of several agents) share a row: ×N.
  const by = new Map();
  for (const t of ths) { const k = t.subject || ""; if (!by.has(k)) by.set(k, []); by.get(k).push(t); }
  exConvs.replaceChildren(ths.length ? h("ul", "tree", [...by.values()].map((g) => {
    const k = g[0].subject, open = S.exGrp.has(k), li = h("li", g.length > 1 ? "cgrp" : null, convRow(g[0], false, cur));
    if (g.length > 1) {
      li.append(h("button", { class: "xn", type: "button", "data-key": "g" + g[0].thread, "aria-expanded": String(open), "aria-label": g.length + " conversations with this subject", title: g.length + " conversations with this subject", onclick: () => { if (open) S.exGrp.delete(k); else S.exGrp.add(k); paintExplorer(); } }, "×" + g.length));
      if (open) li.append(h("ul", "tree csub", g.map((t) => h("li", null, convRow(t, true, cur)))));
    }
    return li;
  })) : h("p", "side-empty", q ? "No matches" : PREFS.threadsOpen ? "Nothing is waiting on an answer." : "No conversations yet."));
  if (fk) { const el = $('#explorer [data-key="' + CSS.escape(fk) + '"]'); if (el) el.focus({ preventScroll: true }); }
}

// A conversation's second line is its route; its state is a mark before the subject.
const routeTxt = (t) => { const n = t.participants.map(nameOf); return n.slice(0, 2).join(" ⇄ ") + (n.length > 2 ? " +" + (n.length - 2) : ""); };
const MARK = { held: "⏸", you: "●", await: "○" };
function convRow(t, sub, cur) {
  const cs = threadState(t.thread, t), id = "thread/" + t.thread, mark = cs.cls === "done" ? null : h("span", { class: "smk " + cs.cls, title: cs.label, "aria-hidden": "true", text: MARK[cs.cls] });
  return h("a", Object.assign({ class: "ti conv" + (t.unread ? " unread" : "") + (cur === id ? " on" : ""), href: hashFor(id), "data-key": "c" + t.thread, onclick: tabLink(id) }, hoverOn(() => hlThread(t.thread))),
    sub ? null : h("span", "ln", mark, h("span", "t trunc grow", t.subject || "(no text)"), t.unread ? h("span", { class: "n", text: String(t.unread), "aria-label": t.unread + " unread" }) : null),
    h("span", "ln sub", sub ? mark : null, h("span", "trunc grow", routeTxt(t)), h("span", "sr-only", ", " + cs.label + ", "), h("span", { text: ago(t.lastAt) })));
}

// ---------------------------------------------------------------- inspector
function inspTower(air) {
  const ov = S.ov || {}, team = ov.team, members = (S.team && S.team.members) || [];
  return [
    air ? h("section", null, h("h3", { text: "Selection" }), h("p", "small muted", air === "graph" ? "Click a node to see who it talks with here. Double-click opens it." : "Click a flight strip or a blip to see its route, timeline and full text here. Double-click opens it.")) : null,
    h("section", null, h("h3", { text: "Tower" }), h("dl", "kv",
      h("dt", { text: "you" }), h("dd", "m", "@" + (ov.handle || S.you.handle)),
      h("dt", { text: "host" }), h("dd", "m", ov.host || S.you.host),
      h("dt", { text: "delivery" }), h("dd", null, ov.paused ? h("span", "pill you", "paused") : h("span", "pill done", "live")),
      h("dt", { text: "version" }), h("dd", "m", ov.version || "")),
      h("div", "card-acts", ov.paused ? h("button", { class: "btn primary sm", type: "button", onclick: () => control("resume") }, icon("play"), "Resume delivery")
        : h("button", { class: "btn sm", type: "button", onclick: () => control("pause") }, icon("pause"), "Pause delivery"))),
    h("section", null, h("h3", null, "Team", team ? h("span", "n m", team.name) : null),
      team ? [h("p", "small muted line", h("i", { class: "st " + (team.connected ? "live" : "down"), "aria-hidden": "true" }), (team.connected ? "Relay connected" : "Relay offline") + ", " + team.membersOnline + " of " + team.members + " online"),
        h("ul", "links", members.map((m) => h("li", null, h("span", "line small", h("i", { class: "st " + (m.online ? "live" : "offline"), "aria-hidden": "true" }), h("span", "m", "@" + m.handle + (m.self ? " (you)" : "")), h("span", "muted trunc", m.host || "")))))]
        : h("p", "small muted", "Solo. Link a teammate's machine with ", h("code", { text: "agentlink team create <name>" }), ".")),
  ];
}
// Depth-1 local graph: the agent (or conversation) in the middle, whoever it talks with around.
function miniGraph(label, a, peers) {
  const ps = peers.slice(0, 8), ring = ps.length > 2, W = 272, H = ring ? 132 : 60, cx = W / 2, cy = ring ? H / 2 : 20, max = Math.max(1, ...ps.map((p) => p.n));
  const el = (tag, at, par) => { const x = document.createElementNS(SVGNS, tag); for (const k in at) x.setAttribute(k, at[k]); if (par) par.append(x); return x; };
  const svg = el("svg", { viewBox: "0 0 " + W + " " + H, class: "mini", "aria-hidden": "true" });
  const dot = (x, y, r, ag, cls, par) => {
    const c = el("circle", { cx: x, cy: y, r, class: "n " + (cls || (liveAgent(ag) ? "" : "off")) }, par);
    if (ag) c.style.setProperty("--h", "var(--h-" + toolOf(ag) + ")");
    if (ag && ag.state === "busy") el("circle", { cx: x, cy: y, r: r + 3, class: "busy" }, par);
  };
  const pos = ps.map((p, i) => { const t = -Math.PI / 2 + (i / ps.length) * TAU + (ring ? 0 : Math.PI / 2); return { p, x: cx + Math.cos(t) * 92, y: cy + Math.sin(t) * 44 }; });
  for (const q of pos) el("line", { x1: cx, y1: cy, x2: q.x, y2: q.y, "stroke-width": (1 + (2.5 * q.p.n) / max).toFixed(1) }, svg);
  dot(cx, cy, 8, a, a ? null : "conv", svg);
  for (const q of pos) {
    const g = el("g", { class: q.p.a ? "pk" : "" }, svg);
    if (q.p.a) g.addEventListener("click", () => select({ t: "a", key: q.p.a.key }));
    dot(q.x, q.y, 5, q.p.a, q.p.a ? null : "person", g);
    const s = String(q.p.label);
    el("text", { x: q.x, y: q.y < cy - 4 ? q.y - 9 : q.y + 16, "text-anchor": "middle" }, g).textContent = s.length > 13 ? s.slice(0, 12) + "…" : s;
  }
  el("text", { x: cx, y: cy + 21, "text-anchor": "middle", class: "c" }, svg).textContent = label;
  return svg;
}
const peerList = (m) => [...m].sort((x, y) => y[1] - x[1]).map(([k, n]) => ({ k, n, a: agentOf(k), label: nameOf(k) }));
function inspMsg(id) {
  const e = S.msgs.get(id);
  if (!e) return [h("section", null, h("h3", { text: "Message" }), h("p", "small muted", "This message is no longer loaded. Open its conversation from Conversations."))];
  const f = flight(e), txt = S.texts.get(id), held = S.held.filter((i) => i.message.id === id), th = "thread/" + e.m.thread;
  if (txt === undefined) {
    S.texts.set(id, null);
    if (S.texts.size > 100) S.texts.delete(S.texts.keys().next().value);
    const done = (x) => { S.texts.set(id, x); if (S.sel && S.sel.id === id) paintInspector(); };
    api("messages/" + encodeURIComponent(id)).then((r) => done(r.text || e.m.preview), (err) => done({ err: err.message }));
  }
  return [
    h("section", null, h("h3", null, kindCode(e.m.kind), h("span", { class: "n m", title: e.m.id, text: csign(e.m) })),
      h("dl", "kv", h("dt", { text: "id" }), h("dd", "m", e.m.id), h("dt", { text: "from" }), h("dd", "m", nameOf(e.m.from)),
        h("dt", { text: "sent" }), h("dd", null, stamp(e.m.createdAt) + " (" + ago(e.m.createdAt) + ")")),
      h("div", "chips route-c", [...e.d.values()].map(chip)),
      held.map((i) => h("div", "card-acts", h("span", "small grow trunc", "Held for " + nameOf(i.delivery.to)),
        h("button", { class: "btn primary sm", type: "button", onclick: () => decide(i, "approve") }, "Approve…"), h("button", { class: "btn danger sm", type: "button", onclick: () => decide(i, "deny") }, "Deny…"))),
      h("div", "card-acts", h("a", { class: "btn sm", href: hashFor(th), onclick: tabLink(th) }, icon("threads"), "Open conversation"))),
    h("section", null, h("h3", { text: "Timeline" }), h("ol", "tl", f.cells.map((c) => h("li", c.st, h("b", { text: c.code }),
      h("span", { text: c.t ? hms(c.t) : c.st === "na" ? "not needed" : c.st === "now" ? "next" : c.st === "bad" ? (f.held ? "held" : "stopped") : "" }))))),
    h("section", null, h("h3", { text: "Text" }), txt == null ? h("p", "small muted", "Loading…") : txt.err ? h("p", "err", txt.err) : h("div", "fulltext", txt)),
  ];
}
function inspThread(id) {
  const v = views.get(id), res = v && v.data;
  if (v && v.error) return [h("section", null, h("h3", { text: "Conversation" }), h("p", "err", "Could not open this conversation: " + v.error))];
  if (!res) return [h("section", null, h("h3", { text: "Conversation" }), h("p", "small muted", "Loading…"))];
  const msgs = res.messages, cs = threadState(argOf(id));
  const parts = uniq(msgs.flatMap((x) => [x.message.from, ...x.deliveries.map((d) => d.to)]));
  const kinds = new Map(), states = new Map(), seen = new Map();
  for (const x of msgs) {
    kinds.set(x.message.kind, (kinds.get(x.message.kind) || 0) + 1);
    for (const d of x.deliveries) states.set(d.state, (states.get(d.state) || 0) + 1);
    for (const p of uniq([x.message.from, ...x.deliveries.map((d) => d.to)])) seen.set(keyOf(p), (seen.get(keyOf(p)) || 0) + 1);
  }
  const max = Math.max(1, ...kinds.values());
  const byId = new Map(msgs.map((x) => [x.message.id, x.message]));
  const links = msgs.filter((x) => x.message.replyTo && byId.has(x.message.replyTo));
  const asks = msgs.some((x) => ANSWERED.has(x.message.kind));
  return [
    h("section", null, h("h3", { text: "Status" }), h("p", "line", statePill(cs)), miniGraph("conversation", null, peerList(seen))),
    h("section", null, h("h3", null, "Participants", h("span", "n", String(parts.length))), h("ul", "links", parts.map((p) => {
      const a = agentOf(p);
      return h("li", null, a ? h("button", { type: "button", onclick: () => openTab("agent/" + a.key) }, stateDot(a.state), h("span", "trunc", nameOf(p)), h("span", "c", a.modelShort || a.harness || ""))
        : h("span", "line small m", icon("user"), nameOf(p), isYou(p) ? h("span", "muted", "(you)") : null));
    }))),
    h("section", null, h("h3", null, "Kinds", h("span", "n", String(msgs.length))), [...kinds].map(([k, n]) => { const bar = h("i"); bar.style.width = Math.round((n / max) * 100) + "%"; return h("div", "kbar " + kcls(k), kindCode(k), h("span", null, bar), h("span", { text: String(n) })); })),
    h("section", null, h("h3", { text: "Receipts" }), h("div", "chips", [...states].map(([st, n]) => h("span", "chip s-" + scls(st), h("span", { text: (STATE_LABEL[st] || st) + " " + n }))))),
    h("section", null, h("h3", null, "Replies", h("span", "n", String(links.length))),
      links.length ? h("ul", "links", links.map((x) => { const p = byId.get(x.message.replyTo); return h("li", null, h("button", { type: "button", onclick: () => v.jump(x.message.id), title: x.message.preview },
        icon("link"), h("span", "trunc", kcode(x.message.kind) + " " + nameOf(x.message.from) + " ↩ " + kcode(p.kind) + " " + nameOf(p.from)), h("span", "c", hms(x.message.createdAt)))); }))
        : h("p", "small muted", asks ? "No replies yet." : "Nothing here asks for a reply.")),
  ];
}
function inspAgent(key, air) {
  const a = agentOf(key);
  if (!a) return inspTower(air);
  const peers = new Map();
  for (const e of S.order) {
    if (!involves(e, a.key)) continue;
    for (const k of uniq([keyOf(e.m.from), ...recipients(e).map(keyOf)])) if (k !== a.key) peers.set(k, (peers.get(k) || 0) + 1);
  }
  const v = views.get("agent/" + key), list = peerList(peers);
  const row = (k, val) => (val ? [h("dt", { text: k }), h("dd", { text: val })] : null);
  return [
    air ? h("section", null, h("h3", null, glyph(a), h("span", "trunc", a.short)), h("div", "card-acts", h("a", { class: "btn sm", href: hashFor("agent/" + a.key), onclick: tabLink("agent/" + a.key) }, icon("agents"), "Open agent"),
      h("button", { class: "btn sm", type: "button", onclick: () => compose([a.local ? a.name : a.address]) }, icon("compose"), "Message"))) : null,
    h("section", null, h("h3", { text: "Identity" }), h("dl", "kv", row("harness", a.harness || a.tool), row("model", a.modelShort), row(a.local ? "folder" : "project", a.dir || a.project), row("branch", a.branch), row("session", a.title), row("host", a.host), row("tag", a.tag ? "#" + a.tag : ""), row("state", a.state))),
    h("section", null, h("h3", null, "Talks with", h("span", "n", String(peers.size))),
      peers.size ? [miniGraph(a.short, a, list), h("ul", "links", list.slice(0, 12).map((p) => h("li", null, h("button", { type: "button", onclick: () => (p.a ? openTab("agent/" + p.a.key) : null) }, p.a ? stateDot(p.a.state) : icon("user"), h("span", "trunc", p.label), h("span", "c", plural(p.n, "msg"))))))]
        : h("p", "small muted", "No recent traffic.")),
    h("section", null, h("h3", { text: "Conversations" }), v && v.conv && v.conv.length ? h("ul", "links", v.conv.slice(0, 12).map((t) => h("li", null, h("a", { href: "#/thread/" + encodeURIComponent(t.thread) }, icon("threads"), h("span", "trunc", t.subject), h("span", "c", ago(t.lastAt))))))
      : h("p", "small muted", air ? "Open the agent to load them." : "None loaded.")),
  ];
}
// On Airspace and Graph the inspector shows what you selected on the scope, a strip or the graph.
function inspAir(t) {
  const s = S.sel;
  if (s && s.t === "m") return inspMsg(s.id);
  if (s && s.t === "a") return inspAgent(s.key, true);
  return inspTower(t);
}
function select(sel) {
  S.sel = sel;
  fan("onSel");
  if (sel && !narrowR.matches && !PREFS.inspector) {
    const e = sel.t === "m" && S.msgs.get(sel.id);
    openTab(e ? "thread/" + e.m.thread : "agent/" + sel.key);
    return;
  }
  if (sel && narrowR.matches) { closeDrawers(); app.classList.add("drawer-r"); $("#scrim").hidden = false; }
  paintInspector();
}
function paintInspector() {
  const ins = $("#inspector");
  const id = S.paneTab[S.focusPane] || "";
  const t = typeOf(id), air = t === "airspace" || t === "graph";
  const body = t === "thread" ? inspThread(id) : t === "agent" ? inspAgent(argOf(id)) : air ? inspAir(t) : inspTower();
  const name = t === "thread" ? "Conversation" : t === "agent" || (air && S.sel && S.sel.t === "a") ? "Agent" : air && S.sel ? "Message" : "Inspector";
  ins.replaceChildren(h("div", "side-h", h("h2", { text: name }), h("span", "grow"),
    air && S.sel ? h("button", { class: "tb", type: "button", "aria-label": "Clear the selection (Esc)", title: "Clear the selection (Esc)", onclick: () => select(null) }, icon("close")) : null,
    h("button", { class: "tb", type: "button", "aria-label": "Hide inspector (I)", title: "Hide inspector (I)", onclick: () => toggleInspector() }, icon("right"))),
    h("div", "side-b insp", body));
}
// ---------------------------------------------------------------- status bar + badges
const clockEl = h("span", { class: "sb clock", "aria-hidden": "true" });
function paintStatus() {
  const ov = S.ov || {};
  const team = ov.team;
  const msg = S.conn === "live" ? "Live" : S.conn === "connecting" ? "Connecting…" : S.connText || "Disconnected";
  const air = views.get("airspace");
  const flying = air ? air.inFlight() : 0;
  $("#statusbar").replaceChildren(
    h("span", { class: "sb", role: "status" }, h("i", { class: "st " + S.conn, "aria-hidden": "true" }), msg),
    h("span", "sb wide", icon("team"), team ? h("span", null, h("b", { text: team.name }), team.connected ? " relay up, " + team.membersOnline + "/" + team.members + " online" : " relay down") : "solo"),
    h("span", "sb-gap"),
    h("button", { class: "sb" + (ov.unread ? " warn" : ""), type: "button", title: "Unread for you", onclick: () => { PREFS.threadsOpen = false; openTab("threads"); } }, icon("inbox"), h("b", { text: String(ov.unread || 0) }), h("span", "wide", "unread")),
    h("button", { class: "sb wide", type: "button", title: "Waiting on you", onclick: () => { PREFS.threadsOpen = true; savePrefs(); openTab("threads"); const tv = views.get("threads"); if (tv) tv.refresh(); } }, h("b", { text: String(ov.todo || 0) }), "waiting on you"),
    h("button", { class: "sb" + (ov.held ? " hot" : ""), type: "button", title: "Held for approval", onclick: () => openTab("approvals") }, icon("approvals"), h("b", { text: String(ov.held || 0) }), h("span", "wide", "held")),
    ov.paused ? h("button", { class: "sb warn", type: "button", onclick: () => control("resume") }, icon("pause"), h("b", { text: "PAUSED" }), "resume")
      : h("button", { class: "sb wide", type: "button", title: "Pause all delivery", onclick: () => control("pause") }, icon("play"), "delivery live"),
    h("span", "sb wide", h("b", { text: String(flying) }), "in flight"),
    clockEl);
  tickClock();
  const badge = (view, n, hot) => {
    const a = $('.ribbon [data-view="' + view + '"]');
    let b = $(".badge-n", a);
    if (!n) { if (b) b.remove(); return; }
    if (!b) { b = h("span", { class: "badge-n", "aria-hidden": "true" }); a.append(b); }
    b.textContent = n > 99 ? "99+" : String(n);
    b.classList.toggle("hot", !!hot);
  };
  badge("threads", ov.unread || 0, false);
  badge("approvals", ov.held || 0, true);
  $('.ribbon [data-view="threads"]').setAttribute("aria-label", "Conversations" + (ov.unread ? ", " + ov.unread + " unread" : ""));
  $('.ribbon [data-view="approvals"]').setAttribute("aria-label", "Approvals" + (ov.held ? ", " + ov.held + " held" : ""));
  const banner = $("#paused");
  banner.hidden = !ov.paused;
}
function tickClock() { clockEl.textContent = T_HMS.format(Date.now()); }

// ---------------------------------------------------------------- loaders
async function refreshCounts() { try { S.ov = await api("overview"); S.you = { handle: S.ov.handle, host: S.ov.host }; paintStatus(); if (typeOf(S.paneTab[S.focusPane] || "") !== "thread" && !$("#inspector").contains(document.activeElement)) paintInspector(); } catch {} }
async function loadAgents() { try { const r = await api("agents?all=1"); setAgents(r.agents); if (r.you) S.you = r.you; } catch {} }
async function loadTeam() { try { S.team = await api("team"); } catch {} }
async function loadThreads() { try { const r = await api("threads?limit=60"); S.threads = r.threads; for (const t of r.threads) S.titles.set(t.thread, t.subject); } catch {} }
async function loadHeld() { try { S.held = (await api("approvals")).items; } catch {} }
const soonCounts = debounce(refreshCounts, 400);
const soonAgents = debounce(async () => { await loadAgents(); fan("onAgents"); paintExplorer(); renderTabs(); paintInspector(); }, 300);
const soonTeam = debounce(async () => { await loadTeam(); fan("onAgents"); paintExplorer(); paintInspector(); }, 1500);
const soonThreads = debounce(async () => { await loadThreads(); paintExplorer(); }, 700);
const soonHeld = debounce(async () => { await loadHeld(); fan("onHeld"); if (S.sel && S.sel.t === "m") paintInspector(); }, 400);
const soonStatus = debounce(paintStatus, 250);

// ---------------------------------------------------------------- drawers, theme, palette, help
const narrowR = window.matchMedia("(max-width: 1279px)"), narrowL = window.matchMedia("(max-width: 600px)");
function closeDrawers() { app.classList.remove("drawer-l", "drawer-r"); $("#scrim").hidden = true; }
// The explorer folds itself where room is short: under 1280 px, and beside Airspace under
// 1600 px. Opening or closing it by hand is remembered for that width.
const EXDEF = { n: false, a: false, w: true };
const exCtx = () => (innerWidth < 1280 ? "n" : innerWidth < 1600 && S.paneTab.includes("airspace") ? "a" : "w");
const exOpen = () => { const c = exCtx(), v = PREFS.exBy[c]; return v == null ? EXDEF[c] : !!v; };
function applyExplorer() { const on = exOpen(); app.classList.toggle("no-explorer", !on); $("#tb-explorer").setAttribute("aria-pressed", String(on)); }
function toggleExplorer() {
  if (narrowL.matches) { const open = !app.classList.contains("drawer-l"); closeDrawers(); if (open) { app.classList.add("drawer-l"); $("#scrim").hidden = false; filterIn.focus(); } return; }
  PREFS.exBy[exCtx()] = !exOpen(); savePrefs();
  applyExplorer();
}
function toggleInspector() {
  if (narrowR.matches) { const open = !app.classList.contains("drawer-r"); closeDrawers(); if (open) { app.classList.add("drawer-r"); $("#scrim").hidden = false; paintInspector(); const b = $("#inspector button"); if (b) b.focus(); } return; }
  PREFS.inspector = !PREFS.inspector; savePrefs();
  app.classList.toggle("no-inspector", !PREFS.inspector);
  $("#tb-inspector").setAttribute("aria-pressed", String(PREFS.inspector));
  if (PREFS.inspector) paintInspector();
}
const THEMES = ["system", "light", "dark"];
let theme = "system";
try { theme = localStorage.getItem("agentlink.theme") || "system"; } catch {}
if (!THEMES.includes(theme)) theme = "system";
function applyTheme(next) {
  if (next) { theme = next; try { localStorage.setItem("agentlink.theme", theme); } catch {} }
  document.documentElement.setAttribute("data-theme", theme);
  const name = theme[0].toUpperCase() + theme.slice(1);
  const b = $("#rb-theme");
  b.setAttribute("aria-label", "Theme: " + name + ". Switch theme");
  $(".rb-l", b).textContent = "Theme: " + name;
  readPalette();
  const bg = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
  $$('meta[name="theme-color"]').forEach((m) => m.setAttribute("content", bg));
  fan("onTheme");
}
function toggleFreeze() {
  const air = views.get("airspace");
  if (air) air.toggleFreeze(); else { PREFS.freeze = !PREFS.freeze; savePrefs(); }
  toast(PREFS.freeze ? "Motion frozen" : "Motion resumed");
}
function openSearch(q) { if (q != null) S.searchQ = q; S.focusSearch = true; openTab("search"); const v = views.get("search"); if (v && v.visible) v.show(); }
function commands() {
  const out = [];
  const view = (id, keyHint) => out.push({ group: "Go to", label: META[id][0], icon: META[id][1], keys: keyHint, top: true, run: () => openTab(id) });
  SINGLE.forEach((id, i) => view(id, String(i + 1)));
  const act = (label, ic, run, keys, top) => out.push({ group: "Actions", label, icon: ic, run, keys, top });
  act("New message", "compose", () => compose(), "C", true);
  if (S.ov && S.ov.paused) act("Resume delivery", "play", () => control("resume"), null, true); else act("Pause all delivery", "pause", () => control("pause"), null, true);
  if (S.ov && S.ov.held) act("Review held messages (" + S.ov.held + ")", "approvals", () => openTab("approvals"), null, true);
  act(PREFS.split ? "Close split view" : "Split view", "split", () => toggleSplit(), "\\", true);
  act(PREFS.freeze ? "Resume scope motion" : "Freeze scope motion", "freeze", toggleFreeze, "F");
  act("Toggle explorer", "left", toggleExplorer, "E");
  act("Toggle inspector", "right", toggleInspector, "I");
  act("Close tab", "close", () => closeTab(S.paneTab[S.focusPane]), "Alt+W");
  for (const t of THEMES) act("Theme: " + t[0].toUpperCase() + t.slice(1), "contrast", () => applyTheme(t));
  act("Keyboard shortcuts", "help", help, "?");
  for (const a of S.agents.filter((x) => liveAgent(x) || PREFS.showOffline)) {
    out.push({ group: "Agents", label: a.short, glyph: a, hint: identityOf(a) + (a.project ? ", " + a.project : ""), run: () => openTab("agent/" + a.key) });
    out.push({ group: "Agents", label: "Message " + a.short, icon: "compose", hint: a.title || "", run: () => compose([a.local ? a.name : a.address]) });
  }
  for (const t of S.threads) out.push({ group: "Conversations", label: t.subject || "(no text)", icon: "threads", hint: t.participants.map(nameOf).slice(0, 3).join(", "), run: () => openTab("thread/" + t.thread) });
  return out;
}
function fuzzy(q, s) {
  s = s.toLowerCase();
  const direct = s.indexOf(q);
  if (direct >= 0) return 1000 - direct * 2 - s.length * 0.1 + (direct === 0 || /[\s/@-]/.test(s[direct - 1]) ? 200 : 0);
  let i = 0, score = 0, run = 0;
  for (const ch of q) {
    const j = s.indexOf(ch, i);
    if (j < 0) return 0;
    run = j === i ? run + 1 : 0;
    score += 10 + run * 6 - (j - i);
    i = j + 1;
  }
  return Math.max(1, score);
}
function palette() {
  const input = h("input", { type: "text", name: "command", role: "combobox", "aria-expanded": "true", "aria-controls": "pal-list", "aria-autocomplete": "list", "aria-label": "Command or search", placeholder: "Agents, conversations, commands…", autocomplete: "off", spellcheck: "false" });
  const list = h("ul", { class: "pal-list", id: "pal-list", role: "listbox", "aria-label": "Results" });
  const all = commands();
  let shown = [], active = 0;
  const dlg = dialog((d) => {
    const run = (c) => { d.close(); setTimeout(() => c.run(), 0); };
    const paint = () => {
      const q = input.value.trim().toLowerCase();
      shown = q ? all.map((c) => ({ c, s: fuzzy(q, c.label + " " + (c.hint || "")) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 40).map((x) => x.c) : all.filter((c) => c.top).concat(all.filter((c) => c.group === "Conversations").slice(0, 6));
      if (q.length >= 2) shown.push({ group: "Search", label: "Search messages for “" + input.value.trim() + "”", icon: "search", run: () => openSearch(input.value.trim()) });
      active = Math.min(active, Math.max(0, shown.length - 1));
      const rows = [];
      let g = "";
      shown.forEach((c, i) => {
        if (c.group !== g) { g = c.group; rows.push(h("li", { class: "pal-g", role: "presentation", text: g })); }
        rows.push(h("li", { class: "pal-o", role: "option", id: "pal-" + i, "aria-selected": String(i === active), onmousemove: () => { if (active !== i) { active = i; mark(); } }, onclick: () => run(c) },
          c.glyph ? glyph(c.glyph) : icon(c.icon || "chev"), h("span", "l", c.label), c.hint ? h("span", "hint", c.hint) : null, c.keys ? h("kbd", { text: c.keys }) : null));
      });
      if (!shown.length) rows.push(h("li", { class: "pal-g", role: "presentation", text: "No matches" }));
      list.replaceChildren(...rows);
      mark();
    };
    const mark = () => {
      $$(".pal-o", list).forEach((li) => li.setAttribute("aria-selected", String(li.id === "pal-" + active)));
      if (shown.length) { input.setAttribute("aria-activedescendant", "pal-" + active); const el = document.getElementById("pal-" + active); if (el) el.scrollIntoView({ block: "nearest" }); }
      else input.removeAttribute("aria-activedescendant");
    };
    input.addEventListener("input", () => { active = 0; paint(); });
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") { e.preventDefault(); active = (active + 1) % Math.max(1, shown.length); mark(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); active = (active - 1 + shown.length) % Math.max(1, shown.length); mark(); }
      else if (e.key === "Home" && e.ctrlKey) { active = 0; mark(); }
      else if (e.key === "Enter") { e.preventDefault(); if (shown[active]) run(shown[active]); }
    });
    paint();
    return h("div", null, h("div", "pal-in", icon("command"), input), list,
      h("div", { class: "pal-f", "aria-hidden": "true" }, h("span", null, h("kbd", { text: "↑↓" }), " move"), h("span", null, h("kbd", { text: "Enter" }), " run"), h("span", null, h("kbd", { text: "Esc" }), " close")));
  }, "palette");
  dlg.setAttribute("aria-label", "Command palette");
  input.focus();
}
function help() {
  const keys = [["Ctrl K / Ctrl P", "Command palette"], ["1 to 6", "Airspace, Graph, Conversations, Agents, Approvals, Search"], ["Click, double-click", "Inspect, open a strip, blip or node"], ["/", "Search messages"], ["c", "New message"], ["j / k", "Next / previous item"], ["[ / ]", "Previous / next tab"], ["Alt W", "Close tab (or middle-click it)"], ["\\", "Split view"], ["Shift + click tab", "Open in the right pane"], ["e / i", "Explorer / inspector"], ["f", "Freeze scope motion"], ["Esc", "Leave a field, close a panel, clear the selection"], ["?", "This help"]];
  const dlg = dialog((d) => h("div", "dlg", h("h2", { text: "Keyboard shortcuts" }),
    h("div", "keys", keys.map(([k, val]) => [h("kbd", { text: k }), h("span", { text: val })])),
    h("h2", { text: "Message kinds" }), h("div", "keys", KINDS.map((k) => [kindCode(k), h("span", { text: klabel(k) + ": " + KMEAN[k] })])),
    h("div", "acts", h("button", { class: "btn", type: "button", onclick: () => d.close() }, "Close"))));
  dlg.setAttribute("aria-label", "Keyboard shortcuts");
  $("button", dlg).focus();
}
function navMove(d) {
  const pane = paneEls[S.focusPane];
  const items = $$("[data-nav]", pane).filter((el) => el.offsetParent !== null);
  if (!items.length) return;
  const i = items.indexOf(document.activeElement);
  const next = items[i < 0 ? (d > 0 ? 0 : items.length - 1) : clamp(i + d, 0, items.length - 1)];
  next.focus();
  next.scrollIntoView({ block: "nearest" });
}
document.addEventListener("keydown", (e) => {
  const k = e.key;
  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (k === "k" || k === "K" || k === "p" || k === "P")) { e.preventDefault(); if (!$("dialog[open]")) palette(); return; }
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || $("dialog[open]")) return;
  if (e.altKey) { if (e.code === "KeyW") { e.preventDefault(); closeTab(S.paneTab[S.focusPane]); } return; }
  const t = e.target, typing = t && t.closest && t.closest("input, textarea, select");
  if (k === "Escape") {
    if (app.classList.contains("drawer-l") || app.classList.contains("drawer-r")) { closeDrawers(); return; }
    if (typing) t.blur();
    else if (S.sel) select(null);
    return;
  }
  if (typing) return;
  if (k === "/") { e.preventDefault(); openSearch(); }
  else if (k === "j" || k === "k") { e.preventDefault(); navMove(k === "j" ? 1 : -1); }
  else if (k === "c") { e.preventDefault(); compose(); }
  else if (k === "?") help();
  else if (k === "f") toggleFreeze();
  else if (k === "e") toggleExplorer();
  else if (k === "i") toggleInspector();
  else if (k === "\\") toggleSplit();
  else if (k === "[" || k === "]") cycleTab(k === "]" ? 1 : -1);
  else if (/^[1-6]$/.test(k)) openTab(SINGLE[Number(k) - 1]);
});

// ---------------------------------------------------------------- live connection
function expired() {
  if (S.expired) return;
  S.expired = true;
  if (S.es) S.es.close();
  clearTimeout(S.retry);
  setConn("down", 0, "Signed out");
  const box = h("div", "page narrow", empty("Session ended", "Run agentlink ui in a terminal to open a new one."));
  paneEls[0].replaceChildren(h("div", "view", box));
  paneEls[1].replaceChildren();
}
function setConn(state, ms, text) {
  S.conn = state;
  S.connText = text || (state === "down" ? "Reconnecting in " + Math.ceil(ms / 1000) + "s" : "");
  $("#offline").hidden = state !== "down";
  $("#offline-text").textContent = text || (state === "down" ? "Lost the connection to agentlink. Reconnecting in " + Math.ceil(ms / 1000) + "s." : "");
  clearInterval(S.tick);
  if (state === "down" && !text) {
    const until = Date.now() + ms;
    S.tick = setInterval(() => {
      const left = Math.max(0, Math.ceil((until - Date.now()) / 1000));
      S.connText = "Reconnecting in " + left + "s";
      $("#offline-text").textContent = "Lost the connection to agentlink. Reconnecting in " + left + "s.";
      soonStatus();
    }, 1000);
  }
  paintStatus();
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
    if (again) resync();
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
async function resync() {
  await Promise.all([refreshCounts(), api("log?limit=200").then((r) => ingestLog(r.messages), () => {}), loadAgents(), loadTeam(), loadThreads()]);
  const air = views.get("airspace");
  if (air) air.rebuild();
  fan("onAgents");
  for (const v of views.values()) if (v.soon) v.soon();
  paintExplorer();
}
function onEvent(ev) {
  if (ev.type === "message" && ev.message) {
    const e = upsert(ev.message, null, true);
    fan("onMessage", e, true);
    soonCounts(); soonThreads(); soonStatus();
  } else if (ev.type === "delivery" && ev.delivery) {
    const d = ev.delivery, r = applyDelivery(d);
    if (r) fan("onDelivery", r.e, d, r.prev);
    // Spoken: only what needs you. Everything else is on the board and in the log.
    if (r && (!r.prev || r.prev.state !== d.state)) {
      if (heldHere(d)) announce("Held for approval: " + klabel(r.e.m.kind) + " from " + nameOf(r.e.m.from) + " to " + nameOf(d.to));
      else if (!r.prev && isYou(d.to) && ANSWERED.has(r.e.m.kind)) announce(klabel(r.e.m.kind) + " for you from " + nameOf(r.e.m.from) + ": " + r.e.m.preview);
    }
    if (ev.delivery.state === "held" || (r && r.prev && r.prev.state === "held")) soonHeld();
    soonCounts(); soonStatus();
    if (["seen", "replied", "acked"].includes(ev.delivery.state)) soonThreads();
  } else if (ev.type === "agent") { soonAgents(); soonTeam(); }
  else if (ev.type === "notice" && ev.text) { toast(ev.text, ev.level === "warn"); soonCounts(); }
}

// ---------------------------------------------------------------- boot
function initShell() {
  $$("[data-icon]").forEach((el) => el.prepend(icon(el.getAttribute("data-icon"))));
  $("#rb-compose").addEventListener("click", () => compose());
  $("#rb-palette").addEventListener("click", () => palette());
  $("#rb-help").addEventListener("click", help);
  $("#rb-theme").addEventListener("click", () => applyTheme(THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length]));
  $("#tb-explorer").addEventListener("click", () => toggleExplorer());
  $("#tb-menu").addEventListener("click", () => toggleExplorer());
  $("#tb-palette").addEventListener("click", () => palette());
  $("#tb-split").addEventListener("click", () => toggleSplit());
  $("#tb-more").addEventListener("click", tabMenu);
  $("#tabs").addEventListener("scroll", tabFade, { passive: true });
  new ResizeObserver(tabFade).observe($("#tabs"));
  $("#tb-inspector").addEventListener("click", () => toggleInspector());
  $("#paused-resume").addEventListener("click", () => control("resume"));
  $("#scrim").addEventListener("click", closeDrawers);
  $$(".ribbon a[data-view]").forEach((a) => a.addEventListener("click", (e) => { if (e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey) { e.preventDefault(); openTab(a.getAttribute("data-view")); } }));
  applyExplorer();
  app.classList.toggle("no-inspector", !PREFS.inspector);
  $("#tb-inspector").setAttribute("aria-pressed", String(PREFS.inspector));
  narrowR.addEventListener("change", () => { closeDrawers(); applyExplorer(); });
  window.matchMedia("(max-width: 1599px)").addEventListener("change", applyExplorer);
  narrowL.addEventListener("change", closeDrawers);
  window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => applyTheme());
  MOTION.addEventListener("change", () => fan("onMotion"));
  document.addEventListener("visibilitychange", () => fan("onVisibility"));
  window.addEventListener("hashchange", route);
  window.addEventListener("beforeunload", (e) => { if ($$("textarea").some((t) => t.value.trim())) e.preventDefault(); });
  buildExplorer();
  applyTheme();
  setInterval(tickClock, 1000);
  setInterval(() => { $$("time.ago").forEach((el) => { el.textContent = ago(el.getAttribute("datetime")); }); $$("[data-p]").forEach(paintAge); }, 30000);
}
function parseHash() {
  const raw = location.hash.replace(/^#\/?/, "");
  const parts = raw.split("/");
  let view = parts[0] || "airspace", arg = "";
  try { arg = decodeURIComponent(parts.slice(1).join("/")); } catch {}
  if (view === "overview" || view === "live") view = "airspace";
  if ((view === "thread" || view === "agent") && arg) return view + "/" + arg;
  return SINGLE.includes(view) ? view : "airspace";
}
function route() { if (!S.expired) openTab(parseHash()); }
// Saved tabs whose conversation or agent is gone are dropped before the layout comes back.
async function pruneTabs() {
  await Promise.all(PREFS.tabs.map(async (id) => {
    const t = typeOf(id), arg = argOf(id);
    if (t === "agent" && S.agents.length && !agentOf(arg)) BADTABS.add(id);
    if (t === "thread" && !S.threads.some((x) => x.thread === arg)) await api("threads/" + encodeURIComponent(arg)).catch((e) => { if (e.status === 400 || e.status === 404) BADTABS.add(id); });
  }));
  PREFS.tabs = PREFS.tabs.filter((id) => !BADTABS.has(id));
  PREFS.panes = (PREFS.panes || []).map((p) => (BADTABS.has(p) ? null : p));
}
async function boot() {
  initShell();
  paintStatus();
  await Promise.all([refreshCounts(), api("log?limit=200").then((r) => ingestLog(r.messages), () => {}), loadAgents(), loadTeam(), loadThreads(), loadHeld()]);
  if (S.expired) return;
  PREFS.tabs = uniq(PREFS.tabs.filter(validId));
  await pruneTabs();
  const want = parseHash();
  const panes = (PREFS.panes || []).filter(validId);
  if (!PREFS.tabs.length) PREFS.tabs = ["airspace"];
  for (const id of panes) if (!PREFS.tabs.includes(id)) PREFS.tabs.push(id);
  const split = !!PREFS.split && panes.length === 2 && panes[0] !== panes[1];
  PREFS.split = false;
  mount(0, location.hash.length > 2 ? want : panes[0] || PREFS.tabs[0]);
  if (split && panes[1] !== S.paneTab[0]) { PREFS.split = true; panesEl.append(paneEls[1]); panesEl.classList.add("split"); mount(1, panes[1]); $("#tb-split").setAttribute("aria-pressed", "true"); }
  if (!PREFS.tabs.includes(S.paneTab[0])) PREFS.tabs.unshift(S.paneTab[0]);
  focusPane(0);
  connect();
}
boot();
`;
