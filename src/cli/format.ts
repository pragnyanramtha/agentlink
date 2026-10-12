const useColor = () =>
  !process.env.NO_COLOR && (process.env.FORCE_COLOR === "1" || Boolean(process.stdout.isTTY));

const wrap = (code: number, reset: number) => (s: string) =>
  useColor() ? `\u001b[${code}m${s}\u001b[${reset}m` : s;

export const c = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
  underline: wrap(4, 24),
};

/** Search matches («word») in bold and underlined on a terminal; elsewhere the «» marks stay. */
export const mark = (snippet: string): string =>
  useColor() ? snippet.replace(/«([^«»]*)»/g, (_, w: string) => c.bold(c.underline(w))) : snippet;

/** One line, at most `max` characters. */
export function clip(text: string, max: number): string {
  const s = text.replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "-";
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
}

/** Message ids in human output: 12 characters (any unique prefix works as an argument). */
export const short = (id: string | null | undefined): string => (id ?? "").slice(0, 12);

const pad2 = (n: number) => String(n).padStart(2, "0");

/** 24-hour local time, HH:MM:SS. */
export const clock = (d: Date): string =>
  `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;

/** "12s ago" within a day, otherwise the local date and time ("2026-09-14 13:05"). */
export function when(iso: string, now = Date.now()): string {
  const d = new Date(iso);
  if (now - d.getTime() < 86_400_000) return ago(iso, now);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${clock(d).slice(0, 5)}`;
}

/** A length of time: "12s", "2m", "3h", "2d". */
export function span(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86_400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86_400)}d`;
}

/** Ack values as words: accept → accepted, decline → declined. */
export const ackWord = (ack: string): string =>
  ack === "accept" ? "accepted" : ack === "decline" ? "declined" : ack;

/** Delivery state in plain words: an acked handoff reads "accepted" or "declined". */
export function stateLabel(d: { state: string; note?: string | null }): string {
  const ack = d.state === "acked" ? /^(accepted|declined)\b/.exec(d.note ?? "")?.[1] : undefined;
  return ack ?? d.state;
}

/** `re: "<preview…>" (<from>)` for replies, acks and review results that carry it. */
export function reLine(re: { from: string; preview: string } | null | undefined): string {
  if (!re) return "";
  const p = re.preview.replace(/\s+/g, " ");
  return `re: "${p.length > 60 ? `${p.slice(0, 59)}…` : p}" (${re.from})`;
}

/** One updating status line on stderr (a terminal only); returns a function that clears it. */
export function statusLine(text: (seconds: number) => string): () => void {
  if (!process.stderr.isTTY) return () => {};
  const started = Date.now();
  const draw = () => {
    const line = text(Math.round((Date.now() - started) / 1000));
    const width = (process.stderr.columns || 80) - 1;
    process.stderr.write(`\r\u001b[K${c.dim(line.length > width ? line.slice(0, width) : line)}`);
  };
  draw();
  const timer = setInterval(draw, 1000);
  const stop = () => {
    clearInterval(timer);
    process.removeListener("SIGINT", interrupt);
    process.stderr.write("\r\u001b[K");
  };
  const interrupt = () => {
    stop();
    process.exit(130);
  };
  process.once("SIGINT", interrupt);
  return stop;
}

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[\\d+m`, "g");
const visible = (s: string) => s.replace(ANSI, "");

function fitCell(cell: string, width: number): string {
  const plain = visible(cell);
  return plain.length <= width ? cell : `${plain.slice(0, Math.max(1, width - 1))}…`;
}

/** Column-aligned table; on a terminal, the widest columns shrink so rows don't wrap. */
export function table(rows: string[][], header?: string[]): string {
  const all = header ? [header.map((h) => c.dim(h)), ...rows] : rows;
  const widths: number[] = [];
  for (const row of all) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, visible(cell).length);
    });
  }
  const columns = process.stdout.isTTY ? process.stdout.columns : undefined;
  if (columns) {
    const total = () => widths.reduce((a, b) => a + b, 0) + 2 * (widths.length - 1);
    while (total() > columns) {
      let widest = -1;
      widths.forEach((w, i) => {
        if (i > 0 && w > 8 && (widest < 0 || w > (widths[widest] ?? 0))) widest = i;
      });
      if (widest < 0) break;
      widths[widest] = (widths[widest] ?? 0) - 1;
    }
  }
  return all
    .map((row) =>
      row
        .map((raw, i) => {
          const cell = fitCell(raw, widths[i] ?? 0);
          return i === row.length - 1
            ? cell
            : cell + " ".repeat(Math.max(0, (widths[i] ?? 0) - visible(cell).length));
        })
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

export function stateColor(state: string): string {
  switch (state) {
    case "busy":
      return c.yellow(state);
    case "idle":
      return c.green(state);
    case "offline":
    case "stale":
      return c.dim(state);
    default:
      return state;
  }
}

export function deliveryColor(state: string): string {
  if (["seen", "acked", "accepted", "replied"].includes(state)) return c.green(state);
  if (["queued", "delivered", "held", "declined"].includes(state)) return c.yellow(state);
  if (["refused", "expired", "failed"].includes(state)) return c.red(state);
  return state;
}

export function indent(text: string, prefix = "  "): string {
  return text
    .split("\n")
    .map((l) => prefix + l)
    .join("\n");
}
