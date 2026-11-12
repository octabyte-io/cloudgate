import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/api-error";
import type { SpendFigures, TokenSpend } from "@/lib/api/endpoints/token-spend";

const forAiModel = vi.fn();
vi.mock("@/lib/api/endpoints/token-spend", () => ({
  tokenSpendApi: {
    forAiModel: (...args: unknown[]) => forAiModel(...args),
  },
}));

vi.mock("@/lib/auth/client", () => ({
  useActiveOrganizationId: () => ({ organizationId: "org_1" }),
}));

const { TokenSpendCard } = await import("./token-spend-card");

const figures = (
  prompt: [number, number],
  completion: [number, number],
  calls: Partial<SpendFigures["calls"]> = {},
): SpendFigures => ({
  promptTokens: { reported: prompt[0], estimated: prompt[1] },
  completionTokens: { reported: completion[0], estimated: completion[1] },
  calls: { ok: 0, runtimeError: 0, clientAborted: 0, refused: 0, ...calls },
});

const SPEND: TokenSpend = {
  from: "2026-10-15",
  to: "2026-10-16",
  total: figures([1100, 40], [500, 0], {
    ok: 6,
    runtimeError: 1,
    clientAborted: 2,
    refused: 3,
  }),
  days: [
    { day: "2026-10-15", ...figures([1000, 0], [500, 0]) },
    { day: "2026-10-16", ...figures([100, 40], [0, 0]) },
  ],
  breakdown: [
    {
      agentId: "u1",
      agentUserId: "u1",
      agentName: "chat-bot",
      model: "smollm2:135m",
      ...figures([1000, 0], [500, 0], { ok: 5, runtimeError: 1 }),
    },
    {
      agentId: "u2",
      agentUserId: null,
      agentName: "old-bot",
      model: "smollm2:135m",
      ...figures([100, 40], [0, 0], { ok: 1, clientAborted: 2, refused: 3 }),
    },
  ],
};

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const mount = () =>
  render(<TokenSpendCard applicationId="app-1" />, { wrapper: Wrapper });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-16T12:00:00.000Z"));
  forAiModel.mockReset();
  forAiModel.mockResolvedValue(SPEND);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("TokenSpendCard", () => {
  it("asks for 30 days first, then each range's UTC days, and 'all' with no bounds", async () => {
    mount();
    await screen.findByText("1,640");
    expect(forAiModel).toHaveBeenLastCalledWith("app-1", {
      from: "2026-09-17",
      to: "2026-10-16",
    });

    const ranges = screen.getByRole("group", { name: "Token spend window" });
    const pick = async (name: string, window: object) => {
      fireEvent.click(within(ranges).getByRole("button", { name }));
      await waitFor(() =>
        expect(forAiModel).toHaveBeenLastCalledWith("app-1", window),
      );
    };
    await pick("7 days", { from: "2026-10-10", to: "2026-10-16" });
    await pick("90 days", { from: "2026-07-19", to: "2026-10-16" });
    await pick("All", {});
    expect(
      within(ranges)
        .getByRole("button", { name: "All" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("marks the estimated tokens apart from the reported ones", async () => {
    mount();
    await screen.findByText("1,640");
    expect(screen.getByText(/of which/).textContent).toBe(
      "of which 40 estimated, over 12 calls",
    );

    const legend = screen.getByLabelText("Legend");
    expect(within(legend).getByText("Reported")).toBeTruthy();
    expect(within(legend).getByText("Estimated")).toBeTruthy();

    // The day with an estimate draws it as its own, striped segment.
    const estimated = document.querySelectorAll(
      '[data-slot="spend-columns"] [data-part="estimated"]',
    );
    expect(estimated).toHaveLength(1);
    expect((estimated[0] as HTMLElement).style.backgroundImage).toContain(
      "repeating-linear-gradient",
    );

    // And every day's two parts are in the chart's table.
    const table = screen.getByRole("table", { name: /Tokens by UTC day/ });
    const oct16 = within(table).getByRole("row", { name: /Oct 16/ });
    expect(
      within(oct16)
        .getAllByRole("cell")
        .map((c) => c.textContent),
    ).toEqual(["100", "40"]);
  });

  it("lists each Agent × model with its calls per outcome, a removed Agent by its kept name", async () => {
    mount();
    const table = await screen.findByRole("table", {
      name: /by Agent and model served/,
    });
    const heads = within(table)
      .getAllByRole("columnheader")
      .map((head) => head.textContent);
    expect(heads).toEqual(
      expect.arrayContaining([
        "ok",
        "runtime-error",
        "client-aborted",
        "refused",
      ]),
    );

    const removed = within(table).getByRole("row", { name: /old-bot/ });
    expect(within(removed).getByText("Removed")).toBeTruthy();
    expect(
      within(removed)
        .getAllByRole("cell")
        .map((cell) => cell.textContent),
    ).toEqual([
      "old-botRemoved",
      "smollm2:135m",
      "140",
      "40",
      "1",
      "0",
      "2",
      "3",
    ]);

    const live = within(table).getByRole("row", { name: /chat-bot/ });
    expect(within(live).queryByText("Removed")).toBeNull();
  });

  it("says a refusal, rather than drawing a window with no spend", async () => {
    forAiModel.mockRejectedValue(new ApiError(403, "Forbidden resource"));
    mount();
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Your role in this Organization does not allow this",
    );
    expect(screen.queryByText(/No calls/)).toBeNull();
  });

  it("says when nobody has called it in the window", async () => {
    forAiModel.mockResolvedValue({
      ...SPEND,
      total: figures([0, 0], [0, 0]),
      days: SPEND.days.map((d) => ({ ...d, ...figures([0, 0], [0, 0]) })),
      breakdown: [],
    });
    mount();
    expect(
      await screen.findByText("No calls in the last 30 days"),
    ).toBeTruthy();
  });
});
