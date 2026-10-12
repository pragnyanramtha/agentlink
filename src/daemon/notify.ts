import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { safeField } from "../core/sanitize.ts";
import type { DaemonContext } from "./context.ts";
import type { DaemonEvent } from "./events.ts";
import type { Mailbox } from "./mailbox.ts";
import type { MessageRow } from "./types.ts";

type Category = "message" | "ask" | "held";

/** Finds an executable by path or on PATH. */
function which(bin: string): string | null {
  const candidates = isAbsolute(bin)
    ? [bin]
    : (process.env.PATH ?? "").split(delimiter).flatMap((d) => (d ? [join(d, bin)] : []));
  for (const c of candidates) {
    try {
      accessSync(c, constants.X_OK);
      return c;
    } catch {
      // not here
    }
  }
  return null;
}

/** AppleScript string literal. */
const appleString = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/**
 * Opt-in desktop notifications for the person at this machine (config notify.desktop): mail for
 * you, handoffs/asks for you, and deliveries held for your approval. Text is one bounded line;
 * the notifier runs without a shell; at most one notification per kind per window (the rest are
 * coalesced into one summary). Missing notifier binaries are ignored.
 */
export class DesktopNotifier {
  readonly #ctx: DaemonContext;
  readonly #mailbox: Mailbox;
  readonly #bin: string | undefined;
  readonly #windowMs: number;
  readonly #seen = new Set<string>();
  readonly #slots = new Map<
    Category,
    { last: number; pending: string[]; timer?: ReturnType<typeof setTimeout> }
  >();

  constructor(
    ctx: DaemonContext,
    mailbox: Mailbox,
    opts: { bin?: string; windowMs?: number } = {},
  ) {
    this.#ctx = ctx;
    this.#mailbox = mailbox;
    this.#bin = opts.bin;
    this.#windowMs = opts.windowMs ?? 5_000;
  }

  get enabled(): boolean {
    return this.#ctx.config.notify?.desktop === true;
  }

  /** The notifier binary (AGENTLINK_NOTIFY_BIN, else notify-send on Linux, osascript on macOS). */
  notifier(): string | null {
    const bin =
      this.#bin ??
      process.env.AGENTLINK_NOTIFY_BIN ??
      (process.platform === "darwin"
        ? "osascript"
        : process.platform === "win32"
          ? undefined
          : "notify-send");
    return bin ? which(bin) : null;
  }

  start(): () => void {
    const unsubscribe = this.#ctx.events.subscribe((event) => {
      try {
        this.#onEvent(event);
      } catch {
        // notifications never break the daemon
      }
    });
    return () => {
      unsubscribe();
      for (const slot of this.#slots.values()) clearTimeout(slot.timer);
      this.#slots.clear();
    };
  }

  /** Sends a test notification now (even when disabled). */
  test(): { found: boolean; sent: boolean; notifier: string | null; enabled: boolean } {
    const notifier = this.notifier();
    const sent = !!notifier && this.#send("Desktop notifications from agentlink work.");
    return { found: !!notifier, sent, notifier, enabled: this.enabled };
  }

  #onEvent(event: DaemonEvent): void {
    if (event.type !== "delivery" || !this.enabled) return;
    const d = event.delivery;
    const human = `@${this.#mailbox.handle}`;
    const state = String(d.state);
    const key = `${state === "held" ? "held" : "mail"}:${String(d.id)}`;
    if (this.#seen.has(key)) return;
    const forHuman = d.to === human && state === "delivered";
    if (!forHuman && state !== "held") return;
    const m = this.#ctx.store.get<MessageRow>(
      "SELECT from_addr, kind, preview FROM messages WHERE id = ?",
      String(d.messageId),
    );
    if (!m || (forHuman && m.from_addr === human)) return;
    this.#seen.add(key);
    if (this.#seen.size > 2_000) this.#seen.delete(this.#seen.values().next().value as string);
    const from = safeField(m.from_addr, 60) ?? "someone";
    const preview = safeField(m.preview, 140) ?? "";
    if (state === "held") {
      const to = safeField(String(d.to), 60) ?? "";
      this.#push(
        "held",
        `Needs your approval: ${m.kind} from ${from} to ${to}: "${preview}" (agentlink approvals)`,
      );
    } else if (m.kind === "handoff" || m.kind === "ask") {
      this.#push("ask", `${m.kind} from ${from}: ${preview}`);
    } else {
      this.#push("message", `${m.kind === "info" ? "message" : m.kind} from ${from}: ${preview}`);
    }
  }

  #push(category: Category, text: string): void {
    const slot = this.#slots.get(category) ?? { last: 0, pending: [] };
    this.#slots.set(category, slot);
    const now = Date.now();
    if (now - slot.last >= this.#windowMs && !slot.timer) {
      slot.last = now;
      this.#send(text);
      return;
    }
    slot.pending.push(text);
    slot.timer ??= setTimeout(
      () => {
        slot.timer = undefined;
        const pending = slot.pending.splice(0);
        if (!pending.length || !this.enabled) return;
        slot.last = Date.now();
        const noun = category === "held" ? "approvals needed" : `new ${category}s`;
        this.#send(
          pending.length === 1
            ? (pending[0] as string)
            : `${pending.length} ${noun} (latest: ${pending[pending.length - 1]})`,
        );
      },
      Math.max(0, slot.last + this.#windowMs - now),
    );
    slot.timer.unref?.();
  }

  #send(text: string): boolean {
    const bin = this.notifier();
    if (!bin) return false;
    const body = safeField(text, 240) ?? "";
    const args = bin.endsWith("/osascript")
      ? ["-e", `display notification ${appleString(body)} with title ${appleString("agentlink")}`]
      : ["--", "agentlink", body];
    try {
      execFile(bin, args, { timeout: 10_000, windowsHide: true }, () => {
        // failures are ignored: notifications are best effort
      });
      return true;
    } catch {
      return false;
    }
  }
}
