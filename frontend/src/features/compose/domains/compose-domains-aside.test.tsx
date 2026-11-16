import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Domain } from "@/lib/api/endpoints/domains";

import { ComposeDomainsAside } from "./compose-domains-aside";
import { useComposeDomains } from "./use-compose-domains";

vi.mock("./use-compose-domains", () => ({ useComposeDomains: vi.fn() }));

afterEach(cleanup);

const DOMAIN = {
  domainId: "d1",
  host: "ackee.example.com",
  port: 3000,
  https: true,
  certificateType: "letsencrypt",
  customCertResolver: null,
  storedCertificate: null,
  serviceName: "ackee",
} as unknown as Domain;

function renderWith(data: Domain[]) {
  vi.mocked(useComposeDomains).mockReturnValue({
    data,
    isPending: false,
  } as unknown as ReturnType<typeof useComposeDomains>);
  render(<ComposeDomainsAside composeId="cmp-1" />);
}

describe("ComposeDomainsAside", () => {
  it("opens the stack's first domain and names the service it routes into", () => {
    renderWith([DOMAIN]);

    expect(screen.getByRole("heading", { name: "Domain" })).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: /ackee\.example\.com/ })
        .getAttribute("href"),
    ).toBe("https://ackee.example.com");
    const text = document.body.textContent ?? "";
    expect(text).toContain("Service");
    expect(text).toContain("ackee");
    expect(text).toContain(":3000");
  });

  it("links the rest to the Domains tab", () => {
    renderWith([DOMAIN, { ...DOMAIN, domainId: "d2", host: "b.example.com" }]);

    expect(screen.getByRole("heading", { name: "Domains" })).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "1 more" }).getAttribute("href"),
    ).toBe("/compose/cmp-1/domains");
  });

  it("stays with no domain, pointing at the tab that adds one", () => {
    renderWith([]);

    expect(
      screen.getByRole("link", { name: "Add a domain" }).getAttribute("href"),
    ).toBe("/compose/cmp-1/domains");
    expect(document.body.textContent).toContain(
      "to reach this stack from the internet",
    );
  });
});
