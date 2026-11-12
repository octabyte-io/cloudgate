import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  AttachedPaidBy,
  AttachedPlan,
  BillingState,
} from "@/lib/api/endpoints/billing";
import { ApiError } from "@/lib/api/api-error";

const useSubscription = vi.hoisted(() => vi.fn());
const useAttachedPlan = vi.hoisted(() => vi.fn());
const useProducts = vi.hoisted(() => vi.fn());
const useInvoices = vi.hoisted(() => vi.fn());
const useInstanceMode = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api/use-instance-mode", () => ({ useInstanceMode }));

vi.mock("@/lib/api/use-billing", async (original) => ({
  ...(await original<typeof import("@/lib/api/use-billing")>()),
  useSubscription,
  useAttachedPlan,
  useProducts,
  useInvoices,
}));

// The three cloud cards are their own tests; here only whether they render.
vi.mock("./plan-card", () => ({ PlanCard: () => <p>plan card</p> }));
vi.mock("./plans-card", () => ({
  PlansCard: () => {
    useProducts();
    return <p>plans card</p>;
  },
}));
vi.mock("./organizations-on-plan-card", () => ({
  OrganizationsOnPlanCard: () => <p>organizations on this plan card</p>,
}));
vi.mock("./attached-plan-card", () => ({
  AttachedPlanCard: ({
    paidBy,
    usage,
    catalogue,
  }: {
    paidBy: { name: string };
    usage: { servers: number };
    catalogue: ReactNode;
  }) => (
    <>
      <p>paid by {paidBy.name}</p>
      <p>{usage.servers} servers here</p>
      {catalogue}
    </>
  ),
}));
vi.mock("./invoices-card", () => ({
  InvoicesCard: () => {
    useInvoices();
    return <p>invoices card</p>;
  },
}));

const { BillingSection } = await import("./billing-section");

const SUBSCRIPTION = {
  plan: null,
  status: null,
  addOns: 0,
  allowance: { plan: null, servers: 0, cloudEnvironments: 0 },
  usage: { servers: 0, cloudEnvironments: 0 },
  minimumAddOns: 0,
  sendInvoiceNotifications: false,
  stripeCustomerId: null,
  stripeSubscriptionId: null,
  trialAvailable: false,
  trialEndsAt: null,
  scheduledPlan: null,
  scheduledAt: null,
  trial: null,
  paidBy: null,
  pool: null,
} satisfies BillingState;

const HOPPER: AttachedPaidBy = {
  name: "Hopper Labs",
  roomLeft: { servers: 1, cloudEnvironments: 4 },
  payForItYourself: null,
};

/**
 * Renders the page on `mode`, with the member read answering `attached` and
 * the owner's and admin's read answering as `subscription` says: its data, or
 * the 403 a plain member gets.
 */
function onInstance(
  mode: "hosted" | "self-hosted",
  {
    attached = { paidBy: null, usage: null },
    subscription = "admin",
  }: {
    attached?: AttachedPlan;
    subscription?: "admin" | "member";
  } = {},
) {
  useInstanceMode.mockReturnValue({ isPending: false, error: null, data: mode });
  useAttachedPlan.mockReturnValue({
    isPending: false,
    isSuccess: true,
    isError: false,
    error: null,
    data: attached,
  });
  useSubscription.mockImplementation(({ enabled }: { enabled: boolean }) => {
    if (!enabled) return { isPending: true, error: null, data: undefined };
    return subscription === "admin"
      ? { isPending: false, error: null, data: SUBSCRIPTION }
      : {
          isPending: false,
          error: new ApiError(403, "You are not authorized to read billing"),
          data: undefined,
        };
  });
  render(<BillingSection />);
}

/** Whether the owner's and admin's read was ever switched on. */
const subscriptionAsked = () =>
  useSubscription.mock.calls.some(
    ([options]) => (options as { enabled: boolean }).enabled,
  );

afterEach(() => {
  cleanup();
  useSubscription.mockReset();
  useAttachedPlan.mockReset();
  useProducts.mockReset();
  useInvoices.mockReset();
  useInstanceMode.mockReset();
});

/**
 * On a self-hosted instance the page rendered a failed catalogue, an
 * invoice-email switch whose only answer was a 400, and an allowance of None.
 * The mode comes off `GET /settings/about`; self-hosted, the page is one
 * sentence and asks Stripe nothing.
 */
describe("BillingSection", () => {
  it("says billing is not used on a self-hosted instance, and reads nothing else", () => {
    onInstance("self-hosted");

    expect(screen.getByText("Billing is not used on this instance.")).toBeDefined();
    expect(screen.queryByText("plan card")).toBeNull();
    expect(screen.queryByText("plans card")).toBeNull();
    expect(screen.queryByText("invoices card")).toBeNull();
    expect(useProducts).not.toHaveBeenCalled();
    expect(useInvoices).not.toHaveBeenCalled();
    expect(subscriptionAsked()).toBe(false);
  });

  it("shows the plan, the catalogue and the invoices on the Hosted instance", () => {
    onInstance("hosted");

    expect(screen.queryByText("Billing is not used on this instance.")).toBeNull();
    expect(screen.getByText("plan card")).toBeDefined();
    expect(screen.getByText("plans card")).toBeDefined();
    expect(screen.getByText("invoices card")).toBeDefined();
    expect(screen.getByText("organizations on this plan card")).toBeDefined();
  });

  it("tells a plain member of an Organization that pays for itself that reading billing needs an owner or admin", () => {
    onInstance("hosted", { subscription: "member" });

    expect(
      screen.getByText(/Reading billing needs an owner or admin role/),
    ).toBeDefined();
    expect(screen.queryByText("plan card")).toBeNull();
  });

  it("shows an Attached Organization who pays for it, and no plan, catalogue, invoices or card of its own", () => {
    onInstance("hosted", {
      attached: { paidBy: HOPPER, usage: { servers: 2, cloudEnvironments: 0 } },
    });

    expect(screen.getByText("paid by Hopper Labs")).toBeDefined();
    expect(screen.getByText("2 servers here")).toBeDefined();
    expect(screen.queryByText("plan card")).toBeNull();
    expect(screen.queryByText("plans card")).toBeNull();
    expect(screen.queryByText("invoices card")).toBeNull();
    expect(screen.queryByText("organizations on this plan card")).toBeNull();
    expect(useProducts).not.toHaveBeenCalled();
  });

  it("shows a plain member of an Attached Organization its page, without asking the owner's and admin's read", () => {
    onInstance("hosted", {
      attached: { paidBy: HOPPER, usage: { servers: 2, cloudEnvironments: 0 } },
      subscription: "member",
    });

    expect(screen.getByText("paid by Hopper Labs")).toBeDefined();
    expect(screen.getByText("2 servers here")).toBeDefined();
    expect(screen.queryByText(/Reading billing needs/)).toBeNull();
    // Nothing a member would be refused was asked for.
    expect(subscriptionAsked()).toBe(false);
  });

  it("asks the owner's read for an Attached Organization's own owner, whose \"Pay for it yourself\" opens the plans", () => {
    onInstance("hosted", {
      attached: {
        paidBy: {
          ...HOPPER,
          payForItYourself: { allowed: true, reason: null, code: null },
        },
        usage: { servers: 2, cloudEnvironments: 0 },
      },
    });

    expect(subscriptionAsked()).toBe(true);
    expect(screen.getByText("plans card")).toBeDefined();
  });
});
