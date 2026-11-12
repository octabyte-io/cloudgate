import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  AttachedOrganization,
  AttachedOrganizations,
} from "@/lib/api/endpoints/billing";

const useAttachedOrganizations = vi.hoisted(() => vi.fn());
const stop = vi.hoisted(() => vi.fn());
const remove = vi.hoisted(() => vi.fn());
const toastDone = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api/use-billing", () => ({
  useAttachedOrganizations,
  useStopPaying: () => ({ isPending: false, mutateAsync: stop }),
}));

vi.mock("@/lib/api/use-organizations", () => ({
  useDeleteOrganization: () => ({ isPending: false, mutateAsync: remove }),
}));

const permitted = vi.hoisted(() => ({ current: true }));

vi.mock("@/lib/auth/use-permission", async (original) => ({
  ...(await original<typeof import("@/lib/auth/use-permission")>()),
  usePermission: () => ({ allowed: permitted.current, pending: false }),
}));

vi.mock("@/components/console/toast", () => ({
  toast: { done: toastDone, error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

const { StarterChecklist } = await import("./starter-checklist");

const turing: AttachedOrganization = {
  id: "org-turing",
  name: "Turing Works",
  owner: { name: "Alan Turing", email: "alan@example.com" },
  ownedByYou: false,
  servers: 2,
  cloudEnvironments: 1,
  boughtServers: 0,
  createdAt: "2026-03-12T10:00:00.000Z",
};

const babbage: AttachedOrganization = {
  id: "org-babbage",
  name: "Babbage Engines",
  owner: { name: "Grace Hopper", email: "grace@example.com" },
  ownedByYou: true,
  servers: 1,
  cloudEnvironments: 0,
  boughtServers: 0,
  createdAt: "2026-04-02T10:00:00.000Z",
};

/** What the checklist reads now; a later call re-reads it, as a refetch. */
function attached(organizations: AttachedOrganization[]) {
  useAttachedOrganizations.mockReturnValue({
    isPending: false,
    error: null,
    data: {
      name: "Hopper Labs",
      allowed: true,
      reason: null,
      code: null,
      free: { servers: 2, cloudEnvironments: 1 },
      organizations,
    } satisfies AttachedOrganizations,
  });
}

const onCleared = vi.fn();
const onOpenChange = vi.fn();

function renderChecklist() {
  return render(
    <StarterChecklist
      open
      onOpenChange={onOpenChange}
      move="Move to Starter"
      onCleared={onCleared}
    />,
  );
}

/** The checklist's own row for `name`. */
function row(name: string): HTMLElement {
  return screen.getByRole("listitem", { name });
}

afterEach(() => {
  cleanup();
  permitted.current = true;
  useAttachedOrganizations.mockReset();
  stop.mockReset();
  remove.mockReset();
  toastDone.mockReset();
  onCleared.mockReset();
  onOpenChange.mockReset();
});

describe("StarterChecklist", () => {
  it("is titled for the Paying Organization and lists each Attached Organization with its owner and Servers", () => {
    attached([turing, babbage]);
    renderChecklist();

    expect(
      screen.getByText("Before Hopper Labs can move to Starter"),
    ).toBeDefined();
    expect(row("Turing Works").textContent).toContain("Alan Turing");
    expect(row("Turing Works").textContent).toContain("2 Servers");
    expect(row("Babbage Engines").textContent).toContain("Grace Hopper");
    expect(row("Babbage Engines").textContent).toContain("1 Server");
  });

  it('offers "Stop paying for it" on every row, and Delete only on one the reader owns', () => {
    attached([turing, babbage]);
    renderChecklist();

    const theirs = within(row("Turing Works"));
    expect(
      theirs.getByRole("button", { name: "Stop paying for it" }),
    ).toBeDefined();
    expect(theirs.queryByRole("button", { name: "Delete" })).toBeNull();

    const mine = within(row("Babbage Engines"));
    expect(
      mine.getByRole("button", { name: "Stop paying for it" }),
    ).toBeDefined();
    expect(mine.getByRole("button", { name: "Delete" })).toBeDefined();
  });

  it("greys out the detach for anyone but the Paying Organization's owners and admins", () => {
    permitted.current = false;
    attached([turing]);
    renderChecklist();

    expect(
      within(row("Turing Works"))
        .getByRole("button", { name: "Stop paying for it" })
        .getAttribute("aria-disabled"),
    ).toBe("true");
  });

  it("keeps the move disabled while anything is attached", () => {
    attached([turing]);
    renderChecklist();

    const move = screen.getByRole("button", { name: "Move to Starter" });
    // Base UI keeps an off button focusable and marks it aria-disabled.
    expect(move.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(move);
    expect(onCleared).not.toHaveBeenCalled();
  });

  it("detaches through the Stop paying confirm, then comes back to the list", async () => {
    stop.mockResolvedValue({
      organizationId: turing.id,
      lapsedAt: "2026-11-08T10:00:00.000Z",
      deletesOn: "2026-12-08T10:00:00.000Z",
    });
    attached([turing]);
    renderChecklist();

    fireEvent.click(
      within(row("Turing Works")).getByRole("button", {
        name: "Stop paying for it",
      }),
    );
    expect(screen.getByText("Stop paying for Turing Works?")).toBeDefined();

    attached([]);
    fireEvent.click(screen.getByRole("button", { name: "Stop paying" }));
    await waitFor(() => expect(stop).toHaveBeenCalledWith(turing.id));

    await waitFor(() =>
      expect(
        screen.getByText("Before Hopper Labs can move to Starter"),
      ).toBeDefined(),
    );
    expect(
      screen.getByText(
        "Nothing else is on this plan now. Hopper Labs can move to Starter.",
      ),
    ).toBeDefined();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("deletes one the reader owns behind its typed name", async () => {
    remove.mockResolvedValue(undefined);
    attached([babbage]);
    renderChecklist();

    fireEvent.click(
      within(row("Babbage Engines")).getByRole("button", { name: "Delete" }),
    );
    fireEvent.change(screen.getByLabelText("Type Babbage Engines to confirm"), {
      target: { value: "Babbage Engines" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Delete Organization" }),
    );

    await waitFor(() => expect(remove).toHaveBeenCalledWith(babbage.id));
    expect(toastDone).toHaveBeenCalledWith("Babbage Engines is deleted.");
  });

  it("enables the move once the list is empty, and hands over to the normal confirm", () => {
    attached([]);
    renderChecklist();

    expect(
      screen.getByText(
        "Nothing else is on this plan now. Hopper Labs can move to Starter.",
      ),
    ).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Move to Starter" }));
    expect(onCleared).toHaveBeenCalledTimes(1);
  });
});
