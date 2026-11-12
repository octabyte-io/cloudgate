import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AttachedOrganizations } from "@/lib/api/endpoints/billing";

const useAttachedOrganizations = vi.hoisted(() => vi.fn());
const add = vi.hoisted(() => vi.fn());
const stop = vi.hoisted(() => vi.fn());
const toastDone = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api/use-billing", () => ({
  useAttachedOrganizations,
  useAddOrganizationToPlan: () => ({ isPending: false, mutateAsync: add }),
  useStopPaying: () => ({ isPending: false, mutateAsync: stop }),
}));

const permitted = vi.hoisted(() => ({ current: true }));

vi.mock("@/lib/auth/use-permission", async (original) => ({
  ...(await original<typeof import("@/lib/auth/use-permission")>()),
  usePermission: () => ({ allowed: permitted.current, pending: false }),
}));

vi.mock("@/components/console/toast", () => ({
  toast: { done: toastDone, error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

const { OrganizationsOnPlanCard } =
  await import("./organizations-on-plan-card");

function given(overrides: Partial<AttachedOrganizations> = {}) {
  useAttachedOrganizations.mockReturnValue({
    isPending: false,
    error: null,
    data: {
      name: "Hopper Labs",
      allowed: true,
      reason: null,
      code: null,
      free: { servers: 2, cloudEnvironments: 1 },
      organizations: [],
      ...overrides,
    } satisfies AttachedOrganizations,
  });
  render(<OrganizationsOnPlanCard />);
}

const ADD = "Add an Organization to this plan";

/** The card's button, not the dialog's title of the same words. */
function addButton(): HTMLElement {
  return screen.getByRole("button", { name: ADD });
}

afterEach(() => {
  cleanup();
  permitted.current = true;
  useAttachedOrganizations.mockReset();
  add.mockReset();
  stop.mockReset();
  toastDone.mockReset();
});

describe("OrganizationsOnPlanCard", () => {
  it("lists each Organization the plan pays for: name, owner, Servers, Cloud Environments and the day it was made", () => {
    given({
      organizations: [
        {
          id: "org-turing",
          name: "Turing Works",
          owner: { name: "Alan Turing", email: "alan@example.com" },
          ownedByYou: false,
          servers: 2,
          cloudEnvironments: 1,
          boughtServers: 0,
          createdAt: "2026-03-12T10:00:00.000Z",
        },
      ],
    });

    const row = screen.getByText("Turing Works").closest("tr");
    expect(row?.textContent).toContain("Alan Turing");
    expect(row?.textContent).toContain("alan@example.com");
    expect(row?.textContent).toContain("2026");
    const cells = [...(row?.querySelectorAll("td") ?? [])].map(
      (cell) => cell.textContent,
    );
    expect(cells).toContain("2");
    expect(cells).toContain("1");
  });

  it("greys out the add with the backend's reason, before anyone clicks", () => {
    const reason =
      "Hopper Labs is on Starter, which pays for one Organization. On Business, Hopper Labs can pay for more Organizations";
    given({ allowed: false, reason, code: "ORGANIZATION_LIMIT" });

    expect(addButton().getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByText(`${reason}.`)).toBeDefined();
  });

  it("greys out the add and the detach for anyone but the Paying Organization's owners and admins", () => {
    permitted.current = false;
    given({
      organizations: [
        {
          id: "org-turing",
          name: "Turing Works",
          owner: { name: "Alan Turing", email: "alan@example.com" },
          ownedByYou: false,
          servers: 2,
          cloudEnvironments: 1,
          boughtServers: 0,
          createdAt: "2026-03-12T10:00:00.000Z",
        },
      ],
    });

    expect(addButton().getAttribute("aria-disabled")).toBe("true");
    expect(
      screen
        .getByRole("button", { name: "Stop paying for it" })
        .getAttribute("aria-disabled"),
    ).toBe("true");
  });

  it("says in the dialog how much of the shared pool is free, and makes the Organization", async () => {
    add.mockResolvedValue({ id: "org-new", name: "Babbage Engines" });
    given();

    fireEvent.click(addButton());

    expect(
      screen.getByText(
        /2 Servers and 1 Cloud Environment are free on this plan\./,
      ),
    ).toBeDefined();
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Babbage Engines" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add Organization" }));

    await waitFor(() => expect(add).toHaveBeenCalledWith("Babbage Engines"));
  });
  describe('"Stop paying for it"', () => {
    const turing = {
      id: "org-turing",
      name: "Turing Works",
      owner: { name: "Alan Turing", email: "alan@example.com" },
      ownedByYou: false,
      servers: 2,
      cloudEnvironments: 1,
      boughtServers: 0,
      createdAt: "2026-03-12T10:00:00.000Z",
    };

    it("is the last thing on each row", () => {
      given({ organizations: [turing] });

      const cells = [
        ...(screen
          .getByText("Turing Works")
          .closest("tr")
          ?.querySelectorAll("td") ?? []),
      ];
      expect(cells.at(-1)?.textContent).toBe("Stop paying for it");
    });

    it("asks first, saying it freezes at once, is deleted after 30 days unless its owner pays, emails its owner and leaves the pool now", () => {
      given({ organizations: [turing] });

      fireEvent.click(
        screen.getByRole("button", { name: "Stop paying for it" }),
      );

      const dialog = screen.getByRole("dialog");
      const said = dialog.textContent ?? "";
      expect(said).toContain("Stop paying for Turing Works?");
      expect(said).toContain("Turing Works freezes at once");
      expect(said).toContain(
        "It is deleted after 30 days unless its owner pays for it",
      );
      expect(said).toContain("Alan Turing (alan@example.com) is emailed");
      expect(said).toContain(
        "It leaves this plan now: its 2 Servers and 1 Cloud Environment stop counting against it.",
      );
      expect(stop).not.toHaveBeenCalled();
    });

    it("says nothing of Bought Servers when it has none", () => {
      given({ organizations: [turing] });

      fireEvent.click(
        screen.getByRole("button", { name: "Stop paying for it" }),
      );

      const dialog = screen.getByRole("dialog");
      expect(dialog.textContent).not.toContain("Bought Server");
      expect(dialog.querySelector('[role="alert"]')).toBeNull();
    });

    it("warns first that its Bought Servers are deleted at once unless it pays for itself", () => {
      given({ organizations: [{ ...turing, boughtServers: 2 }] });

      fireEvent.click(
        screen.getByRole("button", { name: "Stop paying for it" }),
      );

      const warning = screen.getByRole("alert");
      expect(warning.textContent).toContain(
        "Turing Works's 2 Bought Servers are deleted at once, with their data and backups, unless Turing Works starts paying for itself before you stop.",
      );
      expect(warning.textContent).toContain("This can’t be undone.");
      expect(stop).not.toHaveBeenCalled();
    });

    it("words the warning for a single Bought Server", () => {
      given({ organizations: [{ ...turing, boughtServers: 1 }] });

      fireEvent.click(
        screen.getByRole("button", { name: "Stop paying for it" }),
      );

      expect(screen.getByRole("alert").textContent).toContain(
        "Turing Works's Bought Server is deleted at once, with its data and backups",
      );
    });

    it("detaches it once confirmed", async () => {
      stop.mockResolvedValue({
        organizationId: "org-turing",
        lapsedAt: "2026-11-08T12:00:00.000Z",
        deletesOn: "2026-12-08T12:00:00.000Z",
      });
      given({ organizations: [turing] });

      fireEvent.click(
        screen.getByRole("button", { name: "Stop paying for it" }),
      );
      const dialog = screen.getByRole("dialog");
      fireEvent.click(
        [...dialog.querySelectorAll("button")].find(
          (button) => button.textContent === "Stop paying",
        )!,
      );

      await waitFor(() => expect(stop).toHaveBeenCalledWith("org-turing"));
      await waitFor(() =>
        expect(toastDone).toHaveBeenCalledWith(
          expect.stringContaining("This plan no longer pays for Turing Works"),
        ),
      );
    });
  });
});
