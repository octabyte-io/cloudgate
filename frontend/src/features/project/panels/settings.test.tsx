import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PanelProps } from "@/lib/shell/tab-registry";

const usePermission = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/auth/use-permission", async (original) => ({
  ...(await original<typeof import("@/lib/auth/use-permission")>()),
  usePermission,
}));
vi.mock("../use-projects", async (original) => ({
  ...(await original<typeof import("../use-projects")>()),
  useProject: () => ({
    data: { projectId: "p1", name: "Storefront", env: "" },
    error: null,
  }),
  useUpdateProject: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("@/features/environment/use-environments", () => ({
  useEnvironments: () => ({ data: [] }),
}));
// The details form and the variables card have their own tests; this file is
// about Delete.
vi.mock("../project-details-form", () => ({ ProjectDetailsForm: () => null }));
vi.mock("@/components/console/variables-card", () => ({
  VariablesCard: () => null,
}));
vi.mock("../project-facts-card", () => ({ ProjectFactsCard: () => null }));
vi.mock("../delete-project-modal", () => ({
  DeleteProjectModal: ({ open }: { open: boolean }) =>
    open ? <div data-testid="delete-project" /> : null,
}));

const { PROJECT_DELETE_REFUSAL } = await import("../use-projects");
const { default: Panel } = await import("./settings");

afterEach(() => {
  cleanup();
  usePermission.mockReset();
});

/**
 * A Project's Settings tab, its Delete row. `DELETE /projects/:id` is
 * decorated `project: ['delete']`, which the built-in member does not hold
 * — the Projects list's row menu already turns its Delete off on it
 * and this one sat live beside it.
 */
function mount({ remove }: { remove: boolean }) {
  usePermission.mockImplementation((required: Record<string, string[]>) => ({
    allowed: required.project?.[0] === "delete" ? remove : true,
    pending: false,
    role: "member",
  }));
  render(
    <Panel
      {...({
        id: "p1",
        label: "Settings",
        icon: "sliders",
      } as unknown as PanelProps)}
    />,
  );
  return screen.getByRole("button", { name: "Delete" });
}

describe("Project Settings panel", () => {
  it("asks for project:delete", () => {
    mount({ remove: true });
    expect(usePermission).toHaveBeenCalledWith({ project: ["delete"] });
  });

  it("holds Delete off for a role that cannot delete a Project, and says why", () => {
    const button = mount({ remove: false });

    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.hasAttribute("disabled")).toBe(false);
    expect(button.getAttribute("title")).toBe(PROJECT_DELETE_REFUSAL);
    const described = button.getAttribute("aria-describedby");
    expect(described).toBeTruthy();
    expect(document.getElementById(described as string)?.textContent).toBe(
      PROJECT_DELETE_REFUSAL,
    );

    fireEvent.click(button);
    expect(screen.queryByTestId("delete-project")).toBeNull();
  });

  it("offers Delete to a role that can, and opens the dialog", () => {
    const button = mount({ remove: true });

    expect(button.getAttribute("aria-disabled")).not.toBe("true");
    expect(button.hasAttribute("title")).toBe(false);
    expect(document.body.textContent).not.toContain(PROJECT_DELETE_REFUSAL);

    fireEvent.click(button);
    expect(screen.getByTestId("delete-project")).toBeTruthy();
  });
});
