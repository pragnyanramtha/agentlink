import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  type KeyObject,
  randomBytes,
  sign,
  timingSafeEqual,
  verify,
} from "node:crypto";
import { canonicalJson } from "./canonical-json.ts";

/**
 * Device identity: Ed25519 (signatures) + X25519 (key agreement), stored as raw 32-byte keys
 * in base64url. Messages are sealed per recipient device: ephemeral X25519 → HKDF-SHA256 →
 * ChaCha20-Poly1305. The relay only ever sees ciphertext.
 */
export interface DeviceKeys {
  deviceId: string;
  signPub: string;
  signPriv: string;
  boxPub: string;
  boxPriv: string;
}

export interface PublicDevice {
  deviceId: string;
  signPub: string;
  boxPub: string;
}

const b64 = (buf: Buffer | Uint8Array) => Buffer.from(buf).toString("base64url");
const unb64 = (s: string) => Buffer.from(s, "base64url");

// DER prefixes for raw 32-byte keys (RFC 8410).
const ED25519_SPKI = Buffer.from("302a300506032b6570032100", "hex");
const ED25519_PKCS8 = Buffer.from("302e020100300506032b657004220420", "hex");
const X25519_SPKI = Buffer.from("302a300506032b656e032100", "hex");
const X25519_PKCS8 = Buffer.from("302e020100300506032b656e04220420", "hex");

const pub = (prefix: Buffer, raw: string): KeyObject =>
  createPublicKey({ key: Buffer.concat([prefix, unb64(raw)]), format: "der", type: "spki" });
const priv = (prefix: Buffer, raw: string): KeyObject =>
  createPrivateKey({ key: Buffer.concat([prefix, unb64(raw)]), format: "der", type: "pkcs8" });

function rawKeys(type: "ed25519" | "x25519"): { pub: string; priv: string } {
  const { publicKey, privateKey } = generateKeyPairSync(type as "ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" });
  const pkcs8 = privateKey.export({ format: "der", type: "pkcs8" });
  return {
    pub: b64(spki.subarray(spki.length - 32)),
    priv: b64(pkcs8.subarray(pkcs8.length - 32)),
  };
}

export function fingerprint(signPub: string): string {
  const hex = createHash("sha256").update(unb64(signPub)).digest("hex").slice(0, 20);
  return hex.match(/.{4}/g)?.join("-") ?? hex;
}

export function generateDeviceKeys(): DeviceKeys {
  const s = rawKeys("ed25519");
  const x = rawKeys("x25519");
  return {
    deviceId: `dev_${fingerprint(s.pub).replace(/-/g, "").slice(0, 16)}`,
    signPub: s.pub,
    signPriv: s.priv,
    boxPub: x.pub,
    boxPriv: x.priv,
  };
}

export function publicPart(keys: DeviceKeys): PublicDevice {
  return { deviceId: keys.deviceId, signPub: keys.signPub, boxPub: keys.boxPub };
}

export function signJson(keys: Pick<DeviceKeys, "signPriv">, value: unknown): string {
  return b64(sign(null, Buffer.from(canonicalJson(value)), priv(ED25519_PKCS8, keys.signPriv)));
}

export function verifyJson(signPub: string, value: unknown, signature: string): boolean {
  try {
    return verify(
      null,
      Buffer.from(canonicalJson(value)),
      pub(ED25519_SPKI, signPub),
      unb64(signature),
    );
  } catch {
    return false;
  }
}

export interface Sealed {
  v: 1;
  epk: string;
  nonce: string;
  ct: string;
}

function aeadKey(shared: Buffer, info: string): Buffer {
  return Buffer.from(hkdfSync("sha256", shared, Buffer.alloc(0), Buffer.from(info), 32));
}

/** Encrypts `plaintext` so only the holder of `recipientBoxPub`'s private key can read it. */
export function seal(recipientBoxPub: string, plaintext: Buffer, aad: string): Sealed {
  const eph = rawKeys("x25519");
  const shared = diffieHellman({
    privateKey: priv(X25519_PKCS8, eph.priv),
    publicKey: pub(X25519_SPKI, recipientBoxPub),
  });
  const key = aeadKey(shared, `agentlink/seal/v1|${eph.pub}|${recipientBoxPub}`);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("chacha20-poly1305", key, nonce, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(aad), { plaintextLength: plaintext.length });
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  return { v: 1, epk: eph.pub, nonce: b64(nonce), ct: b64(ct) };
}

export function open(
  keys: Pick<DeviceKeys, "boxPriv" | "boxPub">,
  sealed: Sealed,
  aad: string,
): Buffer {
  const shared = diffieHellman({
    privateKey: priv(X25519_PKCS8, keys.boxPriv),
    publicKey: pub(X25519_SPKI, sealed.epk),
  });
  const key = aeadKey(shared, `agentlink/seal/v1|${sealed.epk}|${keys.boxPub}`);
  const data = unb64(sealed.ct);
  const decipher = createDecipheriv("chacha20-poly1305", key, unb64(sealed.nonce), {
    authTagLength: 16,
  });
  decipher.setAAD(Buffer.from(aad), { plaintextLength: data.length - 16 });
  decipher.setAuthTag(data.subarray(data.length - 16));
  return Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]);
}

/** Team secret: symmetric key every member holds and the relay never sees. */
export const newTeamKey = () => b64(randomBytes(32));

export function teamMac(teamKey: string, value: unknown): string {
  return b64(createHmac("sha256", unb64(teamKey)).update(canonicalJson(value)).digest());
}

export function teamMacOk(teamKey: string, value: unknown, mac: string): boolean {
  const expected = unb64(teamMac(teamKey, value));
  const given = unb64(mac);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export function teamEncrypt(
  teamKey: string,
  plaintext: Buffer,
  aad: string,
): { nonce: string; ct: string } {
  const key = aeadKey(unb64(teamKey), "agentlink/team/v1");
  const nonce = randomBytes(12);
  const cipher = createCipheriv("chacha20-poly1305", key, nonce, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(aad), { plaintextLength: plaintext.length });
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  return { nonce: b64(nonce), ct: b64(ct) };
}

export function teamDecrypt(
  teamKey: string,
  box: { nonce: string; ct: string },
  aad: string,
): Buffer {
  const key = aeadKey(unb64(teamKey), "agentlink/team/v1");
  const data = unb64(box.ct);
  const decipher = createDecipheriv("chacha20-poly1305", key, unb64(box.nonce), {
    authTagLength: 16,
  });
  decipher.setAAD(Buffer.from(aad), { plaintextLength: data.length - 16 });
  decipher.setAuthTag(data.subarray(data.length - 16));
  return Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]);
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("base64url");
export const randomToken = (bytes = 24) => b64(randomBytes(bytes));
