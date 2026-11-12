import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/api-error";
import type { BillingState } from "@/lib/api/endpoints/billing";

const useProducts = vi.hoisted(() => vi.fn());

// One system boundary, replaced rather than driven: the catalogue read.
vi.mock("@/lib/api/use-billing", async (original) => ({
  ...(await original<typeof import("@/lib/api/use-billing")>()),
  useProducts,
}));

const { PlansCard } = await import("./plans-card");

afterEach(() => {
  cleanup();
  useProducts.mockReset();
});

/**
 * What the card says when the catalogue does not answer (H-48).
 *
 * The card is rendered only on Cloudgate Cloud — a self-hosted instance gets
 * one sentence from `BillingSection` instead — so an unnamed failure is the
 * payment provider not answering, and a named refusal (a ban) is said in the
 * backend's words. Neither is ever "no plans available".
 */

const PROVIDER_COPY = "The payment provider did not answer";
const HEADLINE = "Cloudgate could not read the plan catalogue.";

const SUBSCRIPTION = {} as unknown as BillingState;

function said(error: unknown) {
  useProducts.mockReturnValue({
    data: undefined,
    error,
    isPending: false,
    isFetching: false,
    refetch: vi.fn(),
  });
  render(<PlansCard subscription={SUBSCRIPTION} />);
  return document.body.textContent ?? "";
}

describe("PlansCard", () => {
  it("says the catalogue did not answer on an unnamed failure", () => {
    const text = said(new ApiError(500, "Stripe is not configured"));

    expect(text).toContain(HEADLINE);
    expect(text).toContain(PROVIDER_COPY);
    // An earlier mistake, and F09's first defect: a claim about the configuration
    // made because a request failed.
    expect(text).not.toContain("No plans available");
    expect(text).not.toContain("Stripe is not configured");
  });

  it("says a named refusal in the backend's words", () => {
    const text = said(
      new ApiError(403, "This account is banned", { code: "BANNED_USER" }),
    );

    expect(text).toContain("This account has been banned. Ask an owner to lift the ban.");
    expect(text).not.toContain(PROVIDER_COPY);
  });
});
