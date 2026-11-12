import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/api-error";

const domainStatus = vi.hoisted(() => vi.fn());
const useActiveOrganizationId = vi.hoisted(() => vi.fn());

// Two system boundaries, both replaced rather than driven: the HTTP client and
// better-auth's session store. Nothing of this component's own is doubled.
vi.mock("@/lib/api/endpoints/forward-auth", async (original) => {
  const actual =
    await original<typeof import("@/lib/api/endpoints/forward-auth")>();
  return {
    ...actual,
    forwardAuthApi: { ...actual.forwardAuthApi, domainStatus },
  };
});

vi.mock("@/lib/auth/client", async (original) => ({
  ...(await original<typeof import("@/lib/auth/client")>()),
  useActiveOrganizationId,
}));

const { DomainGateSwitch } = await import("./domain-gate-switch");

afterEach(() => {
  cleanup();
  domainStatus.mockReset();
  useActiveOrganizationId.mockReset();
});

/**
 * What the row says when the gate cannot be read (H-37).
 *
 * The component answered `"Your role cannot manage this"` for any `isForbidden`
 * error and `"Could not be read"` for everything else — a sentence decided from
 * a status, which is the shape H-26 took out of `errorMessage()` and left in one
 * component. A **banned** operator is refused with a 403 on every Cloudgate
 * route, this one included, and was told their role was the problem: there is no
 * role an owner can move them to that would help, and the sentence that would
 * have helped is the one this branch had no way to reach.
 *
 * The two cases below are the same status. That is deliberate — if a later edit
 * puts a status branch back, the ban is the case that breaks.
 */

const ROLE_SENTENCE =
  "Your role in this Organization does not allow this. Ask an owner or an admin to do it, or to change your role.";
const BANNED_SENTENCE = "This account has been banned. Ask an owner to lift the ban.";

function withQuery(children: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function renderSwitch() {
  useActiveOrganizationId.mockReturnValue({
    organizationId: "org-1",
    pending: false,
  });
  render(
    withQuery(<DomainGateSwitch domainId="domain-1" host="app.example.com" />),
  );
}

describe("DomainGateSwitch", () => {
  it("names the ban when the gate read is refused because the account is banned", async () => {
    domainStatus.mockRejectedValue(
      new ApiError(403, "This account is banned", {
        path: "/forward-auth/domains/domain-1",
        code: "BANNED_USER",
      }),
    );
    renderSwitch();

    expect(await screen.findByText(BANNED_SENTENCE)).toBeTruthy();
  });

  /**
   * The control, and the reason this is a re-route rather than a second case:
   * a 403 the backend did not name is still a role refusal, and it must keep
   * saying so — in the console's own words for it, which is the second thing
   * that changed. "Your role cannot manage this" named no fix.
   */
  it("keeps a role refusal a role refusal on the same status", async () => {
    domainStatus.mockRejectedValue(
      new ApiError(403, "Forbidden resource", {
        path: "/forward-auth/domains/domain-1",
      }),
    );
    renderSwitch();

    expect(await screen.findByText(ROLE_SENTENCE)).toBeTruthy();
  });
});
