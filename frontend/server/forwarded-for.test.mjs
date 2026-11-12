import { describe, expect, it } from "vitest";

import {
  stampForwardedFor,
  trustedProxyFrom,
  unmapIpv4,
} from "./forwarded-for.mjs";

/**
 * The console's half of keeping the client's real address.
 *
 * A Next rewrite to an external destination is a server-side proxy that
 * forwards `x-forwarded-host` and nothing about the caller, so the backend's
 * socket peer was this process on every console request: one address in the
 * Sessions list for every user on the install, and one better-auth rate-limit
 * bucket for all of them — a client that had sent nothing got 429 from someone
 * else's traffic.
 *
 * Both halves have to land together. Forwarding without `TRUST_PROXY=loopback`
 * leaves the backend replacing the chain with the console's address anyway, and
 * `TRUST_PROXY=loopback` without the forwarding records nothing at all.
 */
describe("stampForwardedFor", () => {
  it("states the browser when the request carries no chain", () => {
    const headers = { host: "console.cloudgate.test" };

    stampForwardedFor(headers, "198.51.100.9");

    expect(headers["x-forwarded-for"]).toBe("198.51.100.9");
  });

  /**
   * The security-relevant one. Nothing terminates the connection in front of
   * the console on the topology this project ships, so a chain arriving here is
   * a claim with nothing behind it — and an audit column that lies is worse
   * than one that is blank.
   */
  it("replaces a chain the caller sent rather than appending to it", () => {
    const headers = { "x-forwarded-for": "1.2.3.4" };

    stampForwardedFor(headers, "198.51.100.9");

    expect(headers["x-forwarded-for"]).toBe("198.51.100.9");
  });

  /**
   * Node reports an IPv4 client on a dual-stack listener this way. The dotted
   * form is what the backend appends, what better-auth records and what an
   * operator writes in `TRUST_PROXY`, so sending the mapped form would make the
   * console and the backend disagree about the same machine.
   */
  it("unmaps an IPv4-mapped peer before sending it", () => {
    const headers = {};

    stampForwardedFor(headers, "::ffff:198.51.100.9");

    expect(headers["x-forwarded-for"]).toBe("198.51.100.9");
  });

  /**
   * With no socket there is nothing truthful to say, so the caller's claim is
   * removed rather than passed on: the backend then records its own peer, and
   * blank or loopback beats a stranger's string.
   */
  it("removes the header entirely when there is no socket", () => {
    const headers = { "x-forwarded-for": "1.2.3.4" };

    stampForwardedFor(headers, undefined);

    expect("x-forwarded-for" in headers).toBe(false);
  });
});

describe("unmapIpv4", () => {
  it("leaves a dotted address alone", () => {
    expect(unmapIpv4("198.51.100.9")).toBe("198.51.100.9");
  });

  /**
   * `::ffff:` with no dot is the hex form of the same mapping, and no operator
   * writes it in `TRUST_PROXY` either — rewriting it would produce a string
   * that is not an address at all.
   */
  it("leaves the hex form of the mapping alone", () => {
    expect(unmapIpv4("::ffff:c633:6409")).toBe("::ffff:c633:6409");
  });

  it("leaves a plain IPv6 address alone", () => {
    expect(unmapIpv4("2001:db8::1")).toBe("2001:db8::1");
  });
});

/**
 * The Hosted half: Traefik terminates 443 and reaches the console over
 * docker_gwbridge, so its address is the peer on every request. Trusting
 * exactly that one hop is what keeps each browser its own rate-limit bucket
 * and its own `session.ip_address`; trusting nothing else is what keeps a
 * chain sent straight at the console from being believed.
 */
describe("stampForwardedFor, behind the Hosted instance's Traefik", () => {
  const traefik = trustedProxyFrom("172.18.0.0/16");

  it("keeps the address Traefik appended when the peer is Traefik", () => {
    const headers = { "x-forwarded-for": "198.51.100.9" };

    stampForwardedFor(headers, "172.18.0.3", traefik);

    expect(headers["x-forwarded-for"]).toBe("198.51.100.9");
  });

  it("believes one hop only: what the browser put left of Traefik's entry is dropped", () => {
    const headers = { "x-forwarded-for": "1.2.3.4, 198.51.100.9" };

    stampForwardedFor(headers, "::ffff:172.18.0.3", traefik);

    expect(headers["x-forwarded-for"]).toBe("198.51.100.9");
  });

  it("replaces a chain sent straight at the console, not through Traefik", () => {
    const headers = { "x-forwarded-for": "1.2.3.4" };

    stampForwardedFor(headers, "203.0.113.7", traefik);

    expect(headers["x-forwarded-for"]).toBe("203.0.113.7");
  });

  it("states Traefik itself when it sent no usable chain", () => {
    const missing = {};
    const garbage = { "x-forwarded-for": "not-an-address" };

    stampForwardedFor(missing, "172.18.0.3", traefik);
    stampForwardedFor(garbage, "172.18.0.3", traefik);

    expect(missing["x-forwarded-for"]).toBe("172.18.0.3");
    expect(garbage["x-forwarded-for"]).toBe("172.18.0.3");
  });

  it("trusts no hop when CONSOLE_TRUSTED_PROXY is unset (Self-hosted)", () => {
    const headers = { "x-forwarded-for": "1.2.3.4" };

    stampForwardedFor(headers, "172.18.0.3", trustedProxyFrom(undefined));

    expect(headers["x-forwarded-for"]).toBe("172.18.0.3");
  });
});

describe("trustedProxyFrom", () => {
  it("reads unset or blank as no trusted hop", () => {
    expect(trustedProxyFrom(undefined)).toBeNull();
    expect(trustedProxyFrom("  ")).toBeNull();
  });

  it("reads a bare address as that one address and no other", () => {
    const one = trustedProxyFrom("172.18.0.1");
    const headers = { "x-forwarded-for": "198.51.100.9" };

    stampForwardedFor(headers, "172.18.0.2", one);

    expect(headers["x-forwarded-for"]).toBe("172.18.0.2");
  });

  it.each([
    "172.18.0.0/33",
    "172.18.0.0/x",
    "traefik",
    "10.0.0.0/8,172.18.0.0/16",
    "1.2.3.4/8/8",
  ])("refuses %s at boot rather than trusting nothing quietly", (value) => {
    expect(() => trustedProxyFrom(value)).toThrow(/CONSOLE_TRUSTED_PROXY/);
  });
});
