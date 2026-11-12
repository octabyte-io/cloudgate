import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/api-error";

const api = vi.hoisted(() => ({
  purchases: vi.fn(),
  finishPaying: vi.fn(),
  cancel: vi.fn(),
}));

vi.mock("@/lib/auth/client", () => ({
  useActiveOrganizationId: () => ({ organizationId: "org-1" }),
}));
vi.mock("@/lib/api/endpoints/bought-servers", () => ({
  boughtServersApi: api,
}));
vi.mock("@/lib/api/use-invalidate", () => ({
  useInvalidate: () => ({ boughtServers: () => Promise.resolve() }),
}));

const { PurchasesCard } = await import("./purchases-card");

const WAITING = {
  id: "abc",
  name: "web-1",
  stage: "waiting_for_payment",
  monthlyCents: 2500,
  createdAt: "2026-11-10T12:00:00.000Z",
};

function renderCard() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <PurchasesCard enabled />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  api.purchases.mockResolvedValue([WAITING]);
});

afterEach(() => {
  cleanup();
  api.purchases.mockReset();
  api.finishPaying.mockReset();
  api.cancel.mockReset();
});

describe("PurchasesCard", () => {
  it("lists a Server waiting for payment with its price, Finish paying and Cancel", async () => {
    renderCard();

    const list = await screen.findByRole("list", {
      name: "Servers being bought",
    });
    const row = within(list).getByRole("listitem");
    expect(row.textContent).toContain("web-1");
    expect(row.textContent).toContain("Waiting for payment");
    expect(row.textContent).toContain("$25.00/month");
    expect(
      within(row).getByRole("button", { name: "Finish paying" }),
    ).toBeTruthy();
    expect(within(row).getByRole("button", { name: "Cancel" })).toBeTruthy();
  });

  it("offers no actions while the Server is being created", async () => {
    api.purchases.mockResolvedValue([{ ...WAITING, stage: "creating" }]);
    renderCard();

    const list = await screen.findByRole("list", {
      name: "Servers being bought",
    });
    expect(list.textContent).toContain("Creating");
    expect(within(list).queryByRole("button")).toBeNull();
  });

  it("shows a deleted Server as Deleting, with no action, until it is gone", async () => {
    api.purchases.mockResolvedValue([{ ...WAITING, stage: "deleting" }]);
    renderCard();

    const list = await screen.findByRole("list", {
      name: "Servers being bought or deleted",
    });
    expect(list.textContent).toContain("Deleting");
    expect(within(list).queryByRole("button")).toBeNull();
  });

  it("is not there while nothing is being bought", async () => {
    api.purchases.mockResolvedValue([]);
    const { container } = renderCard();

    await waitFor(() => expect(api.purchases).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });

  it("says nothing was charged once Cancel goes through", async () => {
    api.cancel.mockResolvedValue({ id: "abc" });
    renderCard();

    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));

    expect(
      await screen.findByText(
        "The purchase of web-1 was cancelled. Nothing was charged.",
      ),
    ).toBeTruthy();
    expect(api.cancel).toHaveBeenCalledWith("abc");
  });

  it("says why when Finish paying finds the card refused", async () => {
    api.finishPaying.mockRejectedValue(
      new ApiError(
        402,
        "The payment was refused, so nothing was charged and no Server was bought. Your card has insufficient funds.",
        { code: "BOUGHT_SERVER_PAYMENT_REFUSED" },
      ),
    );
    renderCard();

    fireEvent.click(
      await screen.findByRole("button", { name: "Finish paying" }),
    );

    expect(
      await screen.findByText(/Your card has insufficient funds/),
    ).toBeTruthy();
  });
});
