import { join } from "node:path";
import { createLogger } from "../../core/log.ts";
import { didYouMean } from "../../core/suggest.ts";
import { type Command, out, parse, parseDuration, UsageError } from "../args.ts";
import { ago, c, stateColor, table } from "../format.ts";

interface TeamStatus {
  team: {
    name: string;
    id: string;
    relay: string;
    handle: string;
    admin: boolean;
    connected: boolean;
    device: { id: string; fingerprint: string };
  } | null;
  members: {
    handle: string;
    deviceId: string;
    fingerprint: string;
    online: boolean;
    self: boolean;
    deviceName?: string;
  }[];
  agents: { member: string; name: string; tool: string; state: string; at: string }[];
  invitedBy?: { handle: string; fingerprint: string };
}

function printStatus(s: TeamStatus): string {
  if (!s.team) {
    return [
      c.dim("Not in a team yet."),
      "  Start one:   agentlink team create <name> --relay ws://<host>:7700",
      "  Or join one: agentlink team join <invite>",
      c.dim("  Need a relay? agentlink relay serve --host 0.0.0.0"),
    ].join("\n");
  }
  const t = s.team;
  const lines = [
    `${c.bold(t.name)} as ${c.bold(`@${t.handle}`)}${t.admin ? c.dim(" (admin)") : ""} · relay ${t.relay} · ${t.connected ? c.green("connected") : c.yellow("connecting…")}`,
    c.dim(`  this device: ${t.device.id} · fingerprint ${t.device.fingerprint}`),
  ];
  if (s.invitedBy) {
    lines.push(
      c.dim(
        `  invited by @${s.invitedBy.handle} (fingerprint ${s.invitedBy.fingerprint}); compare it with them`,
      ),
    );
  }
  if (s.members.length) {
    lines.push(
      "",
      table(
        s.members.map((m) => [
          c.bold(`@${m.handle}`) + (m.self ? c.dim(" (you)") : ""),
          m.online ? c.green("online") : c.dim("offline"),
          m.deviceName ?? "",
          c.dim(m.fingerprint),
        ]),
        ["MEMBER", "STATUS", "DEVICE", "FINGERPRINT"],
      ),
    );
  }
  if (s.agents.length) {
    lines.push(
      "",
      table(
        s.agents.map((a) => [
          `${a.member}/${a.name}`,
          a.tool,
          stateColor(a.state),
          c.dim(ago(a.at)),
        ]),
        ["TEAMMATE AGENT", "TOOL", "STATE", "UPDATED"],
      ),
    );
  }
  return lines.join("\n");
}

export const team: Command = async (ctx) => {
  const [sub = "status", ...rest] = ctx.argv;
  const sub2 = { ...ctx, argv: rest };
  switch (sub) {
    case "status":
    case "members": {
      parse(sub2.argv, {});
      await ctx.client.ensureDaemon();
      const s = await ctx.client.request<TeamStatus>("GET", "/v1/team");
      out(ctx, s, () => printStatus(s));
      return 0;
    }
    case "create": {
      const { values, positionals } = parse(sub2.argv, {
        relay: { type: "string", short: "r" },
        handle: { type: "string" },
      });
      const [name] = positionals;
      if (!name || !values.relay) {
        throw new UsageError(
          "usage: agentlink team create <name> --relay ws://<host>:7700 [--handle <you>]",
        );
      }
      await ctx.client.ensureDaemon();
      const s = await ctx.client.request<TeamStatus>(
        "POST",
        "/v1/team/create",
        { name, relay: values.relay, ...(values.handle ? { handle: values.handle } : {}) },
        { timeoutMs: 20_000 },
      );
      out(ctx, s, () =>
        [
          `${c.green("✓")} created team ${c.bold(s.team?.name ?? name)}`,
          printStatus(s),
          "",
          `Invite someone: ${c.bold("agentlink team invite")}`,
        ].join("\n"),
      );
      return 0;
    }
    case "invite": {
      const { values } = parse(sub2.argv, {
        uses: { type: "string", default: "1" },
        ttl: { type: "string", default: "24h" },
      });
      const uses = Number(values.uses);
      if (!Number.isInteger(uses) || uses < 1 || uses > 100)
        throw new UsageError("--uses must be a whole number from 1 to 100");
      await ctx.client.ensureDaemon();
      const res = await ctx.client.request<{ invite: string }>("POST", "/v1/team/invite", {
        uses: Number(values.uses),
        ttlMs: parseDuration(String(values.ttl), 24 * 3600_000, "h"),
      });
      out(ctx, res, () =>
        [
          `${c.green("✓")} invite (valid ${values.ttl}, ${values.uses} use${values.uses === "1" ? "" : "s"}). Send it over a private channel:`,
          "",
          res.invite,
          "",
          c.dim("They run: agentlink team join <invite>"),
          c.yellow(
            "Anyone with this invite can join and read team messages: treat it like a password.",
          ),
        ].join("\n"),
      );
      return 0;
    }
    case "join": {
      const { values, positionals } = parse(sub2.argv, { handle: { type: "string" } });
      const [invite] = positionals;
      if (!invite) throw new UsageError("usage: agentlink team join <invite> [--handle <you>]");
      if (
        !invite
          .trim()
          .replace(/^agentlink:\/\/join\//, "")
          .startsWith("al1.")
      ) {
        throw new UsageError(
          "that is not an agentlink invite; invites start with al1. (get one with: agentlink team invite)",
        );
      }
      await ctx.client.ensureDaemon();
      const s = await ctx.client.request<TeamStatus>(
        "POST",
        "/v1/team/join",
        { invite, ...(values.handle ? { handle: values.handle } : {}) },
        { timeoutMs: 20_000 },
      );
      out(ctx, s, () =>
        [`${c.green("✓")} joined ${c.bold(s.team?.name ?? "the team")}`, printStatus(s)].join("\n"),
      );
      return 0;
    }
    case "leave": {
      parse(sub2.argv, {});
      await ctx.client.ensureDaemon();
      await ctx.client.request("POST", "/v1/team/leave", {});
      out(
        ctx,
        { ok: true },
        () =>
          `${c.green("✓")} left the team; this device's keys stay in ${join(ctx.paths.keysDir)}`,
      );
      return 0;
    }
    default:
      throw new UsageError(
        `unknown team command "${sub}"${didYouMean(sub, ["status", "members", "create", "invite", "join", "leave"])}; use status|create|invite|join|leave`,
      );
  }
};

export const relay: Command = async (ctx) => {
  const [sub, ...rest] = ctx.argv;
  if (sub !== "serve") {
    throw new UsageError(
      `${sub ? `unknown relay command "${sub}"${didYouMean(sub, ["serve"])}; ` : ""}usage: agentlink relay serve [--host 0.0.0.0] [--port 7700] [--data <dir>]`,
    );
  }
  const { values } = parse(rest, {
    host: { type: "string", default: "127.0.0.1" },
    port: { type: "string", default: "7700" },
    data: { type: "string" },
  });
  const { startRelay } = await import("../../relay/server.ts");
  const running = await startRelay({
    dataDir: values.data ?? join(ctx.paths.home, "relay"),
    host: String(values.host),
    port: Number(values.port),
    logger: createLogger({ stderr: true }),
  });
  process.stdout.write(
    [
      `${c.green("✓")} agentlink relay on ${running.url} (data: ${values.data ?? join(ctx.paths.home, "relay")})`,
      c.dim("  It stores and forwards sealed blobs; it cannot read messages. Ctrl-C to stop."),
      String(values.host) === "127.0.0.1"
        ? c.dim(
            "  Only this machine can reach it; use --host 0.0.0.0 (or a tailnet IP) for teammates.",
          )
        : "",
    ]
      .filter(Boolean)
      .join("\n") + "\n",
  );
  await new Promise<void>((resolve) => {
    const stop = () => void running.close().then(resolve);
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  return 0;
};
