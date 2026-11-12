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

import type { ServiceType } from "@/lib/api/endpoints/applications";
import { domainsApi, type Domain } from "@/lib/api/endpoints/domains";
import {
  serviceHealthApi,
  type Incident,
  type PublishedPorts,
  type ServiceHealth,
  type StripBucket,
  type UptimeCheckHealth,
} from "@/lib/api/endpoints/service-health";

/**
 * The Health tab, driven through the one boundary it has: the API
 * module. The summary, the Domains and the three writes are spies on
 * `serviceHealthApi` / `domainsApi`; the hooks, `ResourceList`, the modal and
 * the delete confirmation are all real, so what is asserted is what an
 * operator sees and what request each control sends.
 */

const useActiveOrganizationId = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth/client", async (original) => ({
  ...(await original<typeof import("@/lib/auth/client")>()),
  useActiveOrganizationId,
}));

/** The role's statements: everything held unless a test refuses it. */
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

const { HealthPanel } = await import("./health-panel");

const NOW = Date.now();
const HALF_HOUR = 30 * 60 * 1000;

function strip(downAt: number[] = []): StripBucket[] {
  return Array.from({ length: 48 }, (_, index) => ({
    start: new Date(NOW - (47 - index) * HALF_HOUR).toISOString(),
    up: downAt.includes(index) ? 0 : 60,
    down: downAt.includes(index) ? 60 : 0,
  }));
}

const domain = (overrides: Partial<Domain> = {}): Domain =>
  ({
    domainId: "dom-1",
    host: "shop.example.com",
    https: true,
    path: "/health",
    applicationId: "app-1",
    composeId: null,
    ...overrides,
  }) as Domain;

const check = (overrides: Partial<UptimeCheckHealth> = {}): UptimeCheckHealth => ({
  uptimeCheckId: "chk-1",
  serviceType: "application",
  serviceId: "app-1",
  kind: "http",
  target: {
    domainId: "dom-1",
    host: "shop.example.com",
    path: "/health",
    https: true,
    url: "https://shop.example.com/health",
  },
  tcpTarget: null,
  intervalSeconds: 30,
  timeoutSeconds: 10,
  expectedStatuses: ["2xx"],
  downAfter: 3,
  enabled: true,
  disabledReason: null,
  createdAt: new Date(NOW - 86_400_000).toISOString(),
  keyword: null,
  headerName: null,
  hasHeaderValue: false,
  lastProbe: {
    probedAt: new Date(NOW - 20_000).toISOString(),
    verdict: "down",
    latencyMs: null,
    errorClass: "status 503",
  },
  strip: strip([46, 47]),
  upShare24h: 0.9583,
  ...overrides,
});

const openIncident: Incident = {
  incidentId: "inc-open",
  source: "uptime-check",
  uptimeCheckId: "chk-1",
  errorRateThresholdId: null,
  openingErrorRate: null,
  openingRequests: null,
  worstErrorRate: null,
  openedAt: new Date(NOW - 90_000).toISOString(),
  closedAt: null,
  durationSeconds: null,
  openingError: "status 503",
  closeReason: null,
};

const closedIncident: Incident = {
  incidentId: "inc-closed",
  source: "uptime-check",
  uptimeCheckId: "chk-1",
  errorRateThresholdId: null,
  openingErrorRate: null,
  openingRequests: null,
  worstErrorRate: null,
  openedAt: new Date(NOW - 7_200_000).toISOString(),
  closedAt: new Date(NOW - 6_900_000).toISOString(),
  durationSeconds: 300,
  openingError: "timeout",
  closeReason: "recovered",
};

function summary(overrides: Partial<ServiceHealth> = {}): ServiceHealth {
  return {
    serviceType: "application",
    serviceId: "app-1",
    state: "incident",
    uptimeChecks: [check()],
    errorRate: { available: false, reason: "no-domain", message: "No Domain" },
    errorRateThreshold: null,
    openIncidents: [openIncident],
    incidents: {
      items: [openIncident, closedIncident],
      meta: {
        page: 1,
        limit: 20,
        totalItems: 2,
        totalPages: 1,
        hasNextPage: false,
        hasPreviousPage: false,
      },
    },
    ...overrides,
  };
}

const PORTS: PublishedPorts = {
  host: "203.0.113.7",
  ports: [{ port: 5432, label: "Database" }],
  unavailableReason: null,
};

const tcpCheck = (overrides: Partial<UptimeCheckHealth> = {}): UptimeCheckHealth =>
  check({
    uptimeCheckId: "chk-tcp",
    serviceType: "postgres",
    serviceId: "pg-1",
    kind: "tcp",
    target: null,
    tcpTarget: { host: "203.0.113.7", port: 5432, address: "203.0.113.7:5432" },
    lastProbe: {
      probedAt: new Date(NOW - 20_000).toISOString(),
      verdict: "up",
      latencyMs: 3,
      errorClass: null,
    },
    strip: strip(),
    ...overrides,
  });

const noIncidents = {
  openIncidents: [],
  incidents: {
    items: [],
    meta: { page: 1, limit: 20, totalItems: 0, totalPages: 0, hasNextPage: false, hasPreviousPage: false },
  },
};

let spies: {
  summary: ReturnType<typeof vi.spyOn>;
  publishedPorts: ReturnType<typeof vi.spyOn>;
  byApplication: ReturnType<typeof vi.spyOn>;
  byCompose: ReturnType<typeof vi.spyOn>;
  create: ReturnType<typeof vi.spyOn>;
  update: ReturnType<typeof vi.spyOn>;
  remove: ReturnType<typeof vi.spyOn>;
};

beforeEach(() => {
  refused.current = new Set();
  useActiveOrganizationId.mockReturnValue({ organizationId: "org-1", pending: false });
  spies = {
    summary: vi.spyOn(serviceHealthApi, "summary").mockResolvedValue(summary()),
    publishedPorts: vi.spyOn(serviceHealthApi, "publishedPorts").mockResolvedValue({
      host: "203.0.113.7",
      ports: [],
      unavailableReason: "This Application publishes no TCP port.",
    }),
    byApplication: vi
      .spyOn(domainsApi, "byApplication")
      .mockResolvedValue([domain()]),
    byCompose: vi
      .spyOn(domainsApi, "byCompose")
      .mockResolvedValue([domain({ domainId: "dom-c", applicationId: null, composeId: "cmp-1" })]),
    create: vi.spyOn(serviceHealthApi, "createCheck").mockResolvedValue(check()),
    update: vi.spyOn(serviceHealthApi, "updateCheck").mockResolvedValue(check()),
    remove: vi.spyOn(serviceHealthApi, "removeCheck").mockResolvedValue(check()),
  };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function mount(
  serviceType: ServiceType = "application",
  serviceId = "app-1",
  aside?: { node: React.ReactNode; label: string },
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <HealthPanel
        serviceType={serviceType}
        serviceId={serviceId}
        label="Health"
        icon="activity"
        aside={aside}
      />
    </QueryClientProvider>,
  );
}

const checksCard = () =>
  screen.getByRole("heading", { name: "Uptime checks" }).closest("[data-slot=card]") as HTMLElement;

/**
 * A spec-driven picker, by its field's label: a `Picker` is a button with no
 * accessible name of its own (`previews-settings-card.test.tsx` says why).
 */
const picker = (dialog: HTMLElement, label: string) =>
  within(
    within(dialog).getByText(label).closest('[data-slot="field"]') as HTMLElement,
  ).getByRole("combobox");

/** Base UI's option commits on a pointer press then a click (`invite-member-modal.test.tsx`). */
async function chooseOption(trigger: HTMLElement, name: RegExp) {
  fireEvent.click(trigger);
  const option = await screen.findByRole("option", { name });
  fireEvent.pointerDown(option, { pointerType: "mouse" });
  fireEvent.click(option, { detail: 1 });
  await waitFor(() => expect(screen.queryAllByRole("option")).toHaveLength(0));
}

/**
 * Closes an open picker's list on the option it already has picked, asserting
 * it is the picked one first. Chosen with the pointer, as `picker.test.tsx`
 * does, never an Escape: Base UI moves focus into the list a frame after it
 * renders, so an Escape sent to `document.activeElement` before then lands on
 * the dialog and closes it, and the Add that follows clicks nothing.
 */
async function closeOnPicked(name: string) {
  const option = screen.getByRole("option", { name });
  expect(option.getAttribute("aria-selected")).toBe("true");
  fireEvent.pointerDown(option, { pointerType: "mouse" });
  fireEvent.click(option, { detail: 1 });
  await waitFor(() => expect(screen.queryAllByRole("option")).toHaveLength(0));
  expect(screen.getByRole("dialog")).toBeTruthy();
}

async function loaded() {
  await screen.findByRole("table", { name: "Uptime checks of this Service" });
}

describe("the Health tab", () => {
  it("reads the summary once and shows the banner, the checks and the history, in that order", async () => {
    mount();
    await loaded();

    expect(spies.summary).toHaveBeenCalledWith("application", "app-1", { page: 1, limit: 20 });
    expect(spies.summary).toHaveBeenCalledTimes(1);

    const banner = screen.getByText("1 open Incident on this Service");
    const checks = screen.getByRole("heading", { name: "Uptime checks" });
    const history = screen.getByRole("heading", { name: "Incident history" });
    expect(banner.compareDocumentPosition(checks) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(checks.compareDocumentPosition(history) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // The banner names the target, the opening error, and that it is down.
    expect(screen.getByText("https://shop.example.com/health is down")).toBeTruthy();
    expect(screen.getByText(/Answered 503\. Opened/)).toBeTruthy();

    // The check: target, vantage line with its hint, last verdict and strip.
    const table = screen.getByRole("table", { name: "Uptime checks of this Service" });
    const row = within(table).getAllByRole("row")[1];
    expect(within(row).getByText("https://shop.example.com/health")).toBeTruthy();
    expect(within(row).getByText("Checked from the platform host")).toBeTruthy();
    expect(within(row).getByText(/One vantage point/)).toBeTruthy();
    expect(within(row).getByText("down")).toBeTruthy();
    expect(within(row).getByText(/Answered 503/)).toBeTruthy();
    expect(within(row).getByText("95.8% up over 24 hours · down in 2 of 48 half-hours probed")).toBeTruthy();

    // The history: open one first, then the closed one with its reason.
    const incidents = screen.getByRole("table", { name: "Incident history of this Service" });
    const [, open, closed] = within(incidents).getAllByRole("row");
    expect(within(open).getByText("open")).toBeTruthy();
    expect(within(open).getByText("Still open")).toBeTruthy();
    expect(within(closed).getByText("Recovered")).toBeTruthy();
    expect(within(closed).getByText("Timed out")).toBeTruthy();
    expect(within(closed).getByText("5m 00s")).toBeTruthy();
  });

  it("keeps a kind's facts card beside the sections when it is handed one", async () => {
    mount("compose", "cmp-1", { node: <p>Stack facts</p>, label: "About shop" });
    await loaded();
    const aside = screen.getByRole("complementary", { name: "About shop" });
    expect(within(aside).getByText("Stack facts")).toBeTruthy();
  });

  it("shows no banner when nothing is open", async () => {
    spies.summary.mockResolvedValue(
      summary({
        openIncidents: [],
        uptimeChecks: [check({ lastProbe: { probedAt: new Date(NOW).toISOString(), verdict: "up", latencyMs: 42, errorClass: null } })],
      }),
    );
    mount();
    await loaded();
    expect(screen.queryByText(/open Incident/)).toBeNull();
    expect(screen.getByText(/42 ms/)).toBeTruthy();
  });

  it("says a refused read rather than an empty list", async () => {
    spies.summary.mockRejectedValue(new Error("boom"));
    mount();
    // Every section says it: the checks list, the Error rate, the threshold and the history.
    await waitFor(() =>
      expect(screen.getAllByText(/error it does not recognise/)).toHaveLength(4),
    );
    expect(screen.queryByText("Nothing is checked")).toBeNull();
    expect(screen.queryByText("No Incidents")).toBeNull();
  });

  it("adds an HTTP check on the Service's own Domain", async () => {
    mount();
    await loaded();
    expect(spies.byApplication).toHaveBeenCalledWith("app-1");
    expect(spies.byCompose).not.toHaveBeenCalled();

    fireEvent.click(within(checksCard()).getByRole("button", { name: /Add an Uptime check/ }));
    const dialog = await screen.findByRole("dialog");
    // The picker offers the Service's Domain, as the URL it probes.
    fireEvent.click(picker(dialog, "Domain"));
    await waitFor(() => expect(screen.getAllByRole("option").length).toBe(1));
    await closeOnPicked("https://shop.example.com/health");

    fireEvent.change(within(dialog).getByRole("textbox", { name: /Expected statuses/ }), {
      target: { value: "2xx, 301" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add an Uptime check" }));

    await waitFor(() => expect(spies.create).toHaveBeenCalledTimes(1));
    expect(spies.create).toHaveBeenCalledWith({
      serviceType: "application",
      serviceId: "app-1",
      kind: "http",
      domainId: "dom-1",
      intervalSeconds: 60,
      timeoutSeconds: 10,
      expectedStatuses: ["2xx", "301"],
      downAfter: 3,
      enabled: true,
      keyword: null,
      headerName: null,
    });
    // The summary is read again, so the new check shows up.
    await waitFor(() => expect(spies.summary).toHaveBeenCalledTimes(2));
  });

  it("refuses a timeout longer than the interval before it sends anything", async () => {
    mount();
    await loaded();
    fireEvent.click(within(checksCard()).getByRole("button", { name: /Add an Uptime check/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByRole("spinbutton", { name: /Interval/ }), {
      target: { value: "30" },
    });
    fireEvent.change(within(dialog).getByRole("spinbutton", { name: /Timeout/ }), {
      target: { value: "45" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add an Uptime check" }));
    expect(await within(dialog).findByText("The timeout cannot be longer than the interval.")).toBeTruthy();
    expect(spies.create).not.toHaveBeenCalled();
  });

  it("edits a check", async () => {
    mount();
    await loaded();
    fireEvent.click(within(checksCard()).getByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByRole("spinbutton", { name: /Downs in a row/ }), {
      target: { value: "5" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(spies.update).toHaveBeenCalledTimes(1));
    expect(spies.update).toHaveBeenCalledWith("chk-1", {
      domainId: "dom-1",
      intervalSeconds: 30,
      timeoutSeconds: 10,
      expectedStatuses: ["2xx"],
      downAfter: 5,
      enabled: true,
      keyword: null,
      headerName: null,
    });
  });

  it("turns a check off, and a turned-off one on", async () => {
    mount();
    await loaded();
    fireEvent.click(within(checksCard()).getByRole("button", { name: "Turn off" }));
    await waitFor(() =>
      expect(spies.update).toHaveBeenCalledWith("chk-1", { enabled: false }),
    );

    cleanup();
    spies.summary.mockResolvedValue(
      summary({ openIncidents: [], uptimeChecks: [check({ enabled: false })] }),
    );
    mount();
    await loaded();
    const row = within(screen.getByRole("table", { name: "Uptime checks of this Service" })).getAllByRole("row")[1];
    expect(within(row).getByText("off")).toBeTruthy();
    fireEvent.click(within(row).getByRole("button", { name: "Turn on" }));
    await waitFor(() =>
      expect(spies.update).toHaveBeenCalledWith("chk-1", { enabled: true }),
    );
  });

  it("shows why Cloudgate turned a check off beside it", async () => {
    const reason = "Port 5432 is no longer published by this Service, so Cloudgate turned the check off.";
    spies.summary.mockResolvedValue(
      summary({
        openIncidents: [],
        uptimeChecks: [check({ enabled: false, disabledReason: reason })],
      }),
    );
    mount();
    await loaded();
    const row = within(screen.getByRole("table", { name: "Uptime checks of this Service" })).getAllByRole("row")[1];
    expect(within(row).getByText("off")).toBeTruthy();
    expect(within(row).getByText(reason)).toBeTruthy();
  });

  it("deletes a check, saying its history goes with it and nothing is announced", async () => {
    mount();
    await loaded();
    fireEvent.click(within(checksCard()).getByRole("button", { name: "Remove" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Incident history\. It cannot be put back\./)).toBeTruthy();
    expect(within(dialog).getByText("Nothing is announced")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove Uptime check" }));
    await waitFor(() => expect(spies.remove).toHaveBeenCalledWith("chk-1"));
  });

  it("leaves every control off, with the reason, for a role without service:update", async () => {
    refused.current = new Set(["service:update"]);
    mount();
    await loaded();
    const card = checksCard();
    for (const name of [/Add an Uptime check/, /^Edit$/, /^Remove$/, /^Turn off$/]) {
      const button = within(card).getAllByRole("button", { name })[0];
      expect(button.getAttribute("aria-disabled")).toBe("true");
      expect(button.getAttribute("title")).toMatch(/^Your role in this Organization cannot/);
      fireEvent.click(button);
    }
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(spies.update).not.toHaveBeenCalled();
    expect(spies.create).not.toHaveBeenCalled();
    expect(spies.remove).not.toHaveBeenCalled();
    // Reading is still allowed: the history and banner are there.
    expect(screen.getByText("1 open Incident on this Service")).toBeTruthy();
  });

  it("offers a Compose stack its own Domains", async () => {
    spies.summary.mockResolvedValue(
      summary({ serviceType: "compose", serviceId: "cmp-1", uptimeChecks: [], openIncidents: [], incidents: { items: [], meta: { page: 1, limit: 20, totalItems: 0, totalPages: 0, hasNextPage: false, hasPreviousPage: false } } }),
    );
    mount("compose", "cmp-1");
    await loaded();
    expect(spies.summary).toHaveBeenCalledWith("compose", "cmp-1", { page: 1, limit: 20 });
    expect(spies.byCompose).toHaveBeenCalledWith("cmp-1");
    expect(spies.byApplication).not.toHaveBeenCalled();
    expect(screen.getByText("Nothing is checked")).toBeTruthy();
    expect(screen.getByText("No Incidents")).toBeTruthy();
  });

  it("tells a database without an external port to publish it first, and reads no Domains", async () => {
    spies.summary.mockResolvedValue(
      summary({ serviceType: "postgres", serviceId: "pg-1", uptimeChecks: [], ...noIncidents }),
    );
    spies.publishedPorts.mockResolvedValue({
      host: "203.0.113.7",
      ports: [],
      unavailableReason:
        "This database has no external port. Publish its port first, under Published ports on its Credentials tab; a TCP check dials the external port.",
    });
    mount("postgres", "pg-1");
    expect(await within(checksCard()).findByText(/has no external port\. Publish its port first/)).toBeTruthy();
    expect(spies.publishedPorts).toHaveBeenCalledWith("postgres", "pg-1");
    expect(spies.byApplication).not.toHaveBeenCalled();
    expect(spies.byCompose).not.toHaveBeenCalled();
  });

  it("adds a TCP check to a database on its external port, without asking the kind", async () => {
    spies.summary.mockResolvedValue(
      summary({ serviceType: "postgres", serviceId: "pg-1", uptimeChecks: [tcpCheck()], ...noIncidents }),
    );
    spies.publishedPorts.mockResolvedValue(PORTS);
    mount("postgres", "pg-1");
    await loaded();
    const row = within(screen.getByRole("table", { name: "Uptime checks of this Service" })).getAllByRole("row")[1];
    expect(within(row).getByText("tcp://203.0.113.7:5432")).toBeTruthy();
    expect(within(row).getByText(/connects, down after 3/)).toBeTruthy();

    fireEvent.click(within(checksCard()).getByRole("button", { name: /Add an Uptime check/ }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByText("Kind")).toBeNull();
    expect(within(dialog).queryByText("Domain")).toBeNull();
    expect(within(dialog).queryByRole("textbox", { name: /Expected statuses/ })).toBeNull();
    expect(within(dialog).queryByRole("textbox", { name: /keyword/ })).toBeNull();
    expect(within(dialog).getByText(/dialled on 203\.0\.113\.7/)).toBeTruthy();
    // The one published port is picked already.
    fireEvent.click(picker(dialog, "Published port"));
    await waitFor(() => expect(screen.getAllByRole("option").length).toBe(1));
    await closeOnPicked("5432 — Database");
    fireEvent.click(within(dialog).getByRole("button", { name: "Add an Uptime check" }));

    await waitFor(() => expect(spies.create).toHaveBeenCalledTimes(1));
    expect(spies.create).toHaveBeenCalledWith({
      serviceType: "postgres",
      serviceId: "pg-1",
      kind: "tcp",
      port: 5432,
      intervalSeconds: 60,
      timeoutSeconds: 10,
      downAfter: 3,
      enabled: true,
    });
  });

  it("lets an Application choose TCP and pick one of its published ports", async () => {
    spies.publishedPorts.mockResolvedValue({
      host: "203.0.113.7",
      ports: [{ port: 2222, label: "Container port 22" }],
      unavailableReason: null,
    });
    mount();
    await loaded();
    fireEvent.click(within(checksCard()).getByRole("button", { name: /Add an Uptime check/ }));
    const dialog = await screen.findByRole("dialog");
    await chooseOption(picker(dialog, "Kind"), /^TCP/);
    await waitFor(() =>
      expect(within(dialog).queryByText("Domain")).toBeNull(),
    );
    expect(within(dialog).queryByText(/Header name/)).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Add an Uptime check" }));

    await waitFor(() => expect(spies.create).toHaveBeenCalledTimes(1));
    expect(spies.create).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "tcp", port: 2222, serviceType: "application" }),
    );
    expect(spies.create.mock.calls[0][0]).not.toHaveProperty("domainId");
  });

  it("adds an HTTP check with a keyword and a header, sending the value once", async () => {
    mount();
    await loaded();
    fireEvent.click(within(checksCard()).getByRole("button", { name: /Add an Uptime check/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByRole("textbox", { name: /Required keyword/ }), {
      target: { value: "operational" },
    });
    fireEvent.change(within(dialog).getByRole("textbox", { name: /Header name/ }), {
      target: { value: "Authorization" },
    });
    // No value is stored yet, so there is nothing to keep: the box is asked for.
    expect(within(dialog).queryByText("Header value")).toBeNull();
    fireEvent.change(within(dialog).getByLabelText(/New header value/), {
      target: { value: "Bearer s3cr3t" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add an Uptime check" }));

    await waitFor(() => expect(spies.create).toHaveBeenCalledTimes(1));
    expect(spies.create).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "http",
        keyword: "operational",
        headerName: "Authorization",
        headerValue: "Bearer s3cr3t",
      }),
    );
  });

  it("refuses a header value with no name to send it under", async () => {
    mount();
    await loaded();
    fireEvent.click(within(checksCard()).getByRole("button", { name: /Add an Uptime check/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(/New header value/), {
      target: { value: "Bearer s3cr3t" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add an Uptime check" }));
    expect(await within(dialog).findByText(/A header value is sent under a name/)).toBeTruthy();
    expect(spies.create).not.toHaveBeenCalled();
  });

  describe("a saved header value", () => {
    const withHeader = () =>
      spies.summary.mockResolvedValue(
        summary({
          uptimeChecks: [check({ headerName: "Authorization", hasHeaderValue: true })],
        }),
      );

    async function editDialog() {
      withHeader();
      mount();
      await loaded();
      expect(within(checksCard()).getByText(/sends/)).toBeTruthy();
      expect(within(checksCard()).getByText(/\(value saved\)/)).toBeTruthy();
      fireEvent.click(within(checksCard()).getByRole("button", { name: "Edit" }));
      return screen.findByRole("dialog");
    }

    const choose = (dialog: HTMLElement, action: RegExp) =>
      chooseOption(picker(dialog, "Header value"), action);

    it("is kept, never shown, by an edit that leaves it alone", async () => {
      const dialog = await editDialog();
      // Keep is the default and there is no box holding the value.
      expect(within(dialog).queryByLabelText(/New header value/)).toBeNull();
      fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
      await waitFor(() => expect(spies.update).toHaveBeenCalledTimes(1));
      expect(spies.update.mock.calls[0][1]).not.toHaveProperty("headerValue");
      expect(spies.update.mock.calls[0][1]).toMatchObject({ headerName: "Authorization" });
    });

    it("is replaced from an empty box", async () => {
      const dialog = await editDialog();
      await choose(dialog, /Replace it/);
      const box = await within(dialog).findByLabelText(/New header value/);
      expect((box as HTMLInputElement).value).toBe("");
      // Replace with nothing typed is refused rather than sent as a blank.
      fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
      expect(await within(dialog).findByText(/Type the new value/)).toBeTruthy();
      expect(spies.update).not.toHaveBeenCalled();

      fireEvent.change(box, { target: { value: "Bearer rotated" } });
      fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
      await waitFor(() => expect(spies.update).toHaveBeenCalledTimes(1));
      expect(spies.update.mock.calls[0][1]).toMatchObject({ headerValue: "Bearer rotated" });
    });

    it("is removed with null", async () => {
      const dialog = await editDialog();
      await choose(dialog, /Remove it/);
      expect(within(dialog).queryByLabelText(/New header value/)).toBeNull();
      fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
      await waitFor(() => expect(spies.update).toHaveBeenCalledTimes(1));
      expect(spies.update.mock.calls[0][1]).toMatchObject({
        headerName: "Authorization",
        headerValue: null,
      });
    });
  });

  it("pages the Incident history", async () => {
    const meta = { page: 1, limit: 20, totalItems: 25, totalPages: 2, hasNextPage: true, hasPreviousPage: false };
    spies.summary.mockResolvedValue(summary({ incidents: { items: [closedIncident], meta } }));
    mount();
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() =>
      expect(spies.summary).toHaveBeenCalledWith("application", "app-1", { page: 2, limit: 20 }),
    );
  });
});
