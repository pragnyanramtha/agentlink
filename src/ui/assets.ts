import { JS } from "./app.ts";
import { CSS } from "./styles.ts";

// The page shell. No inline script or style: the CSP allows only same-origin /app.js and /app.css.
const HTML = `<!doctype html>
<html lang="en" data-theme="system">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark light">
<meta name="theme-color" content="#0E1116" media="(prefers-color-scheme: dark)">
<meta name="theme-color" content="#F8F9FB" media="(prefers-color-scheme: light)">
<meta name="referrer" content="no-referrer">
<meta name="description" content="agentlink tower: watch your agents' messages and act on them">
<title>agentlink</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/app.css">
<script src="/app.js" defer></script>
</head>
<body>
<a class="skip" href="#ws">Skip to workspace</a>
<div class="app" id="app">
<nav class="ribbon" aria-label="Views">
<a class="brand" href="#/airspace" aria-label="agentlink tower"><svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="16" cy="16" r="12.5"/><circle cx="16" cy="16" r="6.5" opacity=".55"/><path d="M16 16l8.8-8.8" stroke-linecap="round"/><circle cx="21.5" cy="12.6" r="1.8" fill="currentColor" stroke="none"/><circle cx="11" cy="20" r="1.4" fill="currentColor" stroke="none" opacity=".7"/></svg></a>
<a class="rb" href="#/airspace" data-view="airspace" data-icon="radar" aria-label="Airspace"><span class="rb-l">Airspace</span></a>
<a class="rb" href="#/graph" data-view="graph" data-icon="graph" aria-label="Graph"><span class="rb-l">Graph</span></a>
<a class="rb" href="#/threads" data-view="threads" data-icon="threads" aria-label="Conversations"><span class="rb-l">Conversations</span></a>
<a class="rb" href="#/agents" data-view="agents" data-icon="agents" aria-label="Agents"><span class="rb-l">Agents</span></a>
<a class="rb" href="#/approvals" data-view="approvals" data-icon="approvals" aria-label="Approvals"><span class="rb-l">Approvals</span></a>
<a class="rb" href="#/search" data-view="search" data-icon="search" aria-label="Search"><span class="rb-l">Search</span></a>
<span class="rb-gap"></span>
<button class="rb" id="rb-compose" type="button" data-icon="compose" aria-label="New message (C)"><span class="rb-l">New message</span></button>
<button class="rb" id="rb-palette" type="button" data-icon="command" aria-label="Command palette (Ctrl+K)"><span class="rb-l">Commands</span></button>
<button class="rb" id="rb-theme" type="button" data-icon="contrast" aria-label="Theme"><span class="rb-l">Theme</span></button>
<button class="rb" id="rb-help" type="button" data-icon="help" aria-label="Keyboard shortcuts (?)"><span class="rb-l">Shortcuts</span></button>
</nav>
<aside class="explorer" id="explorer" aria-label="Explorer"></aside>
<main class="workspace" id="ws" tabindex="-1">
<div class="banner" id="offline" role="status" hidden><span id="offline-text">Disconnected</span></div>
<div class="banner calm" id="paused" hidden><span class="grow">Delivery is paused. Messages are kept, but nothing reaches an agent until you resume.</span><button class="btn sm primary" id="paused-resume" type="button">Resume delivery</button></div>
<div class="tabbar">
<button class="tb mob" id="tb-menu" type="button" data-icon="menu" aria-label="Explorer"></button>
<button class="tb desk" id="tb-explorer" type="button" data-icon="left" aria-label="Toggle explorer (E)" title="Toggle explorer (E)"></button>
<div class="tabs" id="tabs" role="tablist" aria-label="Open tabs"></div>
<button class="tb" id="tb-more" type="button" data-icon="more" aria-label="All open tabs" title="All open tabs" hidden></button>
<button class="tb mob" id="tb-palette" type="button" data-icon="command" aria-label="Command palette"></button>
<button class="tb desk" id="tb-split" type="button" data-icon="split" aria-label="Split view (\\)" title="Split view (\\)" aria-pressed="false"></button>
<button class="tb" id="tb-inspector" type="button" data-icon="right" aria-label="Toggle inspector (I)" title="Toggle inspector (I)"></button>
</div>
<div class="panes" id="panes"></div>
</main>
<aside class="inspector" id="inspector" aria-label="Inspector"></aside>
<footer class="statusbar" id="statusbar"></footer>
<div class="scrim" id="scrim" hidden></div>
</div>
<div class="sr-only" id="announce" aria-live="polite"></div>
<div class="toasts" id="toasts" aria-live="polite"></div>
</body>
</html>
`;

const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#0E1116"/><g fill="none" stroke="#F0A43A" stroke-width="1.8"><circle cx="16" cy="16" r="11"/><circle cx="16" cy="16" r="5.5" opacity=".55"/><path d="M16 16l7.8-7.8" stroke-linecap="round"/></g><circle cx="21" cy="12.8" r="2" fill="#7FCB9B"/></svg>`;

export const ASSETS: Record<string, { type: string; body: string }> = {
  "/": { type: "text/html; charset=utf-8", body: HTML },
  "/app.js": { type: "text/javascript; charset=utf-8", body: JS },
  "/app.css": { type: "text/css; charset=utf-8", body: CSS },
  "/favicon.svg": { type: "image/svg+xml", body: FAVICON },
};
