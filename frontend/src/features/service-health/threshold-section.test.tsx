import { QueryClient, QueryClientProvider, type UseQueryResult } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ServiceType } from "@/lib/api/endpoints/applications";
import {
  serviceHealthApi,
  type ErrorRate,
  type ErrorRateThreshold,
  type Incident,
  type ServiceHealth,
} from "@/lib/api/endpoints/service-health";

/**
 * The Health tab's Error-rate threshold, driven through the API module:
 * the summary and the two writes are spies on `serviceHealthApi`; the hooks,
 * the section, the modal and the delete confirmation are real. Also the
 * banner and the history, for how a threshold's Incident reads in them.
 */

const useActiveOrganizationId = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth/client", async (original) => ({
  ...(await original<typeof import("@/lib/auth/client")>()),
  useActiveOrganizationId,
}));

const refused = vi.hoisted(() => ({ current: new Set<string>() }));
vi.mock("@/lib/auth/use-permission", async (original) => ({
  ...(await original<typeof import("@/lib/auth/use-permission")>()),
  usePermission: (required: Record<string, string[]>) => ({
    allowed: Object.entries(required).every(([resource, actions]) =>
      actions.every((action) => !refused.current.has(`${resource}:${action}`)),
    ),
    pending: false,
    role: "member",
  }),
}));

vi.mock("@/components/console/toast", () => ({
  toast: { done: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

const { ThresholdSection } = await import("./threshold-section");
const { OpenIncidentBanner } = await import("./open-incident-banner");
const { IncidentHistory } = await import("./incident-history");

const NOW = Date.now();

const NOT_AVAILABLE: ErrorRate = {
  available: false,
  reason: "metrics-not-enabled",
  message: "Request metrics not enabled on this Server",
};

const AVAILABLE: ErrorRate = {
  available: true,
  since: new Date(NOW - 86_400_000).toISOString(),
  lastCollectedAt: new Date(NOW - 30_000).toISOString(),
  totals: { requests: 100, errors: 2, slow: 0, errorRate: 0.02, slowShare: 0 },
  series: [],
  domains: [],
};

const threshold = (overrides: Partial<ErrorRateThreshold> = {}): ErrorRateThreshold => ({
  errorRateThresholdId: "ert-1",
  serviceType: "application",
  serviceId: "app-1",
  percentage: 5,
  windowMinutes: 5,
  minRequests: 20,
  enabled: true,
  createdAt: new Date(NOW - 3_600_000).toISOString(),
  ...overrides,
});

const thresholdIncident: Incident = {
  incidentId: "inc-t",
  source: "error-rate-threshold",
  uptimeCheckId: null,
  errorRateThresholdId: "ert-1",
  openedAt: new Date(NOW - 120_000).toISOString(),
  closedAt: null,
  durationSeconds: null,
  openingError: null,
  openingErrorRate: 0.125,
  openingRequests: 40,
  worstErrorRate: 0.5,
  closeReason: null,
};

function summary(overrides: Partial<ServiceHealth> = {}): ServiceHealth {
  return {
    serviceType: "application",
    serviceId: "app-1",
    state: "unchecked",
    uptimeChecks: [],
    errorRate: NOT_AVAILABLE,
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
    ...overrides,
  };
}

let spies: {
  summary: ReturnType<typeof vi.spyOn>;
  put: ReturnType<typeof vi.spyOn>;
  remove: ReturnType<typeof vi.spyOn>;
};

beforeEach(() => {
  refused.current = new Set();
  useActiveOrganizationId.mockReturnValue({ organizationId: "org-1", pending: false });
  spies = {
    summary: vi.spyOn(serviceHealthApi, "summary").mockResolvedValue(summary()),
    put: vi.spyOn(serviceHealthApi, "putThreshold").mockResolvedValue(threshold()),
    remove: vi.spyOn(serviceHealthApi, "removeThreshold").mockResolvedValue(threshold()),
  };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function mount(serviceType: ServiceType = "application", serviceId = "app-1") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ThresholdSection serviceType={serviceType} serviceId={serviceId} page={1} />
    </QueryClientProvider>,
  );
}

const card = () =>
  screen
    .getByRole("heading", { name: "Error-rate threshold" })
    .closest("[data-slot=card]") as HTMLElement;

describe("the Error-rate threshold section", () => {
  it("offers Add a threshold on a Service whose Error rate is not available, and adds one with the defaults", async () => {
    mount();
    expect(await screen.findByText("No threshold")).toBeTruthy();
    // It says it can be added before there is an Error rate, and why there is none.
    expect(
      within(card()).getByText(/judged once there is an Error rate \(Request metrics not enabled on this Server\)/),
    ).toBeTruthy();

    fireEvent.click(within(card()).getByRole("button", { name: "Add a threshold" }));
    const dialog = await screen.findByRole("dialog");
    expect(
      (within(dialog).getByRole("spinbutton", { name: /Error rate/ }) as HTMLInputElement).value,
    ).toBe("5");
    expect(
      (within(dialog).getByRole("spinbutton", { name: /Minimum requests/ }) as HTMLInputElement)
        .value,
    ).toBe("20");
    fireEvent.click(within(dialog).getByRole("button", { name: "Add a threshold" }));

    await waitFor(() => expect(spies.put).toHaveBeenCalledTimes(1));
    expect(spies.put).toHaveBeenCalledWith("application", "app-1", {
      percentage: 5,
      windowMinutes: 5,
      minRequests: 20,
      enabled: true,
    });
    // The summary is read again, so the new threshold shows.
    await waitFor(() => expect(spies.summary).toHaveBeenCalledTimes(2));
  });

  it("shows a threshold on a Service reading not available as not judged yet, with the reason", async () => {
    spies.summary.mockResolvedValue(summary({ errorRateThreshold: threshold() }));
    mount();
    expect(await within(await findCard()).findByText("5 % over 5 minutes")).toBeTruthy();
    expect(within(card()).getByText("At least 20 requests in 5 minutes")).toBeTruthy();
    expect(within(card()).getByText("not judged yet")).toBeTruthy();
    expect(
      within(card()).getByText(/Not judged yet: Request metrics not enabled on this Server\./),
    ).toBeTruthy();
    expect(within(card()).queryByRole("button", { name: "Add a threshold" })).toBeNull();
  });

  it("reads judged with an Error rate, and turns it off and on with the whole rule", async () => {
    spies.summary.mockResolvedValue(
      summary({ errorRate: AVAILABLE, errorRateThreshold: threshold({ percentage: 10, windowMinutes: 1 }) }),
    );
    mount();
    expect(await within(await findCard()).findByText("judged")).toBeTruthy();
    expect(within(card()).getByText("10 % over 1 minute")).toBeTruthy();
    expect(within(card()).queryByText(/Not judged yet/)).toBeNull();

    fireEvent.click(within(card()).getByRole("button", { name: "Turn off" }));
    await waitFor(() =>
      expect(spies.put).toHaveBeenCalledWith("application", "app-1", {
        percentage: 10,
        windowMinutes: 1,
        minRequests: 20,
        enabled: false,
      }),
    );

    cleanup();
    spies.summary.mockResolvedValue(
      summary({ errorRate: AVAILABLE, errorRateThreshold: threshold({ enabled: false }) }),
    );
    mount();
    expect(await within(await findCard()).findByText("off")).toBeTruthy();
    fireEvent.click(within(card()).getByRole("button", { name: "Turn on" }));
    await waitFor(() =>
      expect(spies.put).toHaveBeenLastCalledWith("application", "app-1", {
        percentage: 5,
        windowMinutes: 5,
        minRequests: 20,
        enabled: true,
      }),
    );
  });

  it("edits the threshold in the modal, window included", async () => {
    spies.summary.mockResolvedValue(summary({ errorRateThreshold: threshold() }));
    mount();
    await within(await findCard()).findByText("5 % over 5 minutes");
    fireEvent.click(within(card()).getByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByRole("spinbutton", { name: /Error rate/ }), {
      target: { value: "12" },
    });
    fireEvent.click(within(dialog).getByRole("combobox"));
    const option = await screen.findByRole("option", { name: "The last 15 minutes" });
    fireEvent.pointerDown(option, { pointerType: "mouse" });
    fireEvent.click(option, { detail: 1 });
    await waitFor(() => expect(screen.queryAllByRole("option")).toHaveLength(0));
    fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(spies.put).toHaveBeenCalledTimes(1));
    expect(spies.put).toHaveBeenCalledWith("application", "app-1", {
      percentage: 12,
      windowMinutes: 15,
      minRequests: 20,
      enabled: true,
    });
  });

  it("refuses too few requests before it sends anything", async () => {
    mount();
    fireEvent.click(await within(await findCard()).findByRole("button", { name: "Add a threshold" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByRole("spinbutton", { name: /Minimum requests/ }), {
      target: { value: "" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add a threshold" }));
    expect(
      await within(dialog).findByText("How many requests make a window worth judging."),
    ).toBeTruthy();
    expect(spies.put).not.toHaveBeenCalled();
  });

  it("removes the threshold, saying its history goes and nothing is announced", async () => {
    spies.summary.mockResolvedValue(summary({ errorRateThreshold: threshold() }));
    mount();
    await within(await findCard()).findByText("5 % over 5 minutes");
    fireEvent.click(within(card()).getByRole("button", { name: "Remove" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Incident history\. It cannot be put back\./)).toBeTruthy();
    expect(within(dialog).getByText("Nothing is announced")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove Error-rate threshold" }));
    await waitFor(() => expect(spies.remove).toHaveBeenCalledWith("application", "app-1"));
  });

  it("leaves every control off, with the reason, for a role without service:update", async () => {
    refused.current = new Set(["service:update"]);
    mount();
    const add = await within(await findCard()).findByRole("button", { name: "Add a threshold" });
    expect(add.getAttribute("aria-disabled")).toBe("true");
    expect(add.getAttribute("title")).toMatch(/^Your role in this Organization cannot/);
    fireEvent.click(add);
    expect(screen.queryByRole("dialog")).toBeNull();

    cleanup();
    spies.summary.mockResolvedValue(summary({ errorRateThreshold: threshold() }));
    mount();
    await within(await findCard()).findByText("5 % over 5 minutes");
    for (const name of ["Turn off", "Edit", "Remove"]) {
      const button = within(card()).getByRole("button", { name });
      expect(button.getAttribute("aria-disabled")).toBe("true");
      expect(button.getAttribute("title")).toMatch(/^Your role in this Organization cannot/);
      fireEvent.click(button);
    }
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(spies.put).not.toHaveBeenCalled();
    expect(spies.remove).not.toHaveBeenCalled();
  });

  it("tells a database it cannot have one, with no button", async () => {
    mount("postgres", "pg-1");
    expect(within(card()).getByText("Databases have no Error-rate threshold")).toBeTruthy();
    expect(within(card()).queryAllByRole("button")).toHaveLength(0);
  });

  it("says a refused read rather than No threshold", async () => {
    spies.summary.mockRejectedValue(new Error("boom"));
    mount();
    await waitFor(() =>
      expect(within(card()).getByText(/error it does not recognise/)).toBeTruthy(),
    );
    expect(screen.queryByText("No threshold")).toBeNull();
  });
});

describe("a threshold's Incident", () => {
  const health = summary({
    errorRate: AVAILABLE,
    errorRateThreshold: threshold(),
    openIncidents: [thresholdIncident],
    incidents: {
      items: [thresholdIncident],
      meta: { page: 1, limit: 20, totalItems: 1, totalPages: 1, hasNextPage: false, hasPreviousPage: false },
    },
  });

  it("is a banner row worded by its rate", () => {
    render(<OpenIncidentBanner health={health} />);
    expect(screen.getByText("The Error rate is over its threshold")).toBeTruthy();
    expect(screen.getByText(/12\.5 % of 40 requests answered 5xx, worst 50 %\. Opened/)).toBeTruthy();
  });

  it("is a history row with Error rate as its target and the opening window as its error", () => {
    render(
      <IncidentHistory
        health={{ data: health, isPending: false, error: null } as UseQueryResult<ServiceHealth>}
        page={1}
        onPage={() => undefined}
      />,
    );
    const table = screen.getByRole("table", { name: "Incident history of this Service" });
    const row = within(table).getAllByRole("row")[1];
    expect(within(row).getByText("Error rate")).toBeTruthy();
    expect(within(row).getByText("12.5 % of 40 requests answered 5xx, worst 50 %")).toBeTruthy();
  });
});

async function findCard(): Promise<HTMLElement> {
  await screen.findByRole("heading", { name: "Error-rate threshold" });
  return card();
}
