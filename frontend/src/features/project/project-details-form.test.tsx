import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Project } from "@/lib/api/endpoints/projects";

const usePermission = vi.hoisted(() => vi.fn());
const useUpdateProject = vi.hoisted(() => vi.fn());

// Two system boundaries replaced and nothing of the form's own doubled: the
// caller's effective statements, and the write the button would send. The branch
// under test is this component's.
vi.mock("@/lib/auth/use-permission", () => ({ usePermission }));
vi.mock("./use-projects", async (original) => ({
  ...(await original<typeof import("./use-projects")>()),
  useUpdateProject,
}));

const { PROJECT_UPDATE_REFUSAL } = await import("./use-projects");
const { ProjectDetailsForm } = await import("./project-details-form");

const project = {
  projectId: "p1",
  name: "Storefront",
  description: "What customers see.",
} as unknown as Project;

afterEach(() => {
  cleanup();
  usePermission.mockReset();
  useUpdateProject.mockReset();
});

/**
 * Whether Save is on offer, and whether it says why when it is not.
 *
 * The base member no longer holds `project: ['update']`, so `PATCH /projects/:id`
 * answers 403 to them — and this form was gated on nothing at all, so a member
 * typed a new name, pressed Save and met the raw refusal. The two assertions
 * that matter are opposites: the member's Save must stay off *after* the form is
 * dirtied, since `isDirty` was the only thing holding it before, and the owner's
 * must come on, since a gate that is always shut is not a gate.
 */

/** The form, with a verdict, dirtied on request so `isDirty` is not the reason. */
function mount({ allowed, dirty }: { allowed: boolean; dirty: boolean }) {
  usePermission.mockReturnValue({
    allowed,
    pending: false,
    role: allowed ? "owner" : "member",
  });
  const mutateAsync = vi.fn(async () => {});
  useUpdateProject.mockReturnValue({ mutateAsync });

  render(<ProjectDetailsForm project={project} />);

  if (dirty) {
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Storefront EU" },
    });
  }

  return {
    save: screen.getByRole("button", { name: "Save changes" }),
    mutateAsync,
  };
}

describe("ProjectDetailsForm", () => {
  it("holds Save off for a role that cannot rewrite a Project, and says why", () => {
    const { save } = mount({ allowed: false, dirty: true });

    // §3.10 — `aria-disabled` for an action, so it keeps its tab position and
    // can be reached by the keyboard user who most needs to hear the reason.
    // Base UI's `focusableWhenDisabled` default is what turns `disabled` into
    // this; the native attribute would take it out of the tab order.
    expect(save.getAttribute("aria-disabled")).toBe("true");
    expect(save.hasAttribute("disabled")).toBe(false);

    // On hover, in the accessibility tree, and on the page without either.
    expect(save.getAttribute("title")).toBe(PROJECT_UPDATE_REFUSAL);
    const described = save.getAttribute("aria-describedby");
    expect(described).toBeTruthy();
    expect(document.getElementById(described as string)?.textContent).toBe(
      PROJECT_UPDATE_REFUSAL,
    );
    expect(document.body.textContent).toContain(PROJECT_UPDATE_REFUSAL);
  });

  it("offers Save to a role that can, once there is a change to save", () => {
    const { save } = mount({ allowed: true, dirty: true });

    expect(save.getAttribute("aria-disabled")).not.toBe("true");
    expect(save.hasAttribute("title")).toBe(false);
    // The negative assertion the case above is worth nothing without: an owner
    // is told nothing about roles.
    expect(document.body.textContent).not.toContain(PROJECT_UPDATE_REFUSAL);
  });

  it("still holds Save off for an unchanged form, and stays quiet about roles", () => {
    const { save } = mount({ allowed: true, dirty: false });

    // The pre-existing reason Save is off. It has no explanation attached,
    // because "you have not changed anything" is visible in the form itself.
    expect(save.getAttribute("aria-disabled")).toBe("true");
    expect(save.hasAttribute("title")).toBe(false);
    expect(document.body.textContent).not.toContain(PROJECT_UPDATE_REFUSAL);
  });

  it("sends nothing when a refused Save is pressed anyway", () => {
    // The primitive swallows the click; this is the assertion that it did, and
    // the one that would fail if the gate were cosmetic.
    const { save, mutateAsync } = mount({ allowed: false, dirty: true });

    fireEvent.click(save);

    expect(mutateAsync).not.toHaveBeenCalled();
  });
});
