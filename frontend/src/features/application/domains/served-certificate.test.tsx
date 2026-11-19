import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Domain } from "@/lib/api/endpoints/domains";

const served = vi.hoisted(() => ({
  current: { state: "reading" } as Record<string, unknown>,
  asked: [] as Array<{ id: string | null; since?: number }>,
}));

vi.mock("@/lib/api/use-served-certificate", () => ({
  useServedCertificate: (
    id: string | null,
    options: { since?: number } = {},
  ) => {
    served.asked.push({ id, since: options.since });
    return id === null ? { state: "reading" } : served.current;
  },
}));

const { CertificateCell } = await import("./served-certificate");

afterEach(() => {
  cleanup();
  served.current = { state: "reading" };
  served.asked = [];
});

const ROW = {
  domainId: "d1",
  host: "shop.example.com",
  https: true,
  certificateType: "letsencrypt",
  customCertResolver: null,
  storedCertificate: null,
  createdAt: "2026-11-19T22:00:00Z",
} as unknown as Domain;

describe("CertificateCell (#130)", () => {
  it("counts the wait from when the Domain was made", () => {
    render(<CertificateCell row={ROW} />);

    expect(served.asked[0]).toEqual({
      id: "d1",
      since: Date.parse("2026-11-19T22:00:00Z"),
    });
  });

  it("links a certificate not issued yet to the Server's Traefik log", () => {
    served.current = { state: "not-issued" };
    render(<CertificateCell row={ROW} serverId="srv-1" />);

    expect(
      screen
        .getByRole("link", { name: "the Server’s Traefik log" })
        .getAttribute("href"),
    ).toBe("/servers/srv-1/docker");
  });

  it("keeps a stored certificate's words, warning only when what is served is not trusted", () => {
    const stored = {
      ...ROW,
      certificateType: "stored",
      storedCertificate: { certificateId: "c1", name: "shop cert" },
    } as unknown as Domain;

    served.current = { state: "issued", issuer: "Acme CA", notAfter: null };
    const { unmount } = render(<CertificateCell row={stored} />);
    expect(document.body.textContent).toContain("shop cert");
    expect(document.body.textContent).not.toContain("Browsers warn");
    unmount();

    served.current = { state: "not-issued" };
    render(<CertificateCell row={stored} />);
    expect(document.body.textContent).toContain("shop cert");
    expect(document.body.textContent).toContain(
      "Browsers warn here: what this host serves is not a trusted certificate for it.",
    );
  });

  it("asks nothing for a cloud Domain, whose certificate is its cloud's", () => {
    render(
      <CertificateCell
        row={{ ...ROW, cloud: { status: "issued" } } as unknown as Domain}
      />,
    );

    expect(served.asked[0].id).toBeNull();
  });
});
