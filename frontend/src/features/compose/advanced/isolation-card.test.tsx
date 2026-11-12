import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ComposeDetail } from "@/lib/api/endpoints/compose";

const usePermission = vi.hoisted(() => vi.fn());

// Two boundaries: the caller's effective statements, and the domain list the
// preview reads. The card and its preview are real.
vi.mock("@/lib/auth/use-permission", async (original) => ({
  ...(await original<typeof import("@/lib/auth/use-permission")>()),
  usePermission,
}));
vi.mock("../domains/use-compose-domains", () => ({
  useComposeDomains: () => ({ data: [] }),
}));
vi.mock("@/components/console/toast", () => ({
  toast: { done: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const { COMPOSE_UPDATE_REFUSAL } = await import("../use-compose");
const { IsolationCard } = await import("./isolation-card");

const compose = {
  composeId: "cmp-1",
  appName: "ui-compose-abc",
  composeType: "docker-compose",
  isolatedDeployment: false,
} as unknown as ComposeDetail;

afterEach(() => {
  cleanup();
  usePermission.mockReset();
});

/** The card with a verdict, switched on so `changed` is not the reason. */
function mount({ allowed }: { allowed: boolean }) {
  usePermission.mockReturnValue({ allowed, pending: false, role: "member" });
  const save = vi.fn(async () => undefined);
  render(<IsolationCard compose={compose} save={save} />);
  fireEvent.click(screen.getByRole("switch", { name: "Deploy onto its own network" }));
  return { save, button: screen.getByRole("button", { name: "Save" }) };
}

/**
 * Isolation's Save: `PATCH /compose/:id` with `isolatedDeployment`,
 * which `findOwnedForUpdate` holds to `service: ['update']`.
 */
describe("IsolationCard — Save", () => {
  it("asks for service:update", () => {
    mount({ allowed: true });
    expect(usePermission).toHaveBeenCalledWith({ service: ["update"] });
  });

  it("is off with the reason for a role that cannot change the stack, and sends nothing", () => {
    const { save, button } = mount({ allowed: false });

    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.getAttribute("title")).toBe(COMPOSE_UPDATE_REFUSAL);
    const described = button.getAttribute("aria-describedby");
    expect(described).toBeTruthy();
    expect(document.getElementById(described as string)?.textContent).toBe(
      COMPOSE_UPDATE_REFUSAL,
    );

    fireEvent.click(button);
    expect(save).not.toHaveBeenCalled();
  });

  it("is live for a role that can, and saves", async () => {
    const { save, button } = mount({ allowed: true });

    expect(button.getAttribute("aria-disabled")).not.toBe("true");
    expect(button.hasAttribute("title")).toBe(false);
    expect(document.body.textContent).not.toContain(COMPOSE_UPDATE_REFUSAL);

    fireEvent.click(button);
    await waitFor(() => expect(save).toHaveBeenCalledWith({ isolatedDeployment: true }));
  });
});
