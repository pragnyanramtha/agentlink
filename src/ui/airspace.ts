// Web UI script, part 2: the Airspace view. A canvas radar scope (this machine at the centre,
// teammates' machines as sectors on the ring) with every message flying as a packet, plus the
// flight-strip board and transmission log, which carry the same traffic as text.
export const AIRSPACE = String.raw`
const MOTION = window.matchMedia("(prefers-reduced-motion: reduce)");
let PAL = { k: {}, h: {} };
let MONO = "monospace";
function readPalette() {
  const cs = getComputedStyle(document.documentElement);
  const v = (n) => cs.getPropertyValue(n).trim();
  PAL = { bg: v("--scope-bg"), ring: v("--scope-ring"), strong: v("--hair-strong"), text: v("--text"), muted: v("--muted"), faint: v("--faint"), amber: v("--amber"), glacier: v("--glacier"), lichen: v("--lichen"), ember: v("--ember"), iris: v("--iris"), panel: v("--panel"), sweep: v("--sweep"), k: {}, h: {} };
  PAL.light = cs.getPropertyValue("color-scheme").trim() === "light";
  for (const k of KINDS) PAL.k[k] = v("--k-" + k);
  for (const t of HARNESS) PAL.h[t] = v("--h-" + t);
  MONO = v("--font-mono") || "monospace";
}
function rgba(hex, a) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return "rgba(" + (n >> 16) + "," + ((n >> 8) & 255) + "," + (n & 255) + "," + a + ")";
}
const TAU = Math.PI * 2;
const byName = (a, b) => String(a.name).localeCompare(String(b.name));
// The scope and the strips show the same traffic: the kinds left on and, with a teammate's
// sector isolated, only what touches that machine.
const onH = (addr, hd) => { const s = String(addr); return s === "@" + hd || s.indexOf(hd + "/") === 0; };
const passes = (e) => !PREFS.hideKinds.includes(e.m.kind) && (!S.iso || [e.m.from, ...recipients(e)].some((a) => onH(a, S.iso)));
const liveAgent = (a) => a.state === "busy" || a.state === "idle";
function sizeCanvas(cv, box) {
  const r = box.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  cv.width = Math.max(1, Math.round(r.width * dpr));
  cv.height = Math.max(1, Math.round(r.height * dpr));
  return { W: r.width, H: r.height, DPR: dpr };
}
const animOn = (v) => v.visible && !document.hidden && !PREFS.freeze && !MOTION.matches;
function frameLoop(v, draw) {
  let raf = 0, once = 0;
  const loop = (t) => { raf = 0; draw(t); if (animOn(v) || (v.busy && v.busy())) raf = requestAnimationFrame(loop); };
  return {
    kick() { if (!raf && v.visible && !document.hidden) raf = requestAnimationFrame(loop); },
    draw() { if (!once && v.visible) once = requestAnimationFrame((t) => { once = 0; draw(t); }); },
    stop() { cancelAnimationFrame(raf); cancelAnimationFrame(once); raf = 0; once = 0; },
  };
}
function phaseOf(state) {
  if (state === "held") return "hold";
  if (state === "queued" || state === "sent") return "wait";
  if (BAD.has(state)) return "break";
  return "land";
}

// Linked highlighting: a strip, log line, explorer row or blip lights its routes on the scope.
function hlOf(list) {
  const pairs = [], addrs = [];
  for (const e of list) { addrs.push(e.m.from); for (const d of e.d.values()) { pairs.push([e.m.from, d.to, e.m.kind]); addrs.push(d.to); } }
  return { pairs, addrs };
}
const hlThread = (id) => hlOf(S.order.filter((e) => e.m.thread === id).slice(0, 24));
function hlAgent(k) { const x = hlOf(S.order.slice(0, 160).filter((e) => involves(e, k)).slice(0, 24)); x.addrs.push(k); x.agent = k; return x; }
function hilite(spec) { S.hl = spec; const a = views.get("airspace"); if (a && a.visible) a.redraw(); }
function selHl() { const s = S.sel; if (!s) return null; if (s.t === "a") return hlAgent(s.key); const e = S.msgs.get(s.id); return e ? hlOf([e]) : null; }
const hoverOn = (fn) => ({ onmouseenter: () => hilite(fn()), onmouseleave: () => hilite(null), onfocusin: () => hilite(fn()), onfocusout: () => hilite(null) });
function pickSel(ev, sel) { if (ev.button || ev.ctrlKey || ev.metaKey || ev.shiftKey || ev.altKey) return; ev.preventDefault(); select(sel); }

// One encoding on the scope and the graph: harness colour (and letter, when there is room)
// inside, state as the ring around it. Busy is a ring in the text colour that pulses on the
// scope; offline is a dashed outline.
function agentDot(g, x, y, r, a, pulse) {
  const t = toolOf(a), live = liveAgent(a);
  g.beginPath(); g.arc(x, y, r, 0, TAU);
  if (live) { g.fillStyle = PAL.h[t] || PAL.muted; g.fill(); }
  else { g.setLineDash([2, 2]); g.strokeStyle = PAL.muted; g.lineWidth = 1.25; g.stroke(); g.setLineDash([]); }
  if (live && r >= 6) { g.fillStyle = PAL.bg; g.font = "700 " + Math.round(r * 1.3) + "px " + MONO; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText(GLYPH[t], x, y + 0.5); }
  if (a.state === "busy") {
    g.strokeStyle = PAL.text; g.lineWidth = 1.75; g.beginPath(); g.arc(x, y, r + 3, 0, TAU); g.stroke();
    if (pulse != null) { g.strokeStyle = rgba(PAL.text, 0.55 * (1 - pulse)); g.lineWidth = 1.25; g.beginPath(); g.arc(x, y, r + 4 + pulse * 9, 0, TAU); g.stroke(); }
  }
  if (a.muted) { g.strokeStyle = PAL.ember; g.lineWidth = 1.5; g.beginPath(); g.moveTo(x - r - 3, y + r + 3); g.lineTo(x + r + 3, y - r - 3); g.stroke(); }
}

function Airspace() {
  const v = { visible: false };
  const canvas = h("canvas", { role: "img", "aria-label": "Airspace scope" });
  const tip = h("div", { class: "scope-tip", hidden: true, "aria-hidden": "true" });
  const legend = h("div", { class: "scope-legend", role: "group", "aria-label": "Filter the scope" });
  // The legend sits under the scope, never over its labels.
  const scopeC = h("div", "scope-c", canvas, tip);
  const scope = h("div", "scope", scopeC, legend);
  const sum = h("span", "sum");
  const isoBtn = h("button", { class: "btn sm", type: "button", hidden: true, onclick: () => isolate(null) });
  const freezeBtn = h("button", { class: "btn sm", type: "button", onclick: () => toggleFreeze() });
  const head = h("header", "air-head", h("h1", "vt", "Airspace"), sum, h("div", "acts", isoBtn, freezeBtn));
  // The board's bays, in the order a controller works them.
  const BAYS = [["hold", "Holding"], ["you", "Awaiting you"], ["air", "En route"], ["land", "Landed"]];
  const bay = {};
  const noActive = h("p", "side-empty", "Nothing in flight. New messages appear here as strips and move to Landed once answered.");
  const scroll = h("div", "strip-scroll", noActive);
  for (const [id, name] of BAYS) {
    const n = h("span", "n"), ol = h("ol", { class: "strips", "aria-label": name });
    bay[id] = { n, ol, head: h("div", "strip-grp", name + " ", n) };
    scroll.append(bay[id].head, ol);
  }
  const filt = h("span", "filt");
  const tabSeg = () => h("div", { class: "seg air-tabs", role: "group", "aria-label": "Panel" }, [["strips", "Flight strips"], ["log", "Transmission log"]].map(([id, t]) => h("button", { type: "button", "data-t": id, onclick: () => setTab(id) }, t)));
  const strips = h("section", { class: "air-strips", "aria-label": "Flight strips" }, h("div", "pnl-h", h("h2", { text: "Flight strips" }), filt, tabSeg()), scroll);
  // Not a live region: screen readers hear held mail and questions for you through the announcer.
  const log = h("ol", { class: "txlog", "aria-label": "Transmission log", "aria-live": "off" });
  const logBox = h("section", { class: "air-log", "aria-label": "Transmission log" }, h("div", "pnl-h", h("h2", { text: "Transmission log" }), tabSeg()), log);
  v.el = h("div", "view air", head, scope, strips, logBox);
  function setTab(id) {
    PREFS.airTab = id; savePrefs();
    v.el.setAttribute("data-tab", id);
    $$(".air-tabs button", v.el).forEach((b) => b.setAttribute("aria-pressed", String(b.getAttribute("data-t") === id)));
  }

  // ------------------------------------------------ strips + log (the text equivalent of the scope)
  const stripRec = new Map();
  const youOwe = (e) => ANSWERED.has(e.m.kind) && [...e.d.values()].some((d) => isYou(d.to) && OPEN_D.has(d.state));
  const touches = (e, k) => involves(e, k) || (k[0] === "@" && [e.m.from, ...recipients(e)].some((x) => x === k || onH(x, k.slice(1))));
  function makeStrip(e) {
    const f = flight(e), to = recipients(e), id = e.m.id;
    const where = f.held ? "hold" : f.landed ? "land" : youOwe(e) ? "you" : "air";
    const toTxt = to.length ? nameOf(to[0]) + (to.length > 1 ? " +" + (to.length - 1) : "") : "…";
    const now = f.cells.find((c) => c.st === "now" || c.st === "bad");
    const status = f.diverted ? "diverted" : f.landed ? "landed" : f.held ? "held for approval" : now ? "next " + now.code.toLowerCase() : "in flight";
    const a = h("a", { class: "strip-a", href: "#/thread/" + encodeURIComponent(e.m.thread), "data-nav": "", "data-key": "s" + id,
      "aria-label": klabel(e.m.kind) + " " + csign(e.m) + " from " + nameOf(e.m.from) + " to " + (to.map(nameOf).join(", ") || "nobody yet") + ", " + status + ": " + e.m.preview,
      onclick: (ev) => pickSel(ev, { t: "m", id }), ondblclick: () => openTab("thread/" + e.m.thread) },
      h("span", { class: "cs", title: id }, h("b", { text: kcode(e.m.kind) }), "·" + tail4(id)),
      where === "hold" ? ageEl("held", e.m.createdAt) : where === "you" ? ageEl("waiting", e.m.createdAt) : f.diverted ? h("span", "flag", "DIVERTED") : h("span", "strip-t", hms(e.m.createdAt)),
      h("span", "route", h("span", "trunc", nameOf(e.m.from)), h("span", { class: "arr", "aria-hidden": "true", text: "▸" }), h("span", "to trunc", toTxt)),
      h("span", "prev", e.m.preview),
      h("span", { class: "track", "aria-hidden": "true" }, f.cells.map((c) => h("span", "ph " + c.st, c.code,
        h("em", { text: c.t ? hms(c.t).slice(-5) : c.st === "na" ? "n/a" : c.st === "now" ? "…" : c.st === "bad" ? (f.held ? "hold" : "stop") : "\u00a0" })))));
    const li = h("li", Object.assign({ class: "strip " + kcls(e.m.kind) + (f.landed ? " landed" : "") + (f.held ? " held" : "") + (f.diverted ? " diverted" : "") + (S.sel && S.sel.id === id ? " sel" : ""), "data-mid": id }, hoverOn(() => hlOf([e]))), a,
      f.held ? h("div", "strip-act", h("button", { class: "btn sm danger", type: "button", onclick: () => reviewHeld(id) }, "Review…")) : null);
    return { li, bay: where, e };
  }
  let hoverK = null;
  function syncStrip(e, fresh) {
    const old = stripRec.get(e.m.id);
    if (!passes(e)) { if (old) { old.li.remove(); stripRec.delete(e.m.id); } return; }
    const had = old && old.li.contains(document.activeElement);
    const rec = makeStrip(e);
    if (old && old.bay === rec.bay) old.li.replaceWith(rec.li);
    else {
      if (old) old.li.remove();
      bay[rec.bay].ol.prepend(rec.li);
      if (fresh && !MOTION.matches) rec.li.classList.add("enter");
    }
    stripRec.set(e.m.id, rec);
    if (had) $(".strip-a", rec.li).focus({ preventScroll: true });
    if (hoverK) rec.li.classList.toggle("off", !touches(e, hoverK));
    while (stripRec.size > 200) {
      const victim = bay.land.ol.lastElementChild || bay.air.ol.lastElementChild;
      if (!victim) break;
      stripRec.delete(victim.getAttribute("data-mid"));
      victim.remove();
    }
  }
  // Bay headers count what is shown: all strips, or the hovered agent's.
  function countStrips() {
    let active = 0;
    for (const [id] of BAYS) {
      const c = hoverK ? [...bay[id].ol.children].filter((li) => !li.classList.contains("off")).length : bay[id].ol.childElementCount;
      bay[id].n.textContent = String(c); bay[id].head.hidden = !c;
      if (id !== "land") active += c;
    }
    noActive.hidden = active > 0 || !!hoverK;
    return active;
  }
  // Hovering a blip narrows the board to that agent's strips.
  function filterStrips(k) {
    if (k === hoverK) return;
    hoverK = k;
    for (const r of stripRec.values()) r.li.classList.toggle("off", !!k && !touches(r.e, k));
    countStrips();
    const b = k && blips.get(k);
    filt.textContent = b ? "only " + (b.a ? b.a.short : k) : "";
  }
  const txRec = new Map();
  function logLine(t, code, cls, e, route, text, fresh, tx) {
    const li = h("li", Object.assign({ class: "tx " + cls + (fresh && !MOTION.matches ? " new" : "") }, hoverOn(() => hlOf([e]))),
      h("time", { datetime: new Date(t).toISOString(), text: hms(t) }), h("b", "c", code),
      h("span", "r", route), h("span", { class: "id", title: e.m.id, text: tail4(e.m.id) }), h("span", { class: "p", text }));
    li.mid = e.m.id;
    if (tx) txRec.set(e.m.id, li);
    log.prepend(li);
    while (log.childElementCount > 300) { const x = log.lastElementChild; if (txRec.get(x.mid) === x) txRec.delete(x.mid); x.remove(); }
  }
  const routeOf = (e) => nameOf(e.m.from) + " ▸ " + (recipients(e).map(nameOf).join(", ") || "…");
  function logTx(e, fresh) { logLine(fresh ? Date.now() : ts(e.m.createdAt), kcode(e.m.kind), kcls(e.m.kind), e, routeOf(e), e.m.preview, fresh, true); }
  const DCODE = { sent: ["SENT", "warn"], delivered: ["DLVR", "ok"], seen: ["SEEN", "ok"], replied: ["RPLD", "ok"], acked: ["ACK", "ok"], held: ["HELD", "bad"], refused: ["RFSD", "bad"], expired: ["EXPD", "bad"], failed: ["FAIL", "bad"] };
  function logDelivery(e, d, prev) {
    let c = DCODE[d.state];
    if (!c && d.state === "queued") c = prev && prev.state === "held" ? ["CLRD", "ok"] : null;
    if (!c || (prev && prev.state === d.state)) return;
    logLine(Date.now(), c[0], c[1], e, nameOf(e.m.from) + " ▸ " + nameOf(d.to), (d.method ? "via " + d.method + " " : "") + (d.note || STATE_LABEL[d.state] || d.state), true);
  }
  function rebuild() {
    for (const [id] of BAYS) bay[id].ol.replaceChildren();
    stripRec.clear(); log.replaceChildren(); txRec.clear();
    const list = S.order.filter(passes);
    for (const e of list.slice(0, 200).reverse()) syncStrip(e, false);
    for (const e of list.slice(0, 60).reverse()) logTx(e, false);
    packets.length = 0;
    seedPackets();
    countStrips();
    layout();
    stat = null;
    loop.draw();
  }

  // ------------------------------------------------ scope geometry
  const ctx = canvas.getContext("2d");
  let W = 0, H = 0, DPR = 1, cx = 0, cy = 0, R = 0, stat = null, teamMode = false, discR = 0.68;
  let blips = new Map(), sectors = [], staticBoxes = [];
  const traffic = new Map();
  const packets = [], pings = [];
  let hover = null;
  // This machine's agents ring the centre at about half the radius; teammates' agents sit in
  // the outer band of their sector, the teammate on the ring with the sector's caption outside.
  function layout() {
    blips = new Map();
    traffic.clear();
    const recent = new Set();
    for (const e of S.order.slice(0, 160)) for (const k of [keyOf(e.m.from), ...recipients(e).map(keyOf)]) { recent.add(k); traffic.set(k, (traffic.get(k) || 0) + 1); }
    const show = (a) => liveAgent(a) || PREFS.showOffline || recent.has(a.key);
    const local = S.agents.filter((a) => a.local && show(a)).sort(byName);
    const remote = S.agents.filter((a) => !a.local && show(a));
    const members = ((S.team && S.team.members) || []).filter((m) => !m.self);
    const handles = uniq([...members.map((m) => m.handle), ...remote.map((a) => a.member)]).filter((x) => x && x !== S.you.handle).sort();
    teamMode = handles.length > 0;
    const ring = teamMode ? 0.52 : 0.6;
    const n = local.length, two = n > (teamMode ? 9 : 12);
    local.forEach((a, i) => {
      const ang = -Math.PI / 2 + (i / Math.max(1, n)) * TAU + (n > 1 ? 0.18 : 0);
      const r = two ? (i % 2 ? ring * 1.18 : ring * 0.78) : ring;
      blips.set(a.key, { ux: Math.cos(ang) * r, uy: Math.sin(ang) * r, a });
    });
    blips.set("@" + S.you.handle, { ux: 0, uy: 0, person: "you" });
    sectors = [];
    const span = TAU / Math.max(1, handles.length), gap = handles.length > 1 ? 0.05 : 0;
    handles.forEach((hd, j) => {
      const a0 = -Math.PI / 2 + j * span + gap + (handles.length === 1 ? 0.35 : 0), a1 = a0 + span - 2 * gap;
      const mine = members.filter((m) => m.handle === hd);
      const host = (mine.find((m) => m.host) || {}).host || (remote.find((a) => a.member === hd && a.host) || {}).host || "";
      const sec = { handle: hd, host, online: mine.some((m) => m.online) || remote.some((a) => a.member === hd && liveAgent(a)), a0, a1, mid: (a0 + a1) / 2 };
      sectors.push(sec);
      const list = remote.filter((a) => a.member === hd).sort(byName);
      const full = handles.length === 1;
      list.forEach((a, k) => {
        const f = full ? (k + 0.5) / list.length : (k + 0.5) / list.length;
        const ang = full ? sec.mid + 0.5 + f * (TAU - 1) : a0 + f * (a1 - a0);
        const r = list.length > 3 && k % 2 ? 0.92 : 0.82;
        blips.set(a.key, { ux: Math.cos(ang) * r, uy: Math.sin(ang) * r, a });
      });
      blips.set("@" + hd, { ux: Math.cos(sec.mid), uy: Math.sin(sec.mid), person: "teammate", handle: hd });
    });
    summarize();
    paintLegend();
  }
  function bkey(addr) {
    const k = keyOf(addr), s = String(addr);
    return blips.has(k) ? k : s.indexOf("/") > 0 ? "@" + s.split("/")[0] : k;
  }
  function at(addr) { const b = blips.get(bkey(addr)); return b ? { x: cx + b.ux * R, y: cy + b.uy * R } : null; }
  function resize() {
    const s = sizeCanvas(canvas, scopeC);
    W = s.W; H = s.H; DPR = s.DPR;
    cx = W / 2; cy = H / 2 - 4;
    R = Math.max(60, Math.min(W, H - 8) / 2 - (teamMode ? 44 : 34));
    stat = null;
    loop.draw();
  }
  function buildStatic() {
    stat = document.createElement("canvas");
    stat.width = canvas.width; stat.height = canvas.height;
    const g = stat.getContext("2d");
    g.setTransform(DPR, 0, 0, DPR, 0, 0);
    const glow = g.createRadialGradient(cx, cy, 0, cx, cy, R * 1.15);
    glow.addColorStop(0, rgba(PAL.sweep, PAL.light ? 0.07 : 0.06));
    glow.addColorStop(1, rgba(PAL.sweep, 0));
    g.fillStyle = glow;
    g.fillRect(0, 0, W, H);
    g.lineWidth = 1;
    for (const f of [0.25, 0.5, 0.75]) { g.strokeStyle = PAL.ring; g.beginPath(); g.arc(cx, cy, R * f, 0, TAU); g.stroke(); }
    g.strokeStyle = PAL.strong; g.lineWidth = 1.25; g.beginPath(); g.arc(cx, cy, R, 0, TAU); g.stroke();
    g.lineWidth = 1;
    g.font = "500 9.5px " + MONO; g.textAlign = "center"; g.textBaseline = "middle";
    const near = (a) => sectors.some((s) => Math.abs(Math.atan2(Math.sin(a - s.mid), Math.cos(a - s.mid))) < 0.32);
    for (let deg = 0; deg < 360; deg += 5) {
      const a = (deg * Math.PI) / 180 - Math.PI / 2, len = deg % 30 === 0 ? 7 : deg % 10 === 0 ? 4 : 2;
      g.strokeStyle = deg % 30 === 0 ? PAL.strong : PAL.ring;
      g.beginPath(); g.moveTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R); g.lineTo(cx + Math.cos(a) * (R + len), cy + Math.sin(a) * (R + len)); g.stroke();
      if (deg % 30 === 0 && !near(a)) { g.fillStyle = PAL.muted; g.fillText(String(deg).padStart(3, "0"), cx + Math.cos(a) * (R + 18), cy + Math.sin(a) * (R + 18)); }
    }
    g.strokeStyle = PAL.ring; g.setLineDash([2, 5]);
    g.beginPath(); g.moveTo(cx - R, cy); g.lineTo(cx + R, cy); g.moveTo(cx, cy - R); g.lineTo(cx, cy + R); g.stroke();
    g.setLineDash([]);
    staticBoxes = [];
    if (!teamMode) return;
    g.strokeStyle = PAL.strong; g.setLineDash([4, 4]);
    g.beginPath(); g.arc(cx, cy, R * discR, 0, TAU); g.stroke();
    if (sectors.length > 1) {
      g.strokeStyle = PAL.ring;
      for (const s of sectors) { const a = s.a0 - 0.05; g.beginPath(); g.moveTo(cx + Math.cos(a) * R * (discR + 0.04), cy + Math.sin(a) * R * (discR + 0.04)); g.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R); g.stroke(); }
    }
    g.setLineDash([]);
    if (R >= 150) {
      const ty = cy - R * discR;
      g.font = "600 9.5px " + MONO;
      const tw = g.measureText("THIS MACHINE").width + 12;
      g.fillStyle = PAL.bg; g.fillRect(cx - tw / 2, ty - 7, tw, 14);
      g.fillStyle = PAL.muted; g.fillText("THIS MACHINE", cx, ty);
      staticBoxes.push({ x0: cx - tw / 2, x1: cx + tw / 2, y0: ty - 8, y1: ty + 8 });
    }
    // A sector's caption sits just outside the ring and is also the label of its teammate.
    for (const s of sectors) {
      const ox = Math.cos(s.mid), oy = Math.sin(s.mid), al = Math.abs(ox) < 0.35 ? "center" : ox > 0 ? "left" : "right";
      const x = cx + ox * (R + 14), y = cy + oy * (R + 14) + (al === "center" ? (oy > 0 ? 7 : -19) : -6);
      const name = "@" + s.handle, sub = s.online ? s.host || "teammate" : "offline";
      g.textAlign = al;
      g.font = "9.5px " + MONO;
      const wsub = g.measureText(sub).width;
      g.font = "600 10.5px " + MONO; g.fillStyle = s.online ? PAL.glacier : PAL.muted; g.fillText(name, x, y);
      const w = Math.max(g.measureText(name).width, wsub) + 4;
      g.font = "9.5px " + MONO; g.fillStyle = PAL.muted; g.fillText(sub, x, y + 12);
      const x0 = al === "left" ? x - 2 : al === "right" ? x - w + 2 : x - w / 2;
      staticBoxes.push({ x0, x1: x0 + w, y0: y - 8, y1: y + 19 });
    }
    g.textAlign = "center";
  }

  // ------------------------------------------------ packets
  function seedPackets() {
    for (const e of S.order.slice(0, 120)) {
      if (!passes(e)) continue;
      for (const d of e.d.values()) if (d.state === "held" || d.state === "queued" || d.state === "sent") spawn(e, d, false);
    }
  }
  function spawn(e, d, fly) {
    if (!passes(e) || packets.some((p) => p.did === d.id)) return;
    const now = performance.now();
    const p = { did: d.id, e, from: e.m.from, to: d.to, kind: e.m.kind, t0: now, ph: "fly", tPh: now, seed: ((d.id * 2.399) % TAU) };
    packets.push(p);
    if (!(fly && animOn(v))) settle(p, d.state, now);
    while (packets.length > 160) packets.shift();
  }
  function settle(p, state, now) {
    const ph = phaseOf(state);
    const i = packets.indexOf(p);
    if (ph === "land") {
      if (animOn(v)) pings.push({ to: p.to, t0: now, col: PAL.lichen });
      if (i >= 0) packets.splice(i, 1);
    } else if (ph === "break") {
      if (animOn(v) && p.ph !== "break") { p.ph = "break"; p.tPh = now; } else if (i >= 0) packets.splice(i, 1);
    } else { p.ph = ph; p.tPh = now; }
  }
  const ctrl = (A, B) => { const dx = B.x - A.x, dy = B.y - A.y; return { x: (A.x + B.x) / 2 - dy * 0.22, y: (A.y + B.y) / 2 + dx * 0.22 }; };
  const quad = (A, Q, B, t) => { const u = 1 - t; return { x: u * u * A.x + 2 * u * t * Q.x + t * t * B.x, y: u * u * A.y + 2 * u * t * Q.y + t * t * B.y }; };
  const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
  function circle(x, y, r) { ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); }
  function arc(A, B) { const Q = ctrl(A, B); ctx.beginPath(); ctx.moveTo(A.x, A.y); ctx.quadraticCurveTo(Q.x, Q.y, B.x, B.y); ctx.stroke(); }

  // ------------------------------------------------ frame
  function draw(now) {
    if (!W || !v.visible) return;
    if (!stat) buildStatic();
    const moving = animOn(v);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(stat, 0, 0, W, H);
    let sweep = null;
    if (moving) {
      sweep = ((now / 9000) % 1) * TAU - Math.PI / 2;
      if (ctx.createConicGradient) {
        const tail = 0.85, g = ctx.createConicGradient(sweep - tail, cx, cy);
        g.addColorStop(0, rgba(PAL.sweep, 0));
        g.addColorStop(tail / TAU, rgba(PAL.sweep, PAL.light ? 0.1 : 0.12));
        g.addColorStop(tail / TAU + 0.002, rgba(PAL.sweep, 0));
        g.addColorStop(1, rgba(PAL.sweep, 0));
        ctx.fillStyle = g; circle(cx, cy, R); ctx.fill();
      }
      ctx.strokeStyle = rgba(PAL.sweep, 0.4); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(sweep) * R, cy + Math.sin(sweep) * R); ctx.stroke();
    }
    // A hovered route wins over the selection; either one dims everything else.
    const sh = selHl(), focus = S.hl || sh;
    const lit = focus ? new Set(focus.addrs.map(bkey)) : null;
    const marks = focus ? (focus.agent ? new Set([bkey(focus.agent)]) : lit) : new Set();
    // trails: who talked to whom in the last ten minutes, fading with age
    const span = 600000, wall = Date.now();
    let n = 0;
    ctx.lineWidth = 1;
    for (const e of S.order) {
      const t = ts(e.m.createdAt);
      if (wall - t > span || n > 80) break;
      if (!passes(e)) continue;
      const A = at(e.m.from);
      if (!A) continue;
      for (const d of e.d.values()) {
        const B = at(d.to);
        if (!B || (B.x === A.x && B.y === A.y)) continue;
        ctx.strokeStyle = rgba(PAL.k[e.m.kind] || PAL.muted, (focus ? 0.3 : 1) * (0.05 + 0.3 * (1 - (wall - t) / span)));
        arc(A, B);
        n++;
      }
    }
    if (focus) {
      const seen = new Set();
      ctx.lineWidth = 2;
      for (const [f, t2, kind] of focus.pairs) {
        const A = at(f), B = at(t2), id = A && B ? A.x + "," + A.y + ">" + B.x + "," + B.y : "";
        if (!id || seen.has(id) || (A.x === B.x && A.y === B.y)) continue;
        seen.add(id);
        ctx.strokeStyle = rgba(PAL.k[kind] || PAL.text, 0.95);
        arc(A, B);
      }
      ctx.lineWidth = 1;
    }
    // holding patterns: dashed orbit around recipients with held mail
    const holding = new Set(packets.filter((p) => p.ph === "hold").map((p) => bkey(p.to)));
    ctx.setLineDash([3, 3]); ctx.strokeStyle = rgba(PAL.ember, 0.6); ctx.lineWidth = 1;
    for (const k of holding) { const B = at(k); if (B) { circle(B.x, B.y, 20); ctx.stroke(); } }
    ctx.setLineDash([]);
    drawBlips(now, sweep, moving, lit, marks);
    drawPackets(now, moving);
    for (let i = pings.length - 1; i >= 0; i--) {
      const p = pings[i], k = (now - p.t0) / 750, B = at(p.to);
      if (k >= 1 || !B) { pings.splice(i, 1); continue; }
      ctx.strokeStyle = rgba(p.col, 0.9 * (1 - k)); ctx.lineWidth = 1.5;
      circle(B.x, B.y, 6 + k * 22); ctx.stroke();
    }
  }
  // Labels go outward from the blip, then below, above or inward; then the name alone; then out
  // on a leader line. With no room left the name shows on hover only: labels never overlap.
  let placed = [];
  const hits = (b) => b.y0 < 2 || b.y1 > H - 2 || placed.some((p) => b.x0 < p.x1 && b.x1 > p.x0 && b.y0 < p.y1 && b.y1 > p.y0);
  function halo(text, x, y) { ctx.strokeText(text, x, y); ctx.fillText(text, x, y); }
  function label(x, y, r, ang, name, sub, alpha) {
    ctx.font = "600 11px " + MONO;
    const wn = ctx.measureText(name).width;
    ctx.font = "500 10px " + MONO;
    const wt = sub && R >= 150 ? ctx.measureText(sub).width : -1;
    const box = (dir, dy, two, gap) => {
      const w = Math.max(wn, two ? wt : 0) + 4, ox = Math.cos(ang) * dir, oy = Math.sin(ang) * dir;
      const align = Math.abs(ox) < 0.35 ? "center" : ox > 0 ? "left" : "right";
      const lx = x + ox * (r + gap);
      let ly = y + oy * (r + gap) + dy;
      if (align === "center") ly += oy > 0 ? 8 : two ? -20 : -8; else if (two) ly -= 6;
      let x0 = align === "left" ? lx : align === "right" ? lx - w : lx - w / 2;
      const shift = x0 < 4 ? 4 - x0 : x0 + w > W - 4 ? W - 4 - w - x0 : 0;
      x0 += shift;
      return { align, two, gap, lx: lx + shift, ly, x0, x1: x0 + w, y0: ly - 7, y1: ly + (two ? 19 : 6) };
    };
    let b = null;
    for (const two of wt >= 0 ? [true, false] : [false]) for (const [d, dy] of [[1, 0], [1, 14], [1, -14], [-1, 0]]) if (!b) { const c = box(d, dy, two, 9); if (!hits(c)) b = c; }
    for (const dy of [0, 16, -16]) if (!b) { const c = box(1, dy, false, 30); if (!hits(c)) b = c; }
    if (!b) return;
    placed.push(b);
    ctx.globalAlpha = alpha; ctx.textBaseline = "middle"; ctx.lineJoin = "round";
    if (b.gap > 9) { ctx.strokeStyle = PAL.strong; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x + Math.cos(ang) * (r + 3), y + Math.sin(ang) * (r + 3)); ctx.lineTo(b.align === "left" ? b.x0 : b.align === "right" ? b.x1 : b.lx, b.ly); ctx.stroke(); }
    ctx.lineWidth = 3; ctx.strokeStyle = PAL.bg;
    ctx.font = "600 11px " + MONO; ctx.textAlign = b.align; ctx.fillStyle = PAL.text;
    halo(name, b.lx, b.ly);
    if (b.two) { ctx.font = "500 10px " + MONO; ctx.fillStyle = PAL.muted; halo(sub, b.lx, b.ly + 13); }
    ctx.globalAlpha = 1;
  }
  const blipR = (k) => 6 + Math.min(2, Math.log2(1 + (traffic.get(k) || 0)) * 0.6);
  function drawBlips(now, sweep, moving, lit, marks) {
    placed = [{ x0: cx - 34, x1: cx + 34, y0: cy - 9, y1: cy + 36 }, ...staticBoxes];
    for (const [k, b] of blips) { const x = cx + b.ux * R, y = cy + b.uy * R, r = b.person ? 7 : blipR(k) + 3; placed.push({ x0: x - r, x1: x + r, y0: y - r, y1: y + r }); }
    for (const [k, b] of blips) {
      const x = cx + b.ux * R, y = cy + b.uy * R, dim = lit && !lit.has(k) ? 0.3 : 1;
      ctx.globalAlpha = dim;
      if (b.person) {
        const you = b.person === "you", s = you ? 7 : 5;
        ctx.strokeStyle = you ? PAL.amber : PAL.glacier; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(x, y - s); ctx.lineTo(x + s, y); ctx.lineTo(x, y + s); ctx.lineTo(x - s, y); ctx.closePath();
        ctx.fillStyle = you ? rgba(PAL.amber, 0.25) : PAL.bg; ctx.fill(); ctx.stroke();
        if (hover === k || marks.has(k)) brackets(x, y, s + 6);
        if (you) {
          ctx.textAlign = "center"; ctx.textBaseline = "middle";
          ctx.font = "600 10.5px " + MONO; ctx.fillStyle = PAL.amber; ctx.fillText("@" + S.you.handle, x, y + s + 12);
          ctx.font = "9.5px " + MONO; ctx.fillStyle = PAL.muted; ctx.fillText(teamMode ? "you" : S.you.host || "you", x, y + s + 24);
        }
        continue;
      }
      const a = b.a, r = blipR(k);
      const ang = b.ux || b.uy ? Math.atan2(b.uy, b.ux) : -Math.PI / 2;
      if (sweep != null && liveAgent(a)) { const d = (((sweep - ang) % TAU) + TAU) % TAU; if (d < 1.3) { ctx.fillStyle = rgba(PAL.sweep, 0.18 * (1 - d / 1.3)); circle(x, y, r + 8); ctx.fill(); } }
      agentDot(ctx, x, y, r, a, a.state === "busy" && moving ? (now % 1700) / 1700 : null);
      if (hover === k || marks.has(k)) brackets(x, y, r + 8);
      label(x, y, r + (a.state === "busy" ? 4 : 0), ang, a.local ? a.name : a.name.split("/").pop(), a.modelShort || a.harness || "", dim * (liveAgent(a) ? 1 : 0.65));
    }
    ctx.globalAlpha = 1;
  }
  function brackets(x, y, s) {
    ctx.strokeStyle = PAL.text; ctx.lineWidth = 1.5;
    const l = 4;
    ctx.beginPath();
    for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      ctx.moveTo(x + sx * s, y + sy * (s - l)); ctx.lineTo(x + sx * s, y + sy * s); ctx.lineTo(x + sx * (s - l), y + sy * s);
    }
    ctx.stroke();
  }
  function drawPackets(now, moving) {
    for (let i = packets.length - 1; i >= 0; i--) {
      const p = packets[i];
      if (i >= packets.length) continue;
      const B = at(p.to);
      if (!B) { packets.splice(i, 1); continue; }
      const col = PAL.k[p.kind] || PAL.text;
      if (p.ph === "fly") {
        const A = at(p.from);
        if (!A || !moving) { settle(p, (p.e.d.get(p.did) || {}).state, now); continue; }
        const dist = Math.hypot(B.x - A.x, B.y - A.y), dur = clamp(800 + dist * 2.4, 1000, 2600);
        const t = (now - p.t0) / dur;
        if (t >= 1) { settle(p, (p.e.d.get(p.did) || {}).state, now); continue; }
        const te = ease(t), Q = ctrl(A, B);
        let prev = quad(A, Q, B, Math.max(0, te - 0.24));
        for (let j = 1; j <= 8; j++) {
          const q = quad(A, Q, B, Math.max(0, te - 0.24 + (0.24 * j) / 8));
          ctx.strokeStyle = rgba(col, (j / 8) * 0.85); ctx.lineWidth = 0.6 + (j / 8) * 1.8;
          ctx.beginPath(); ctx.moveTo(prev.x, prev.y); ctx.lineTo(q.x, q.y); ctx.stroke();
          prev = q;
        }
        ctx.fillStyle = col; ctx.strokeStyle = PAL.bg; ctx.lineWidth = 1.5;
        circle(prev.x, prev.y, 3.4); ctx.fill(); ctx.stroke();
      } else if (p.ph === "wait") {
        const x = B.x + Math.cos(p.seed) * 16, y = B.y + Math.sin(p.seed) * 16;
        const al = moving ? 0.55 + 0.45 * Math.sin(now / 320 + p.seed) : 1;
        ctx.strokeStyle = rgba(PAL.glacier, al); ctx.lineWidth = 1.25; circle(x, y, 4.5); ctx.stroke();
        ctx.fillStyle = col; circle(x, y, 2.2); ctx.fill();
      } else if (p.ph === "hold") {
        const a = p.seed + (moving ? (now / 1000) * 1.5 : 0);
        ctx.strokeStyle = rgba(PAL.ember, 0.8); ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(B.x, B.y, 20, a - 0.7, a); ctx.stroke();
        ctx.fillStyle = PAL.ember; circle(B.x + Math.cos(a) * 20, B.y + Math.sin(a) * 20, 3.2); ctx.fill();
      } else if (p.ph === "break") {
        const k = (now - p.tPh) / 900;
        if (k >= 1) { packets.splice(i, 1); continue; }
        const ox = Math.cos(p.seed), oy = Math.sin(p.seed);
        const sx = B.x + ox * 16, sy = B.y + oy * 16;
        ctx.strokeStyle = rgba(PAL.ember, 1 - k); ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(sx - 3, sy - 3); ctx.lineTo(sx + 3, sy + 3); ctx.moveTo(sx + 3, sy - 3); ctx.lineTo(sx - 3, sy + 3); ctx.stroke();
        const px = sx + (ox - oy) * k * 38, py = sy + (oy + ox) * k * 38;
        ctx.fillStyle = rgba(PAL.ember, 1 - k); circle(px, py, 3); ctx.fill();
      }
    }
  }
  v.busy = () => pings.length > 0 || packets.some((p) => p.ph === "fly" || p.ph === "break");
  const loop = frameLoop(v, draw);

  // ------------------------------------------------ summary, filters, hover, controls
  let lastSum = "";
  const inFlight = () => bay.hold.ol.childElementCount + bay.you.ol.childElementCount + bay.air.ol.childElementCount;
  function summarize() {
    const loc = S.agents.filter((a) => a.local && liveAgent(a)), rem = S.agents.filter((a) => !a.local && liveAgent(a));
    const busy = loc.filter((a) => a.state === "busy").length;
    const waiting = packets.filter((p) => p.ph === "wait" || p.ph === "fly").length, held = bay.hold.ol.childElementCount;
    const text = loc.length + " local, " + rem.length + " remote, " + inFlight() + " in flight" + (held ? ", " + held + " held" : "");
    if (text !== lastSum) {
      lastSum = text;
      sum.textContent = text;
      canvas.setAttribute("aria-label", "Airspace scope. " + plural(loc.length, "agent") + " on this machine (" + busy + " busy)" + (teamMode ? ", " + plural(rem.length, "agent") + " on teammates' machines" : "") + ". " + plural(waiting, "message") + " on the way, " + held + " held for approval. The flight strips and transmission log list the same traffic.");
    }
  }
  // The legend filters the scope: toggle kinds; a teammate's handle isolates that sector.
  function paintLegend() {
    const f = legend.contains(document.activeElement) ? document.activeElement.getAttribute("aria-label") : null;
    legend.replaceChildren(...KINDS.filter((k) => k !== "ack").map((k) => h("button", { type: "button", class: kcls(k), "aria-pressed": String(!PREFS.hideKinds.includes(k)), "aria-label": "Show " + klabel(k), title: klabel(k) + ": " + KMEAN[k], onclick: () => toggleKind(k) }, h("i"), kcode(k))),
      ...sectors.map((s) => h("button", { type: "button", class: "sec", "aria-pressed": String(S.iso === s.handle), "aria-label": "Only traffic with @" + s.handle, title: "Only traffic with @" + s.handle, onclick: () => isolate(S.iso === s.handle ? null : s.handle) }, "@" + s.handle)));
    const b = f && [...legend.children].find((x) => x.getAttribute("aria-label") === f);
    if (b) b.focus();
  }
  function toggleKind(k) {
    const s = new Set(PREFS.hideKinds);
    if (s.has(k)) s.delete(k); else s.add(k);
    PREFS.hideKinds = [...s]; savePrefs();
    rebuild();
  }
  function isolate(hd) {
    S.iso = hd;
    isoBtn.hidden = !hd;
    isoBtn.replaceChildren(icon("close"), hd ? "@" + hd + " only" : "");
    isoBtn.setAttribute("aria-label", "Show all traffic again (now only @" + hd + ")");
    rebuild();
  }
  function paintFreeze() {
    freezeBtn.replaceChildren(icon(PREFS.freeze ? "play" : "pause"), PREFS.freeze ? "Resume motion" : "Freeze motion");
    freezeBtn.setAttribute("aria-pressed", String(!!PREFS.freeze));
    freezeBtn.hidden = MOTION.matches;
  }
  v.toggleFreeze = () => {
    PREFS.freeze = !PREFS.freeze; savePrefs(); paintFreeze();
    if (PREFS.freeze) for (const p of packets.slice()) if (p.ph === "fly") settle(p, (p.e.d.get(p.did) || {}).state, performance.now());
    loop.kick(); loop.draw();
  };
  function pickBlip(ev) {
    const r = canvas.getBoundingClientRect(), x = ev.clientX - r.left, y = ev.clientY - r.top;
    let best = null, bd = 18 * 18;
    for (const [k, b] of blips) { const dx = cx + b.ux * R - x, dy = cy + b.uy * R - y, d2 = dx * dx + dy * dy; if (d2 < bd) { bd = d2; best = k; } }
    return { k: best, x, y };
  }
  function showTip(k, x, y) {
    const b = blips.get(k);
    if (!b) { tip.hidden = true; return; }
    const lines = [];
    if (b.person === "you") lines.push(h("b", { text: "@" + S.you.handle }), h("span", { text: "You, on " + (S.you.host || "this machine") }));
    else if (b.person) lines.push(h("b", { text: "@" + b.handle }), h("span", { text: "Teammate (person). Click the sector to show only its traffic." }));
    else {
      const a = b.a;
      lines.push(h("b", { text: a.short }), h("span", { text: identityOf(a) || a.tool }));
      if (a.dir || a.project) lines.push(h("span", { text: (a.dir || a.project) + (a.branch ? " @ " + a.branch : "") }));
      if (a.title) lines.push(h("span", { text: "“" + a.title + "”" }));
      lines.push(h("span", { text: a.state + (a.host ? " on " + a.host : "") + (a.muted ? ", muted" : "") }));
    }
    tip.replaceChildren(...lines);
    tip.hidden = false;
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    const px = clamp(x + 16, 6, W - tw - 6), py = y + 16 + th > H ? y - th - 12 : y + 16;
    tip.style.transform = "translate(" + Math.round(px) + "px," + Math.round(py) + "px)";
  }
  const agentAt = (k) => (k && blips.get(k) && blips.get(k).a ? k : null);
  canvas.addEventListener("pointermove", (ev) => {
    const p = pickBlip(ev);
    if (p.k !== hover) {
      hover = p.k;
      const ak = agentAt(hover);
      canvas.style.cursor = hover ? "pointer" : "";
      S.hl = ak ? hlAgent(ak) : null;
      filterStrips(ak);
      loop.draw();
    }
    if (hover) showTip(hover, p.x, p.y); else tip.hidden = true;
  });
  canvas.addEventListener("pointerleave", () => { hover = null; tip.hidden = true; if (S.hl && S.hl.agent) S.hl = null; filterStrips(null); loop.draw(); });
  // Click a blip to inspect it (double-click opens it); click a teammate's sector to isolate
  // its traffic, and this machine's disc to show everything again.
  canvas.addEventListener("click", (ev) => {
    const p = pickBlip(ev), b = p.k && blips.get(p.k);
    if (b && b.a) return select({ t: "a", key: b.a.key });
    if (b && b.handle) return isolate(S.iso === b.handle ? null : b.handle);
    const dx = p.x - cx, dy = p.y - cy, d = Math.hypot(dx, dy) / R;
    if (!teamMode || d < discR || d > 1.35) { if (S.iso) isolate(null); else if (S.sel) select(null); return; }
    const ang = Math.atan2(dy, dx);
    const s = sectors.find((x) => ((((ang - x.a0) % TAU) + TAU) % TAU) <= x.a1 - x.a0 + 0.05);
    if (s) isolate(S.iso === s.handle ? null : s.handle);
  });
  canvas.addEventListener("dblclick", (ev) => { const k = agentAt(pickBlip(ev).k); if (k) openTab("agent/" + blips.get(k).a.key); });
  const ro = new ResizeObserver(() => resize());

  // ------------------------------------------------ lifecycle + store events
  v.show = () => { v.visible = true; ro.observe(scope); layout(); resize(); paintFreeze(); loop.kick(); };
  v.hide = () => { v.visible = false; ro.disconnect(); loop.stop(); hover = null; tip.hidden = true; filterStrips(null); };
  v.destroy = () => v.hide();
  v.redraw = () => loop.draw();
  v.onSel = () => { for (const r of stripRec.values()) r.li.classList.toggle("sel", !!S.sel && S.sel.id === r.e.m.id); loop.draw(); };
  v.onMessage = (e, fresh) => {
    if (!passes(e)) return;
    syncStrip(e, fresh); logTx(e, fresh); countStrips();
    if (!blips.has(keyOf(e.m.from))) { layout(); stat = null; }
    summarize(); loop.kick(); loop.draw();
  };
  v.onDelivery = (e, d, prev) => {
    if (!passes(e)) return;
    const p = packets.find((x) => x.did === d.id);
    if (!p) { if (e.live) spawn(e, d, !prev); else if (phaseOf(d.state) !== "land") spawn(e, d, false); }
    else if (p.ph !== "fly") settle(p, d.state, performance.now());
    if (!blips.has(keyOf(d.to))) { layout(); stat = null; }
    // The TX line was written before any recipient was known: fill its route in now.
    const tl = txRec.get(e.m.id);
    if (tl) tl.children[2].textContent = routeOf(e);
    syncStrip(e, false); logDelivery(e, d, prev); countStrips(); summarize();
    loop.kick(); loop.draw();
  };
  v.onAgents = () => { layout(); stat = null; loop.draw(); };
  v.onTheme = () => { stat = null; loop.draw(); };
  v.onVisibility = () => { if (document.hidden) loop.stop(); else { loop.kick(); loop.draw(); } };
  v.onMotion = () => { paintFreeze(); loop.kick(); loop.draw(); };
  v.inFlight = inFlight;
  v.rebuild = rebuild;
  setTab(PREFS.airTab === "log" ? "log" : "strips");
  paintFreeze();
  rebuild();
  return v;
}
`;
