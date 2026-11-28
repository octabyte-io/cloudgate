import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Gate } from "@/lib/auth/use-permission";

const useInstanceGate = vi.hoisted(() => vi.fn<() => Gate>());
const useInfrastructureHealth = vi.hoisted(() => vi.fn());

// The instance-authority read is the boundary (ADR-0013). The fleet's own
// reads and the cards beside the This host card are not what is asked here.
vi.mock("@/features/settings/platform/use-platform", async (original) => ({
  ...(await original<typeof import("@/features/settings/platform/use-platform")>()),
  useInstanceGate,
  useInfrastructureHealth,
}));
vi.mock("@/lib/api/use-servers", () => ({
  useServers: () => ({ data: [], isPending: false, error: null }),
}));
vi.mock("@/lib/auth/use-permission", async (original) => ({
  ...(await original<typeof import("@/lib/auth/use-permission")>()),
  usePermission: () => ({ allowed: true, refusal: "" }),
}));
vi.mock("@/lib/api/use-bought-server-offer", () => ({
  useBoughtServerOffer: () => ({ offered: false, pending: false }),
}));
vi.mock("../buy/purchases-card", () => ({ PurchasesCard: () => null }));
vi.mock("./fleet-aside", () => ({ FleetAside: () => null }));
vi.mock("./add-server-dialogs", () => ({ AddServerDialogs: () => null }));

const { FleetScreen } = await import("./fleet-screen");

const REFUSAL = "Only an administrator of this Cloudgate instance can do this.";

afterEach(() => {
  cleanup();
  useInstanceGate.mockReset();
  useInfrastructureHealth.mockReset();
});

function mount(authority: "held" | "refused" | "pending") {
  useInstanceGate.mockReturnValue(
    authority === "refused"
      ? { allowed: false, refusal: REFUSAL }
      : { allowed: true, refusal: "" },
  );
  useInfrastructureHealth.mockReturnValue({
    isSuccess: authority === "held",
    isPending: authority === "pending",
  });
  render(<FleetScreen />);
}

const hostCard = () => screen.queryByRole("heading", { name: "This host" });

describe("the This host card on Servers", () => {
  it("is left out for a caller the instance gate refuses", () => {
    // A customer on Hosted owns their Organization, so "Only an owner or an
    // admin can open it" read as "you can", and Open a shell only got a 4403.
    mount("refused");

    expect(hostCard()).toBeNull();
    expect(screen.queryByRole("button", { name: "Open a shell" })).toBeNull();
  });

  it("is left out while the instance gate is still being read", () => {
    // Not shown and then taken away from a customer a round trip later.
    mount("pending");

    expect(hostCard()).toBeNull();
  });

  it("is offered to a caller who holds instance authority", () => {
    mount("held");

    expect(hostCard()).not.toBeNull();
    expect(screen.getByRole("button", { name: "Open a shell" })).toBeDefined();
  });
});
