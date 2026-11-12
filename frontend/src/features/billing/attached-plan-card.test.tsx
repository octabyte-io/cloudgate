import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  AttachedPaidBy,
  PayForItYourself,
  Standing,
} from "@/lib/api/endpoints/billing";

const useStanding = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api/use-standing", () => ({ useStanding }));

const { AttachedPlanCard } = await import("./attached-plan-card");

const HOPPER: AttachedPaidBy = {
  name: "Hopper Labs",
  roomLeft: { servers: 1, cloudEnvironments: 3 },
  payForItYourself: null,
};

const LIMIT_REASON =
  "You already own Bletchley, and a person can own one Organization that pays for itself";

function standing(paymentFailed: boolean): Standing {
  return {
    frozen: false,
    causes: [],
    paymentFailed: false,
    lapsedAt: null,
    suspendedReason: null,
    payingOrganization: { name: "Hopper Labs", paymentFailed },
  };
}

/** A row's text, found by its label. */
function row(label: string): string | null {
  return screen.getByText(label).parentElement?.textContent ?? null;
}

function renderCard(
  paymentFailed = false,
  payForItYourself: PayForItYourself | null = null,
) {
  useStanding.mockReturnValue({ data: standing(paymentFailed) });
  render(
    <AttachedPlanCard
      paidBy={{ ...HOPPER, payForItYourself }}
      usage={{ servers: 2, cloudEnvironments: 1 }}
      catalogue={<p>plans card</p>}
    />,
  );
}

afterEach(() => {
  cleanup();
  useStanding.mockReset();
});

describe("AttachedPlanCard", () => {
  it("shows the Paid by chip, who changes the plan, its own use and the room left on the plan", () => {
    renderCard();

    expect(screen.getByText("Paid by Hopper Labs")).toBeDefined();
    expect(
      screen.getByText(
        "Only the owners and admins of Hopper Labs change the plan this Organization is on.",
      ),
    ).toBeDefined();
    expect(row("Servers in this Organization")).toContain("2");
    expect(row("Servers left on the plan")).toContain("1");
    expect(row("Cloud Environments in this Organization")).toContain("1");
    expect(row("Cloud Environments left on the plan")).toContain("3");
    expect(
      screen.getByText(
        "Room left is shared with the other Organizations on Hopper Labs's plan.",
      ),
    ).toBeDefined();
  });

  it("offers no plan, Checkout or Add-on button to anyone but its owner", () => {
    renderCard();

    expect(screen.queryAllByRole("button")).toEqual([]);
    expect(screen.queryByText("plans card")).toBeNull();
  });

  describe("Pay for it yourself", () => {
    it("is offered to its owner, saying there is no Free trial and that it stays on the plan until the payment goes through", () => {
      renderCard(false, { allowed: true, reason: null, code: null });

      const button = screen.getByRole("button", {
        name: "Pay for it yourself",
      });
      expect(button.getAttribute("aria-disabled")).not.toBe("true");
      expect(
        screen.getByText(
          "Take this Organization off Hopper Labs's plan by paying for it yourself. There is no Free trial, and it stays on Hopper Labs's plan until your first payment goes through.",
        ),
      ).toBeDefined();
      expect(screen.queryByText("plans card")).toBeNull();
    });

    it("opens the plans to check out once pressed", () => {
      renderCard(false, { allowed: true, reason: null, code: null });

      fireEvent.click(
        screen.getByRole("button", { name: "Pay for it yourself" }),
      );

      expect(screen.getByText("plans card")).toBeDefined();
    });

    it("is greyed out with the backend's reason when its owner already owns an Organization that pays for itself", () => {
      renderCard(false, {
        allowed: false,
        reason: LIMIT_REASON,
        code: "ORGANIZATION_LIMIT",
      });

      const button = screen.getByRole("button", {
        name: "Pay for it yourself",
      });
      expect(button.getAttribute("aria-disabled")).toBe("true");
      expect(screen.getByText(`${LIMIT_REASON}.`)).toBeDefined();
      fireEvent.click(button);
      expect(screen.queryByText("plans card")).toBeNull();
    });
  });

  it("says, calmly, that the Paying Organization's payment is failing", () => {
    renderCard(true);

    expect(screen.getByRole("status").textContent).toBe(
      "Hopper Labs's payment is failing; only its owners and admins can fix it.",
    );
  });

  it("says nothing about the payment while it is not failing", () => {
    renderCard(false);

    expect(screen.queryByRole("status")).toBeNull();
  });
});
