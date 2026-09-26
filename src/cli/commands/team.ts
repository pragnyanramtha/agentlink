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
          m.self || t.connected
            ? m.online
              ? c.green("online")
              : c.dim("offline")
            : c.dim("unknown"),
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
        "create-token": { type: "string" },
      });
      const [name] = positionals;
      if (!name) {
        throw new UsageError(
          "usage: agentlink team create <name> [--relay <url>] [--handle <you>] [--create-token <t>]",
        );
      }
      await ctx.client.ensureDaemon();
      const s = await ctx.client.request<TeamStatus>(
        "POST",
        "/v1/team/create",
        {
          name,
          ...(values.relay ? { relay: values.relay } : {}),
          ...(values.handle ? { handle: values.handle } : {}),
          ...(values["create-token"] ? { createToken: values["create-token"] } : {}),
        },
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
        "no-code": { type: "boolean" },
      });
      const ttlMs = parseDuration(String(values.ttl), 24 * 3600_000, "h");
      if (!(ttlMs > 0))
        throw new UsageError("--ttl must be more than 0 (e.g. 30m, 24h, 7d is 168h)");
      const uses = Number(values.uses);
      if (!Number.isInteger(uses) || uses < 1 || uses > 100)
        throw new UsageError("--uses must be a whole number from 1 to 100");
      await ctx.client.ensureDaemon();
      const res = await ctx.client.request<{
        invite: string;
        code?: string;
        codeExpiresAt?: string;
        relay: string;
        communityRelay: boolean;
      }>("POST", "/v1/team/invite", { uses: Number(values.uses), ttlMs, code: !values["no-code"] });
      const relayFlag = res.communityRelay ? "" : ` --relay ${res.relay}`;
      const minutes = Math.round((Date.parse(res.codeExpiresAt ?? "") - Date.now()) / 60_000);
      const long = `valid ${values.ttl}, ${values.uses} use${values.uses === "1" ? "" : "s"}`;
      out(ctx, res, () =>
        [
          res.code
            ? `${c.green("✓")} invite code (one use, expires in ${minutes} min):`
            : `${c.green("✓")} invite (${long}):`,
          "",
          `    ${c.bold(res.code ?? res.invite)}`,
          "",
          `They run: ${c.bold(`agentlink team join ${res.code ? `${res.code}${relayFlag}` : "<invite>"}`)}`,
          ...(res.code
            ? ["", c.dim(`Long form (${long}, carries the relay address):`), c.dim(res.invite)]
            : []),
          c.yellow(
            "Anyone with this code or invite can join and read team messages: share it privately.",
          ),
        ].join("\n"),
      );
      return 0;
    }
    case "join": {
      const { values, positionals } = parse(sub2.argv, {
        handle: { type: "string" },
        relay: { type: "string", short: "r" },
      });
      const [invite] = positionals;
      if (!invite)
        throw new UsageError(
          "usage: agentlink team join <invite> [--handle <you>] [--relay <url>]",
        );
      const trimmed = invite
        .trim()
        .toLowerCase()
        .replace(/^agentlink:\/\/join\//, "");
      if (!trimmed.startsWith("al1.") && !/^[a-z]+-[a-z]+-[a-z]+-[a-z]+-\d{2}$/.test(trimmed)) {
        throw new UsageError(
          "that is not an agentlink invite: use the code (like tiger-lamp-orbit-sun-42) or the al1.… string from agentlink team invite",
        );
      }
      await ctx.client.ensureDaemon();
      const s = await ctx.client.request<TeamStatus>(
        "POST",
        "/v1/team/join",
        {
          invite,
          ...(values.handle ? { handle: values.handle } : {}),
          ...(values.relay ? { relay: values.relay } : {}),
        },
        { timeoutMs: 20_000 },
      );
      out(ctx, s, () =>
        [`${c.green("✓")} joined ${c.bold(s.team?.name ?? "the team")}`, printStatus(s)].join("\n"),
      );
      return 0;
    }
    case "relay": {
      const { positionals } = parse(sub2.argv, {});
      const [url] = positionals;
      if (!url) throw new UsageError("usage: agentlink team relay <ws://host:port>");
      await ctx.client.ensureDaemon();
      const s = await ctx.client.request<TeamStatus>(
        "POST",
        "/v1/team/relay",
        { url },
        { timeoutMs: 20_000 },
      );
      out(ctx, s, () =>
        [
          s.team?.connected
            ? `${c.green("✓")} now using relay ${s.team.relay}`
            : `${c.yellow("!")} saved relay ${s.team?.relay}, but it is not reachable yet (agentlink keeps retrying)`,
          printStatus(s),
        ].join("\n"),
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
        `unknown team command "${sub}"${didYouMean(sub, ["status", "members", "create", "invite", "join", "relay", "leave"])}; use status|create|invite|join|relay|leave`,
      );
  }
};

export const relay: Command = async (ctx) => {
  const [sub, ...rest] = ctx.argv;
  if (sub !== "serve") {
    throw new UsageError(
      `${sub ? `unknown relay command "${sub}"${didYouMean(sub, ["serve"])}; ` : ""}usage: agentlink relay serve [--host 127.0.0.1] [--port 7700] [--data <dir>] [--create-token <t>]`,
    );
  }
  const { values } = parse(rest, {
    host: { type: "string", default: "127.0.0.1" },
    port: { type: "string", default: "7700" },
    data: { type: "string" },
    "create-token": { type: "string" },
  });
  const createToken = values["create-token"] ?? process.env.AGENTLINK_RELAY_CREATE_TOKEN;
  const { startRelay } = await import("../../relay/server.ts");
  process.umask(0o077);
  const running = await startRelay({
    dataDir: values.data ?? join(ctx.paths.home, "relay"),
    host: String(values.host),
    port: Number(values.port),
    logger: createLogger({ stderr: true }),
    ...(createToken ? { createToken } : {}),
  });
  process.stdout.write(
    [
      `${c.green("✓")} agentlink relay on ${["0.0.0.0", "::"].includes(String(values.host)) ? `port ${running.port}, all interfaces` : running.url} (data: ${values.data ?? join(ctx.paths.home, "relay")})`,
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
