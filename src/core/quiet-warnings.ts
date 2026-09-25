// Import first in every entry point: silences Node's experimental-feature warnings
// (node:sqlite, type stripping) so they never pollute CLI output or MCP stdio.
const originalEmitWarning = process.emitWarning.bind(process);

process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const text = typeof warning === "string" ? warning : warning.message;
  const type = typeof rest[0] === "string" ? rest[0] : (rest[0] as { type?: string })?.type;
  if (
    (type === "ExperimentalWarning" || /ExperimentalWarning/.test(String(warning))) &&
    /SQLite|Type Stripping|strip-types/i.test(text)
  ) {
    return;
  }
  (originalEmitWarning as (...args: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;
