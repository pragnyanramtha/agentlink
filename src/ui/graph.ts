// Web UI script, part 3: the Graph view. A hand-written force simulation (repulsion, springs,
// damping) of who talks to whom, drawn on canvas with pan, zoom and drag.
export const GRAPH = `
const WINDOWS = [["15m", "15 min", 900000], ["1h", "1 hour", 3600000], ["24h", "24 hours", 86400000], ["all", "All loaded", Infinity]];
function Graph() {
  const v = { visible: false };
  const canvas = h("canvas", { role: "img", "aria-label": "Graph of agents and the messages between them" });
  const listOl = h("ol");
  // The Most active overlay folds away; your choice is kept, else it starts folded when narrow.
  const glist = h("details", "glist", h("summary", { text: "Most active" }), h("nav", { "aria-label": "Most active agents" }, listOl));
  let autoG = false;
  glist.addEventListener("toggle", () => { if (autoG) autoG = false; else { PREFS.gList = glist.open; savePrefs(); } if (!userMoved) { fit(); loop.draw(); } });
  const legend = h("div", { class: "glegend", "aria-hidden": "true" });
  const zb = (name, label, fn) => h("button", { class: "btn sm icon", type: "button", "aria-label": label, title: label, onclick: fn }, icon(name));
  const wrap = h("div", "gwrap", canvas, glist, h("div", "gzoom", zb("plus", "Zoom in", () => zoomBy(1.25)), zb("minus", "Zoom out", () => zoomBy(0.8)), zb("fit", "Fit to view", () => { userMoved = false; fit(); loop.draw(); })), legend);
  const sum = h("span", "sum");
  const seg = h("div", { class: "seg", role: "group", "aria-label": "Time window" });
  const paintSeg = () => seg.replaceChildren(...WINDOWS.map(([id, text]) => h("button", { type: "button", "aria-pressed": String(PREFS.graphWindow === id), onclick: () => { PREFS.graphWindow = id; savePrefs(); paintSeg(); build(); } }, text)));
  paintSeg();
  const thr = h("input", { type: "checkbox", checked: !!PREFS.graphThreads, name: "threads", onchange: (e) => { PREFS.graphThreads = e.target.checked; savePrefs(); build(); } });
  v.el = h("div", "view graph", h("header", "air-head", h("h1", "vt", "Graph"), sum,
    h("div", "acts", seg, h("label", "check", thr, "Conversations"))), wrap);

  const ctx = canvas.getContext("2d");
  let W = 0, H = 0, DPR = 1, alpha = 0, extra = [], loaded = false, fitted = false;
  let nodes = new Map(), edges = [], adj = new Map();
  const cam = { x: 0, y: 0, k: 1 };
  let hover = null, drag = null, userMoved = false;
  async function load() {
    try { const r = await api("log?limit=500"); extra = r.messages.map((x) => ({ m: x.message, d: new Map(x.deliveries.map((d) => [d.id, d])) })); } catch {}
    loaded = true;
    build();
  }
  function build() {
    const span = (WINDOWS.find((w) => w[0] === PREFS.graphWindow) || WINDOWS[1])[2];
    const cut = Date.now() - span;
    const seen = new Set(), msgs = [];
    for (const e of [...S.order, ...extra]) { if (seen.has(e.m.id) || ts(e.m.createdAt) < cut) continue; seen.add(e.m.id); msgs.push(e); }
    const old = nodes;
    nodes = new Map();
    const E = new Map();
    const node = (key, spec) => {
      let n = nodes.get(key);
      if (!n) {
        const o = old.get(key);
        n = Object.assign({ key, msgs: 0, x: o ? o.x : NaN, y: o ? o.y : NaN, vx: 0, vy: 0, fx: null, fy: null }, spec);
        nodes.set(key, n);
      }
      return n;
    };
    const ensure = (addr) => {
      const a = agentOf(addr);
      if (a) return node(a.key, { type: "agent", a, label: a.short });
      return node(String(addr), { type: "person", label: String(addr) });
    };
    for (const a of S.agents) if (liveAgent(a)) node(a.key, { type: "agent", a, label: a.short });
    for (const e of msgs) {
      const f = ensure(e.m.from);
      f.msgs++;
      const tn = PREFS.graphThreads ? node("t:" + e.m.thread, { type: "thread", thread: e.m.thread, label: titleOf(e.m.thread).slice(0, 32) }) : null;
      if (tn) { tn.msgs++; link(E, f.key, tn.key); }
      for (const to of uniq([...e.d.values()].map((d) => d.to))) {
        const t = ensure(to);
        if (t === f) continue;
        t.msgs++;
        if (tn) link(E, t.key, tn.key); else link(E, f.key, t.key);
      }
    }
    edges = [...E.values()];
    adj = new Map();
    for (const ed of edges) { (adj.get(ed.a) || adj.set(ed.a, new Set()).get(ed.a)).add(ed.b); (adj.get(ed.b) || adj.set(ed.b, new Set()).get(ed.b)).add(ed.a); }
    for (const n of nodes.values()) {
      if (!Number.isNaN(n.x)) continue;
      const nb = [...(adj.get(n.key) || [])].map((k) => nodes.get(k)).find((m) => m && !Number.isNaN(m.x));
      const a = Math.random() * TAU, r = nb ? 40 : 60 + Math.random() * 140;
      n.x = (nb ? nb.x : 0) + Math.cos(a) * r; n.y = (nb ? nb.y : 0) + Math.sin(a) * r;
    }
    alpha = 1;
    for (let i = 0; i < (MOTION.matches ? 320 : old.size ? 10 : 90); i++) tick();
    if (!fitted && W) { fit(); fitted = true; }
    paintList(msgs.length);
    loop.kick(); loop.draw();
  }
  function link(E, a, b) {
    const k = a < b ? a + "|" + b : b + "|" + a;
    const ed = E.get(k) || { a, b, w: 0 };
    ed.w++;
    E.set(k, ed);
  }
  function tick() {
    const ns = [...nodes.values()];
    for (let i = 0; i < ns.length; i++) {
      const p = ns[i];
      for (let j = i + 1; j < ns.length; j++) {
        const q = ns[j];
        let dx = q.x - p.x, dy = q.y - p.y, d2 = dx * dx + dy * dy;
        if (d2 < 1) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 1; }
        if (d2 > 250000) continue;
        const f = (2600 * alpha) / d2, d = Math.sqrt(d2);
        p.vx -= (dx / d) * f; p.vy -= (dy / d) * f; q.vx += (dx / d) * f; q.vy += (dy / d) * f;
      }
    }
    for (const ed of edges) {
      const p = nodes.get(ed.a), q = nodes.get(ed.b);
      const dx = q.x - p.x, dy = q.y - p.y, d = Math.max(1, Math.hypot(dx, dy));
      const rest = 120 - Math.min(55, 14 * Math.log2(1 + ed.w));
      const f = (d - rest) * 0.04 * alpha;
      p.vx += (dx / d) * f; p.vy += (dy / d) * f; q.vx -= (dx / d) * f; q.vy -= (dy / d) * f;
    }
    for (const n of ns) {
      n.vx -= n.x * 0.01 * alpha; n.vy -= n.y * 0.01 * alpha;
      n.vx *= 0.62; n.vy *= 0.62;
      if (n.fx != null) { n.x = n.fx; n.y = n.fy; n.vx = n.vy = 0; } else { n.x += n.vx; n.y += n.vy; }
    }
    alpha = Math.max(0, alpha * 0.985 - 0.001);
  }
  const radius = (n) => (n.type === "thread" ? 4 : 5 + Math.min(12, Math.sqrt(n.msgs) * 1.6));
  const toScreen = (x, y) => ({ x: (x - cam.x) * cam.k + W / 2, y: (y - cam.y) * cam.k + H / 2 });
  const toWorld = (sx, sy) => ({ x: (sx - W / 2) / cam.k + cam.x, y: (sy - H / 2) / cam.k + cam.y });
  function fit() {
    if (!nodes.size || !W) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of nodes.values()) { x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y); x1 = Math.max(x1, n.x); y1 = Math.max(y1, n.y); }
    // Keep the drawing clear of the Most active list on the left when there is room.
    const left = W >= 640 && glist.open ? 270 : 0;
    cam.k = clamp(Math.min((W - left - 60) / Math.max(80, x1 - x0 + 100), (H - 60) / Math.max(80, y1 - y0 + 100)), 0.3, 2.2);
    cam.x = (x0 + x1) / 2 - left / 2 / cam.k; cam.y = (y0 + y1) / 2;
  }
  function zoomBy(f, sx, sy) {
    const px = sx == null ? W / 2 : sx, py = sy == null ? H / 2 : sy;
    const w = toWorld(px, py);
    cam.k = clamp(cam.k * f, 0.2, 4);
    userMoved = true;
    cam.x = w.x - (px - W / 2) / cam.k; cam.y = w.y - (py - H / 2) / cam.k;
    loop.draw();
  }
  function draw() {
    if (!W || !v.visible) return;
    if (alpha > 0.02 && !MOTION.matches) { tick(); if (!userMoved) fit(); }
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.clearRect(0, 0, W, H);
    // Hover, else the selection shared with the scope, lights a node and its neighbours.
    const sel = S.sel, selK = sel && sel.t === "a" && nodes.has(sel.key) ? sel.key : null;
    const se = sel && sel.t === "m" && S.msgs.get(sel.id), focusK = hover || selK;
    const near = focusK ? new Set([focusK, ...(adj.get(focusK) || [])]) : se ? new Set([keyOf(se.m.from), ...recipients(se).map(keyOf)]) : null;
    for (const ed of edges) {
      const p = nodes.get(ed.a), q = nodes.get(ed.b), A = toScreen(p.x, p.y), B = toScreen(q.x, q.y);
      const lit = near && near.has(ed.a) && near.has(ed.b) && (!focusK || ed.a === focusK || ed.b === focusK);
      ctx.globalAlpha = near && !lit ? 0.12 : 1;
      ctx.strokeStyle = lit ? PAL.text : rgba(PAL.muted, 0.45);
      ctx.lineWidth = Math.min(5, 0.8 + Math.log2(1 + ed.w) * 0.9) * Math.sqrt(cam.k);
      ctx.beginPath(); ctx.moveTo(A.x, A.y); ctx.lineTo(B.x, B.y); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.textAlign = "center"; ctx.textBaseline = "top";
    for (const n of nodes.values()) {
      const P = toScreen(n.x, n.y), r = radius(n) * Math.sqrt(cam.k);
      const dim = near && !near.has(n.key);
      ctx.globalAlpha = dim ? 0.18 : 1;
      if (n.type === "thread") {
        ctx.fillStyle = PAL.iris; ctx.fillRect(P.x - r, P.y - r, r * 2, r * 2);
      } else if (n.type === "person") {
        ctx.fillStyle = isYou(n.key) ? PAL.amber : PAL.glacier;
        ctx.beginPath(); ctx.moveTo(P.x, P.y - r - 1); ctx.lineTo(P.x + r + 1, P.y); ctx.lineTo(P.x, P.y + r + 1); ctx.lineTo(P.x - r - 1, P.y); ctx.closePath(); ctx.fill();
      } else {
        agentDot(ctx, P.x, P.y, r, n.a, null);
      }
      if (hover === n.key || selK === n.key) { ctx.strokeStyle = PAL.text; ctx.lineWidth = 1.5; ctx.setLineDash(selK === n.key ? [] : [3, 3]); circle(P.x, P.y, r + 7); ctx.stroke(); ctx.setLineDash([]); }
      const showLabel = cam.k > 0.55 || (near && near.has(n.key));
      if (showLabel) {
        ctx.globalAlpha = dim ? 0.18 : n.type === "thread" ? 0.8 : 1;
        ctx.font = (focusK === n.key ? "600 " : "500 ") + (n.type === "thread" ? "10px " : "11px ") + MONO;
        ctx.fillStyle = n.type === "thread" ? PAL.muted : PAL.text;
        ctx.lineJoin = "round"; ctx.lineWidth = 3; ctx.strokeStyle = PAL.bg;
        const ly = P.y + r + (n.a && n.a.state === "busy" ? 9 : 5);
        ctx.strokeText(n.label, P.x, ly);
        ctx.fillText(n.label, P.x, ly);
      }
    }
    ctx.globalAlpha = 1;
  }
  function circle(x, y, r) { ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); }
  v.busy = () => (alpha > 0.02 && !MOTION.matches) || !!drag;
  const loop = frameLoop(v, draw);
  function paintList(count) {
    const ranked = [...nodes.values()].filter((n) => n.type !== "thread").sort((a, b) => b.msgs - a.msgs).slice(0, 10);
    listOl.replaceChildren(...ranked.map((n) => h("li", null, h("button", { type: "button", "data-nav": "", "data-key": "g" + n.key,
      onclick: () => (n.type === "agent" ? select({ t: "a", key: n.a.key }) : null), ondblclick: () => (n.type === "agent" ? openTab("agent/" + n.a.key) : null),
      onmouseenter: () => { hover = n.key; loop.draw(); }, onfocus: () => { hover = n.key; loop.draw(); }, onmouseleave: () => { hover = null; loop.draw(); }, onblur: () => { hover = null; loop.draw(); } },
      n.type === "agent" ? stateDot(n.a.state) : h("span", { class: "hg", "aria-hidden": "true", text: "@" }),
      h("span", "trunc", n.label), h("span", "c", plural(n.msgs, "msg"))))));
    if (!ranked.length) listOl.append(h("li", "side-empty", "No traffic in this window."));
    const tools = uniq([...nodes.values()].filter((n) => n.type === "agent").map((n) => toolOf(n.a)));
    legend.replaceChildren(...tools.map((t) => { const s = h("span", null, h("i", "hg-dot"), (S.agents.find((a) => toolOf(a) === t) || {}).harness || t); s.firstChild.style.setProperty("--h", "var(--h-" + t + ")"); return s; }),
      ...[h("span", { text: "◇ person" }), PREFS.graphThreads ? h("span", { text: "▪ conversation" }) : null, h("span", { text: "ring: busy" }), h("span", { text: "dashed: offline" })].filter(Boolean));
    const agentsN = [...nodes.values()].filter((n) => n.type === "agent").length;
    sum.textContent = agentsN + " agents, " + edges.length + " links, " + plural(count, "message");
    canvas.setAttribute("aria-label", "Graph: " + sum.textContent + " in the selected window. The Most active list selects each agent.");
  }
  function pickNode(sx, sy) {
    let best = null, bd = Infinity;
    for (const n of nodes.values()) {
      const P = toScreen(n.x, n.y), r = radius(n) * Math.sqrt(cam.k) + 6, d = Math.hypot(P.x - sx, P.y - sy);
      if (d < r && d < bd) { bd = d; best = n; }
    }
    return best;
  }
  const local = (ev) => { const r = canvas.getBoundingClientRect(); return { x: ev.clientX - r.left, y: ev.clientY - r.top }; };
  canvas.addEventListener("pointerdown", (ev) => {
    const p = local(ev), n = pickNode(p.x, p.y);
    canvas.setPointerCapture(ev.pointerId);
    drag = { n, sx: p.x, sy: p.y, cx: cam.x, cy: cam.y, moved: false };
    if (n) { n.fx = n.x; n.fy = n.y; }
    canvas.classList.add("drag");
  });
  canvas.addEventListener("pointermove", (ev) => {
    const p = local(ev);
    if (drag) {
      if (Math.abs(p.x - drag.sx) + Math.abs(p.y - drag.sy) > 4) drag.moved = true;
      if (drag.n) { const w = toWorld(p.x, p.y); drag.n.fx = w.x; drag.n.fy = w.y; alpha = Math.max(alpha, 0.25); }
      else { cam.x = drag.cx - (p.x - drag.sx) / cam.k; cam.y = drag.cy - (p.y - drag.sy) / cam.k; userMoved = true; }
      loop.kick(); loop.draw();
      return;
    }
    const n = pickNode(p.x, p.y), k = n ? n.key : null;
    if (k !== hover) { hover = k; canvas.style.cursor = n && n.type !== "person" ? "pointer" : ""; loop.draw(); }
  });
  const end = (ev) => {
    if (!drag) return;
    const d = drag;
    drag = null;
    canvas.classList.remove("drag");
    if (d.n) { d.n.fx = null; d.n.fy = null; }
    // A click selects (the inspector shows it; the scope shares it); a double-click opens.
    if (!d.moved && ev.type === "pointerup") {
      if (d.n && d.n.type === "agent") select({ t: "a", key: d.n.a.key });
      else if (d.n && d.n.type === "thread") openTab("thread/" + d.n.thread);
      else if (!d.n && S.sel) select(null);
    }
    loop.draw();
  };
  canvas.addEventListener("pointerup", end);
  canvas.addEventListener("pointercancel", end);
  canvas.addEventListener("pointerleave", () => { if (!drag && hover) { hover = null; loop.draw(); } });
  canvas.addEventListener("wheel", (ev) => { ev.preventDefault(); const p = local(ev); zoomBy(Math.exp(-ev.deltaY * 0.0015), p.x, p.y); }, { passive: false });
  canvas.addEventListener("dblclick", (ev) => { const p = local(ev), n = pickNode(p.x, p.y); if (n && n.type === "agent") openTab("agent/" + n.a.key); else if (!n) { userMoved = false; fit(); loop.draw(); } });
  const resize = () => { const s = sizeCanvas(canvas, wrap); W = s.W; H = s.H; DPR = s.DPR; if (!fitted && nodes.size) { fit(); fitted = true; } loop.draw(); };
  const ro = new ResizeObserver(resize);
  const soon = debounce(() => build(), 600);
  v.show = () => {
    v.visible = true; ro.observe(wrap);
    const open = PREFS.gList == null ? wrap.getBoundingClientRect().width >= 900 : !!PREFS.gList;
    if (glist.open !== open) { autoG = true; glist.open = open; }
    resize(); if (!loaded) load(); else build();
  };
  v.hide = () => { v.visible = false; ro.disconnect(); loop.stop(); };
  v.destroy = () => v.hide();
  v.onMessage = () => { if (v.visible) soon(); };
  v.onAgents = () => { if (v.visible) soon(); };
  v.onTheme = () => loop.draw();
  v.onSel = () => loop.draw();
  v.onVisibility = () => { if (!document.hidden) loop.kick(); };
  return v;
}
`;
