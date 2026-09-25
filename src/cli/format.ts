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
};

export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "-";
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
}

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[\\d+m`, "g");
const visible = (s: string) => s.replace(ANSI, "");

function fit(cell: string, width: number): string {
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
          const cell = fit(raw, widths[i] ?? 0);
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
  if (["seen", "acked", "replied"].includes(state)) return c.green(state);
  if (["queued", "delivered", "held"].includes(state)) return c.yellow(state);
  if (["refused", "expired", "failed"].includes(state)) return c.red(state);
  return state;
}

export function indent(text: string, prefix = "  "): string {
  return text
    .split("\n")
    .map((l) => prefix + l)
    .join("\n");
}
