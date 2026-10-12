// Stylesheet for the web UI (served as /app.css; no inline styles under the CSP).

// "Day shift": cool chart paper, never cream; the workspace is the lightest surface and every
// text colour (faint included) keeps 4.5:1 on all of them.
const LIGHT = `--bg:#F8F9FB;--panel:#EEF1F4;--raised:#FDFDFE;--card:#FDFDFE;--sunk:#E7EAEE;--hair:#D3D9E0;--hair-strong:#AEB7C3;--text:#141920;--muted:#47505D;--faint:#5D6573;
--amber:#945300;--amber-fill:#D98A1C;--on-amber:#1A1206;--glacier:#1B6588;--lichen:#256C45;--ember:#BB3527;--iris:#5641C4;
--k-info:#576071;--k-ask:#945300;--k-request:#5641C4;--k-handoff:#A3307F;--k-review_request:#1B6588;--k-review_result:#6E6300;--k-reply:#256C45;--k-ack:#386950;
--h-claude:#954F2B;--h-codex:#1C6890;--h-opencode:#28704A;--h-gemini:#5B47C9;--h-copilot:#3A4150;--h-cursor:#A33E74;--h-kiro:#116E66;--h-devin:#4F6478;--h-agy:#4D5FB0;--h-worker:#6A5A3E;--h-generic:#5F6775;
--scope-bg:#F2F4F7;--scope-ring:#CED5DE;--sweep:#1B6588;--tint:color-mix(in srgb,var(--amber) 9%,transparent);
--shadow:0 18px 40px -18px rgb(40 52 70 / .35),0 2px 6px -2px rgb(40 52 70 / .12);--scrim:rgb(30 38 50 / .38);color-scheme:light`;

const SOURCE = `
:root{
--font-mono:"JetBrains Mono","Berkeley Mono","IBM Plex Mono","Iosevka Term","Cascadia Code","SF Mono",ui-monospace,Menlo,Consolas,"Liberation Mono",monospace;
--font-ui:"IBM Plex Sans","Segoe UI Variable Text","Segoe UI",system-ui,-apple-system,"Noto Sans",Ubuntu,Cantarell,sans-serif;
--r-chip:2px;--r-ctl:4px;--r-panel:6px;
--ease-out:cubic-bezier(.16,1,.3,1);--ease-in:cubic-bezier(.7,0,.84,0);--d1:120ms;--d2:200ms;--d3:320ms;
--z-drawer:20;--z-overlay:30;--z-toast:40;
--ribbon:46px;--explorer-w:264px;--inspector-w:304px;--tabbar:38px;--status:26px;
--bg:#0E1116;--panel:#151A21;--raised:#1C222C;--card:#151A21;--sunk:#11151B;--hair:#283041;--hair-strong:#3A4458;--text:#E7E4DC;--muted:#9AA1B0;--faint:#838A9C;
--amber:#F0A43A;--amber-fill:#F0A43A;--on-amber:#1A1206;--glacier:#7CC4E4;--lichen:#7FCB9B;--ember:#F06A5B;--iris:#9B8CF2;
--k-info:#A9B0BE;--k-ask:#F0A43A;--k-request:#9B8CF2;--k-handoff:#E07BC8;--k-review_request:#7CC4E4;--k-review_result:#E3D35C;--k-reply:#7FCB9B;--k-ack:#6FAE8A;
--h-claude:#D9A07E;--h-codex:#7CC4E4;--h-opencode:#7FCB9B;--h-gemini:#9B8CF2;--h-copilot:#D8D3C6;--h-cursor:#E58FB8;--h-kiro:#6FD0C5;--h-devin:#9FB3C8;--h-agy:#8EA2F0;--h-worker:#B7A27E;--h-generic:#9AA1B0;
--scope-bg:#0A0D11;--scope-ring:#1F2633;--sweep:#7CC4E4;--tint:color-mix(in srgb,var(--amber) 7%,transparent);
--shadow:0 22px 48px -20px rgb(2 4 8 / .8),0 2px 8px -2px rgb(2 4 8 / .5);--scrim:rgb(4 6 10 / .6);color-scheme:dark}
:root[data-theme=light]{${LIGHT}}
@media (prefers-color-scheme:light){:root[data-theme=system]{${LIGHT}}}
*,*::before,*::after{box-sizing:border-box}
[hidden]{display:none!important}
html,body{height:100%;margin:0}
html{-webkit-text-size-adjust:100%;-webkit-tap-highlight-color:transparent}
@media (pointer:fine){html{overscroll-behavior:none}}
body{background:var(--bg);color:var(--text);font:13px/1.5 var(--font-ui);-webkit-font-smoothing:antialiased;overflow:hidden;touch-action:manipulation}
button,input,select,textarea{font:inherit;color:inherit}
*{scrollbar-width:thin;scrollbar-color:var(--hair-strong) transparent}
a{color:var(--glacier);text-decoration:none}
a:hover{text-decoration:underline;text-underline-offset:3px}
:focus-visible{outline:2px solid var(--amber);outline-offset:2px}
::selection{background:color-mix(in srgb,var(--amber) 35%,transparent)}
.mono,code,kbd,.m{font-family:var(--font-mono);font-variant-numeric:tabular-nums;font-feature-settings:"zero" 1}
.muted{color:var(--muted)}.small{font-size:12px}
.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.trunc{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.grow{flex:1;min-width:0}
.skip{position:fixed;left:8px;top:-60px;z-index:var(--z-toast);background:var(--amber-fill);color:var(--on-amber);padding:8px 12px;border-radius:var(--r-ctl);font-weight:600}
.skip:focus{top:8px}
svg.i{width:18px;height:18px;flex:none;fill:none;stroke:currentColor;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}
.small svg.i,.btn.sm svg.i{width:15px;height:15px}

/* ---------------------------------------------------------------- shell */
.app{display:grid;height:100vh;height:100dvh;grid-template-columns:var(--ribbon) var(--explorer-w) minmax(0,1fr) var(--inspector-w);grid-template-rows:minmax(0,1fr) var(--status);grid-template-areas:"ribbon explorer ws inspector" "status status status status"}
.app.no-explorer{--explorer-w:0px}.app.no-explorer .explorer{display:none}
.app.no-inspector{--inspector-w:0px}.app.no-inspector .inspector{display:none}
.ribbon{grid-area:ribbon;display:flex;flex-direction:column;align-items:center;gap:4px;padding:8px 0;background:var(--sunk);border-right:1px solid var(--hair);z-index:2}
.brand{display:grid;place-items:center;width:34px;height:34px;margin-bottom:8px;color:var(--amber)}
.brand svg{width:26px;height:26px}
.brand:hover{text-decoration:none}
.rb{position:relative;display:grid;place-items:center;width:34px;height:34px;border:0;border-radius:var(--r-ctl);background:none;color:var(--muted);cursor:pointer;transition:color var(--d1) var(--ease-out),background-color var(--d1) var(--ease-out)}
.rb:hover{color:var(--text);background:var(--raised);text-decoration:none}
.rb:active{transform:translateY(1px)}
.rb[aria-current=page]{color:var(--amber);background:var(--raised)}
.rb[aria-current=page]::before{content:"";position:absolute;left:-6px;top:8px;bottom:8px;width:2px;border-radius:2px;background:var(--amber)}
.rb-l{position:absolute;left:calc(100% + 10px);top:50%;transform:translate(-4px,-50%);padding:3px 8px;border-radius:var(--r-chip);background:var(--text);color:var(--bg);font:500 12px/1.4 var(--font-ui);white-space:nowrap;pointer-events:none;opacity:0;transition:opacity var(--d1) var(--ease-out),transform var(--d1) var(--ease-out);z-index:var(--z-overlay)}
.rb:hover .rb-l,.rb:focus-visible .rb-l{opacity:1;transform:translate(0,-50%)}
.rb-gap{flex:1}
.badge-n{position:absolute;top:1px;right:0;min-width:16px;height:16px;padding:0 4px;border-radius:8px;background:var(--raised);border:1px solid var(--hair-strong);color:var(--text);font:600 10px/14px var(--font-mono);text-align:center}
.badge-n.hot{background:var(--ember);border-color:var(--ember);color:var(--bg)}

.explorer,.inspector{display:flex;flex-direction:column;min-height:0;background:var(--panel)}
.explorer{grid-area:explorer;border-right:1px solid var(--hair)}
.inspector{grid-area:inspector;border-left:1px solid var(--hair)}
.side-h{display:flex;align-items:center;gap:6px;height:var(--tabbar);padding:0 8px 0 14px;border-bottom:1px solid var(--hair);flex:none}
.side-h h2{margin:0;font:600 11px/1 var(--font-mono);letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
.side-b{flex:1;overflow:auto;overscroll-behavior:contain;padding:8px 0 16px}
.filter{margin:4px 10px 8px;display:block}
.filter input{width:100%;height:28px;padding:0 8px;border:1px solid var(--hair);border-radius:var(--r-ctl);background:var(--sunk);font-size:12px}
.filter input::placeholder{color:var(--faint)}
.grp{margin:6px 0 2px;padding:0 14px;display:flex;align-items:center;gap:6px;font:600 10.5px/24px var(--font-mono);letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
.grp .seg{margin-left:auto}
.tree{list-style:none;margin:0;padding:0}
.tree details>summary{list-style:none;display:flex;align-items:center;gap:6px;min-height:28px;padding:0 10px 0 12px;cursor:pointer;font:500 12px/1.3 var(--font-mono);color:var(--text)}
.tree details>summary::-webkit-details-marker{display:none}
.tree summary .chev{width:12px;height:12px;transition:transform var(--d1) var(--ease-out);color:var(--muted)}
.tree details[open]>summary .chev{transform:rotate(90deg)}
.tree summary:hover,.ti:hover{background:var(--raised)}
.ti{display:flex;align-items:center;gap:8px;width:100%;min-height:28px;padding:3px 10px 3px 30px;border:0;background:none;text-align:left;cursor:pointer;color:var(--text);font-size:12.5px}
.ti:hover{text-decoration:none}
.ti.on{background:var(--raised);box-shadow:inset 2px 0 0 var(--amber)}
.ti .sub{color:var(--muted);font:11px var(--font-mono)}
.ti .n{margin-left:auto;font:600 10.5px/1 var(--font-mono);color:var(--amber)}
.ti.conv{padding-left:14px;align-items:flex-start;flex-direction:column;gap:1px}
.ti.conv .ln{display:flex;align-items:center;gap:6px;width:100%;min-width:0}
.ti.conv .t{font-weight:500}
.ti.conv.unread .t{font-weight:650}
.side-empty{padding:6px 14px;color:var(--muted);font-size:12px}
.cgrp{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:start}
.xn{margin:5px 8px 0 0;height:22px;padding:0 6px;border:1px solid var(--hair-strong);border-radius:var(--r-chip);background:none;color:var(--muted);font:600 10.5px/1 var(--font-mono);cursor:pointer}
.xn:hover,.xn[aria-expanded=true]{color:var(--text);background:var(--raised)}
.csub{grid-column:1/-1}
.csub .ti.conv{padding-left:28px}
.smk{flex:none;width:12px;font-size:10px;text-align:center}
.smk.held{color:var(--ember)}.smk.you{color:var(--amber)}.smk.await{color:var(--glacier)}

/* state glyphs: shape + color, never color alone */
.st{display:inline-block;width:9px;height:9px;flex:none;border-radius:50%;border:1.5px solid var(--faint)}
.st.busy{position:relative;background:var(--lichen);border-color:var(--lichen)}
.st.busy::after{content:"";position:absolute;inset:-4.5px;border:1.5px solid var(--text);border-radius:50%;animation:busy 1.8s ease-in-out infinite}
.st.idle{background:var(--lichen);border-color:var(--lichen)}
.st.offline,.st.stale{background:transparent;border-style:dashed}
.st.live{background:var(--lichen);border-color:var(--lichen)}
.st.connecting{background:var(--amber);border-color:var(--amber)}
.st.down{background:var(--ember);border-color:var(--ember)}
.hg{display:inline-grid;place-items:center;width:16px;height:16px;flex:none;border-radius:3px;border:1px solid currentColor;font:700 9.5px/1 var(--font-mono);color:var(--h,var(--h-generic))}


.workspace{grid-area:ws;display:flex;flex-direction:column;min-width:0;min-height:0;background:var(--bg)}
.workspace:focus{outline:none}
.tabbar{display:flex;align-items:stretch;height:var(--tabbar);flex:none;background:var(--sunk);border-bottom:1px solid var(--hair)}
.tabbar>.tb{flex:none;align-self:center;margin:0 4px}
.tabs{display:flex;align-items:stretch;min-width:0;flex:1;overflow-x:auto;scrollbar-width:none}
.tabs::-webkit-scrollbar{display:none}
.tabs.fl{mask-image:linear-gradient(90deg,transparent,#000 32px)}
.tabs.fr{mask-image:linear-gradient(90deg,#000 calc(100% - 32px),transparent)}
.tabs.fl.fr{mask-image:linear-gradient(90deg,transparent,#000 32px,#000 calc(100% - 32px),transparent)}
.tabmenu li{display:flex;align-items:center;gap:4px}
.tabmenu button:first-child{flex:1;width:auto;margin:0;min-width:0}
.tabmenu button:first-child>span:not(.c){flex:0 1 auto;max-width:60%}
.tabmenu button .c{flex:1 1 0;margin-left:6px;font:12.5px var(--font-ui)}
.tabmenu button[aria-current]{background:var(--raised);box-shadow:inset 2px 0 0 var(--amber)}
.tabmenu .x{flex:none;width:30px;margin:0;justify-content:center}
.tab{position:relative;display:flex;align-items:center;flex:0 1 200px;min-width:136px;max-width:220px;border-right:1px solid var(--hair);color:var(--muted)}
.tab>.tab-b{display:flex;align-items:center;gap:7px;min-width:0;flex:1;height:100%;padding:0 4px 0 12px;border:0;background:none;cursor:pointer;font:500 12.5px/1 var(--font-ui);color:inherit;text-align:left}
.kc{font:700 10.5px/1 var(--font-mono);letter-spacing:.04em;color:var(--k)}
.tab>.tab-b:focus-visible{outline-offset:-3px}
.tab .x{display:grid;place-items:center;width:24px;height:24px;margin-right:4px;border:0;border-radius:var(--r-ctl);background:none;color:var(--muted);cursor:pointer;opacity:0;transition:opacity var(--d1) var(--ease-out)}
.tab .x svg.i{width:13px;height:13px}
.tab:hover .x,.tab .x:focus-visible,.tab.sel .x{opacity:1}
.tab .x:hover{background:var(--raised);color:var(--text)}
.tab:hover{color:var(--text);background:color-mix(in srgb,var(--raised) 50%,transparent)}
.tab.sel{background:var(--bg);color:var(--text)}
.tab.sel::after{content:"";position:absolute;left:0;right:0;top:0;height:2px;background:var(--amber)}
.tab.other{color:var(--text)}
.tab.other::after{content:"";position:absolute;left:0;right:0;top:0;height:2px;background:var(--hair-strong)}
.tab .hg{width:14px;height:14px;font-size:8.5px}
.tb{display:grid;place-items:center;width:30px;height:30px;border:0;border-radius:var(--r-ctl);background:none;color:var(--muted);cursor:pointer}
.tb:hover{background:var(--raised);color:var(--text)}
.tb[aria-pressed=true]{color:var(--text)}
.tb.mob{display:none}
.panes{position:relative;flex:1;min-height:0;display:grid;grid-template-columns:minmax(0,1fr)}
.panes.split{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}
.pane{position:relative;min-width:0;min-height:0;container-type:inline-size;container-name:pane}
.panes.split .pane+.pane{border-left:1px solid var(--hair)}
.panes.split .pane.focus{box-shadow:inset 0 2px 0 var(--amber)}
.view{position:absolute;inset:0;overflow:auto;overscroll-behavior:contain}
.page{max-width:1080px;margin:0 auto;padding:24px 28px 56px}
.page.narrow{max-width:820px}

.statusbar{grid-area:status;display:flex;align-items:center;gap:2px;padding:0 6px;background:var(--sunk);border-top:1px solid var(--hair);font:11px/1 var(--font-mono);color:var(--muted);white-space:nowrap;overflow:hidden}
.sb{display:inline-flex;align-items:center;gap:6px;height:22px;padding:0 8px;border:0;border-radius:var(--r-chip);background:none;color:inherit;font:inherit}
button.sb{cursor:pointer}
button.sb:hover{background:var(--raised);color:var(--text)}
.sb b{color:var(--text);font-weight:600}
.sb.hot b,.sb.hot{color:var(--ember)}
.sb.warn{color:var(--amber)}
.sb .st{width:7px;height:7px}
.sb-gap{flex:1}
.clock{color:var(--text);letter-spacing:.04em}

.banner{display:flex;align-items:center;gap:12px;padding:8px 14px;background:color-mix(in srgb,var(--ember) 14%,var(--panel));border-bottom:1px solid color-mix(in srgb,var(--ember) 40%,transparent);font:13px var(--font-ui);color:var(--text)}
.banner.calm{background:color-mix(in srgb,var(--amber) 12%,var(--panel));border-color:color-mix(in srgb,var(--amber) 40%,transparent)}
.scrim{position:fixed;inset:0;background:var(--scrim);z-index:calc(var(--z-drawer) - 1)}

/* ---------------------------------------------------------------- controls */
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:30px;padding:0 12px;border:1px solid var(--hair-strong);border-radius:var(--r-ctl);background:var(--raised);color:var(--text);font:500 12.5px/1 var(--font-ui);cursor:pointer;white-space:nowrap;transition:background-color var(--d1) var(--ease-out),border-color var(--d1) var(--ease-out),transform var(--d1) var(--ease-out)}
.btn:hover{border-color:var(--muted);text-decoration:none}
.btn:active{transform:translateY(1px)}
.btn:disabled{opacity:.45;cursor:not-allowed;transform:none}
.btn.primary{background:var(--amber-fill);border-color:var(--amber-fill);color:var(--on-amber);font-weight:600}
.btn.primary:hover{background:color-mix(in srgb,var(--amber-fill) 88%,var(--text))}
.btn.danger{color:var(--ember);border-color:color-mix(in srgb,var(--ember) 55%,transparent);background:transparent}
.btn.danger:hover{background:color-mix(in srgb,var(--ember) 12%,transparent)}
.btn.ghost{border-color:transparent;background:transparent;color:var(--muted)}
.btn.ghost:hover{color:var(--text);background:var(--raised)}
.btn.sm{height:26px;padding:0 9px;font-size:12px}
.btn.icon{width:30px;padding:0}
.btn.sm.icon{width:26px}
input[type=text],input[type=search],input:not([type]),select,textarea{border:1px solid var(--hair-strong);border-radius:var(--r-ctl);background:var(--sunk);color:var(--text)}
input[type=text],input[type=search],input:not([type]),select{height:30px;padding:0 9px}
select{padding-right:6px;background-color:var(--sunk);color:var(--text)}
textarea{width:100%;min-height:96px;padding:9px 10px;resize:vertical;line-height:1.5}
input::placeholder,textarea::placeholder{color:var(--faint)}
input:focus-visible,select:focus-visible,textarea:focus-visible{outline:2px solid var(--amber);outline-offset:0;border-color:transparent}
input[type=checkbox]{width:16px;height:16px;margin:0;accent-color:var(--amber-fill)}
.check{display:inline-flex;align-items:center;gap:7px;min-height:28px;cursor:pointer;font-size:12.5px;color:var(--muted)}
.check:hover{color:var(--text)}
.field{display:flex;flex-direction:column;gap:5px;min-width:0}
.field>span{font:600 10.5px/1 var(--font-mono);letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
.seg{display:inline-flex;border:1px solid var(--hair-strong);border-radius:var(--r-ctl);overflow:hidden;flex:none}
.seg button{height:24px;padding:0 9px;border:0;background:transparent;color:var(--muted);cursor:pointer;font:500 12px/1 var(--font-ui);white-space:nowrap}
.seg button+button{border-left:1px solid var(--hair-strong)}
.seg button[aria-pressed=true]{background:var(--raised);color:var(--text);font-weight:650;box-shadow:inset 0 -2px 0 var(--text)}
kbd{display:inline-block;min-width:20px;padding:2px 6px;border:1px solid var(--hair-strong);border-bottom-width:2px;border-radius:var(--r-chip);background:var(--raised);font-size:11px;text-align:center;color:var(--text)}
.kcode{display:inline-grid;place-items:center;min-width:34px;height:20px;padding:0 5px;border:1px solid currentColor;border-radius:var(--r-chip);font:700 10.5px/1 var(--font-mono);letter-spacing:.06em}
.chip{display:inline-flex;align-items:center;gap:5px;max-width:100%;height:22px;padding:0 7px;border:1px solid var(--hair);border-radius:var(--r-chip);background:var(--sunk);font:11px/1 var(--font-mono);color:var(--muted);white-space:nowrap}
.chip>span{overflow:hidden;text-overflow:ellipsis}
.chip.s-delivered,.chip.s-seen,.chip.s-acked,.chip.s-replied{color:var(--lichen);border-color:color-mix(in srgb,var(--lichen) 40%,transparent)}
.chip.s-queued,.chip.s-sent{color:var(--glacier);border-color:color-mix(in srgb,var(--glacier) 40%,transparent)}
.chip.s-held,.chip.s-refused,.chip.s-failed,.chip.s-expired{color:var(--ember);border-color:color-mix(in srgb,var(--ember) 45%,transparent)}
.chips{display:flex;flex-wrap:wrap;gap:5px;align-items:center;min-width:0}
.k-info{--k:var(--k-info)}.k-ask{--k:var(--k-ask)}.k-request{--k:var(--k-request)}.k-handoff{--k:var(--k-handoff)}.k-review_request{--k:var(--k-review_request)}.k-review_result{--k:var(--k-review_result)}.k-reply{--k:var(--k-reply)}.k-ack{--k:var(--k-ack)}
.kcode{color:var(--k,var(--muted))}

.vh{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:18px}
.vh h1,.vt{margin:0;font:650 18px/1.2 var(--font-ui);letter-spacing:-.01em;text-wrap:balance}
.vh .sub{color:var(--muted);font-size:12.5px}
.vh .acts{margin-left:auto;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
h2.sec{margin:26px 0 10px;font:600 12px/1.2 var(--font-mono);letter-spacing:.06em;text-transform:uppercase;color:var(--muted);display:flex;align-items:center;gap:8px}
h2.sec::after{content:"";flex:1;height:1px;background:var(--hair)}
.empty{display:grid;justify-items:start;gap:6px;padding:22px 20px;border:1px dashed var(--hair-strong);border-radius:var(--r-panel);color:var(--muted);max-width:60ch}
.empty strong{color:var(--text);font:600 14px var(--font-ui)}
.empty code{padding:1px 5px;border-radius:var(--r-chip);background:var(--sunk);color:var(--text)}
.skel{display:grid;gap:8px}
.skel i{display:block;height:46px;border-radius:var(--r-chip);background:linear-gradient(90deg,var(--panel),var(--raised),var(--panel));background-size:200% 100%;animation:shimmer 1.4s linear infinite}

/* ---------------------------------------------------------------- airspace */
.air{display:grid;grid-template-columns:minmax(0,1fr) clamp(320px,36%,460px);grid-template-rows:auto minmax(0,1fr) minmax(120px,26%);grid-template-areas:"head strips" "scope strips" "log strips";overflow:hidden}
.air-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:12px 16px 8px}
.air>.air-head{grid-area:head}
.air-head .sum{color:var(--muted);font:11.5px var(--font-mono)}
.air-head .acts{margin-left:auto;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.air-head select{height:26px;font-size:12px;max-width:170px}
.scope{grid-area:scope;display:grid;grid-template-rows:minmax(0,1fr) auto;min-height:240px;margin:0 12px;border:1px solid var(--hair);border-radius:var(--r-panel);background:var(--scope-bg);overflow:hidden}
.scope-c{position:relative;min-height:0}
.scope canvas{position:absolute;inset:0;width:100%;height:100%;touch-action:none}
.scope-legend{display:flex;flex-wrap:wrap;gap:2px;padding:0 6px 6px}
.scope-legend button{display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 7px;border:1px solid transparent;border-radius:var(--r-chip);background:color-mix(in srgb,var(--scope-bg) 85%,transparent);color:var(--muted);font:10.5px/1 var(--font-mono);cursor:pointer}
.scope-legend button:hover{color:var(--text);border-color:var(--hair-strong)}
.scope-legend button:not(.sec)[aria-pressed=false]{text-decoration:line-through}
.scope-legend button[aria-pressed=false] i{background:transparent;box-shadow:inset 0 0 0 1.5px var(--k)}
.scope-legend .sec{margin-left:6px}
.scope-legend .sec[aria-pressed=true]{color:var(--glacier);border-color:var(--glacier)}
.scope-legend i{width:8px;height:8px;border-radius:50%;background:var(--k)}
.scope-tip{position:absolute;left:0;top:0;z-index:2;min-width:180px;max-width:280px;padding:8px 10px;border:1px solid var(--hair-strong);border-radius:var(--r-ctl);background:var(--card);box-shadow:var(--shadow);font:11.5px/1.45 var(--font-mono);pointer-events:none}
.scope-tip b{display:block;color:var(--text);font-size:12.5px}
.scope-tip span{display:block;color:var(--muted)}
.air-log{grid-area:log;display:flex;flex-direction:column;min-height:0;margin:10px 12px 12px;border:1px solid var(--hair);border-radius:var(--r-panel);background:var(--sunk);container:log/inline-size}
.pnl-h{display:flex;align-items:center;gap:8px;height:30px;flex:none;padding:0 10px;border-bottom:1px solid var(--hair);font:600 10.5px/1 var(--font-mono);letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
.pnl-h h2{margin:0;font:inherit}
.pnl-h .n{color:var(--text)}
.txlog{flex:1;margin:0;padding:4px 0;list-style:none;overflow:auto;font:11.5px/20px var(--font-mono)}
.tx{display:grid;grid-template-columns:8.5ch 4.5ch minmax(8ch,max-content) 4.5ch minmax(0,1fr);gap:10px;padding:0 10px;white-space:nowrap}
.tx:hover{background:var(--raised)}
.tx>*{overflow:hidden;text-overflow:ellipsis}
.tx time{color:var(--faint)}
@container log (max-width:560px){.tx{grid-template-columns:8.5ch 4.5ch minmax(0,1fr);row-gap:0;padding-bottom:3px}.tx .id{display:none}.tx .p{grid-column:2/-1;white-space:normal;line-height:1.4}}
.tx .c{font-weight:700;color:var(--k,var(--muted))}
.tx .r{color:var(--text)}
.tx .id{color:var(--muted)}
.tx .p{color:var(--muted)}
.tx.ok .c{color:var(--lichen)}.tx.warn .c{color:var(--amber)}.tx.bad .c{color:var(--ember)}
.tx.new{animation:txin var(--d3) var(--ease-out)}
.air-strips{grid-area:strips;display:flex;flex-direction:column;min-height:0;border-left:1px solid var(--hair);background:var(--panel)}
.air-strips .pnl-h{height:var(--tabbar)}
.strip-scroll{flex:1;overflow:auto;padding:8px 10px 16px;overscroll-behavior:contain}
.strip-grp{display:flex;align-items:center;gap:8px;margin:10px 2px 6px;font:600 10.5px/1 var(--font-mono);letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
.strip-grp:first-child{margin-top:2px}
.strip-grp::after{content:"";flex:1;height:1px;background:var(--hair)}
.strips{list-style:none;margin:0;padding:0;display:grid;gap:6px}
.strip{position:relative;display:grid;grid-template-columns:minmax(0,1fr);border:1px solid var(--hair);border-left:4px solid var(--k);border-radius:var(--r-chip);background:var(--raised);content-visibility:auto;contain-intrinsic-size:auto 86px;transition:border-color var(--d1) var(--ease-out)}
.strip:hover{border-color:var(--hair-strong);border-left-color:var(--k)}
.strip.enter{animation:stripin var(--d3) var(--ease-out)}
.strip-a{display:grid;grid-template-columns:minmax(0,1fr) auto;column-gap:8px;row-gap:3px;padding:7px 10px 7px 9px;color:var(--text);min-width:0}
.strip-a:hover{text-decoration:none}
.strip-a:focus-visible{outline-offset:-2px}
.cs{font:700 12.5px/1.2 var(--font-mono);letter-spacing:.03em;color:var(--text)}
.cs b{color:var(--k)}
.strip.sel{box-shadow:0 0 0 1.5px var(--text)}
.strip.off{display:none}
.strip-act{display:flex;padding:0 10px 8px 9px}
.age{font:600 10.5px/1 var(--font-mono);padding:3px 6px;border:1px solid var(--hair-strong);border-radius:var(--r-chip);color:var(--muted);white-space:nowrap;align-self:start}
.age.a2{color:var(--ember);border-color:color-mix(in srgb,var(--ember) 55%,transparent)}
.age.a3{color:var(--bg);background:var(--ember);border-color:var(--ember)}
.filt{margin-left:auto;text-transform:none;letter-spacing:0;font-weight:500;color:var(--text)}
.air-tabs{display:none}
.strip-t{font:11px/1.2 var(--font-mono);color:var(--faint)}
.route{grid-column:1/-1;display:flex;align-items:center;gap:6px;min-width:0;font:600 12px/1.25 var(--font-mono)}
.route .to{color:var(--muted)}
.route .arr{color:var(--k);flex:none}
.prev{grid-column:1/-1;font-size:12px;line-height:1.35;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.track{grid-column:1/-1;display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:2px;margin-top:4px}
.ph{display:flex;flex-direction:column;gap:1px;padding:3px 4px 2px;border-top:2px solid var(--hair);font:600 9.5px/1.15 var(--font-mono);letter-spacing:.05em;color:var(--faint);min-width:0}
.ph em{font-style:normal;font-weight:400;letter-spacing:0;font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ph.done{border-top-color:color-mix(in srgb,var(--lichen) 70%,transparent);color:var(--lichen)}
.ph.done em{color:var(--muted)}
.ph.now{border-top-color:var(--glacier);color:var(--glacier)}
.ph.now em{color:var(--glacier)}
.ph.bad{border-top-color:var(--ember);color:var(--ember)}
.ph.na{opacity:.5}
.strip.landed{background:var(--panel)}
.strip.landed .route,.strip.landed .cs{color:var(--muted)}
.strip.held{border-color:color-mix(in srgb,var(--ember) 55%,transparent);border-left-color:var(--ember);background:color-mix(in srgb,var(--ember) 6%,var(--raised))}
.strip.diverted{border-left-color:var(--ember)}
.strip .flag{font:700 9.5px/1 var(--font-mono);letter-spacing:.06em;color:var(--ember)}

/* ---------------------------------------------------------------- graph */
.graph{display:grid;grid-template-rows:auto minmax(0,1fr);overflow:hidden}
.graph .air-head{padding:12px 16px 8px}
.gwrap{position:relative;margin:0 12px 12px;border:1px solid var(--hair);border-radius:var(--r-panel);background:var(--scope-bg);overflow:hidden;min-height:260px}
.gwrap canvas{position:absolute;inset:0;width:100%;height:100%;touch-action:none;cursor:grab}
.gwrap canvas.drag{cursor:grabbing}
.gzoom{position:absolute;right:10px;top:10px;display:flex;flex-direction:column;gap:4px}
.gzoom .btn{background:var(--panel)}
.glist{position:absolute;left:10px;top:10px;width:min(250px,calc(100% - 70px));max-height:calc(100% - 60px);overflow:auto;padding:6px;border:1px solid var(--hair);border-radius:var(--r-ctl);background:color-mix(in srgb,var(--panel) 92%,transparent)}
.glist summary{margin:2px 4px;min-height:22px;display:flex;align-items:center;cursor:pointer;font:600 10.5px/1 var(--font-mono);letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
.glist[open] summary{margin-bottom:6px}
.glist ol{list-style:none;margin:0;padding:0}
.glist button{display:flex;align-items:center;gap:7px;width:100%;min-height:26px;padding:2px 6px;border:0;border-radius:var(--r-chip);background:none;cursor:pointer;text-align:left;font:12px var(--font-mono)}
.glist button:hover,.glist button.hot{background:var(--raised)}
.glist .c{margin-left:auto;color:var(--muted);font-size:11px}
.glegend{position:absolute;left:10px;bottom:8px;display:flex;flex-wrap:wrap;gap:4px 12px;max-width:calc(100% - 20px);font:10.5px var(--font-mono);color:var(--muted);pointer-events:none}
.glegend span{display:inline-flex;align-items:center;gap:5px}
.glegend i{width:9px;height:9px;border-radius:50%;background:var(--h)}

/* ---------------------------------------------------------------- lists */
.list{display:grid;gap:1px;border:1px solid var(--hair);border-radius:var(--r-panel);background:var(--hair);overflow:hidden}
.row{display:grid;gap:4px;padding:11px 14px;background:var(--card);color:var(--text);min-width:0}
a.row:hover{background:var(--raised);text-decoration:none}
.row:focus-visible{outline-offset:-2px}
.line{display:flex;align-items:center;gap:8px;min-width:0}
.subj{font-weight:600;font-size:13.5px}
.ago{color:var(--muted);font:11px var(--font-mono);white-space:nowrap}
.who{font:600 12px var(--font-mono);color:var(--text)}
.pill{display:inline-flex;align-items:center;height:20px;padding:0 7px;border-radius:var(--r-chip);font:600 10.5px/1 var(--font-mono);letter-spacing:.04em;border:1px solid currentColor;white-space:nowrap}
.pill.you{color:var(--amber)}.pill.await{color:var(--glacier)}.pill.done{color:var(--lichen)}.pill.unread{color:var(--glacier)}.pill.held{color:var(--ember)}.pill.muted{color:var(--muted)}
mark{background:color-mix(in srgb,var(--amber) 30%,transparent);color:var(--text);border-radius:2px;padding:0 1px}
.filters{display:grid;grid-template-columns:2fr repeat(4,minmax(0,1fr));gap:10px;margin-bottom:16px}
.filters input[type=search]{font-size:14px;height:34px}
.more{display:flex;justify-content:center;margin-top:14px}
table.tbl{width:100%;border-collapse:collapse;font-size:12.5px}
.tbl th{text-align:left;padding:7px 10px;border-bottom:1px solid var(--hair-strong);font:600 10.5px/1 var(--font-mono);letter-spacing:.06em;text-transform:uppercase;color:var(--muted);white-space:nowrap}
.tbl td{padding:8px 10px;border-bottom:1px solid var(--hair);vertical-align:middle}
.tbl tr:hover td{background:color-mix(in srgb,var(--raised) 60%,transparent)}
.tbl .nm{display:flex;align-items:center;gap:8px;font:600 12.5px var(--font-mono);white-space:nowrap}
.tbl .nm a{color:var(--text)}
.tbl .acts{display:flex;gap:6px;justify-content:flex-end}
.tbl td.m{color:var(--muted);font-size:12px;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* ---------------------------------------------------------------- note */
.note-title{margin:4px 0 14px;font:650 22px/1.3 var(--font-ui);letter-spacing:-.015em;text-wrap:balance;overflow-wrap:anywhere}
.props{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:0;margin:0 0 26px;padding:6px 0;border-top:1px solid var(--hair);border-bottom:1px solid var(--hair);font-size:12.5px}
.props dt{display:flex;align-items:center;gap:7px;padding:5px 18px 5px 0;color:var(--muted);font:11.5px var(--font-mono)}
.props dt svg.i{width:14px;height:14px}
.props dd{margin:0;padding:5px 0;min-width:0;overflow-wrap:anywhere}
.callouts{display:grid;gap:12px}
.callout{position:relative;border-left:3px solid var(--k);border-radius:0 var(--r-ctl) var(--r-ctl) 0;background:color-mix(in srgb,var(--k) 7%,var(--card));padding:10px 14px 10px 14px;scroll-margin:24px}
.callout:focus-visible{outline-offset:2px}
.callout.mine{background:color-mix(in srgb,var(--k) 4%,var(--sunk))}
.callout.target{box-shadow:0 0 0 1px color-mix(in srgb,var(--amber) 55%,transparent)}
.co-h{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
.co-h .kcode{background:color-mix(in srgb,var(--k) 12%,transparent)}
.co-h .to{color:var(--muted);font:12px var(--font-mono)}
.co-h .acts{margin-left:auto;display:flex;gap:4px}
.co-id{font:10.5px var(--font-mono);color:var(--faint)}
.co-re{display:flex;align-items:center;gap:6px;width:100%;margin:8px 0 0;padding:5px 8px;border:1px solid var(--hair);border-radius:var(--r-chip);background:var(--sunk);color:var(--glacier);font:11.5px var(--font-mono);text-align:left;cursor:pointer;min-width:0}
.co-re:hover{border-color:var(--glacier)}
.co-re span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.co-body{margin-top:8px;font-size:14px;line-height:1.6;max-width:76ch;overflow-wrap:anywhere}
.co-body p{margin:0 0 8px;white-space:pre-wrap}
.co-body p:last-child{margin-bottom:0}
.co-body code{padding:1px 4px;border-radius:var(--r-chip);background:var(--sunk);font-size:12.5px}
.co-body pre{margin:8px 0;padding:10px 12px;border:1px solid var(--hair);border-radius:var(--r-ctl);background:var(--sunk);overflow:auto;font:12px/1.5 var(--font-mono)}
.co-f{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:10px}
.composer{position:sticky;bottom:0;margin-top:24px;padding:12px;border:1px solid var(--hair-strong);border-radius:var(--r-panel);background:var(--card);box-shadow:var(--shadow);display:grid;gap:8px}
.composer .replying{display:flex;align-items:center;gap:8px;min-width:0;font-size:12.5px;color:var(--muted)}
.composer .replying .warn{flex:none;color:var(--ember)}
.composer textarea{min-height:72px}
.composer .bar{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.composer .hint{font:11px var(--font-mono);color:var(--faint);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.kv{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:4px 14px;margin:0;font-size:12px}
.kv dt{color:var(--muted);font:11px/1.6 var(--font-mono)}
.kv dd{margin:0;min-width:0;overflow-wrap:anywhere;line-height:1.6}
.fulltext{margin-top:8px;padding:10px 12px;border:1px solid var(--hair);border-radius:var(--r-ctl);background:var(--sunk);white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px;max-height:320px;overflow:auto}
.card{padding:14px 16px;border:1px solid var(--hair);border-radius:var(--r-panel);background:var(--card)}
.card+.card{margin-top:10px}
.card.held{border-left:3px solid var(--ember)}
.card .acts{display:flex;gap:8px;margin-top:12px}

/* ---------------------------------------------------------------- inspector */
.insp{padding:4px 0 24px}
.insp section{padding:12px 16px;border-bottom:1px solid var(--hair)}
.insp h3{margin:0 0 10px;font:600 10.5px/1 var(--font-mono);letter-spacing:.08em;text-transform:uppercase;color:var(--muted);display:flex;align-items:center;gap:8px}
.insp h3 .n{margin-left:auto;color:var(--text);letter-spacing:0}
.card-acts{display:flex;gap:8px;margin-top:12px}
.links{list-style:none;margin:0;padding:0;display:grid;gap:2px}
.links li{min-width:0}
.links button,.links a{display:flex;align-items:center;gap:7px;width:calc(100% + 12px);min-height:26px;padding:3px 6px;margin:0 -6px;border:0;border-radius:var(--r-chip);background:none;color:var(--text);cursor:pointer;text-align:left;font:12px var(--font-mono);min-width:0}
.links button:hover,.links a:hover{background:var(--raised);text-decoration:none}
.links .c{margin-left:auto;color:var(--muted);font-size:11px;flex:none}
.tl{list-style:none;margin:0;padding:0;display:grid;gap:3px}
.tl li{display:flex;justify-content:space-between;gap:10px;padding:2px 0 2px 10px;border-left:2px solid var(--hair);font:11.5px var(--font-mono);color:var(--muted)}
.tl .done{border-left-color:var(--lichen)}.tl .done b{color:var(--lichen)}
.tl .now{border-left-color:var(--glacier)}.tl .now b{color:var(--glacier)}
.tl .bad{border-left-color:var(--ember)}.tl .bad b{color:var(--ember)}
.tl .na{opacity:.7}
.route-c{margin-top:10px}
.mini{display:block;width:100%;height:auto;margin:6px 0 10px}
.mini line{stroke:var(--hair-strong)}
.mini .n{fill:var(--h,var(--muted))}
.mini .n.off{fill:none;stroke:var(--muted);stroke-dasharray:2 2}
.mini .n.person{fill:var(--glacier)}.mini .n.conv{fill:var(--iris)}
.mini .busy{fill:none;stroke:var(--text);stroke-width:1.5}
.mini text{fill:var(--text);font:10px var(--font-mono)}
.mini .c{fill:var(--muted)}
.mini .pk{cursor:pointer}
.mini .pk:hover text{text-decoration:underline}
.kbar{display:grid;grid-template-columns:5ch minmax(0,1fr) 3ch;gap:6px;align-items:center;font:11px var(--font-mono);margin-top:4px}
.kbar i{display:block;height:6px;border-radius:1px;background:var(--k)}
.kbar span:last-child{text-align:right;color:var(--muted)}

/* ---------------------------------------------------------------- dialogs */
dialog{padding:0;border:1px solid var(--hair-strong);border-radius:var(--r-panel);background:var(--card);color:var(--text);box-shadow:var(--shadow);max-width:min(600px,calc(100vw - 24px));width:100%;overscroll-behavior:contain}
dialog::backdrop{background:var(--scrim);backdrop-filter:blur(2px)}
dialog[open]{animation:dlgin var(--d2) var(--ease-out)}
.dlg{display:grid;gap:14px;padding:18px 20px}
.dlg h2{margin:0;font:650 15px/1.3 var(--font-ui)}
.dlg-b,.dlg-msg{display:grid;gap:10px}
.dlg p{margin:0}
.dlg .acts{display:flex;align-items:center;justify-content:flex-end;gap:8px}
.to-box{position:relative;display:flex;flex-wrap:wrap;align-items:center;gap:5px;min-height:34px;padding:3px 5px;border:1px solid var(--hair-strong);border-radius:var(--r-ctl);background:var(--sunk)}
.to-box:focus-within{outline:2px solid var(--amber);border-color:transparent}
.to-box input{flex:1;min-width:140px;border:0!important;background:transparent!important;outline:none!important;height:26px;padding:0 4px}
.to-chip{display:inline-flex;align-items:center;gap:2px;height:24px;padding:0 2px 0 7px;border:1px solid var(--hair-strong);border-radius:var(--r-chip);background:var(--raised);font:12px var(--font-mono)}
.to-chip button{display:grid;place-items:center;width:20px;height:20px;border:0;background:none;color:var(--muted);cursor:pointer;border-radius:var(--r-chip)}
.to-chip button:hover{color:var(--text);background:var(--hair)}
.suggest{position:absolute;left:-1px;right:-1px;top:calc(100% + 4px);z-index:3;margin:0;padding:4px;list-style:none;border:1px solid var(--hair-strong);border-radius:var(--r-ctl);background:var(--panel);box-shadow:var(--shadow);max-height:240px;overflow:auto}
.suggest li{display:flex;align-items:center;gap:8px;min-height:30px;padding:3px 8px;border-radius:var(--r-chip);cursor:pointer;font-size:12px}
.suggest li[aria-selected=true]{background:var(--raised);box-shadow:inset 2px 0 0 var(--amber)}
.err{color:var(--ember);font-size:12px;min-height:1em}
.palette{margin-top:12vh;max-width:min(640px,calc(100vw - 24px))}
.pal-in{display:flex;align-items:center;gap:10px;padding:0 14px;border-bottom:1px solid var(--hair)}
.pal-in:focus-within{border-bottom-color:var(--amber);box-shadow:inset 0 -1px 0 var(--amber)}
.pal-in input{flex:1;height:48px;border:0!important;background:transparent!important;outline:none!important;font:15px var(--font-ui);padding:0}
.pal-list{list-style:none;margin:0;padding:6px;max-height:min(420px,56vh);overflow:auto}
.pal-g{padding:8px 10px 4px;font:600 10px/1 var(--font-mono);letter-spacing:.08em;text-transform:uppercase;color:var(--faint)}
.pal-o{display:flex;align-items:center;gap:10px;min-height:34px;padding:4px 10px;border-radius:var(--r-ctl);cursor:pointer;color:var(--text)}
.pal-o[aria-selected=true]{background:var(--raised);box-shadow:inset 2px 0 0 var(--amber)}
.pal-o .l{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pal-o .hint{color:var(--muted);font:11px var(--font-mono);max-width:45%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pal-o mark{background:none;color:var(--amber);padding:0}
.pal-f{display:flex;gap:14px;padding:8px 14px;border-top:1px solid var(--hair);font:11px var(--font-mono);color:var(--muted)}
.keys{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:8px 16px;align-items:center;font-size:12.5px}
.toasts{position:fixed;right:16px;bottom:calc(var(--status) + 14px);z-index:var(--z-toast);display:grid;gap:8px;justify-items:end;pointer-events:none}
.toast{max-width:min(420px,calc(100vw - 32px));padding:9px 12px;border:1px solid var(--hair-strong);border-left:3px solid var(--lichen);border-radius:var(--r-ctl);background:var(--card);box-shadow:var(--shadow);font:13px var(--font-ui);pointer-events:auto;animation:toastin var(--d2) var(--ease-out)}
.toast.bad{border-left-color:var(--ember)}

@keyframes stripin{from{opacity:0;transform:translateX(14px)}to{opacity:1;transform:none}}
@keyframes txin{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}
@keyframes dlgin{from{opacity:0;transform:translateY(8px) scale(.985)}to{opacity:1;transform:none}}
@keyframes toastin{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
@keyframes shimmer{to{background-position:-200% 0}}
@keyframes busy{50%{opacity:.2}}

/* ---------------------------------------------------------------- container: narrow panes */
@container pane (max-width:1040px){.tbl .c-ses{display:none}}
/* mid widths: the scope keeps its place beside one panel, the strips or the log, as tabs */
@container pane (max-width:999px){
.air{grid-template-columns:minmax(0,1fr) minmax(280px,40%);grid-template-rows:auto minmax(0,1fr);grid-template-areas:"head head" "scope side"}
.air-strips,.air-log{grid-area:side;margin:0 12px 12px 0;border:1px solid var(--hair);border-radius:var(--r-panel)}
.scope{margin-bottom:12px}
.air .pnl-h{height:var(--tabbar)}
.air .pnl-h h2{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}
.air-tabs{display:inline-flex}
.air[data-tab=log] .air-strips,.air[data-tab=strips] .air-log{display:none}
}
/* a portrait tablet: scope over the log on the left, strips on the right, no tabs */
@media (orientation:portrait){@container pane (min-width:640px) and (max-width:999px){
.air{grid-template-rows:auto auto minmax(0,1fr);grid-template-areas:"head head" "scope strips" "log strips"}
.scope{aspect-ratio:1/1.08;margin-bottom:0}
.air-strips{grid-area:strips;grid-row:2/4}
.air-log{grid-area:log;margin:10px 12px 12px}
.air[data-tab] .air-strips,.air[data-tab] .air-log{display:flex}
.air-tabs{display:none}
.air .pnl-h h2{position:static;width:auto;height:auto;clip-path:none}
}}
@container pane (max-width:639px){
.air{display:block;overflow:auto}
.scope{height:min(100cqw + 24px,560px);min-height:300px;margin-bottom:10px}
.composer{position:static}
.air-strips,.air-log{margin:0 12px 12px}
.air-strips .strip-scroll{max-height:70vh}
.air-log{height:60vh}
}
@container pane (max-width:560px){.composer .hint{display:none}}
@container pane (max-width:760px){
.filters{grid-template-columns:1fr 1fr}
.filters .field:first-child{grid-column:1/-1}
.page{padding:18px 16px 48px}
.tbl thead{display:none}
.tbl tr{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:2px 10px;padding:10px 0;border-bottom:1px solid var(--hair)}
.tbl td{display:block;padding:0;border:0}
.tbl td.m{max-width:none;grid-column:1}
.tbl td.acts-c{grid-column:2;grid-row:1/span 3;align-self:center}
}

/* ---------------------------------------------------------------- viewport */
@media (max-width:1279px){
.app,.app.no-inspector{--inspector-w:0px}
.inspector{display:flex;position:fixed;right:0;top:0;bottom:var(--status);width:min(340px,92vw);z-index:var(--z-drawer);box-shadow:var(--shadow);transform:translateX(105%);visibility:hidden;transition:transform var(--d3) var(--ease-out),visibility 0s linear var(--d3)}
.app.no-inspector .inspector{display:flex}
.app.drawer-r .inspector{transform:none;visibility:visible;transition:transform var(--d3) var(--ease-out)}
}
@media (max-width:900px){:root{--explorer-w:228px}.statusbar .wide{display:none}}
@media (max-width:600px){
body{font-size:14px}
.app,.app.no-explorer{grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(0,1fr) calc(56px + env(safe-area-inset-bottom));grid-template-areas:"ws" "ribbon";--explorer-w:0px}
.statusbar{display:none}
.ribbon{flex-direction:row;justify-content:space-around;gap:0;padding:4px 4px env(safe-area-inset-bottom);border-right:0;border-top:1px solid var(--hair)}
.brand,.rb-gap,.ribbon button.rb,.rb[data-view=search]{display:none}
.rb{width:auto;flex:1;height:48px;display:flex;flex-direction:column;gap:3px;justify-content:center;align-items:center}
.rb-l{position:static;opacity:1;transform:none;padding:0;background:none;color:inherit;font-size:10px}
.rb[aria-current=page]::before{left:20%;right:20%;top:-4px;bottom:auto;width:auto;height:2px}
.badge-n{top:2px;right:calc(50% - 22px)}
.explorer{display:flex;position:fixed;left:0;top:0;bottom:0;width:min(320px,86vw);z-index:var(--z-drawer);box-shadow:var(--shadow);transform:translateX(-105%);visibility:hidden;transition:transform var(--d3) var(--ease-out),visibility 0s linear var(--d3)}
.app.no-explorer .explorer{display:flex}
.app.drawer-l .explorer{transform:none;visibility:visible;transition:transform var(--d3) var(--ease-out)}
.inspector{bottom:0}
.tb.mob{display:grid}
.tb.desk{display:none}
.tab{min-width:124px}
.toasts{bottom:calc(66px + env(safe-area-inset-bottom));right:10px}
.palette{margin-top:6vh}
}
/* touch: 16 px inputs (no zoom on focus) and 44 px targets */
@media (pointer:coarse){
:root{--tabbar:44px;--status:40px}
input[type=text],input[type=search],input:not([type]),select,textarea{font-size:16px;min-height:44px}
.btn,.btn.sm,.seg button,.ti,.tree details>summary,.links button,.links a,.pal-o,.suggest li,.glist button,.check,.scope-legend button,.xn,.sb{min-height:44px}
.btn.icon,.btn.sm.icon,.xn{min-width:44px}
.tb{width:44px;height:44px}
.tab .x{width:36px;height:36px;opacity:1}
input[type=checkbox]{width:22px;height:22px}
}
@media (prefers-reduced-motion:reduce){
*,*::before,*::after{animation-duration:1ms!important;animation-iteration-count:1!important;transition-duration:1ms!important;scroll-behavior:auto!important}
}
@media (forced-colors:active){.st,.hg,.kcode,.pill{forced-color-adjust:none}}
`;

// Long custom-property names read well here; the served sheet uses short ones, and so do the
// script's lookups (app.ts maps its "--name" literals through the same table).
const NAMES =
  "font-mono font-ui hair-strong hair ease-out ease-in r-chip r-ctl r-panel muted text raised glacier lichen amber-fill on-amber amber ember sunk panel card shadow faint scope-bg scope-ring sweep iris tint scrim explorer-w inspector-w tabbar ribbon status".split(
    " ",
  );
// Short names skip any the sheet already uses (--h, --k, --d1, …).
const taken = new Set(SOURCE.match(/--[\w-]+/g));
const ids = [...Array(80).keys()]
  .map((i) => `--${(i + 10).toString(36)}`)
  .filter((n) => !taken.has(n));
export const SHORT = new Map(NAMES.map((n, i) => [`--${n}`, ids[i] as string]));
const short = (s: string) => s.replace(/--[a-z][a-z-]*/g, (n) => SHORT.get(n) ?? n);

// Comments and line breaks are for reading the source only.
export const CSS = short(SOURCE.replace(/\/\*[^*]*\*\//g, "").replace(/\n+/g, ""));
