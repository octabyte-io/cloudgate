import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Environment } from "@/lib/api/endpoints/environments";
import type { PanelProps } from "@/lib/shell/tab-registry";

const usePermission = vi.hoisted(() => vi.fn());
const environments = vi.hoisted(() => ({ data: [] as Environment[] }));

// The caller's statements and the two reads are the boundaries; the dialogs
// are stood in for by a marker that says whether one was opened.
vi.mock("@/lib/auth/use-permission", async (original) => ({
  ...(await original<typeof import("@/lib/auth/use-permission")>()),
  usePermission,
}));
vi.mock("@/features/environment/use-environments", async (original) => ({
  ...(await original<
    typeof import("@/features/environment/use-environments")
  >()),
  useEnvironments: () => ({
    data: environments.data,
    isPending: false,
    error: null,
  }),
}));
vi.mock("../use-projects", async (original) => ({
  ...(await original<typeof import("../use-projects")>()),
  useProject: () => ({ data: { projectId: "p1", name: "Storefront" } }),
}));
vi.mock("../project-facts-card", () => ({ ProjectFactsCard: () => null }));
vi.mock("@/features/environment/environment-form-modal", () => ({
  EnvironmentFormModal: ({ open }: { open: boolean }) =>
    open ? <div data-testid="environment-form" /> : null,
}));
vi.mock("@/features/environment/delete-environment-modal", () => ({
  DeleteEnvironmentModal: ({ open }: { open: boolean }) =>
    open ? <div data-testid="delete-environment" /> : null,
}));

const { ENVIRONMENT_CREATE_REFUSAL, ENVIRONMENT_DELETE_REFUSAL } =
  await import("@/features/environment/use-environments");
const { default: Panel } = await import("./environments");

const staging = {
  environmentId: "e1",
  projectId: "p1",
  name: "staging",
  description: null,
  env: "",
  createdAt: "2026-01-01T00:00:00.000Z",
} as unknown as Environment;

afterEach(() => {
  cleanup();
  usePermission.mockReset();
  environments.data = [];
});

/**
 * A Project's Environments tab. New Environment is `POST
 * /environments`, decorated `environment: ['create']` — which the built-in
 * member does not hold — and the row menu's two items are read here and
 * handed down, because the columns are a declaration and cannot call a hook.
 */
function mount(grants: Record<string, boolean>, rows: Environment[] = []) {
  environments.data = rows;
  usePermission.mockImplementation((required: Record<string, string[]>) => ({
    allowed: grants[Object.values(required)[0][0]] ?? true,
    pending: false,
    role: "member",
  }));
  render(
    <Panel
      {...({
        id: "p1",
        label: "Environments",
        icon: "layers",
      } as unknown as PanelProps)}
    />,
  );
}

describe("Project Environments panel", () => {
  it("asks for each statement its routes check", () => {
    mount({});
    expect(usePermission).toHaveBeenCalledWith({ environment: ["create"] });
    expect(usePermission).toHaveBeenCalledWith({ environment: ["update"] });
    expect(usePermission).toHaveBeenCalledWith({ environment: ["delete"] });
  });

  it("holds New Environment off for a role without environment:create, in the header and the empty state", () => {
    mount({ create: false });

    const buttons = screen.getAllByRole("button", { name: /New Environment/ });
    expect(buttons).toHaveLength(2);
    for (const button of buttons) {
      expect(button.getAttribute("aria-disabled")).toBe("true");
      expect(button.hasAttribute("disabled")).toBe(false);
      expect(button.getAttribute("title")).toBe(ENVIRONMENT_CREATE_REFUSAL);
      fireEvent.click(button);
    }
    expect(screen.queryByTestId("environment-form")).toBeNull();
  });

  it("offers New Environment to a role that holds it, and opens the form", () => {
    mount({ create: true });

    const [header] = screen.getAllByRole("button", { name: /New Environment/ });
    expect(header.getAttribute("aria-disabled")).not.toBe("true");
    expect(header.hasAttribute("title")).toBe(false);

    fireEvent.click(header);
    expect(screen.getByTestId("environment-form")).toBeTruthy();
  });

  it("hands the row menu the delete verdict it read", () => {
    mount({ delete: false }, [staging]);

    fireEvent.click(
      screen.getByRole("button", { name: "Actions for staging" }),
    );
    const remove = screen.getByRole("menuitem", { name: "Delete" });
    expect(remove.getAttribute("aria-disabled")).toBe("true");
    expect(remove.getAttribute("title")).toBe(ENVIRONMENT_DELETE_REFUSAL);
    expect(
      screen
        .getByRole("menuitem", { name: "Rename" })
        .getAttribute("aria-disabled"),
    ).not.toBe("true");

    fireEvent.click(remove);
    expect(screen.queryByTestId("delete-environment")).toBeNull();
  });
});
