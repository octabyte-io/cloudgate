import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const subscription = vi.hoisted(() => vi.fn());

// The endpoint is the boundary; the session only says which Organization.
vi.mock("@/lib/api/endpoints/billing", () => ({
  billingApi: { subscription: () => subscription() },
}));
vi.mock("@/lib/auth/client", () => ({
  useActiveOrganizationId: () => ({ organizationId: "org_1", pending: false }),
}));

const { useTrialOpen } = await import("./use-billing");

afterEach(cleanup);
beforeEach(() => {
  subscription.mockReset();
});

let client: QueryClient;

/** Settled once the subscription read has answered, either way. */
function settled() {
  return client.isFetching() === 0 && subscription.mock.calls.length > 0;
}

function trialOpen(enabled = true) {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return renderHook(() => useTrialOpen({ enabled }), {
    wrapper: ({ children }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  }).result;
}

function state(plan: string | null, trialAvailable: boolean) {
  return { allowance: { plan }, trialAvailable };
}

/**
 * Whether the paid-feature pages' no-plan button reads "Start 30-day free
 * trial", decided as the plan picker decides it.
 */
describe("useTrialOpen", () => {
  it("is open with no plan held when the subscription says a trial is available", async () => {
    subscription.mockResolvedValue(state(null, true));
    const result = trialOpen();

    await waitFor(() => expect(result.current).toBe(true));
  });

  it("is closed when the reader or the Organization is not eligible", async () => {
    subscription.mockResolvedValue(state(null, false));
    const result = trialOpen();

    await waitFor(() => expect(settled()).toBe(true));
    expect(result.current).toBe(false);
  });

  it("is closed while a plan is held", async () => {
    subscription.mockResolvedValue(state("starter", true));
    const result = trialOpen();

    await waitFor(() => expect(settled()).toBe(true));
    expect(result.current).toBe(false);
  });

  it("is closed, and reads nothing, when not enabled (a member)", () => {
    subscription.mockResolvedValue(state(null, true));
    const result = trialOpen(false);

    expect(result.current).toBe(false);
    expect(subscription).not.toHaveBeenCalled();
  });

  it("is closed when the read fails", async () => {
    subscription.mockRejectedValue(new Error("403 Forbidden"));
    const result = trialOpen();

    await waitFor(() => expect(settled()).toBe(true));
    expect(result.current).toBe(false);
  });
});
