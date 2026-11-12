import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { DomainValidation } from "@/lib/api/endpoints/domains";

import { DnsHelper } from "./dns-helper";

afterEach(cleanup);

/**
 * What the panel says about a host nobody can create a record for, and about a
 * check it cannot make.
 *
 * Two separate over-claims, both of them the same mistake — the panel speaking
 * as though it knew something it does not:
 *
 * - **"The record to create at your DNS provider" for a `*.sslip.io` host.**
 *   sslip.io answers from the name itself; the `A` record it named, in the zone
 *   `sslip.io`, is one nobody but sslip.io can create.
 * - **"A certificate can be issued … which it is" with no address to compare
 *   against.** On Cloudgate's own host the dialog validates with no expected
 *   address, and `cdn.service.ts` answers `isValid` for any host that resolves
 *   *at all* — so `dns.google` came back green with a promise an HTTP-01
 *   challenge would have broken.
 *
 * The record half of the panel is unchanged for an ordinary hostname, which is
 * the case it was written for and the one these tests keep.
 */

const OK: DomainValidation = {
  isValid: true,
  resolvedIp: "8.8.8.8",
} as unknown as DomainValidation;

describe("DnsHelper, for an sslip.io host", () => {
  it("does not send the operator to a DNS provider", () => {
    render(
      <DnsHelper
        host="blog-4f2a1c-203-0-113-10.sslip.io"
        serverIp={null}
        result={null}
      />,
    );

    const said = document.body.textContent ?? "";
    expect(said).not.toContain("The record to create at your DNS provider");
    expect(said).toContain("There is no record to create");
    // The address is in the name, so the panel can say what it answers with.
    expect(said).toContain("203.0.113.10");
  });

  it("says a name carrying no address resolves to nothing, and what to set", () => {
    render(
      <DnsHelper host="blog-4f2a1c.sslip.io" serverIp={null} result={null} />,
    );

    // The exact host "Generate one for me" used to hand over.
    expect(document.body.textContent).toContain("carries no address");
    const link = screen.getByRole("link", { name: "Settings → Instance" });
    expect(link.getAttribute("href")).toBe("/settings/instance");
  });

  it("points a Server's stack at Generate rather than at the instance setting", () => {
    render(
      <DnsHelper
        host="blog-4f2a1c.sslip.io"
        serverIp="192.168.1.10"
        result={null}
        noun="stack"
      />,
    );

    const said = document.body.textContent ?? "";
    expect(said).toContain("There is no record to create");
    // The address is the Server's, so the setting on the instance is not what
    // this operator is missing — the button that writes it into a name is.
    expect(screen.queryByRole("link", { name: "Settings → Instance" })).toBe(
      null,
    );
    expect(said).toContain("Generate one for me writes this stack’s address");
    expect(said).toContain("192.168.1.10");
  });
});

describe("DnsHelper, for a hostname with a record to create", () => {
  it("still derives the record, and names the zone it assumed", () => {
    render(
      <DnsHelper host="api.example.com" serverIp="203.0.113.10" result={null} />,
    );

    const said = document.body.textContent ?? "";
    expect(said).toContain("The record to create at your DNS provider");
    expect(said).toContain("example.com");
    expect(said).toContain("203.0.113.10");
  });

  it("leads the platform host to the setting that fills the Value in", () => {
    render(<DnsHelper host="api.example.com" serverIp={null} result={null} />);

    expect(document.body.textContent).toContain(
      "this machine's public address",
    );
    const link = screen.getByRole("link", { name: "Settings → Instance" });
    expect(link.getAttribute("href")).toBe("/settings/instance");
  });
});

describe("DnsHelper, on what Check DNS answered", () => {
  it("does not promise a certificate for a host it could not compare", () => {
    render(
      <DnsHelper host="dns.google" serverIp={null} result={OK} />,
    );

    const said = document.body.textContent ?? "";
    expect(said).toContain("dns.google resolves.");
    expect(said).not.toContain("A certificate can be issued");
    expect(said).toContain("not that it reaches this machine");
  });

  it("keeps the promise where there was an address to compare against", () => {
    render(
      <DnsHelper
        host="api.example.com"
        serverIp="8.8.8.8"
        result={OK}
      />,
    );

    const said = document.body.textContent ?? "";
    expect(said).toContain("api.example.com points here.");
    expect(said).toContain(
      "A certificate can be issued once the record is in place, which it is.",
    );
  });
});
