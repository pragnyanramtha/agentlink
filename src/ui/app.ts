// Browser script for the web UI (served as /app.js). Every node is built with createElement and
// textContent: message data never goes through an HTML parser.
import { AIRSPACE } from "./airspace.ts";
import { CORE } from "./core.ts";
import { GRAPH } from "./graph.ts";
import { SHELL } from "./shell.ts";
import { SHORT } from "./styles.ts";
import { VIEWS } from "./views.ts";

const PUNCT = "{}()[];,:=+-*/<>!?&|%^~";

/**
 * Shrinks the script without a parser. The parts use no template literals, multi-line strings,
 * trailing comments, or regex literals with spaces or quotes (a test compiles the result): so
 * whole-line comments and indentation go, and spaces next to punctuation go outside quotes.
 * Newlines stay, except after `{ ( [ , ;`, `=>`, `&&` and `||`, where one can never end a
 * statement (so ASI is unchanged); spaces in `+ +` and `- -` stay too.
 */
export function squeeze(src: string): string {
  const lines = src
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("//"));
  let out = "";
  for (const line of lines) {
    let i = 0;
    while (i < line.length) {
      const ch = line[i] as string;
      if (ch === '"' || ch === "'") {
        let j = i + 1;
        while (j < line.length && line[j] !== ch) j += line[j] === "\\" ? 2 : 1;
        out += line.slice(i, j + 1);
        i = j + 1;
      } else if (ch === " ") {
        let j = i;
        while (line[j] === " ") j++;
        const prev = out[out.length - 1] ?? "";
        const next = line[j] ?? "";
        const sign = (c: string) => c === "+" || c === "-";
        if ((!PUNCT.includes(prev) && !PUNCT.includes(next)) || (sign(prev) && sign(next)))
          out += " ";
        i = j;
      } else {
        out += ch;
        i++;
      }
    }
    if (!/(?:[{([,;]|=>|&&|\|\|)$/.test(out)) out += "\n";
  }
  return out;
}

// The script reads a few colours and fonts from the sheet: by their short names, as served.
const named = (js: string) =>
  js.replace(/"(--[a-z][a-z-]*)"/g, (m, n: string) => (SHORT.has(n) ? `"${SHORT.get(n)}"` : m));

export const JS = `(() => {\n"use strict";\n${named(squeeze([CORE, AIRSPACE, GRAPH, VIEWS, SHELL].join("\n")))}})();\n`;
