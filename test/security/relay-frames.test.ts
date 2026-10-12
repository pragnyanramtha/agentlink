import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { fetchCode } from "../../src/daemon/relay-client.ts";
import {
  decodeInvite,
  encodeInvite,
  SealableSchema,
  ServerFrameSchema,
} from "../../src/relay/protocol.ts";

const blob = { v: 1, epk: "e", nonce: "n", ct: "c" };
const invite = {
  v: 1 as const,
  relay: "wss://relay.example.com",
  teamId: "acme-abc123",
  teamName: "acme",
  token: "t".repeat(32),
  teamKey: "k".repeat(44),
  by: { handle: "alice", fingerprint: "ab12-cd34" },
};
const raw = (value: unknown) => `al1.${Buffer.from(JSON.stringify(value)).toString("base64url")}`;

describe("relay frames are untrusted input", () => {
  it("accepts well-formed frames", () => {
    for (const frame of [
      { t: "welcome", teamId: "x", deviceId: "d", roster: [], admins: [], online: ["d2"] },
      { t: "roster", roster: [], admins: ["d"] },
      { t: "msg", id: "m", from: "d", blob, at: new Date().toISOString() },
      { t: "presence", deviceId: "d", box: { nonce: "n", ct: "c" }, at: "now" },
      { t: "online", deviceId: "d", online: false },
      { t: "sent", id: "s", queued: true },
      { t: "ok", op: "invite", ref: "r" },
      { t: "pong" },
      { t: "code", box: { nonce: "n", ct: "c" } },
      { t: "error", code: "auth", message: "nope" },
    ]) {
      expect(ServerFrameSchema.safeParse(frame).success, frame.t).toBe(true);
    }
  });

  it("rejects malformed frames", () => {
    for (const frame of [
      { t: "roster", roster: "everyone", admins: [] },
      { t: "welcome", teamId: "x", deviceId: "d", roster: {}, admins: [] },
      { t: "welcome", teamId: "x", deviceId: "d", roster: [], admins: [], online: [1] },
      { t: "msg", id: "m", from: "d", at: "now" },
      { t: "msg", id: "m", from: "d", blob: { ...blob, v: 2 }, at: "now" },
      { t: "online", deviceId: "d", online: "yes" },
      { t: "code" },
      { t: "error", code: "x", message: { html: "<b>" } },
      { t: "error", code: "x", message: "m".repeat(100_000) },
      { t: "roster", roster: [], admins: Array.from({ length: 10_000 }, () => "d") },
      { t: "nope" },
      null,
      "pong",
    ]) {
      expect(ServerFrameSchema.safeParse(frame).success, JSON.stringify(frame)?.slice(0, 80)).toBe(
        false,
      );
    }
  });

  it("validates the sealed inner payload", () => {
    const receipt = { kind: "receipt", messageId: "m", to: "@bob", state: "delivered", sig: "s" };
    expect(SealableSchema.safeParse(receipt).success).toBe(true);
    expect(SealableSchema.safeParse({ ...receipt, note: "on it" }).success).toBe(true);
    expect(SealableSchema.safeParse({ ...receipt, note: { evil: true } }).success).toBe(false);
    expect(SealableSchema.safeParse({ ...receipt, sig: undefined }).success).toBe(false);
    expect(SealableSchema.safeParse({ kind: "envelope", envelope: {}, sig: "s" }).success).toBe(
      true,
    );
    expect(SealableSchema.safeParse({ kind: "envelope", sig: "s" }).success).toBe(false);
    expect(SealableSchema.safeParse({ kind: "other", sig: "s" }).success).toBe(false);
  });
});

describe("invites", () => {
  it("round-trips a valid invite", () => {
    expect(decodeInvite(encodeInvite(invite))).toEqual(invite);
    expect(decodeInvite(`agentlink://join/${encodeInvite(invite)}`)).toEqual(invite);
  });

  it("rejects non-websocket relays and missing fields", () => {
    expect(() => decodeInvite("hello")).toThrow("not an agentlink invite");
    for (const bad of [
      { ...invite, relay: "http://x" },
      { ...invite, relay: "javascript:alert(1)" },
      { ...invite, teamKey: undefined },
      { ...invite, v: 2 },
      { ...invite, by: "alice" },
      { ...invite, teamName: "n".repeat(10_000) },
    ]) {
      expect(() => decodeInvite(raw(bad))).toThrow("invite is incomplete");
    }
  });
});

describe("fetchCode", () => {
  let server: WebSocketServer | undefined;
  afterEach(() => server?.close());

  it("rejects a malformed answer from the relay", async () => {
    server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    server.on("connection", (ws) => ws.on("message", () => ws.send(JSON.stringify({ t: "code" }))));
    await new Promise((r) => server?.once("listening", r));
    const { port } = server.address() as AddressInfo;
    await expect(fetchCode(`ws://127.0.0.1:${port}`, "x".repeat(16))).rejects.toThrow(
      "unexpected answer from the relay",
    );
  });
});
