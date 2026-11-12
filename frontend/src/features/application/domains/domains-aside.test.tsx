import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Domain } from "@/lib/api/endpoints/domains";

import { DomainsAside } from "./domains-aside";
import { useApplicationDomains } from "./use-domains";

vi.mock("./use-domains", () => ({ useApplicationDomains: vi.fn() }));

afterEach(cleanup);

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
});
