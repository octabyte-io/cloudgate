import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  BillingState,
  Catalogue as CatalogueView,
} from "@/lib/api/endpoints/billing";

const checkout = vi.hoisted(() => vi.fn());
const setAddOns = vi.hoisted(() => vi.fn());
const downgrade = vi.hoisted(() => vi.fn());
const keepBusiness = vi.hoisted(() => vi.fn());
const trialSwitch = vi.hoisted(() => vi.fn());
/** What "Organizations on this plan" reads: nothing attached unless a case says. */
const attachedOrganizations = vi.hoisted(() => ({
  current: [] as unknown[],
}));

/** `usePermission`'s verdict: held unless a case takes it away. */
const permitted = vi.hoisted(() => ({ current: true }));
vi.mock("@/lib/auth/use-permission", async (original) => ({
  ...(await original<typeof import("@/lib/auth/use-permission")>()),
  usePermission: () => ({ allowed: permitted.current, pending: false }),
}));

// Base UI keeps an off button focusable and marks it aria-disabled.
// The two writes are the boundary; the picker's own logic is what is tested.
vi.mock("@/lib/api/use-billing", () => ({
  useCheckout: () => ({ mutateAsync: checkout, isPending: false }),
  useSetAddOns: () => ({ mutateAsync: setAddOns, isPending: false }),
  useUpgradePreview: () => ({ isPending: true, error: null, data: undefined }),
  useUpgrade: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDowngrade: () => ({ mutateAsync: downgrade, isPending: false }),
  useDowngradeImpact: () => ({
    isPending: false,
    error: null,
    data: {
      ssoProviders: 0,
      ssoOnlyPeople: 0,
      scimProviders: 0,
      customRoleHolders: [],
      protectedApps: 0,
      downgradeAt: "2026-11-28T09:00:00.000Z",
    },
  }),
  useKeepBusiness: () => ({ mutateAsync: keepBusiness, isPending: false }),
  useTrialSwitch: () => ({ mutateAsync: trialSwitch, isPending: false }),
  useCancelTrial: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useAttachedOrganizations: () => ({
    isPending: false,
    error: null,
    data: {
      name: "Hopper Labs",
      allowed: true,
      reason: null,
      code: null,
      free: { servers: 0, cloudEnvironments: 0 },
      organizations: attachedOrganizations.current,
    },
  }),
  useStopPaying: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock("@/lib/api/use-organizations", () => ({
  useDeleteOrganization: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

const { Catalogue } = await import("./plan-catalogue");
const { BUSINESS_FEATURES } = await import("./plan-pick-grid");
const { formatDay } = await import("@/lib/api/endpoints/billing");

const monthly = (id: string, name: string, unitAmount: number) => ({
  id,
  name,
  unitAmount,
  currency: "usd",
  interval: "month",
});

const CATALOGUE: CatalogueView = {
  includes: 3,
  plans: {
    starter: monthly("price_starter_plan", "Starter", 1500),
    business: monthly("price_business_plan", "Business", 3500),
  },
  addOn: monthly("price_add_on", "Add-on", 500),
};

function state(overrides: Partial<BillingState> = {}): BillingState {
  return {
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
    ...overrides,
  };
}

const heldStarter = (addOns: number) =>
  state({
    plan: "starter",
    status: "active",
    addOns,
    allowance: {
      plan: "starter",
      servers: 3 + addOns,
      cloudEnvironments: 3 + addOns,
    },
    stripeCustomerId: "cus_1",
    stripeSubscriptionId: "sub_1",
  });

const chosen = () => screen.getByLabelText("Add-ons chosen").textContent;
const fewer = () => screen.getByRole("button", { name: "Fewer Add-ons" });
const more = () => screen.getByRole("button", { name: "More Add-ons" });
const card = (name: "Starter" | "Business") =>
  screen.getByRole("button", { name });
const total = () => screen.getByLabelText("Total").textContent;

afterEach(() => {
  cleanup();
  checkout.mockReset();
  setAddOns.mockReset();
  downgrade.mockReset();
  keepBusiness.mockReset();
  attachedOrganizations.current = [];
  vi.unstubAllGlobals();
});

/**
 * Starter and Business side by side, one Add-on picker both share, the
 * total before Stripe, and a picker that cannot go below what the Organization
 * already uses beyond the plan's base 3.
 */
describe("Catalogue", () => {
  it("shows both plans side by side, with their prices and what each includes", () => {
    render(<Catalogue catalogue={CATALOGUE} subscription={state()} />);

    const starter = card("Starter").textContent ?? "";
    const business = card("Business").textContent ?? "";
    for (const text of [starter, business]) {
      expect(text).toContain("3 Servers and 3 Cloud Environments");
      expect(text).toContain("per month");
    }
    expect(starter).toContain("No SSO, SCIM, custom roles or forward auth");
    for (const feature of BUSINESS_FEATURES) {
      expect(business).toContain(feature);
      expect(starter).not.toContain(feature);
    }
    // One stepper for both plans.
    expect(
      screen.getAllByRole("button", { name: "More Add-ons" }),
    ).toHaveLength(1);
  });

  it("picks Business to start with, and one card at a time", () => {
    render(<Catalogue catalogue={CATALOGUE} subscription={state()} />);

    expect(card("Business").getAttribute("aria-pressed")).toBe("true");
    expect(card("Starter").getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(card("Starter"));

    expect(card("Starter").getAttribute("aria-pressed")).toBe("true");
    expect(card("Business").getAttribute("aria-pressed")).toBe("false");
  });

  it("totals the picked plan and the Add-ons, today and then every month", () => {
    render(<Catalogue catalogue={CATALOGUE} subscription={state()} />);

    expect(total()).toContain("Today, then every month");
    expect(total()).toMatch(/35\.00/);

    fireEvent.click(more());
    expect(total()).toMatch(/40\.00/);

    fireEvent.click(card("Starter"));
    expect(total()).toMatch(/20\.00/);
  });

  it("leaves the total out rather than guessing at a tiered price", () => {
    render(
      <Catalogue
        catalogue={{
          ...CATALOGUE,
          plans: {
            ...CATALOGUE.plans,
            business: { ...CATALOGUE.plans.business, unitAmount: null },
          },
        }}
        subscription={state()}
      />,
    );

    expect(screen.queryByLabelText("Total")).toBeNull();
    fireEvent.click(card("Starter"));
    expect(total()).toMatch(/15\.00/);
  });

  it("starts at the Organization's floor and cannot go below it", () => {
    render(
      <Catalogue
        catalogue={CATALOGUE}
        subscription={state({
          usage: { servers: 5, cloudEnvironments: 0 },
          minimumAddOns: 2,
        })}
      />,
    );

    expect(chosen()).toBe("2");
    expect(fewer().getAttribute("aria-disabled")).toBe("true");

    fireEvent.click(more());
    expect(chosen()).toBe("3");
    fireEvent.click(fewer());
    fireEvent.click(fewer());
    expect(chosen()).toBe("2");
    expect(document.body.textContent).toContain("cannot have fewer than 2");
  });

  it.each([
    ["Business", "business"],
    ["Starter", "starter"],
  ] as const)(
    "subscribes to %s with the chosen Add-ons through Stripe Checkout when there is no plan",
    async (name, plan) => {
      checkout.mockResolvedValue({
        sessionId: "cs_1",
        url: "https://checkout.stripe.com/c/pay/cs_1#fidkdWxOYHwnPyd1blpxYHZxWjA0",
        addOns: 1,
      });
      const assign = vi.fn();
      vi.stubGlobal("location", {
        set href(url: string) {
          assign(url);
        },
      });
      render(<Catalogue catalogue={CATALOGUE} subscription={state()} />);

      fireEvent.click(card(name));
      fireEvent.click(more());
      fireEvent.click(screen.getByRole("button", { name: "Subscribe" }));

      await vi.waitFor(() =>
        expect(checkout).toHaveBeenCalledWith({ plan, addOns: 1 }),
      );
      await vi.waitFor(() =>
        expect(assign).toHaveBeenCalledWith(
          "https://checkout.stripe.com/c/pay/cs_1#fidkdWxOYHwnPyd1blpxYHZxWjA0",
        ),
      );
      expect(setAddOns).not.toHaveBeenCalled();
    },
  );

  it("marks the plan held and changes the Add-ons on the existing subscription", async () => {
    setAddOns.mockResolvedValue({ addOns: 2 });
    render(<Catalogue catalogue={CATALOGUE} subscription={heldStarter(1)} />);

    expect(card("Starter").textContent).toContain("Your plan");
    expect(card("Business").textContent).not.toContain("Your plan");
    // No switching plans here: neither card is a choice.
    expect(card("Business").getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(card("Business"));
    expect(card("Starter").getAttribute("aria-pressed")).toBe("true");
    expect(total()).toContain("Every month");
    expect(total()).toMatch(/20\.00/);

    const update = screen.getByRole("button", { name: "Update Add-ons" });
    // Nothing to change yet.
    expect(update.getAttribute("aria-disabled")).toBe("true");
    expect(screen.queryByRole("button", { name: "Subscribe" })).toBeNull();

    fireEvent.click(more());
    fireEvent.click(update);

    await vi.waitFor(() =>
      expect(setAddOns).toHaveBeenCalledWith({ addOns: 2 }),
    );
    expect(checkout).not.toHaveBeenCalled();
  });

  it("offers the upgrade to Business on an active Starter plan only, behind a confirm", () => {
    render(<Catalogue catalogue={CATALOGUE} subscription={heldStarter(1)} />);

    fireEvent.click(
      screen.getByRole("button", { name: "Upgrade to Business" }),
    );
    expect(screen.getByText("Upgrade to Business?")).toBeTruthy();

    cleanup();
    render(
      <Catalogue
        catalogue={CATALOGUE}
        subscription={{ ...heldStarter(1), plan: "business" }}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "Upgrade to Business" }),
    ).toBeNull();
  });

  describe("the free trial", () => {
    // 5 November 2026: the trial started today ends on 5 December.
    const TODAY = new Date("2026-11-05T12:00:00Z");
    const ENDS_ON = formatDay("2026-12-05T12:00:00Z");

    function renderEligible(overrides: Partial<BillingState> = {}) {
      vi.useFakeTimers({ now: TODAY, toFake: ["Date"] });
      render(
        <Catalogue
          catalogue={CATALOGUE}
          subscription={state({ trialAvailable: true, ...overrides })}
        />,
      );
    }

    afterEach(() => {
      vi.useRealTimers();
    });

    it("offers the 30-day free trial with its terms when the Organization and the reader are eligible", async () => {
      checkout.mockResolvedValue({
        sessionId: "cs_1",
        url: "https://checkout.stripe.com/c/pay/cs_1#fidkdWxOYHwnPyd1blpxYHZxWjA0",
        addOns: 1,
      });
      const assign = vi.fn();
      vi.stubGlobal("location", {
        set href(url: string) {
          assign(url);
        },
      });
      renderEligible();

      fireEvent.click(more());
      // Business, $35, plus one $5 Add-on.
      expect(total()).toBe(
        `Free for 30 days, then from ${ENDS_ON}: $40.00 per month`,
      );
      expect(
        screen.getByText(
          "One free trial per person and per card. If this card has had one, you’ll be charged today.",
        ),
      ).toBeTruthy();
      expect(
        screen.getByText(
          `You can cancel any time before ${ENDS_ON} and pay nothing.`,
        ),
      ).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Subscribe" })).toBeNull();

      fireEvent.click(
        screen.getByRole("button", { name: "Start 30-day free trial" }),
      );
      await vi.waitFor(() =>
        expect(checkout).toHaveBeenCalledWith({ plan: "business", addOns: 1 }),
      );
      await vi.waitFor(() =>
        expect(assign).toHaveBeenCalledWith(
          "https://checkout.stripe.com/c/pay/cs_1#fidkdWxOYHwnPyd1blpxYHZxWjA0",
        ),
      );
    });

    it("keeps Start 30-day free trial off, with why, for a role that cannot manage billing", () => {
      permitted.current = false;
      try {
        renderEligible();

        const start = screen.getByRole("button", {
          name: "Start 30-day free trial",
        });
        expect(start.getAttribute("aria-disabled")).toBe("true");
        expect(start.getAttribute("title")).toContain(
          "Your role in this Organization cannot change this Organization's plan.",
        );
        fireEvent.click(start);
        expect(checkout).not.toHaveBeenCalled();
      } finally {
        permitted.current = true;
      }
    });

    it("says Subscribe and nothing of a trial when not eligible", () => {
      render(<Catalogue catalogue={CATALOGUE} subscription={state()} />);

      expect(screen.getByRole("button", { name: "Subscribe" })).toBeTruthy();
      expect(total()).toContain("Today, then every month");
      expect(screen.queryByText(/trial/i)).toBeNull();
      expect(
        screen.queryByRole("button", { name: "Start 30-day free trial" }),
      ).toBeNull();
    });

    it("keeps the terms but leaves the amount out when the prices cannot be added", () => {
      vi.useFakeTimers({ now: TODAY, toFake: ["Date"] });
      render(
        <Catalogue
          catalogue={{
            ...CATALOGUE,
            plans: {
              ...CATALOGUE.plans,
              business: { ...CATALOGUE.plans.business, unitAmount: null },
            },
          }}
          subscription={state({ trialAvailable: true })}
        />,
      );

      expect(total()).toBe("Free for 30 days");
      expect(
        screen.getByText(
          `You can cancel any time before ${ENDS_ON} and pay nothing.`,
        ),
      ).toBeTruthy();
    });
  });

  const heldBusiness = (overrides: Partial<BillingState> = {}) => ({
    ...heldStarter(1),
    plan: "business" as const,
    allowance: { plan: "business" as const, servers: 4, cloudEnvironments: 4 },
    ...overrides,
  });

  const MOVES_AT = "2026-11-28T09:00:00.000Z";

  it("offers the move to Starter on an active Business plan, behind a confirm that schedules it", async () => {
    downgrade.mockResolvedValue({
      scheduledPlan: "starter",
      scheduledAt: MOVES_AT,
    });
    render(<Catalogue catalogue={CATALOGUE} subscription={heldBusiness()} />);

    fireEvent.click(screen.getByRole("button", { name: "Move to Starter" }));
    expect(screen.getByText("Move to Starter?")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", {
        name: `Downgrade on ${formatDay(MOVES_AT)}`,
      }),
    );

    await vi.waitFor(() => expect(downgrade).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("button", { name: "Keep Business" })).toBeNull();

    cleanup();
    render(<Catalogue catalogue={CATALOGUE} subscription={heldStarter(1)} />);
    expect(
      screen.queryByRole("button", { name: "Move to Starter" }),
    ).toBeNull();
  });

  it("shows a waiting move on both cards, and Keep Business takes it back", async () => {
    keepBusiness.mockResolvedValue({ plan: "business" });
    render(
      <Catalogue
        catalogue={CATALOGUE}
        subscription={heldBusiness({
          scheduledPlan: "starter",
          scheduledAt: MOVES_AT,
        })}
      />,
    );

    const day = formatDay(MOVES_AT);
    expect(card("Business").textContent).toContain(
      `Moves to Starter on ${day}`,
    );
    expect(card("Starter").textContent).toContain(`From ${day}`);
    expect(
      screen.queryByRole("button", { name: "Move to Starter" }),
    ).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Keep Business" }));

    await vi.waitFor(() => expect(keepBusiness).toHaveBeenCalledTimes(1));
    expect(downgrade).not.toHaveBeenCalled();
  });

  describe("switching during a free trial", () => {
    const ENDS = "2026-12-05T10:00:00.000Z";
    const trial = {
      endsAt: ENDS,
      cancelled: false,
      firstCharge: null,
      paymentMethod: null,
      paymentMethodMissing: false,
    };

    afterEach(() => trialSwitch.mockReset());

    it.each([
      ["business", "starter"],
      ["starter", "business"],
    ] as const)(
      "on %s, switches to %s at once at 0 USD, the trial keeping its end, with no upgrade charge or month-end wait",
      async (from, to) => {
        trialSwitch.mockResolvedValue({ plan: to });
        const label = to === "business" ? "Business" : "Starter";
        render(
          <Catalogue
            catalogue={CATALOGUE}
            subscription={heldBusiness({
              plan: from,
              status: "trialing",
              allowance: { plan: from, servers: 5, cloudEnvironments: 5 },
              trialEndsAt: ENDS,
              trial,
            })}
          />,
        );

        expect(
          screen.queryByRole("button", { name: "Move to Starter" }),
        ).toBeNull();
        expect(
          screen.queryByRole("button", { name: "Upgrade to Business" }),
        ).toBeNull();

        fireEvent.click(
          screen.getByRole("button", { name: `Switch to ${label}` }),
        );
        expect(screen.getByText(`Switch to ${label}?`)).toBeTruthy();
        expect(screen.getByLabelText("Today").textContent).toContain(
          "0 USD, still free",
        );
        expect(
          screen.getByText(
            `The free trial still ends on ${formatDay(ENDS)}. The first charge, on that day, is for the plan and Add-ons held then.`,
          ),
        ).toBeTruthy();

        fireEvent.click(
          screen.getAllByRole("button", { name: `Switch to ${label}` }).at(-1)!,
        );
        await vi.waitFor(() => expect(trialSwitch).toHaveBeenCalledWith(to));
        expect(downgrade).not.toHaveBeenCalled();
      },
    );
  });
  /**
   * "Before Hopper Labs can move to Starter": while this plan pays
   * for other Organizations, the move stays clickable and opens the checklist
   * instead of its confirm; the confirm comes once the list is empty.
   */
  describe("while Organizations are attached", () => {
    const TURING = {
      id: "org-turing",
      name: "Turing Works",
      owner: { name: "Alan Turing", email: "alan@example.com" },
      ownedByYou: false,
      servers: 2,
      cloudEnvironments: 1,
      createdAt: "2026-03-12T10:00:00.000Z",
    };
    const CHECKLIST = "Before Hopper Labs can move to Starter";

    it("opens the checklist rather than the confirm, and the move in it stays disabled", () => {
      attachedOrganizations.current = [TURING];
      render(<Catalogue catalogue={CATALOGUE} subscription={heldBusiness()} />);

      fireEvent.click(screen.getByRole("button", { name: "Move to Starter" }));

      expect(screen.getByText(CHECKLIST)).toBeTruthy();
      expect(screen.queryByText("Move to Starter?")).toBeNull();
      const move = screen
        .getAllByRole("button", { name: "Move to Starter" })
        .at(-1)!;
      expect(move.getAttribute("aria-disabled")).toBe("true");
      fireEvent.click(move);
      expect(screen.queryByText("Move to Starter?")).toBeNull();
      expect(downgrade).not.toHaveBeenCalled();
    });

    it("hands over to the normal confirm once the list is empty", async () => {
      attachedOrganizations.current = [TURING];
      const view = render(
        <Catalogue catalogue={CATALOGUE} subscription={heldBusiness()} />,
      );
      fireEvent.click(screen.getByRole("button", { name: "Move to Starter" }));

      attachedOrganizations.current = [];
      view.rerender(
        <Catalogue catalogue={CATALOGUE} subscription={heldBusiness()} />,
      );
      fireEvent.click(
        screen.getAllByRole("button", { name: "Move to Starter" }).at(-1)!,
      );

      expect(screen.queryByText(CHECKLIST)).toBeNull();
      expect(screen.getByText("Move to Starter?")).toBeTruthy();
    });

    it("opens the checklist for the switch to Starter during a free trial too, and not for the switch to Business", () => {
      attachedOrganizations.current = [TURING];
      const trialing = (plan: "business" | "starter") =>
        heldBusiness({
          plan,
          status: "trialing",
          allowance: { plan, servers: 5, cloudEnvironments: 5 },
          trialEndsAt: "2026-12-05T10:00:00.000Z",
          trial: {
            endsAt: "2026-12-05T10:00:00.000Z",
            cancelled: false,
            firstCharge: null,
            paymentMethod: null,
            paymentMethodMissing: false,
          },
        });
      render(
        <Catalogue catalogue={CATALOGUE} subscription={trialing("business")} />,
      );

      fireEvent.click(
        screen.getByRole("button", { name: "Switch to Starter" }),
      );
      expect(screen.getByText(CHECKLIST)).toBeTruthy();
      expect(screen.queryByText("Switch to Starter?")).toBeNull();

      cleanup();
      render(
        <Catalogue catalogue={CATALOGUE} subscription={trialing("starter")} />,
      );
      fireEvent.click(
        screen.getByRole("button", { name: "Switch to Business" }),
      );
      expect(screen.queryByText(CHECKLIST)).toBeNull();
      expect(screen.getByText("Switch to Business?")).toBeTruthy();
    });
  });
});
