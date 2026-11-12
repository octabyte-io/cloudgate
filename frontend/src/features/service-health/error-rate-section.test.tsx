import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ServiceType } from "@/lib/api/endpoints/applications";
import {
  serviceHealthApi,
  type ErrorRate,
  type ErrorRateTotals,
  type ServiceHealth,
} from "@/lib/api/endpoints/service-health";

/**
 * The Health tab's Error rate, driven through the summary read on
 * `serviceHealthApi` — the one boundary it has. The hook, the chart, the
 * tiles and the table are real, so what is asserted is what an operator reads.
 */

const useActiveOrganizationId = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth/client", async (original) => ({
  ...(await original<typeof import("@/lib/auth/client")>()),
  useActiveOrganizationId,
}));

const { ErrorRateSection } = await import("./error-rate-section");

const QUARTER = 15 * 60 * 1000;
const NOW = Date.parse("2026-09-25T10:07:00.000Z");

function totals(requests: number, errors: number, slow = 0): ErrorRateTotals {
  return {
    requests,
    errors,
    slow,
    errorRate: requests === 0 ? null : errors / requests,
    slowShare: requests === 0 ? null : slow / requests,
  };
}

/** 96 quarter-hours: quiet, except the last two. */
function available(): ErrorRate {
  const since = NOW - 95 * QUARTER;
  return {
    available: true,
    since: new Date(since).toISOString(),
    lastCollectedAt: new Date(NOW - 20_000).toISOString(),
    totals: totals(120, 30, 6),
    series: Array.from({ length: 96 }, (_, index) => ({
      start: new Date(since + index * QUARTER).toISOString(),
      ...(index === 94 ? totals(80, 10, 6) : index === 95 ? totals(40, 20) : totals(0, 0)),
    })),
    domains: [
      { domainId: "d1", host: "shop.example.com", ...totals(120, 30, 6) },
      { domainId: "d2", host: "quiet.example.com", ...totals(0, 0) },
    ],
  };
}

function summary(errorRate: ErrorRate): ServiceHealth {
  return {
    serviceType: "application",
    serviceId: "app-1",
    state: "unchecked",
    uptimeChecks: [],
    errorRate,
    errorRateThreshold: null,
    openIncidents: [],
    incidents: {
      items: [],
      meta: {
        page: 1,
        limit: 20,
        totalItems: 0,
        totalPages: 0,
        hasNextPage: false,
        hasPreviousPage: false,
      },
    },
  };
}

beforeEach(() => {
  useActiveOrganizationId.mockReturnValue({ organizationId: "org-1", pending: false });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function mount(serviceType: ServiceType = "application") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ErrorRateSection serviceType={serviceType} serviceId="app-1" page={1} />
    </QueryClientProvider>,
  );
}

const card = () =>
  screen.getByRole("heading", { name: "Error rate" }).closest("[data-slot=card]") as HTMLElement;

describe("ErrorRateSection", () => {
  it("shows the rate as a chart, the slow share beside it and a table per Domain", async () => {
    const spy = vi.spyOn(serviceHealthApi, "summary").mockResolvedValue(summary(available()));
    mount();

    const table = await screen.findByRole("table", { name: "Error rate per Domain" });
    expect(spy).toHaveBeenCalledWith("application", "app-1", { page: 1, limit: 20 });
    const figure = within(card()).getByText("Error rate", { selector: "p" }).nextElementSibling;
    expect(figure?.textContent).toBe("25%");
    expect(within(card()).getByText("30 of 120 requests answered 5xx")).toBeTruthy();

    const slow = within(card()).getByText("Slow requests").closest("[data-slot=stat]") as HTMLElement;
    expect(within(slow).getByText("5%")).toBeTruthy();
    expect(within(slow).getByText("6 took longer than 1.2 s")).toBeTruthy();

    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringMatching(/shop\.example\.com.*120.*30.*25%.*5%/),
      expect.stringMatching(/quiet\.example\.com.*0.*0.*No requests.*No requests/),
    ]);
  });

  it("reads a quarter-hour with no requests as no requests, never as 0 %", async () => {
    vi.spyOn(serviceHealthApi, "summary").mockResolvedValue(summary(available()));
    mount();
    await screen.findByRole("table", { name: "Error rate per Domain" });

    // The chart's own table (the screen reader's copy of the plot).
    const series = screen.getByRole("table", { name: "Error rate" });
    const cells = within(series).getAllByRole("cell").map((cell) => cell.textContent);
    expect(cells).toHaveLength(96);
    expect(cells.slice(0, 94).every((text) => text === "No requests")).toBe(true);
    expect(cells.slice(94)).toEqual(["12.5% answered 5xx", "50% answered 5xx"]);
    expect(card().textContent).not.toMatch(/\b0%/);
  });

  it.each([
    ["database", "Databases have no Error rate"],
    ["no-domain", "No Domain"],
    ["metrics-not-enabled", "Request metrics not enabled on this Server"],
    ["no-samples", "No samples yet"],
  ] as const)("names the %s reason verbatim instead of a rate", async (reason, message) => {
    vi.spyOn(serviceHealthApi, "summary").mockResolvedValue(
      summary({ available: false, reason, message }),
    );
    mount();

    expect(await within(card()).findByRole("heading", { name: message })).toBeTruthy();
    expect(card().textContent).not.toMatch(/%/);
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("says a refused read is refused, never an empty rate", async () => {
    vi.spyOn(serviceHealthApi, "summary").mockRejectedValue(new Error("boom"));
    mount();

    expect(await within(card()).findByText(/error it does not recognise/)).toBeTruthy();
    expect(card().textContent).not.toMatch(/%/);
  });
});
