import { z } from "zod";

/**
 * Relay wire protocol (JSON frames over WebSocket). The relay stores and forwards opaque sealed
 * blobs; it authenticates devices by signature but can read neither messages nor presence.
 * Member records are MAC'd with the team key (which the relay never has), so a relay cannot
 * insert a fake member.
 */
export const PublicDeviceSchema = z.object({
  deviceId: z.string().min(1).max(64),
  signPub: z.string().min(40).max(64),
  boxPub: z.string().min(40).max(64),
});

export const MemberRecordSchema = z.object({
  teamId: z.string().min(1).max(64),
  handle: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,62}$/),
  deviceId: z.string(),
  signPub: z.string(),
  boxPub: z.string(),
  deviceName: z.string().max(64).optional(),
  joinedAt: z.string(),
});
export type MemberRecord = z.infer<typeof MemberRecordSchema>;

export const SignedMemberSchema = z.object({ record: MemberRecordSchema, mac: z.string() });
export type SignedMember = z.infer<typeof SignedMemberSchema>;

export const SealedSchema = z.object({
  v: z.literal(1),
  epk: z.string(),
  nonce: z.string(),
  ct: z.string(),
});

export const TeamBoxSchema = z.object({ nonce: z.string(), ct: z.string() });

const Signed = { ts: z.number().int(), nonce: z.string().min(8).max(64), sig: z.string() };

export const ClientFrameSchema = z.discriminatedUnion("t", [
  z.object({ t: z.literal("hello"), teamId: z.string(), deviceId: z.string(), ...Signed }),
  z.object({
    t: z.literal("create"),
    teamId: z.string().regex(/^[a-z0-9_-]{6,64}$/),
    device: PublicDeviceSchema,
    member: SignedMemberSchema,
    createToken: z.string().max(200).optional(),
    ...Signed,
  }),
  z.object({
    t: z.literal("join"),
    teamId: z.string(),
    token: z.string().min(16).max(128),
    device: PublicDeviceSchema,
    member: SignedMemberSchema,
    ...Signed,
  }),
  z.object({
    t: z.literal("invite"),
    tokenHash: z.string(),
    expiresAt: z.string(),
    uses: z.number().int().min(1).max(100),
  }),
  z.object({ t: z.literal("send"), id: z.string().max(64), to: z.string(), blob: SealedSchema }),
  z.object({ t: z.literal("ack"), ids: z.array(z.string()).max(500) }),
  z.object({ t: z.literal("presence"), box: TeamBoxSchema }),
  z.object({ t: z.literal("remove"), deviceId: z.string() }),
  z.object({ t: z.literal("ping") }),
]);
export type ClientFrame = z.infer<typeof ClientFrameSchema>;

export type ServerFrame =
  | { t: "welcome"; teamId: string; deviceId: string; roster: SignedMember[]; admins: string[] }
  | { t: "roster"; roster: SignedMember[]; admins: string[] }
  | { t: "msg"; id: string; from: string; blob: z.infer<typeof SealedSchema>; at: string }
  | { t: "presence"; deviceId: string; box: z.infer<typeof TeamBoxSchema>; at: string }
  | { t: "online"; deviceId: string; online: boolean }
  | { t: "sent"; id: string; queued: boolean }
  | { t: "ok"; op: string }
  | { t: "pong" }
  | { t: "error"; code: string; message: string; ref?: string };

/** The part of a hello/create/join frame covered by the device signature. */
export function authPayload(frame: {
  t: string;
  teamId: string;
  deviceId?: string;
  ts: number;
  nonce: string;
  device?: unknown;
  member?: unknown;
  token?: string;
}) {
  const { t, teamId, ts, nonce } = frame;
  return {
    t,
    teamId,
    ts,
    nonce,
    ...(frame.deviceId ? { deviceId: frame.deviceId } : {}),
    ...(frame.device ? { device: frame.device } : {}),
    ...(frame.member ? { member: frame.member } : {}),
    ...(frame.token ? { token: frame.token } : {}),
  };
}

/** Inner payload sealed to a recipient device. */
export type Sealable =
  | { kind: "envelope"; envelope: unknown; sig: string }
  | { kind: "receipt"; messageId: string; to: string; state: string; note?: string; sig: string };

export interface Invite {
  v: 1;
  relay: string;
  teamId: string;
  teamName: string;
  token: string;
  teamKey: string;
  by: { handle: string; fingerprint: string };
}

export function encodeInvite(invite: Invite): string {
  return `al1.${Buffer.from(JSON.stringify(invite)).toString("base64url")}`;
}

export function decodeInvite(text: string): Invite {
  const trimmed = text.trim().replace(/^agentlink:\/\/join\//, "");
  if (!trimmed.startsWith("al1.")) throw new Error("not an agentlink invite (expected al1.…)");
  const parsed = JSON.parse(Buffer.from(trimmed.slice(4), "base64url").toString("utf8")) as Invite;
  if (parsed.v !== 1 || !parsed.relay || !parsed.teamId || !parsed.token || !parsed.teamKey) {
    throw new Error("invite is incomplete");
  }
  return parsed;
}

export const MAX_FRAME_BYTES = 1024 * 1024;
export const CLOCK_SKEW_MS = 5 * 60_000;
