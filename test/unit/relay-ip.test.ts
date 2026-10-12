import { describe, expect, it } from "vitest";
import { rateKey } from "../../src/relay/server.ts";

describe("rateKey", () => {
  it("buckets IPv6 addresses by their /64 prefix", () => {
    expect(rateKey("2001:db8:1:2:aaaa::1")).toBe(rateKey("2001:db8:1:2:bbbb:cccc:dddd:eeee"));
    expect(rateKey("2001:db8:1:2:aaaa::1")).not.toBe(rateKey("2001:db8:1:3::1"));
  });

  it("expands :: compression and normalises case and leading zeros", () => {
    expect(rateKey("2001:db8::1")).toBe(rateKey("2001:0DB8:0000:0000:ffff::"));
    expect(rateKey("2001:db8::1")).not.toBe(rateKey("2001:db8:0:1::1"));
    expect(rateKey("::2001:db8:1:2:3")).not.toBe(rateKey("2001:db8:1:2::3"));
  });

  it("keeps IPv4 and IPv4-mapped addresses per address", () => {
    expect(rateKey("::ffff:203.0.113.5")).toBe("203.0.113.5");
    expect(rateKey("203.0.113.5")).toBe("203.0.113.5");
    expect(rateKey("203.0.113.6")).not.toBe(rateKey("203.0.113.5"));
  });

  it("handles loopback, zone ids and non-addresses without throwing", () => {
    expect(() => rateKey("::1")).not.toThrow();
    expect(rateKey("::1")).toBe(rateKey("::"));
    expect(rateKey("fe80::1%eth0")).toBe(rateKey("fe80::2"));
    expect(rateKey("")).toBe("");
    expect(rateKey("not-an-ip")).toBe("not-an-ip");
  });
});
