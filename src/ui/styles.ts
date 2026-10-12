// Stylesheet for the web UI (served as /app.css; no inline styles under the CSP).
export const CSS = `
:root{--bg:#f6f6f8;--panel:#fff;--panel2:#f1f2f5;--border:#e3e4e8;--text:#17181c;--muted:#5d5f69;--accent:#4f46e5;--accent-soft:#eef0ff;--accent-fg:#fff;--ok:#15803d;--warn:#b45309;--bad:#b91c1c;--busy:#f59e0b;--idle:#22c55e;--off:#a1a1aa;--shadow:0 1px 2px rgba(16,18,27,.06),0 1px 1px rgba(16,18,27,.04);--c-blue:#1d4ed8;--c-amber:#92400e;--c-violet:#6d28d9;--c-teal:#0f766e;--c-green:#15803d;--c-gray:#4b5563;--mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace;color-scheme:light}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#0d0e12;--panel:#15171c;--panel2:#1b1e25;--border:#272a33;--text:#e8e8ec;--muted:#a0a2ad;--accent:#8f90ff;--accent-soft:#1f2140;--accent-fg:#0d0e12;--ok:#4ade80;--warn:#fbbf24;--bad:#f87171;--off:#6b6d76;--shadow:none;--c-blue:#93c5fd;--c-amber:#fcd34d;--c-violet:#c4b5fd;--c-teal:#5eead4;--c-green:#86efac;--c-gray:#b4b4bd;color-scheme:dark}}
:root[data-theme=dark]{--bg:#0d0e12;--panel:#15171c;--panel2:#1b1e25;--border:#272a33;--text:#e8e8ec;--muted:#a0a2ad;--accent:#8f90ff;--accent-soft:#1f2140;--accent-fg:#0d0e12;--ok:#4ade80;--warn:#fbbf24;--bad:#f87171;--off:#6b6d76;--shadow:none;--c-blue:#93c5fd;--c-amber:#fcd34d;--c-violet:#c4b5fd;--c-teal:#5eead4;--c-green:#86efac;--c-gray:#b4b4bd;color-scheme:dark}
*{box-sizing:border-box}
[hidden]{display:none!important}
html,body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,Ubuntu,Cantarell,"Noto Sans",sans-serif;-webkit-font-smoothing:antialiased}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:6px}
.mono,code{font-family:var(--mono);font-size:12.5px}
.muted{color:var(--muted)}.small{font-size:12.5px}
.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.skip{position:absolute;left:-999px;top:8px;z-index:9;background:var(--panel);padding:8px 12px;border-radius:8px}.skip:focus{left:8px}
.shell{display:grid;grid-template-columns:232px minmax(0,1fr);min-height:100vh}
.side{position:sticky;top:0;height:100vh;display:flex;flex-direction:column;gap:18px;padding:18px 14px;border-right:1px solid var(--border);background:var(--panel)}
.brand{display:flex;align-items:center;gap:10px;font-weight:650;font-size:15px;padding:0 6px}
.brand svg{width:26px;height:26px;flex:none}
.logo rect{fill:var(--accent)}.logo path{stroke:var(--accent-fg);stroke-width:2.5}.logo circle{fill:var(--accent-fg)}
.brand small{display:block;font-weight:400;color:var(--muted);font-size:12px}
.nav{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px}
.nav a{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:8px;color:var(--text);font-weight:500}
.nav a:hover{background:var(--panel2);text-decoration:none}
.nav a[aria-current=page]{background:var(--accent-soft);color:var(--accent)}
.nav .ico{width:18px;text-align:center;opacity:.8}
.nav .count{margin-left:auto;min-width:20px;padding:0 6px;border-radius:10px;background:var(--panel2);color:var(--muted);font-size:12px;text-align:center}
.nav .count.hot{background:var(--warn);color:#fff}
.side-foot{margin-top:auto;display:flex;flex-direction:column;gap:10px}
.conn{display:flex;align-items:center;gap:8px;font-size:12.5px;color:var(--muted);padding:0 6px}
.dot{display:inline-block;width:9px;height:9px;border-radius:50%;background:var(--off);flex:none}
.dot.live,.dot.idle{background:var(--idle)}.dot.busy{background:var(--busy);animation:pulse 2s infinite}
.dot.down{background:var(--bad)}.dot.connecting{background:var(--busy)}.dot.stale{background:transparent;border:2px solid var(--off)}
@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(245,158,11,.5)}70%{box-shadow:0 0 0 6px rgba(245,158,11,0)}100%{box-shadow:0 0 0 0 rgba(245,158,11,0)}}
.row-btns{display:flex;gap:8px;flex-wrap:wrap}
.content{min-width:0}.content>.banner{margin:16px clamp(16px,4vw,40px) 0}
main{padding:28px clamp(16px,4vw,40px) 60px;max-width:1120px;width:100%;outline:none}
.head{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:20px}
h1{font-size:22px;line-height:1.25;margin:0;font-weight:650;letter-spacing:-.01em}
h2{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:28px 0 10px;font-weight:600}
.sub{color:var(--muted);margin-top:4px;font-size:13px}
.btn{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--border);background:var(--panel);color:var(--text);padding:7px 12px;border-radius:8px;font:inherit;font-weight:500;cursor:pointer;line-height:1.2}
.btn:hover{background:var(--panel2)}.btn:disabled{opacity:.55;cursor:default}
.btn.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-fg)}.btn.primary:hover{filter:brightness(1.06)}
.btn.danger{color:var(--bad)}.btn.small{padding:4px 9px;font-size:12.5px}.btn.ghost{border-color:transparent;background:transparent}
.btn.block{width:100%;justify-content:center}
.card{background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:16px;box-shadow:var(--shadow)}
.grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fill,minmax(210px,1fr))}
.grid.wide{grid-template-columns:repeat(auto-fill,minmax(300px,1fr))}
.stat .label{color:var(--muted);font-size:12.5px;font-weight:500}
.stat .num{font-size:30px;font-weight:650;letter-spacing:-.02em;line-height:1.2;margin:4px 0 2px}
.stat.warn{border-color:var(--warn)}.stat.warn .num{color:var(--warn)}
a.stat{color:inherit;display:block}a.stat:hover{text-decoration:none;border-color:var(--accent)}
.legend{display:flex;gap:12px;flex-wrap:wrap;font-size:12.5px;color:var(--muted)}.legend span{display:inline-flex;align-items:center;gap:5px}
.banner{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:12px 16px;border-radius:12px;border:1px solid var(--warn);background:color-mix(in srgb,var(--warn) 12%,var(--panel));margin-bottom:18px}
.banner.bad{border-color:var(--bad);background:color-mix(in srgb,var(--bad) 10%,var(--panel))}
.badge{display:inline-block;padding:1px 8px;border-radius:999px;font-size:11.5px;font-weight:600;letter-spacing:.02em;background:var(--panel2);color:var(--muted);white-space:nowrap}
.k-ask{color:var(--c-blue);background:color-mix(in srgb,var(--c-blue) 14%,transparent)}.k-request{color:var(--c-amber);background:color-mix(in srgb,var(--c-amber) 14%,transparent)}.k-handoff{color:var(--c-violet);background:color-mix(in srgb,var(--c-violet) 14%,transparent)}.k-review_request,.k-review_result{color:var(--c-teal);background:color-mix(in srgb,var(--c-teal) 14%,transparent)}
.k-reply{color:var(--c-green);background:color-mix(in srgb,var(--c-green) 14%,transparent)}.k-info{color:var(--c-gray);background:color-mix(in srgb,var(--c-gray) 14%,transparent)}.k-ack{color:var(--muted)}
.chip{display:inline-flex;align-items:center;gap:4px;padding:1px 8px;border-radius:999px;font-size:12px;border:1px solid var(--border);color:var(--muted);background:var(--panel);white-space:nowrap}
.chip.s-delivered,.chip.s-sent{color:var(--c-blue);border-color:color-mix(in srgb,var(--c-blue) 35%,transparent)}.chip.s-seen{color:var(--accent);border-color:color-mix(in srgb,var(--accent) 40%,transparent)}
.chip.s-replied,.chip.s-acked{color:var(--ok);border-color:color-mix(in srgb,var(--ok) 40%,transparent)}.chip.s-held{color:var(--warn);border-color:color-mix(in srgb,var(--warn) 50%,transparent)}
.chip.s-refused,.chip.s-failed,.chip.s-expired{color:var(--bad);border-color:color-mix(in srgb,var(--bad) 40%,transparent)}
.chip.flash{animation:flash 1.2s}
@keyframes flash{0%{background:var(--accent-soft)}100%{background:var(--panel)}}
.chips{display:flex;gap:6px;flex-wrap:wrap}
.list{display:flex;flex-direction:column;gap:8px}
.item{display:block;color:inherit;background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:12px 14px;box-shadow:var(--shadow)}
a.item:hover{text-decoration:none;border-color:color-mix(in srgb,var(--accent) 50%,var(--border))}
.item.new{animation:slide .35s ease-out}
@keyframes slide{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:none}}
.line{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
.line .grow{flex:1;min-width:0}
.who{font-weight:600}.arrow{color:var(--muted)}
.preview{margin:6px 0;color:var(--text);overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;word-break:break-word}
.subject{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.trunc{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
time{color:var(--muted);font-size:12.5px;white-space:nowrap}
mark{background:color-mix(in srgb,var(--busy) 35%,transparent);color:inherit;border-radius:3px;padding:0 1px}
.empty{text-align:center;padding:48px 20px;color:var(--muted);border:1px dashed var(--border);border-radius:12px;background:var(--panel)}
.empty strong{display:block;color:var(--text);font-size:15px;margin-bottom:4px}
.seg{display:inline-flex;border:1px solid var(--border);border-radius:8px;overflow:hidden;background:var(--panel)}
.seg button{border:0;background:transparent;color:var(--muted);padding:6px 12px;font:inherit;cursor:pointer}
.seg button[aria-pressed=true]{background:var(--accent-soft);color:var(--accent);font-weight:600}
input,select,textarea{font:inherit;color:var(--text);background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:7px 10px;min-width:0}
input:focus,select:focus,textarea:focus{outline:2px solid color-mix(in srgb,var(--accent) 60%,transparent);border-color:var(--accent)}
textarea{width:100%;resize:vertical;min-height:84px;line-height:1.45}
.search{width:100%;font-size:16px;padding:11px 14px;border-radius:10px}
.filters{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0 16px}.filters>*{flex:1 1 140px}
.agent .name{font-family:var(--mono);font-weight:600;font-size:13.5px}
.meta{display:grid;grid-template-columns:auto 1fr;gap:2px 10px;font-size:12.5px;margin:10px 0;color:var(--muted)}.meta dd{margin:0;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.meta dt{white-space:nowrap}
.status{font-style:italic;color:var(--muted);border-left:3px solid var(--border);padding-left:8px;margin:8px 0;word-break:break-word}
.thread{display:flex;flex-direction:column;gap:14px;margin-bottom:18px}
.bubble{max-width:min(720px,88%);background:var(--panel);border:1px solid var(--border);border-radius:14px 14px 14px 4px;padding:10px 14px;box-shadow:var(--shadow)}
.bubble.mine{align-self:flex-end;background:var(--accent-soft);border-color:color-mix(in srgb,var(--accent) 30%,var(--border));border-radius:14px 14px 4px 14px}
.bubble.target{outline:2px solid var(--accent)}
.bubble .body{white-space:pre-wrap;word-break:break-word;margin:6px 0 8px}
.quote{display:block;width:100%;text-align:left;font:inherit;font-size:12.5px;color:var(--muted);border:0;border-left:3px solid var(--accent);background:var(--panel2);padding:4px 8px;border-radius:4px;margin-top:6px;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.composer{position:sticky;bottom:0;background:var(--bg);padding:12px 0 4px;border-top:1px solid var(--border)}
.composer .bar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:8px}.composer .bar .grow{flex:1}
.replying{display:flex;align-items:center;gap:8px;font-size:12.5px;color:var(--muted);margin-bottom:6px;min-width:0}
.fulltext{white-space:pre-wrap;word-break:break-word;background:var(--panel2);border-radius:8px;padding:10px 12px;max-height:320px;overflow:auto;margin:10px 0}
dialog{border:1px solid var(--border);border-radius:14px;background:var(--panel);color:var(--text);padding:0;width:min(560px,calc(100vw - 24px));box-shadow:0 20px 50px rgba(0,0,0,.25)}
dialog::backdrop{background:rgba(10,10,15,.45)}
.dlg{padding:18px 20px;display:flex;flex-direction:column;gap:12px}.dlg h2{margin:0;font-size:16px;text-transform:none;letter-spacing:0;color:var(--text)}
.dlg label{display:flex;flex-direction:column;gap:4px;font-size:12.5px;font-weight:500;color:var(--muted)}
.dlg .actions{display:flex;justify-content:flex-end;align-items:center;gap:8px}.actions .grow{flex:1}
.to-box{display:flex;flex-wrap:wrap;gap:6px;align-items:center;border:1px solid var(--border);border-radius:8px;padding:5px 6px;position:relative;background:var(--panel)}
.to-box input{border:0;flex:1;min-width:120px;padding:3px 4px}.to-box input:focus{outline:none}
.to-box:focus-within{outline:2px solid color-mix(in srgb,var(--accent) 60%,transparent)}
.to-chip{display:inline-flex;align-items:center;gap:4px;background:var(--accent-soft);color:var(--accent);border-radius:6px;padding:1px 4px 1px 8px;font-family:var(--mono);font-size:12.5px}
.to-chip button{border:0;background:transparent;color:inherit;cursor:pointer;font-size:14px;line-height:1;padding:0 3px}
.suggest{position:absolute;left:0;right:0;top:100%;margin:4px 0 0;padding:4px;list-style:none;background:var(--panel);border:1px solid var(--border);border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.15);z-index:5;max-height:220px;overflow:auto}
.suggest li{padding:6px 8px;border-radius:6px;cursor:pointer;display:flex;gap:8px;align-items:center}.suggest li[aria-selected=true]{background:var(--accent-soft)}
.toasts{position:fixed;right:16px;bottom:16px;display:flex;flex-direction:column;gap:8px;z-index:20;max-width:min(380px,calc(100vw - 32px))}
.toast{background:var(--text);color:var(--bg);padding:10px 14px;border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.2);animation:slide .25s}.toast.bad{background:var(--bad);color:#fff}
.keys{display:grid;grid-template-columns:auto 1fr;gap:6px 14px;font-size:13px}.keys kbd{font-family:var(--mono);background:var(--panel2);border:1px solid var(--border);border-bottom-width:2px;border-radius:5px;padding:0 6px;justify-self:start}
.more{display:flex;justify-content:center;margin-top:12px}
.center{max-width:460px;margin:12vh auto;text-align:center}
@media (max-width:760px){
.shell{grid-template-columns:minmax(0,1fr)}
.side{position:sticky;z-index:4;height:auto;min-width:0;flex-direction:row;flex-wrap:wrap;align-items:center;gap:8px 12px;padding:10px 12px;border-right:0;border-bottom:1px solid var(--border)}
.brand small{display:none}.side nav{order:3;width:100%;min-width:0}.nav{flex-direction:row;overflow-x:auto;scrollbar-width:none}.nav a{padding:6px 10px;white-space:nowrap}.nav .ico{display:none}
.side-foot{margin:0 0 0 auto;flex-direction:row;align-items:center}.side-foot .hide-sm{display:none}.conn span{display:none}
main{padding:18px 12px 40px}.bubble{max-width:96%}.stat .num{font-size:26px}
}
`;
