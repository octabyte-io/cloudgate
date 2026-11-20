import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Domain } from "@/lib/api/endpoints/domains";

import { DomainsAside } from "./domains-aside";
import { useApplicationDomains } from "./use-domains";

const served = vi.hoisted(() => ({
  current: { state: "reading" } as Record<string, unknown>,
}));

vi.mock("./use-domains", () => ({ useApplicationDomains: vi.fn() }));
// What the host serves is the served-certificate read's, tested beside it.
vi.mock("@/lib/api/use-served-certificate", () => ({
  useServedCertificate: (id: string | null) =>
    id === null ? { state: "reading" } : served.current,
}));

afterEach(() => {
  cleanup();
  served.current = { state: "reading" };
});

/** The rail card, fed one domain. */
function asideSays(domain: Partial<Domain>): string {
  vi.mocked(useApplicationDomains).mockReturnValue({
    data: [
      {
        domainId: "d1",
        host: "shop.example.com",
        port: 3000,
        https: true,
        customCertResolver: null,
        storedCertificate: null,
        ...domain,
      },
    ],
    isPending: false,
  } as unknown as ReturnType<typeof useApplicationDomains>);
  render(<DomainsAside applicationId="a1" />);
  return document.body.textContent ?? "";
}

/**
 * The Overview rail's Certificate row says what the Domains table's Certificate
 * column says — it knew only three choices, so a stored row read "Not
 * managed here".
 */
describe("DomainsAside", () => {
  it("names the stored certificate a stored domain is served with", () => {
    const said = asideSays({
      certificateType: "stored",
      storedCertificate: { certificateId: "c1", name: "shop cert" },
    });
    expect(said).toContain("shop cert");
    expect(said).not.toContain("Not managed here");
  });

  it("says a stored certificate serves a Let's Encrypt host instead", () => {
    const said = asideSays({
      certificateType: "letsencrypt",
      storedCertificate: { certificateId: "c2", name: "wildcard" },
    });
    expect(said).toContain("wildcard");
    expect(said).toContain("instead of Let's Encrypt");
  });

  describe("what a Let's Encrypt host serves (#130)", () => {
    const LETS_ENCRYPT = {
      certificateType: "letsencrypt" as const,
      createdAt: "2026-11-19T22:00:00Z",
    };

    it("says it is issuing, beside the address and on the Certificate row", () => {
      served.current = { state: "issuing" };
      const said = asideSays(LETS_ENCRYPT);

      expect(said).toContain(
        "HTTPS certificate issuing: your browser may warn for a minute.",
      );
      expect(said).toContain("Let's Encrypt · issuing, usually under a minute");
    });

    it("says until when it is valid once issued, and nothing beside the address", () => {
      served.current = {
        state: "issued",
        issuer: "Let's Encrypt",
        notAfter: "2027-02-17T12:00:00.000Z",
      };
      const said = asideSays(LETS_ENCRYPT);

      expect(said).toContain("Let's Encrypt · valid until Feb 17, 2027");
      expect(said).not.toContain("HTTPS certificate");
    });

    it("says it is not issued yet, and what to check", () => {
      served.current = { state: "not-issued" };
      const said = asideSays(LETS_ENCRYPT);

      expect(said).toContain("Let's Encrypt · not issued yet");
      expect(said).toContain(
        "Check that the A record for shop.example.com points at this Server’s address and that port 80 is reachable.",
      );
      expect(said).toContain("HTTPS certificate not issued yet");
    });

    it("reads nothing for a host served over HTTP", () => {
      served.current = { state: "not-issued" };
      const said = asideSays({ ...LETS_ENCRYPT, https: false });

      expect(said).not.toContain("not issued");
      expect(said).toContain("Not managed here");
    });
  });
});
