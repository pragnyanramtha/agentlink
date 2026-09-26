// Characters that can hide or rewrite what a person or a model sees:
// bidi overrides/isolates, zero-width characters, and Unicode tag characters.
const INVISIBLE =
  /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]|[\u{E0000}-\u{E007F}]/gu;
// C0 controls except tab and newline, DEL, and C1 controls.
// biome-ignore lint/suspicious/noControlCharactersInRegex: finding control characters is the point
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: finding the escape character is the point
const ESC = /\u001B/g;

/** For terminals: escapes become visible (␛), other controls "?", invisible characters are removed. */
export function safeTerminal(text: string): string {
  return text.replace(INVISIBLE, "").replace(ESC, "␛").replace(CONTROL, "?");
}

const LOOKALIKE_TAG = /<\s*\/?\s*agent\W{0,3}link\W{0,3}msg/i;
// Body lines that imitate agentlink's banner or provenance lines.
const FAKE_BANNER =
  /^(\s*)(agentlink:|<\s*\/?\s*agentlink|From your user|Automatic notice from agentlink|From .{1,80}, (a peer agent|a teammate's agent|a person on your team|an EXTERNAL))/i;

/**
 * For agent context: removes invisible/control characters, folds look-alike characters when the
 * text imitates our wrapper tags, and marks body lines that imitate our banner or provenance.
 */
export function safeInject(text: string): string {
  let out = text.replace(INVISIBLE, "").replace(CONTROL, "?");
  const folded = out.normalize("NFKC").replace(/[\u2010-\u2015\u2212]/g, "-");
  if (LOOKALIKE_TAG.test(folded)) out = folded;
  return out
    .split("\n")
    .map((line) => (FAKE_BANNER.test(line) ? `│ ${line}` : line))
    .join("\n");
}

/** Short free-text fields from other machines (presence, status): single line, bounded. */
export function safeField(text: unknown, max = 200): string | null {
  if (typeof text !== "string") return null;
  return safeTerminal(text).replace(/\s+/g, " ").trim().slice(0, max) || null;
}
