import type { Command } from "../args.ts";

// Filled in by the adapter installers (T1.9/T1.10).
export const install: Command = async () => {
  process.stderr.write("agentlink install: not implemented yet\n");
  return 1;
};
export const uninstall: Command = install;
export const doctor: Command = install;
