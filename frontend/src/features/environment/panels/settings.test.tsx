import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PanelProps } from "@/lib/shell/tab-registry";

const usePermission = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/auth/use-permission", async (original) => ({
  ...(await original<typeof import("@/lib/auth/use-permission")>()),
  usePermission,
}));
vi.mock("../use-environments", async (original) => ({
  ...(await original<typeof import("../use-environments")>()),
  useEnvironment: () => ({
    data: { environmentId: "e1", projectId: "p1", name: "staging", env: "" },
    error: null,
  }),
}));
// The details form has its own test; this file is about Delete.
vi.mock("../environment-details-form", () => ({ EnvironmentDetailsForm: () => null }));
vi.mock("../environment-facts-card", () => ({ EnvironmentFactsCard: () => null }));
vi.mock("../environment-deploy-target-card", () => ({
  EnvironmentDeployTargetCard: () => null,
}));
vi.mock("../environment-config-branch-card", () => ({
  EnvironmentConfigBranchCard: () => null,
}));
vi.mock("../delete-environment-modal", () => ({
  DeleteEnvironmentModal: ({ open }: { open: boolean }) =>
    open ? <div data-testid="delete-environment" /> : null,
}));

const { ENVIRONMENT_DELETE_REFUSAL } = await import("../use-environments");
const { default: Panel } = await import("./settings");

afterEach(() => {
  cleanup();
  usePermission.mockReset();
});

/**
 * An Environment's Settings tab, its Delete row. `DELETE
 * /environments/:id` is decorated `environment: ['delete']`, which neither the
 * built-in member nor a read-only role holds; before this they pressed Delete,
 * typed the name into the dialog and met a 403.
 */
function mount({ allowed }: { allowed: boolean }) {
  usePermission.mockReturnValue({ allowed, pending: false, role: "member" });
  render(<Panel {...({ id: "e1", label: "Settings", icon: "sliders" } as unknown as PanelProps)} />);
  return screen.getByRole("button", { name: "Delete" });
}

describe("Environment Settings panel", () => {
  it("asks for environment:delete", () => {
    mount({ allowed: true });
    expect(usePermission).toHaveBeenCalledWith({ environment: ["delete"] });
  });

  it("holds Delete off for a role that cannot delete an Environment, and says why", () => {
    const remove = mount({ allowed: false });

    expect(remove.getAttribute("aria-disabled")).toBe("true");
    expect(remove.hasAttribute("disabled")).toBe(false);
    expect(remove.getAttribute("title")).toBe(ENVIRONMENT_DELETE_REFUSAL);
    const described = remove.getAttribute("aria-describedby");
    expect(described).toBeTruthy();
    expect(document.getElementById(described as string)?.textContent).toBe(
      ENVIRONMENT_DELETE_REFUSAL,
    );

    fireEvent.click(remove);
    expect(screen.queryByTestId("delete-environment")).toBeNull();
  });

  it("offers Delete to a role that can, and opens the dialog", () => {
    const remove = mount({ allowed: true });

    expect(remove.getAttribute("aria-disabled")).not.toBe("true");
    expect(remove.hasAttribute("title")).toBe(false);
    expect(document.body.textContent).not.toContain(ENVIRONMENT_DELETE_REFUSAL);

    fireEvent.click(remove);
    expect(screen.getByTestId("delete-environment")).toBeTruthy();
  });
});
