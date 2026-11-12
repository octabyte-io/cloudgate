import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Environment } from "@/lib/api/endpoints/environments";

const usePermission = vi.hoisted(() => vi.fn());
const useUpdateEnvironment = vi.hoisted(() => vi.fn());

// Two system boundaries replaced and nothing of the form's own doubled: the
// caller's effective statements, and the write the button would send.
vi.mock("@/lib/auth/use-permission", async (original) => ({
  ...(await original<typeof import("@/lib/auth/use-permission")>()),
  usePermission,
}));
vi.mock("./use-environments", async (original) => ({
  ...(await original<typeof import("./use-environments")>()),
  useUpdateEnvironment,
}));

const { roleRefusal } = await import("@/lib/auth/use-permission");
const { EnvironmentDetailsForm } = await import("./environment-details-form");

const REFUSAL = roleRefusal("rename or describe this Environment");

const environment = {
  environmentId: "e1",
  projectId: "p1",
  name: "staging",
  description: "Where a change is tried first.",
} as unknown as Environment;

afterEach(() => {
  cleanup();
  usePermission.mockReset();
  useUpdateEnvironment.mockReset();
});

/**
 * Whether Save changes is on offer, and whether it says why when it is not.
 * `PATCH /environments/:id` runs `findOwnedForUpdate`, which asks for
 * `environment: ['update']`; before this a role without it typed a new name,
 * pressed Save and met a bare 403.
 */

/** The form, with a verdict, dirtied so `isDirty` is not the reason. */
function mount({ allowed }: { allowed: boolean }) {
  usePermission.mockReturnValue({
    allowed,
    pending: false,
    role: allowed ? "owner" : "member",
  });
  const mutateAsync = vi.fn(async () => {});
  useUpdateEnvironment.mockReturnValue({ mutateAsync });

  render(<EnvironmentDetailsForm environment={environment} />);

  const name = screen.getByLabelText("Name");
  fireEvent.change(name, { target: { value: "staging-eu" } });

  return {
    name,
    save: screen.getByRole("button", { name: "Save changes" }),
    mutateAsync,
  };
}

describe("EnvironmentDetailsForm", () => {
  it("asks for environment:update", () => {
    mount({ allowed: true });
    expect(usePermission).toHaveBeenCalledWith({ environment: ["update"] });
  });

  it("holds Save off for a role that cannot rewrite an Environment, and says why", () => {
    const { save } = mount({ allowed: false });

    // §3.10 — `aria-disabled`, so it keeps its tab position.
    expect(save.getAttribute("aria-disabled")).toBe("true");
    expect(save.hasAttribute("disabled")).toBe(false);
    expect(save.getAttribute("title")).toBe(REFUSAL);
    const described = save.getAttribute("aria-describedby");
    expect(described).toBeTruthy();
    expect(document.getElementById(described as string)?.textContent).toBe(REFUSAL);
  });

  it("sends nothing when a refused form is submitted anyway", async () => {
    const { name, save, mutateAsync } = mount({ allowed: false });

    fireEvent.click(save);
    // Enter in a field submits the form whatever the button says.
    fireEvent.submit(name.closest("form") as HTMLFormElement);

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(REFUSAL),
    );
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it("offers Save to a role that can, and saves", async () => {
    const { save, mutateAsync } = mount({ allowed: true });

    expect(save.getAttribute("aria-disabled")).not.toBe("true");
    expect(save.hasAttribute("title")).toBe(false);
    expect(document.body.textContent).not.toContain(REFUSAL);

    fireEvent.click(save);
    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith({
        name: "staging-eu",
        description: "Where a change is tried first.",
      }),
    );
  });
});
