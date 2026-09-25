import { z } from "zod";
import { ulid } from "./ids.ts";
import { LIMITS } from "./limits.ts";

export const KINDS = [
  "info",
  "ask",
  "reply",
  "request",
  "handoff",
  "review_request",
  "review_result",
  "ack",
] as const;
export const KindSchema = z.enum(KINDS);
export type Kind = z.infer<typeof KindSchema>;

/** Kinds that may wake an idle agent (subject to wake policy and budgets). */
export const WAKE_KINDS: ReadonlySet<Kind> = new Set([
  "ask",
  "request",
  "handoff",
  "review_request",
]);
/** Kinds whose sender expects an answer. */
export const EXPECTS_REPLY: ReadonlySet<Kind> = new Set([
  "ask",
  "request",
  "handoff",
  "review_request",
]);

export const RoleSchema = z.enum(["agent", "human", "system"]);
export type Role = z.infer<typeof RoleSchema>;

export const AddrSchema = z.object({
  member: z.string().min(1),
  agent: z.string().min(1).optional(),
  team: z.string().min(1).optional(),
  device: z.string().min(1).optional(),
  role: RoleSchema.default("agent"),
});
export type Addr = z.infer<typeof AddrSchema>;

const Metadata = z.record(z.string(), z.unknown());

export const TextPartSchema = z.object({
  kind: z.literal("text"),
  text: z.string(),
  metadata: Metadata.optional(),
});
export const FilePartSchema = z.object({
  kind: z.literal("file"),
  file: z.object({
    name: z.string().optional(),
    mimeType: z.string().optional(),
    bytes: z.string().optional(),
    uri: z.string().optional(),
    size: z.number().int().nonnegative().optional(),
    sha256: z.string().optional(),
  }),
  metadata: Metadata.optional(),
});
export const DataPartSchema = z.object({
  kind: z.literal("data"),
  data: z.record(z.string(), z.unknown()),
  metadata: Metadata.optional(),
});
export const PartSchema = z.discriminatedUnion("kind", [
  TextPartSchema,
  FilePartSchema,
  DataPartSchema,
]);
export type Part = z.infer<typeof PartSchema>;

export const AckSchema = z.enum(["accept", "decline", "processed"]);
export type AckValue = z.infer<typeof AckSchema>;

export const MetaSchema = z.looseObject({
  repo: z.string().optional(),
  branch: z.string().optional(),
  hops: z.number().int().min(0).default(0),
  expiresAt: z.string(),
  wait: z.boolean().optional(),
  ack: AckSchema.optional(),
});

export const EnvelopeSchema = z.object({
  v: z.literal(1),
  messageId: z.string().min(1),
  contextId: z.string().min(1),
  replyTo: z.string().optional(),
  taskId: z.string().optional(),
  kind: KindSchema,
  from: AddrSchema,
  to: z.array(AddrSchema).min(1),
  parts: z.array(PartSchema).min(1),
  meta: MetaSchema,
  createdAt: z.string(),
  sig: z.string().optional(),
});
export type Envelope = z.infer<typeof EnvelopeSchema>;

export interface NewEnvelopeInput {
  kind: Kind;
  from: Addr;
  to: Addr[];
  parts: Part[];
  contextId?: string;
  replyTo?: string;
  taskId?: string;
  repo?: string;
  branch?: string;
  hops?: number;
  wait?: boolean;
  ack?: AckValue;
  ttlMs?: number;
  now?: Date;
}

export function newEnvelope(input: NewEnvelopeInput): Envelope {
  const now = input.now ?? new Date();
  const messageId = ulid(now.getTime());
  return EnvelopeSchema.parse({
    v: 1,
    messageId,
    contextId: input.contextId ?? messageId,
    replyTo: input.replyTo,
    taskId: input.taskId,
    kind: input.kind,
    from: input.from,
    to: input.to,
    parts: input.parts,
    meta: {
      repo: input.repo,
      branch: input.branch,
      hops: input.hops ?? 0,
      expiresAt: new Date(now.getTime() + (input.ttlMs ?? LIMITS.defaultTtlMs)).toISOString(),
      wait: input.wait,
      ack: input.ack,
    },
    createdAt: now.toISOString(),
  });
}

/** Concatenated text parts. */
export function textOf(env: Pick<Envelope, "parts">): string {
  return env.parts
    .filter((p): p is z.infer<typeof TextPartSchema> => p.kind === "text")
    .map((p) => p.text)
    .join("\n\n");
}

export function preview(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function describePart(part: Part): string {
  if (part.kind === "text") return `text (${part.text.length} chars)`;
  if (part.kind === "file") {
    const size =
      part.file.size ?? (part.file.bytes ? Math.floor((part.file.bytes.length * 3) / 4) : 0);
    return `file ${part.file.name ?? "(unnamed)"} (${part.file.mimeType ?? "application/octet-stream"}, ${size} bytes)`;
  }
  const schema = typeof part.metadata?.schema === "string" ? part.metadata.schema : "data";
  const summary = typeof part.data.summary === "string" ? `: ${part.data.summary}` : "";
  return `${schema}${summary}`;
}
