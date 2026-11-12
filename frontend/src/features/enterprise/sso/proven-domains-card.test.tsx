import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProvenDomain } from "@/lib/api/endpoints/sso";

const provenDomains = vi.hoisted(() => vi.fn());
const addProvenDomain = vi.hoisted(() => vi.fn());
const checkProvenDomain = vi.hoisted(() => vi.fn());
const useActiveOrganizationId = vi.hoisted(() => vi.fn());

// The HTTP client and better-auth's session store, the two boundaries.
vi.mock("@/lib/api/endpoints/sso", async (original) => {
  const actual = await original<typeof import("@/lib/api/endpoints/sso")>();
  return {
    ...actual,
    ssoApi: {
      ...actual.ssoApi,
      provenDomains,
      addProvenDomain,
      checkProvenDomain,
    },
  };
});

vi.mock("@/lib/auth/client", async (original) => ({
  ...(await original<typeof import("@/lib/auth/client")>()),
  useActiveOrganizationId,
}));

const { ProvenDomainsCard } = await import("./proven-domains-card");

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const waiting: ProvenDomain = {
  domain: "acme.com",
  proven: false,
  provenAt: null,
  createdAt: "2026-11-04T10:00:00.000Z",
  record: {
    type: "TXT",
    name: "_cloudgate-challenge.acme.com",
    value: "cloudgate-domain-verification=abc123",
  },
};

function renderCard(rows: ProvenDomain[]) {
  useActiveOrganizationId.mockReturnValue({
    organizationId: "org-1",
    pending: false,
  });
  provenDomains.mockResolvedValue(rows);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrap = (children: ReactNode) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  render(wrap(<ProvenDomainsCard />));
}

/**
 * Proven-domain management: each domain shows the TXT challenge to
 * publish until it is proven, and "Check now" asks the backend to look it up.
 */
describe("ProvenDomainsCard", () => {
  it("shows the TXT record a domain still waits for", async () => {
    renderCard([waiting]);

    expect(await screen.findByText("Waiting for the record")).toBeTruthy();
    expect(screen.getByText("_cloudgate-challenge.acme.com")).toBeTruthy();
    expect(
      screen.getByText("cloudgate-domain-verification=abc123"),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Check now" })).toBeTruthy();
  });

  it("shows a proven domain as proven, with no challenge left to meet", async () => {
    renderCard([{ ...waiting, proven: true, provenAt: waiting.createdAt }]);

    expect(await screen.findByText("Proven")).toBeTruthy();
    expect(screen.queryByText("_cloudgate-challenge.acme.com")).toBeNull();
    expect(screen.queryByRole("button", { name: "Check now" })).toBeNull();
  });

  it("checks the domain's record when asked", async () => {
    renderCard([waiting]);
    checkProvenDomain.mockResolvedValue({ ...waiting, proven: true });

    fireEvent.click(await screen.findByRole("button", { name: "Check now" }));

    await waitFor(() =>
      expect(checkProvenDomain).toHaveBeenCalledWith("acme.com"),
    );
  });

  it("adds a domain to receive its challenge", async () => {
    renderCard([]);
    addProvenDomain.mockResolvedValue(waiting);

    expect(await screen.findByText("No proven domains yet")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Add a domain"), {
      target: { value: " acme.com " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add domain" }));

    await waitFor(() =>
      expect(addProvenDomain).toHaveBeenCalledWith("acme.com"),
    );
  });
});
