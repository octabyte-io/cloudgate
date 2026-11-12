import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AllowanceSource } from "@/lib/api/endpoints/billing";
import type { ForwardAuthTarget } from "@/lib/api/endpoints/forward-auth";

const state = vi.hoisted(() => ({
  licensed: false,
  plan: "starter" as AllowanceSource | null,
  role: "owner",
  targets: [] as unknown[],
  scheduledAt: null as string | null,
}));

const keepBusiness = vi.hoisted(() => vi.fn());

const query = (data: unknown) => ({ data, isPending: false, error: null });
const mutation = () => ({ isPending: false, mutateAsync: vi.fn() });

vi.mock("@/lib/api/use-instance-mode", () => ({
  useInstanceMode: () => ({ data: "hosted", isPending: false }),
}));
vi.mock("@/lib/auth/client", () => ({
  useActiveOrganizationId: () => ({ organizationId: "org-1", pending: false }),
}));
vi.mock("@/features/enterprise/use-license", () => ({
  useLicenseStatus: () =>
    query({ licensed: state.licensed, status: "inactive", validUntil: null }),
}));
vi.mock("@/lib/api/use-organizations", () => ({
  useOrganizations: () =>
    query([
      { id: "org-1", name: "Northwind Labs", member: { role: state.role } },
    ]),
}));
vi.mock("@/lib/api/use-billing", () => ({
  usePlan: () => query({ plan: state.plan, scheduledAt: state.scheduledAt }),
  useTrialOpen: () => false,
  useSubscription: () => query({ status: "active", trial: null }),
  useKeepBusiness: () => ({ isPending: false, mutateAsync: keepBusiness }),
}));
vi.mock("@/components/console/upgrade-confirm", () => ({
  UpgradeConfirm: () => null,
}));
vi.mock("./use-forward-auth", () => ({
  useForwardAuthTargets: () => query(state.targets),
  useForwardAuthProviders: () =>
    query([{ providerId: "okta", issuer: "https://acme.okta.com" }]),
  useSetAuthDomain: mutation,
  useRemoveAuthDomain: mutation,
  useDeployProxy: mutation,
  useRemoveProxy: mutation,
}));

const { ForwardAuthSection } = await import("./forward-auth-section");

const PROTECTING: ForwardAuthTarget = {
  serverId: null,
  name: "Cloudgate Server (local)",
  ipAddress: null,
  status: "running",
  message: null,
  authDomain: "auth.northwind.dev",
  https: true,
  certificateType: "letsencrypt",
  customCertResolver: null,
  callbackUrl: "https://auth.northwind.dev/oauth2/callback",
};

afterEach(() => {
  cleanup();
  Object.assign(state, {
    licensed: false,
    plan: "starter",
    role: "owner",
    targets: [],
    scheduledAt: null,
  });
  keepBusiness.mockReset();
});

const disabled = (name: string) =>
  screen.getByRole("button", { name }).getAttribute("aria-disabled") === "true";

/** Forward auth below Business, kept but stopped or never set up. */
describe("ForwardAuthSection below Business", () => {
  it("shows a running proxy as still protected, with setting up off and removing on", () => {
    state.targets = [PROTECTING];
    render(<ForwardAuthSection />);

    expect(screen.getByRole("status").textContent).toContain(
      "You can't add or change forward auth. This Organization is on Starter. The settings below are kept and work again on Business.",
    );
    expect(screen.getByText("Still protected")).toBeTruthy();
    expect(disabled("Change the domain")).toBe(true);
    expect(disabled("Remove the proxy")).toBe(false);
    expect(disabled("Clear the domain")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Remove the proxy" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("keeps a domain set with no proxy, with deploying off", () => {
    state.targets = [{ ...PROTECTING, status: "stopped" }];
    render(<ForwardAuthSection />);

    expect(disabled("Deploy the proxy")).toBe(true);
    expect(screen.queryByText("Still protected")).toBeNull();
  });

  it("shows the panel when forward auth was never set up", () => {
    state.targets = [{ ...PROTECTING, status: "stopped", authDomain: null }];
    render(<ForwardAuthSection />);

    expect(
      screen.getByText("Forward auth comes with the Business plan."),
    ).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("asks a member of a lapsed Organization to ask for the upgrade", () => {
    state.role = "member";
    state.plan = null;
    state.targets = [PROTECTING];
    render(<ForwardAuthSection />);

    expect(screen.getByRole("status").textContent).toContain(
      "This Organization's plan has lapsed.",
    );
    expect(
      screen.getByText(
        "Ask an owner or admin of Northwind Labs to upgrade.",
      ),
    ).toBeTruthy();
  });

  it("shows neither strip nor chip once on Business", () => {
    state.licensed = true;
    state.plan = "business";
    state.targets = [PROTECTING];
    render(<ForwardAuthSection />);

    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByText("Still protected")).toBeNull();
    expect(disabled("Change the domain")).toBe(false);
  });
});

/** While a downgrade waits, on Business, the page says when. */
describe("ForwardAuthSection while a downgrade waits", () => {
  it("says from when forward auth can't be changed, only while it waits", () => {
    state.licensed = true;
    state.plan = "business";
    state.targets = [PROTECTING];
    state.scheduledAt = "2026-12-01T12:00:00.000Z";
    const { unmount } = render(<ForwardAuthSection />);

    const strip = screen.getByRole("status");
    expect(strip.textContent).toContain(
      "Adding and changing forward auth stops on",
    );
    expect(
      within(strip).getByRole("button", { name: "Keep Business" }),
    ).toBeTruthy();
    expect(disabled("Change the domain")).toBe(false);

    unmount();
    state.scheduledAt = null;
    render(<ForwardAuthSection />);
    expect(screen.queryByRole("status")).toBeNull();
  });
});
