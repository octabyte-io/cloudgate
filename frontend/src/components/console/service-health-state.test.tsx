import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  serviceHealthApi,
  type ServiceHealth,
  type UptimeCheckHealth,
} from "@/lib/api/endpoints/service-health";

/**
 * The Overview's one health fact line: the backend's `state` as a mark,
 * the few words it rests on, and the way to the Health tab — read from the
 * Service's own summary, the Health tab's cache entry.
 */

vi.mock("@/lib/auth/client", async (original) => ({
  ...(await original<typeof import("@/lib/auth/client")>()),
  useActiveOrganizationId: () => ({ organizationId: "org-1", pending: false }),
}));

const { HealthFactRow } = await import("./service-health-state");

const check = (enabled: boolean): UptimeCheckHealth =>
  ({ uptimeCheckId: "chk-1", enabled, lastProbe: null }) as UptimeCheckHealth;

function summary(overrides: Partial<ServiceHealth>): ServiceHealth {
  return {
    serviceType: "compose",
    serviceId: "cmp-1",
    state: "up",
    uptimeChecks: [check(true), check(true)],
    errorRate: { available: false, reason: "no-domain", message: "No Domain" },
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

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function mount(health: ServiceHealth) {
  const spy = vi.spyOn(serviceHealthApi, "summary").mockResolvedValue(health);
  render(
    <QueryClientProvider client={new QueryClient()}>
      <dl>
        <HealthFactRow serviceType="compose" serviceId="cmp-1" />
      </dl>
    </QueryClientProvider>,
  );
  return spy;
}

describe("HealthFactRow", () => {
  it("says the state in one line and links to the Health tab", async () => {
    const spy = mount(summary({}));

    expect(await screen.findByText("up")).toBeTruthy();
    expect(screen.getByText("2 Uptime checks")).toBeTruthy();
    expect(screen.getByText("Health")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Health tab" }).getAttribute("href"),
    ).toBe("/compose/cmp-1/health");
    // The Health tab's own first page, so opening the tab costs nothing more.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("compose", "cmp-1", { page: 1, limit: 20 });
  });

  it("leads with an open Incident", async () => {
    mount(
      summary({
        state: "incident",
        openIncidents: [
          {
            incidentId: "inc-1",
            source: "uptime-check",
            uptimeCheckId: "chk-1",
            errorRateThresholdId: null,
            openingErrorRate: null,
            openingRequests: null,
            worstErrorRate: null,
            openedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
            closedAt: null,
            durationSeconds: null,
            openingError: "status 503",
            closeReason: null,
          },
        ],
      }),
    );

    expect(await screen.findByText("Incident open")).toBeTruthy();
    expect(screen.getByText("opened 10 minutes ago")).toBeTruthy();
  });

  it("tells a Stopped Service's unprobed checks from having none", async () => {
    mount(summary({ state: "unchecked" }));
    expect(await screen.findByText("not probed while Stopped")).toBeTruthy();
    cleanup();

    mount(summary({ state: "unchecked", uptimeChecks: [check(false)] }));
    expect(await screen.findByText("no Uptime check")).toBeTruthy();
  });

  it("ellipsizes its words on a narrow card rather than clipping them", async () => {
    mount(summary({ state: "unchecked", uptimeChecks: [check(false)] }));
    const words = await screen.findByText("no Uptime check");
    // `truncate` only ellipsizes text in a block or flex item that may shrink;
    // inside the old `inline-flex` wrapper it clipped mid-word with no mark.
    expect(words.className).toMatch(/\bmin-w-0\b/);
    expect(words.className).toMatch(/\btruncate\b/);
    expect(words.parentElement?.className).not.toMatch(/inline-flex/);
    expect(words.getAttribute("title")).toBe("no Uptime check");
  });
});
