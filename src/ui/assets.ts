import { JS } from "./app.ts";
import { CSS } from "./styles.ts";

// The page shell. No inline script or style: the CSP allows only same-origin /app.js and /app.css.
const HTML = `<!doctype html>
<html lang="en" data-theme="system">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="referrer" content="no-referrer">
<title>agentlink</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/app.css">
<script src="/app.js" defer></script>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<div class="shell">
<aside class="side">
<div class="brand"><svg class="logo" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="9"/><path d="M12 16h8"/><circle cx="10.5" cy="16" r="4"/><circle cx="21.5" cy="16" r="4"/></svg><div>agentlink<small id="who"></small></div><span class="badge k-request" id="paused" hidden>paused</span></div>
<nav aria-label="Views"><ul class="nav">
<li><a href="#/overview" data-view="overview"><span class="ico" aria-hidden="true">◫</span>Overview</a></li>
<li><a href="#/live" data-view="live"><span class="ico" aria-hidden="true">◉</span>Live</a></li>
<li><a href="#/threads" data-view="threads"><span class="ico" aria-hidden="true">☰</span>Conversations<span class="count" hidden></span></a></li>
<li><a href="#/search" data-view="search"><span class="ico" aria-hidden="true">⌕</span>Search</a></li>
<li><a href="#/agents" data-view="agents"><span class="ico" aria-hidden="true">◎</span>Agents</a></li>
<li><a href="#/approvals" data-view="approvals"><span class="ico" aria-hidden="true">✓</span>Approvals<span class="count" hidden></span></a></li>
</ul></nav>
<div class="side-foot">
<button class="btn primary block" id="compose" type="button">✎ New message</button>
<div class="conn" id="conn" role="status"><i class="dot connecting"></i><span>Connecting…</span></div>
<button class="btn ghost small hide-sm" id="theme" type="button">Theme</button>
<button class="btn ghost small hide-sm" id="help" type="button">Keyboard shortcuts <kbd>?</kbd></button>
</div>
</aside>
<div class="content">
<div class="banner bad" id="offline" role="status" hidden><span id="offline-text">Disconnected</span></div>
<main id="main" tabindex="-1"></main>
</div>
</div>
<div class="sr-only" id="announce" aria-live="polite"></div>
<div class="toasts" id="toasts"></div>
</body>
</html>
`;

const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="9" fill="#4f46e5"/><path d="M12 16h8" stroke="#fff" stroke-width="2.5"/><circle cx="10.5" cy="16" r="4" fill="#fff"/><circle cx="21.5" cy="16" r="4" fill="#fff"/></svg>`;

export const ASSETS: Record<string, { type: string; body: string }> = {
  "/": { type: "text/html; charset=utf-8", body: HTML },
  "/app.js": { type: "text/javascript; charset=utf-8", body: JS },
  "/app.css": { type: "text/css; charset=utf-8", body: CSS },
  "/favicon.svg": { type: "image/svg+xml", body: FAVICON },
};
