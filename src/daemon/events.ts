import { EventEmitter } from "node:events";

export type DaemonEvent =
  | { type: "agent"; agent: Record<string, unknown> }
  | { type: "message"; message: Record<string, unknown> }
  | { type: "delivery"; delivery: Record<string, unknown> }
  | { type: "notice"; level: "info" | "warn"; text: string };

export class EventBus {
  readonly #emitter = new EventEmitter();

  constructor() {
    this.#emitter.setMaxListeners(1_000);
  }

  publish(event: DaemonEvent): void {
    this.#emitter.emit("event", event);
  }

  subscribe(fn: (event: DaemonEvent) => void): () => void {
    this.#emitter.on("event", fn);
    return () => this.#emitter.off("event", fn);
  }
}
