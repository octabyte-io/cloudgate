import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  formatMoney,
  type BillingState,
  type TrialState,
} from "@/lib/api/endpoints/billing";

const portal = vi.hoisted(() => vi.fn());
const keepTrial = vi.hoisted(() => vi.fn());
const cancelTrial = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api/use-billing", () => ({
  usePortal: () => ({ isPending: false, mutateAsync: portal }),
  useKeepTrial: () => ({ isPending: false, mutateAsync: keepTrial }),
  useCancelTrial: () => ({ isPending: false, mutateAsync: cancelTrial }),
}));

/** `usePermission`'s verdict: held unless a case takes it away. */
const permitted = vi.hoisted(() => ({ current: true }));
vi.mock("@/lib/auth/use-permission", async (original) => ({
  ...(await original<typeof import("@/lib/auth/use-permission")>()),
  usePermission: () => ({ allowed: permitted.current, pending: false }),
}));

const { PlanCard } = await import("./plan-card");

function state(overrides: Partial<BillingState> = {}): BillingState {
  return {
    plan: "starter",
    status: "active",
    addOns: 1,
    allowance: { plan: "starter", servers: 4, cloudEnvironments: 4 },
    usage: { servers: 1, cloudEnvironments: 2 },
    minimumAddOns: 0,
    sendInvoiceNotifications: false,
    stripeCustomerId: "cus_1",
    stripeSubscriptionId: "sub_1",
    trialAvailable: false,
    trialEndsAt: null,
    scheduledPlan: null,
    scheduledAt: null,
    trial: null,
    paidBy: null,
    pool: null,
    ...overrides,
  };
}

/** The meter's figure, found by its label. */
function meterValue(label: string): string | null {
  const meter = screen.getByText(label).closest("div")?.parentElement;
  return meter?.textContent ?? null;
}

afterEach(cleanup);

/**
 * The billing page shows Cloud Environments used against the count,
 * beside Servers, each from the backend's own usage.
 */
describe("PlanCard", () => {
  it("shows Cloud Environments in use against the count, beside Servers", () => {
    render(<PlanCard subscription={state()} />);

    expect(meterValue("Servers in use")).toContain("1 of 4");
    expect(meterValue("Cloud Environments in use")).toContain("2 of 4");
  });

  it("says a full Cloud Environment count refuses only the next one, and an over count stops nothing", () => {
    render(
      <PlanCard
        subscription={state({ usage: { servers: 0, cloudEnvironments: 4 } })}
      />,
    );
    expect(
      screen.getByText(
        "Adding another Cloud Environment is refused until an Add-on makes room.",
      ),
    ).toBeDefined();
    cleanup();

    render(
      <PlanCard
        subscription={state({ usage: { servers: 0, cloudEnvironments: 6 } })}
      />,
    );
    expect(meterValue("Cloud Environments in use")).toContain("6 of 4");
    expect(
      screen.getByText(
        "Over the allowance. Every Cloud Environment keeps running; adding another is refused until an Add-on makes room.",
      ),
    ).toBeDefined();
  });

  describe("on a Paying Organization with Organizations attached", () => {
    /** Hopper Labs holds 1 Server; two Attached Organizations hold 3 more. */
    const paying = (overrides: Partial<BillingState> = {}) =>
      state({
        plan: "business",
        allowance: { plan: "business", servers: 5, cloudEnvironments: 5 },
        usage: { servers: 1, cloudEnvironments: 0 },
        pool: {
          usage: { servers: 4, cloudEnvironments: 2 },
          organizations: 3,
        },
        ...overrides,
      });

    it("meters the whole pool, used across every Organization on the plan, with this one's own share", () => {
      render(<PlanCard subscription={paying()} />);

      expect(meterValue("Servers in use")).toContain("4 of 5");
      expect(meterValue("Cloud Environments in use")).toContain("2 of 5");
      expect(
        screen.getByText(
          "4 used across 3 Organizations: 1 in this one, 3 in the other Organizations on this plan.",
        ),
      ).toBeDefined();
      expect(
        screen.getByText(
          "2 used across 3 Organizations: none in this one, 2 in the other Organizations on this plan.",
        ),
      ).toBeDefined();
    });

    it("says a full pool refuses the next one in any Organization on it", () => {
      render(
        <PlanCard
          subscription={paying({
            pool: {
              usage: { servers: 5, cloudEnvironments: 0 },
              organizations: 3,
            },
          })}
        />,
      );

      expect(meterValue("Servers in use")).toContain("5 of 5");
      expect(
        screen.getByText(
          "Adding another Server is refused until an Add-on makes room.",
        ),
      ).toBeDefined();
    });
  });

  it("says nothing about other Organizations with nothing attached", () => {
    render(<PlanCard subscription={state()} />);

    expect(screen.queryByText(/used across/)).toBeNull();
  });

  it("shows no meter without a plan", () => {
    render(
      <PlanCard
        subscription={state({
          plan: null,
          status: null,
          addOns: 0,
          allowance: { plan: null, servers: 0, cloudEnvironments: 0 },
          usage: { servers: 0, cloudEnvironments: 1 },
          stripeCustomerId: null,
          stripeSubscriptionId: null,
        })}
      />,
    );
    expect(screen.queryByText("Cloud Environments in use")).toBeNull();
  });

  it("says when a waiting downgrade moves the plan to Starter", () => {
    const at = "2026-11-28T09:00:00.000Z";
    render(
      <PlanCard
        subscription={state({
          plan: "business",
          allowance: { plan: "business", servers: 4, cloudEnvironments: 4 },
          scheduledPlan: "starter",
          scheduledAt: at,
        })}
      />,
    );
    const day = new Date(at).toLocaleDateString(undefined, {
      day: "numeric",
      month: "long",
    });
    expect(screen.getByText(`Moves to Starter on ${day}`)).toBeTruthy();
  });

  /** Where a free trial stands, on the Billing page only. */
  describe("during a free trial", () => {
    const NOW = new Date("2026-11-23T08:00:00.000Z");
    const ENDS = "2026-12-05T10:00:00.000Z";
    const day = (iso: string) =>
      new Date(iso).toLocaleDateString(undefined, {
        day: "numeric",
        month: "long",
      });

    const trialing = (trial: Partial<TrialState> = {}) =>
      state({
        plan: "business",
        status: "trialing",
        addOns: 2,
        allowance: { plan: "business", servers: 5, cloudEnvironments: 5 },
        trialEndsAt: ENDS,
        trial: {
          endsAt: ENDS,
          cancelled: false,
          firstCharge: { amount: 6500, currency: "usd", at: ENDS },
          paymentMethod: { brand: "visa", last4: "4242" },
          paymentMethodMissing: false,
          ...trial,
        },
      });

    const row = (label: string) =>
      screen.getByText(label).closest("div")?.textContent ?? "";

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(NOW);
    });
    afterEach(() => {
      vi.useRealTimers();
      keepTrial.mockReset();
      cancelTrial.mockReset();
    });

    it("shows the days left on the Plan row, the end date, and the first charge with its card and what it is for", () => {
      render(<PlanCard subscription={trialing()} />);

      // 12 days and 2 hours: a part day counts.
      expect(screen.getByText("Free trial · 13 days left")).toBeTruthy();
      expect(row("Trial ends")).toContain(day(ENDS));
      expect(row("First charge")).toContain(
        `${formatMoney(6500, "usd")} on ${day(ENDS)}, to the Visa ending 4242 (Business + 2 Add-ons)`,
      );
      expect(
        screen.queryByRole("button", { name: "Add a card at Stripe" }),
      ).toBeNull();
      expect(screen.getByRole("button", { name: "Cancel trial" })).toBeTruthy();
    });

    it("leaves the Add-ons out of the charge when there are none, and says 1 day left", () => {
      vi.setSystemTime(new Date("2026-12-04T12:00:00.000Z"));
      render(
        <PlanCard
          subscription={{
            ...trialing({ paymentMethod: { brand: "link", last4: null } }),
            addOns: 0,
            plan: "starter",
          }}
        />,
      );

      expect(screen.getByText("Free trial · 1 day left")).toBeTruthy();
      expect(row("First charge")).toContain(
        `${formatMoney(6500, "usd")} on ${day(ENDS)}, to the Link (Starter)`,
      );
    });

    it("offers Add a card at Stripe when the card was removed, through the portal", async () => {
      portal.mockResolvedValue({ url: "" });
      render(
        <PlanCard
          subscription={trialing({
            paymentMethod: null,
            paymentMethodMissing: true,
          })}
        />,
      );

      expect(row("First charge")).toContain("with no card on file");
      fireEvent.click(
        screen.getByRole("button", { name: "Add a card at Stripe" }),
      );
      await vi.waitFor(() => expect(portal).toHaveBeenCalledTimes(1));
    });

    it("keeps Add a card at Stripe off, with why, for a role that cannot manage billing", () => {
      permitted.current = false;
      portal.mockClear();
      try {
        render(
          <PlanCard
            subscription={trialing({
              paymentMethod: null,
              paymentMethodMissing: true,
            })}
          />,
        );

        const add = screen.getByRole("button", {
          name: "Add a card at Stripe",
        });
        expect(add.getAttribute("aria-disabled")).toBe("true");
        expect(add.getAttribute("title")).toContain(
          "Your role in this Organization cannot",
        );
        fireEvent.click(add);
        expect(portal).not.toHaveBeenCalled();
      } finally {
        permitted.current = true;
      }
    });

    it("cancels behind a confirm that says nothing is charged", async () => {
      cancelTrial.mockResolvedValue({});
      render(<PlanCard subscription={trialing()} />);

      fireEvent.click(screen.getByRole("button", { name: "Cancel trial" }));
      expect(screen.getByText("Cancel the free trial?")).toBeTruthy();
      expect(
        screen.getByText(
          `Business stays until ${day(ENDS)}. Then: No plan. Nothing is charged.`,
        ),
      ).toBeTruthy();
      fireEvent.click(
        screen.getAllByRole("button", { name: "Cancel trial" }).at(-1)!,
      );
      await vi.waitFor(() => expect(cancelTrial).toHaveBeenCalledTimes(1));
    });

    it("once cancelled, says No plan. Nothing is charged, and Keep <plan> takes it back", async () => {
      keepTrial.mockResolvedValue({});
      render(
        <PlanCard
          subscription={trialing({ cancelled: true, firstCharge: null })}
        />,
      );

      expect(row(`From ${day(ENDS)}`)).toContain(
        "No plan. Nothing is charged.",
      );
      expect(screen.queryByText("First charge")).toBeNull();
      expect(screen.queryByRole("button", { name: "Cancel trial" })).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "Keep Business" }));
      await vi.waitFor(() => expect(keepTrial).toHaveBeenCalledTimes(1));
    });

    it("shows no trial rows outside a trial", () => {
      render(<PlanCard subscription={state()} />);
      expect(screen.queryByText(/Free trial/)).toBeNull();
      expect(screen.queryByText("Trial ends")).toBeNull();
      expect(screen.queryByRole("button", { name: "Cancel trial" })).toBeNull();
    });
  });
});
