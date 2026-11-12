import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { OperatorAbuseReport } from "@/lib/api/endpoints/operator-abuse";

const abuseApi = vi.hoisted(() => ({
  reports: vi.fn(),
  forward: vi.fn(),
  close: vi.fn(),
  powerOff: vi.fn(),
  powerOn: vi.fn(),
}));
const invalidated = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api/endpoints/operator-abuse", () => ({
  operatorAbuseApi: abuseApi,
}));
vi.mock("@/lib/api/use-invalidate", () => ({
  useInvalidate: () => ({ operatorAbuseReports: invalidated }),
}));

const { AbuseReportsCard } = await import("./abuse-reports");

afterEach(() => {
  cleanup();
  abuseApi.reports.mockReset();
  abuseApi.close.mockReset();
  invalidated.mockReset();
});

const HOUR = 60 * 60 * 1000;

function reportDue(
  organization: string,
  deadlineFromNow: number,
): OperatorAbuseReport {
  return {
    id: `report-${organization}`,
    organization: { id: `org-${organization}`, name: organization },
    report: `A port scan from ${organization}'s Server.`,
    forwardedAt: new Date(
      Date.now() + deadlineFromNow - 24 * HOUR,
    ).toISOString(),
    deadlineAt: new Date(Date.now() + deadlineFromNow).toISOString(),
    forwardedBy: "ops@octabyte.test",
  };
}

function renderCard(reports: OperatorAbuseReport[]) {
  abuseApi.reports.mockResolvedValue(reports);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <AbuseReportsCard />
    </QueryClientProvider>,
  );
}

async function rowOf(name: string): Promise<HTMLElement> {
  const table = await screen.findByRole("table", {
    name: "Open abuse reports",
  });
  return within(table).getByText(name).closest("tr") as HTMLElement;
}

/**
 * The Operator page's open abuse reports (#1401): each with its deadline,
 * flagged once past it, until an Operator closes it.
 */
describe("AbuseReportsCard", () => {
  it("lists each open report with its deadline, and flags one past it", async () => {
    renderCard([
      reportDue("Wu Contracting", -2 * HOUR),
      reportDue("Hopper Labs", 5 * HOUR),
    ]);

    const past = await rowOf("Wu Contracting");
    expect(past.textContent).toContain("Past deadline");
    expect(past.textContent).toContain(
      "A port scan from Wu Contracting's Server.",
    );
    expect(past.textContent).toContain("ops@octabyte.test");

    const open = await rowOf("Hopper Labs");
    expect(open.textContent).not.toContain("Past deadline");
    expect(open.textContent).toMatch(/in 5 hours/);
  });

  it("closes a report", async () => {
    abuseApi.close.mockResolvedValue(undefined);
    renderCard([reportDue("Hopper Labs", 5 * HOUR)]);

    fireEvent.click(
      within(await rowOf("Hopper Labs")).getByRole("button", { name: "Close" }),
    );

    await waitFor(() =>
      expect(abuseApi.close).toHaveBeenCalledWith("report-Hopper Labs"),
    );
    await waitFor(() => expect(invalidated).toHaveBeenCalled());
  });

  it("says when there is none", async () => {
    renderCard([]);
    expect(await screen.findByText("No open abuse reports")).toBeDefined();
  });
});
