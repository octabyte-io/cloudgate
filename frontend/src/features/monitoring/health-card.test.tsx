import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/api-error";

const useInfrastructureHealth = vi.hoisted(() => vi.fn());

// One system boundary, replaced rather than driven: the HTTP read. Nothing of
// this card's own is doubled — the branch under test is its own.
vi.mock("./use-monitoring", async (original) => ({
  ...(await original<typeof import("./use-monitoring")>()),
  useInfrastructureHealth,
}));

const { HealthCard } = await import("./health-card");

afterEach(() => {
  cleanup();
  useInfrastructureHealth.mockReset();
});

/**
 * Which sentence the top line of Monitoring shows when it cannot read the two
 * legs (H-48).
 *
 * The card decided its wording from `status === 403`, which is the shape H-26
 * took out of `errorMessage()` and H-37 took out of `domain-gate-switch.tsx`. A
 * **banned** operator is refused `GET /settings/infrastructure-health` with the
 * same status as a plain member, and was told an owner or an admin could take
 * this reading for them — true, and not their problem: no role change lifts a
 * ban, and the sentence that would have helped was one this branch had no way to
 * say.
 *
 * The fix is deliberately *narrower* than "call `errorMessage()`": the owner-only
 * sentence below is better than the generic role line, because it also says that
 * nothing is known to be wrong with Postgres or Traefik — which on a health card
 * is the whole question. So the two cases are the same status, and only the code
 * separates them.
 */

const OWNER_SENTENCE =
  "Only an owner or an admin of this Organization can check the platform's own health";
const BANNED_SENTENCE =
  "This account has been banned. Ask an owner to lift the ban.";

function said(error: unknown) {
  useInfrastructureHealth.mockReturnValue({
    data: undefined,
    error,
    isPending: false,
  });
  render(<HealthCard />);
  return document.body.textContent ?? "";
}

describe("HealthCard", () => {
  it("keeps the owner-only reading sentence for a 403 the backend did not name", () => {
    const text = said(
      new ApiError(403, "Only owners and admins can read infrastructure health", {
        path: "/settings/infrastructure-health",
      }),
    );

    expect(text).toContain(OWNER_SENTENCE);
    expect(text).toContain("Nothing is known to be wrong");
    // §3.5 — never `ApiError.message`.
    expect(text).not.toContain("Only owners and admins can read infrastructure");
  });

  it("names the ban when the health read is refused because the account is banned", () => {
    const text = said(
      new ApiError(403, "This account is banned", {
        path: "/settings/infrastructure-health",
        code: "BANNED_USER",
      }),
    );

    expect(text).toContain(BANNED_SENTENCE);
    // The negative assertion the case above is worth nothing without: a role is
    // the one thing that is not the problem here.
    expect(text).not.toContain(OWNER_SENTENCE);
  });

  it("states a failed request rather than a refusal", () => {
    const text = said(new ApiError(500, "Something broke"));

    expect(text).toContain("The backend hit an error handling that");
    expect(text).not.toContain(OWNER_SENTENCE);
  });
});
