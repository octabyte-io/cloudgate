import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TemplateSummary } from "@/lib/api/endpoints/templates";

import type { WizardState } from "./wizard-state";

const reads = vi.hoisted(() => ({
  code: null as string | null,
  trialAvailable: true,
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

  it("waits for the plan to land after a paid Checkout", () => {
    reads.code = "PLAN_REQUIRED";
    render(<OwnFlow template={GHOST} state={state({ checkout: "success" })} />);

    expect(screen.getByRole("status").textContent).toMatch(
      /Confirming your plan/,
    );
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
