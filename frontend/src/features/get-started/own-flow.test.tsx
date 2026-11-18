import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TemplateSummary } from "@/lib/api/endpoints/templates";

import type { WizardState } from "./wizard-state";

const reads = vi.hoisted(() => ({
  code: null as string | null,
  trialAvailable: true,
  waited: 0,
}));
const checkout = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/use-permission", () => ({
  usePermission: () => ({ allowed: true, pending: false, role: "owner" }),
}));
vi.mock("@/lib/api/use-instance-mode", () => ({
  useInstanceMode: () => ({ data: "hosted" }),
}));
vi.mock("@/lib/api/use-billing", () => ({
  useSubscription: () => ({
    data: { trialAvailable: reads.trialAvailable },
  }),
  useProducts: () => ({
    data: {
      plans: { starter: { unitAmount: 1500, currency: "usd" } },
    },
  }),
  useCheckout: () => ({ mutate: checkout, isPending: false, error: null }),
}));
vi.mock("./use-get-started", () => ({
  useWizardServerRoom: () => ({
    isPending: false,
    data: { canCreateMoreServers: reads.code === null, code: reads.code },
  }),
  useSecondsWaited: () => reads.waited,
}));
vi.mock("./own-server-form", () => ({
  OwnServerForm: () => <p>The server form</p>,
}));
vi.mock("./own-connect", () => ({
  OwnConnect: () => <p>Connecting</p>,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

const { OwnFlow } = await import("./own-flow");

const GHOST = { id: "ghost", name: "Ghost" } as TemplateSummary;

function state(over: Partial<WizardState>): WizardState {
  return {
    templateId: "ghost",
    path: "own",
    serverId: null,
    deploying: false,
    environmentId: null,
    checkout: null,
    ...over,
  };
}

beforeEach(() => {
  reads.code = null;
  reads.trialAvailable = true;
  reads.waited = 0;
  checkout.mockReset();
});

afterEach(cleanup);

describe("OwnFlow", () => {
  it("asks for the server's details when a server can be added", () => {
    render(<OwnFlow template={GHOST} state={state({})} />);

    expect(screen.getByText("The server form")).toBeTruthy();
  });

  it("offers the free trial first when the organization has no plan", () => {
    reads.code = "PLAN_REQUIRED";
    render(<OwnFlow template={GHOST} state={state({})} />);

    expect(
      screen.getByRole("heading", { name: "Start your 30-day free trial" }),
    ).toBeTruthy();
    expect(screen.getByText(/then \$15\.00 a month/)).toBeTruthy();
  });

  it("starts Checkout for Starter with the wizard's own address to come back to", async () => {
    reads.code = "PLAN_REQUIRED";
    render(<OwnFlow template={GHOST} state={state({})} />);

    fireEvent.click(screen.getByRole("button", { name: "Start free trial" }));

    await waitFor(() => expect(checkout).toHaveBeenCalled());
    expect(checkout.mock.calls[0][0]).toEqual({
      plan: "starter",
      addOns: 0,
      returnTo: "/get-started?template=ghost&path=own",
    });
  });

  it("says the plan starts today where the trial was used", () => {
    reads.code = "PLAN_REQUIRED";
    reads.trialAvailable = false;
    render(<OwnFlow template={GHOST} state={state({})} />);

    expect(screen.getByRole("button", { name: "Choose Starter" })).toBeTruthy();
  });

  it("waits for the plan to land after a paid Checkout, saying how long it has waited", () => {
    reads.code = "PLAN_REQUIRED";
    reads.waited = 4;
    render(<OwnFlow template={GHOST} state={state({ checkout: "success" })} />);

    const stages = screen.getByRole("list", { name: "Starting your plan" });
    expect(within(stages).getByText("Confirming your plan")).toBeTruthy();
    expect(screen.getByText("Usually a few seconds. Waiting 4s.")).toBeTruthy();
    expect(screen.queryByText(/taking longer than usual/)).toBeNull();
  });

  it("says a long wait for the plan needs no second payment, and where to look", () => {
    reads.code = "PLAN_REQUIRED";
    reads.waited = 31;
    render(<OwnFlow template={GHOST} state={state({ checkout: "success" })} />);

    expect(screen.getByText(/You don.t need to pay again/)).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Billing page" }).getAttribute("href"),
    ).toBe("/settings/billing");
  });

  it("says nothing was charged after a cancelled Checkout", () => {
    reads.code = "PLAN_REQUIRED";
    render(
      <OwnFlow template={GHOST} state={state({ checkout: "cancelled" })} />,
    );

    expect(screen.getByText(/nothing was charged/)).toBeTruthy();
  });

  it("goes on to connecting once the server is recorded", () => {
    render(<OwnFlow template={GHOST} state={state({ serverId: "srv_1" })} />);

    expect(screen.getByText("Connecting")).toBeTruthy();
  });
});
