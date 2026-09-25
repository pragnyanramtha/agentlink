import { describe, expect, it } from "vitest";
import {
  fingerprint,
  generateDeviceKeys,
  newTeamKey,
  open,
  seal,
  signJson,
  teamDecrypt,
  teamEncrypt,
  teamMac,
  teamMacOk,
  verifyJson,
} from "../../src/core/crypto.ts";

describe("crypto", () => {
  const alice = generateDeviceKeys();
  const bob = generateDeviceKeys();

  it("signs canonical JSON and rejects tampering or the wrong key", () => {
    const value = { b: 2, a: [1, "x"] };
    const sig = signJson(alice, value);
    expect(verifyJson(alice.signPub, { a: [1, "x"], b: 2 }, sig)).toBe(true);
    expect(verifyJson(alice.signPub, { a: [1, "y"], b: 2 }, sig)).toBe(false);
    expect(verifyJson(bob.signPub, value, sig)).toBe(false);
  });

  it("seals to one recipient only and binds the AAD", () => {
    const sealed = seal(bob.boxPub, Buffer.from("secret plan"), "aad-1");
    expect(open(bob, sealed, "aad-1").toString()).toBe("secret plan");
    expect(() => open(alice, sealed, "aad-1")).toThrow();
    expect(() => open(bob, sealed, "aad-2")).toThrow();
    const tampered = { ...sealed, ct: `${sealed.ct.slice(0, -2)}AA` };
    expect(() => open(bob, tampered, "aad-1")).toThrow();
  });

  it("team MAC and team encryption need the team key", () => {
    const k = newTeamKey();
    const record = { handle: "bob", deviceId: bob.deviceId };
    const mac = teamMac(k, record);
    expect(teamMacOk(k, record, mac)).toBe(true);
    expect(teamMacOk(newTeamKey(), record, mac)).toBe(false);
    expect(teamMacOk(k, { ...record, handle: "mallory" }, mac)).toBe(false);
    const box = teamEncrypt(k, Buffer.from("presence"), "p");
    expect(teamDecrypt(k, box, "p").toString()).toBe("presence");
    expect(() => teamDecrypt(newTeamKey(), box, "p")).toThrow();
  });

  it("device ids and fingerprints are stable and distinct", () => {
    expect(alice.deviceId).not.toBe(bob.deviceId);
    expect(fingerprint(alice.signPub)).toMatch(/^[0-9a-f]{4}(-[0-9a-f]{4}){4}$/);
  });
});
