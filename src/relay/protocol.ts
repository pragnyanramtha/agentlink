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
    /** Echoed as `ref` in the relay's ok/error reply. */
    id: z.string().max(64).optional(),
    tokenHash: z.string(),
    expiresAt: z.string(),
    uses: z.number().int().min(1).max(100),
  }),
  z.object({ t: z.literal("send"), id: z.string().max(64), to: z.string(), blob: SealedSchema }),
  z.object({ t: z.literal("ack"), ids: z.array(z.string()).max(500) }),
  z.object({ t: z.literal("presence"), box: TeamBoxSchema }),
  z.object({ t: z.literal("remove"), deviceId: z.string() }),
  z.object({ t: z.literal("ping") }),
  // Short invite codes: a member stores the invite sealed under a code-derived key; anyone may
  // fetch it once by the code-derived id (no auth), after which the relay deletes it.
  z.object({
    t: z.literal("code_put"),
    id: z.string().min(16).max(64),
    /** Echoed as `ref` in the relay's ok/error reply. */
    ref: z.string().max(64).optional(),
    box: TeamBoxSchema,
    expiresAt: z.string(),
  }),
  z.object({ t: z.literal("code_get"), id: z.string().min(16).max(64) }),
]);
export type ClientFrame = z.infer<typeof ClientFrameSchema>;

// The relay is untrusted for content: daemons validate every frame it sends.
const Id = z.string().max(64);
const At = z.string().max(64);
const DeviceIds = z.array(Id).max(500);
const Roster = z.array(SignedMemberSchema).max(500);

export const ServerFrameSchema = z.discriminatedUnion("t", [
  z.object({
    t: z.literal("welcome"),
    teamId: Id,
    deviceId: Id,
    roster: Roster,
    admins: DeviceIds,
    /** Devices of the team connected right now (so a fresh join does not show everyone offline). */
    online: DeviceIds.optional(),
  }),
  z.object({ t: z.literal("roster"), roster: Roster, admins: DeviceIds }),
  z.object({ t: z.literal("msg"), id: Id, from: Id, blob: SealedSchema, at: At }),
  z.object({ t: z.literal("presence"), deviceId: Id, box: TeamBoxSchema, at: At }),
  z.object({ t: z.literal("online"), deviceId: Id, online: z.boolean() }),
  z.object({ t: z.literal("sent"), id: Id, queued: z.boolean() }),
  z.object({ t: z.literal("ok"), op: Id, ref: Id.optional() }),
  z.object({ t: z.literal("pong") }),
  z.object({ t: z.literal("code"), box: TeamBoxSchema }),
  z.object({
    t: z.literal("error"),
    code: Id,
    message: z.string().max(1000),
    ref: Id.optional(),
  }),
]);
export type ServerFrame = z.infer<typeof ServerFrameSchema>;

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
export const SealableSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("envelope"), envelope: z.unknown(), sig: z.string().max(200) }),
  z.object({
    kind: z.literal("receipt"),
    messageId: z.string().max(128),
    to: z.string().max(200),
    state: z.string().max(32),
    note: z.string().max(2000).optional(),
    sig: z.string().max(200),
  }),
]);
export type Sealable = z.infer<typeof SealableSchema>;

export const InviteSchema = z.object({
  v: z.literal(1),
  relay: z
    .url({ protocol: /^wss?$/ })
    .max(2048)
    .regex(/^wss?:\/\/\S+$/),
  teamId: z.string().min(1).max(64),
  teamName: z.string().max(64),
  token: z.string().min(1).max(128),
  teamKey: z.string().min(1).max(128),
  by: z.object({ handle: z.string().max(64), fingerprint: z.string().max(128) }),
});
export type Invite = z.infer<typeof InviteSchema>;

export function encodeInvite(invite: Invite): string {
  return `al1.${Buffer.from(JSON.stringify(invite)).toString("base64url")}`;
}

export function decodeInvite(text: string): Invite {
  const trimmed = text.trim().replace(/^agentlink:\/\/join\//, "");
  if (!trimmed.startsWith("al1.")) throw new Error("not an agentlink invite (expected al1.…)");
  const parsed = InviteSchema.safeParse(
    JSON.parse(Buffer.from(trimmed.slice(4), "base64url").toString("utf8")),
  );
  if (!parsed.success) throw new Error("invite is incomplete");
  return parsed.data;
}

export const MAX_FRAME_BYTES = 1024 * 1024;
export const CLOCK_SKEW_MS = 5 * 60_000;
