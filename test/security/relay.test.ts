import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import {
  generateDeviceKeys,
  publicPart,
  randomToken,
  signJson,
  teamMac,
} from "../../src/core/crypto.ts";
import { silentLogger } from "../../src/core/log.ts";
import { authPayload, decodeInvite } from "../../src/relay/protocol.ts";
import { type RunningRelay, startRelay } from "../../src/relay/server.ts";
import { startTestDaemon, type TestDaemon } from "../helpers.ts";

let relayDir: string;
let relay: RunningRelay;
let alice: TestDaemon;

beforeAll(async () => {
  relayDir = mkdtempSync(join(tmpdir(), "agentlink-relay-sec-"));
  relay = await startRelay({ dataDir: relayDir, port: 0, logger: silentLogger });
  alice = await startTestDaemon({ handle: "alice" });
  await alice.raw("POST", "/v1/team/create", { name: "acme", relay: relay.url });
}, 30_000);

afterAll(async () => {
  await alice?.stop();
  await relay?.close();
  rmSync(relayDir, { recursive: true, force: true });
});

function exchange(
  frame: Record<string, unknown>,
): Promise<{ t: string; code?: string; message?: string }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(relay.url);
    ws.on("open", () => ws.send(JSON.stringify(frame)));
    ws.on("message", (data) => {
      resolve(JSON.parse(String(data)));
      ws.close();
    });
    ws.on("error", reject);
  });
}

describe("relay membership", () => {
  it("refuses a join that claims another device's id", async () => {
    const inv = await alice.raw<{ invite: string }>("POST", "/v1/team/invite", { uses: 1 });
    const invite = decodeInvite(inv.data.invite);
    const status = await alice
      .client()
      .request<{ team: { device: { id: string } } }>("GET", "/v1/team");
    const attacker = generateDeviceKeys();
    const device = { ...publicPart(attacker), deviceId: status.team.device.id }; // alice's id, attacker's keys
    const record = {
      teamId: invite.teamId,
      handle: "eve",
      deviceId: device.deviceId,
      signPub: device.signPub,
      boxPub: device.boxPub,
      joinedAt: new Date().toISOString(),
    };
    const frame = {
      t: "join",
      teamId: invite.teamId,
      ts: Date.now(),
      nonce: randomToken(12),
      token: invite.token,
      device,
      member: { record, mac: teamMac(invite.teamKey, record) },
    };
    const reply = await exchange({
      ...frame,
      sig: signJson(attacker, authPayload(frame as never)),
    });
    expect(reply.t).toBe("error");
    expect(reply.message).toContain("does not match");
    // alice is still a member and connected
    const after = await alice
      .client()
      .request<{ team: { connected: boolean }; members: unknown[] }>("GET", "/v1/team");
    expect(after.team.connected).toBe(true);
    expect(after.members).toHaveLength(1);
  });
});
