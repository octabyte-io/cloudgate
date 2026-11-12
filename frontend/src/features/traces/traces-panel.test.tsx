import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  tracesApi,
  type TraceStoreFrame,
  type Traces,
  type TracesWrite,
} from "@/lib/api/endpoints/traces";

/**
 * The Traces tab, driven through the API module: the read, the
 * write and the frame token are spies on `tracesApi`; the hook, the panel,
 * the frame and the turn-off report are real.
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

const { TracesPanel } = await import("./traces-panel");

const OFF: Traces = {
  serviceType: "application",
  serviceId: "app-1",
  enabled: false,
  retentionDays: 3,
  hasCredential: false,
  storeRunning: false,
  storeSizeBytes: null,
};

const RUNNING: Traces = {
  ...OFF,
  enabled: true,
  hasCredential: true,
  storeRunning: true,
  storeSizeBytes: 2 * 1024 * 1024,
};

const written = (overrides: Partial<TracesWrite> = {}): TracesWrite => ({
  serviceType: "application",
  serviceId: "app-1",
  enabled: true,
  retentionDays: 3,
  hasCredential: true,
  ...overrides,
});

/** What `GET /traces/:serviceId/frame` answers: a base path under a token. */
const framed = (serviceId: string): TraceStoreFrame => ({
  uiPath: `/backend/traces/${serviceId}/ui/t/tok.sig`,
  expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
});

let spies: {
  read: ReturnType<typeof vi.spyOn>;
  put: ReturnType<typeof vi.spyOn>;
  frame: ReturnType<typeof vi.spyOn>;
};

beforeEach(() => {
  refused.current = new Set();
  useActiveOrganizationId.mockReturnValue({ organizationId: "org-1", pending: false });
  spies = {
    read: vi.spyOn(tracesApi, "read").mockResolvedValue(OFF),
    put: vi.spyOn(tracesApi, "put").mockResolvedValue(written()),
    frame: vi
      .spyOn(tracesApi, "frame")
      .mockImplementation((serviceId: string) => Promise.resolve(framed(serviceId))),
  };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function mount(
  serviceType: "application" | "compose" = "application",
  serviceId = "app-1",
  aside?: { node: React.ReactNode; label: string },
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <TracesPanel
        serviceType={serviceType}
        serviceId={serviceId}
        label="Traces"
        icon="route"
        aside={aside}
      />
    </QueryClientProvider>,
  );
}

const settings = () =>
  screen
    .getByRole("heading", { name: "Trace store" })
    .closest("[data-slot=card]") as HTMLElement;

const loaded = () => screen.findByText(/^(Off|On)$/);

const frameOf = () => screen.findByTitle("Traces of this Service") as Promise<HTMLIFrameElement>;

describe("the Traces tab", () => {
  it("reads a Service with traces off, with no frame, and turns them on at the default retention", async () => {
    mount();
    await loaded();
    expect(spies.read).toHaveBeenCalledWith("application", "app-1");
    expect(within(settings()).getByText("Not created yet")).toBeTruthy();
    expect(within(settings()).getByRole("button", { name: "3 days" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByTitle("Traces of this Service")).toBeNull();
    // No frame, so no frame token is minted.
    expect(spies.frame).not.toHaveBeenCalled();
    expect(within(settings()).getByText(/takes effect at this Service’s next deploy/)).toBeTruthy();

    fireEvent.click(within(settings()).getByRole("button", { name: "Turn on" }));
    await waitFor(() =>
      expect(spies.put).toHaveBeenCalledWith("application", "app-1", {
        enabled: true,
        retentionDays: 3,
      }),
    );
    // The read is asked again, so the new state shows.
    await waitFor(() => expect(spies.read).toHaveBeenCalledTimes(2));
  });

  it("keeps a kind's facts card beside the store when it is handed one", async () => {
    mount("compose", "cmp-1", { node: <p>Stack facts</p>, label: "About shop" });
    await loaded();
    const aside = screen.getByRole("complementary", { name: "About shop" });
    expect(within(aside).getByText("Stack facts")).toBeTruthy();
  });

  it("shows a running store's credential, size and retention, and opens its search in a sandboxed frame under a frame token", async () => {
    spies.read.mockResolvedValue(RUNNING);
    mount();
    await loaded();
    expect(within(settings()).getByText("On")).toBeTruthy();
    expect(within(settings()).getByText("Present")).toBeTruthy();
    expect(within(settings()).getByText("2 MB")).toBeTruthy();
    expect(within(settings()).getByText(/applies only to spans sent after it/)).toBeTruthy();
    const frame = await frameOf();
    expect(spies.frame).toHaveBeenCalledWith("app-1");
    expect(frame.getAttribute("src")).toBe("/backend/traces/app-1/ui/t/tok.sig/search");
    // An opaque origin: never allow-same-origin, never allow-top-navigation
    // (ADR-0075), spelled out rather than read off the module's constant.
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts allow-forms allow-popups");
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
  });

  it("says an empty store is 0 bytes on disk, not a limit", async () => {
    spies.read.mockResolvedValue({ ...RUNNING, storeSizeBytes: 0 });
    mount();
    await loaded();
    expect(within(settings()).getByText("0 bytes")).toBeTruthy();
    expect(within(settings()).queryByText("no limit")).toBeNull();
  });

  it("sizes the frame from a design token, not an off-scale value", async () => {
    spies.read.mockResolvedValue(RUNNING);
    mount();
    await loaded();
    const frame = await frameOf();
    expect(frame.className).toContain("h-frame");
    expect(frame.className).not.toMatch(/\[/);
  });

  it("says why there is no frame when the frame token is refused", async () => {
    spies.read.mockResolvedValue(RUNNING);
    spies.frame.mockRejectedValue(new Error("refused"));
    mount();
    await loaded();
    expect(await screen.findByText(/^The console hit an error it does not recognise/)).toBeTruthy();
    expect(screen.queryByTitle("Traces of this Service")).toBeNull();
  });

  it("reads the setting again after a write that failed, since it may have been saved", async () => {
    spies.put.mockRejectedValue(new Error("timed out"));
    mount();
    await loaded();
    fireEvent.click(within(settings()).getByRole("button", { name: "Turn on" }));
    await waitFor(() => expect(spies.read).toHaveBeenCalledTimes(2));
  });

  it("says traces take effect at the next deploy while the store has not started, with no frame", async () => {
    spies.read.mockResolvedValue({ ...RUNNING, storeRunning: false, storeSizeBytes: null });
    mount();
    await loaded();
    expect(screen.getAllByText(/next deploy/).length).toBeGreaterThan(0);
    expect(within(settings()).getByText("Not started")).toBeTruthy();
    expect(screen.queryByTitle("Traces of this Service")).toBeNull();
  });

  it("changes retention with traces left as they are", async () => {
    spies.read.mockResolvedValue(RUNNING);
    mount();
    await loaded();
    fireEvent.click(within(settings()).getByRole("button", { name: "7 days" }));
    await waitFor(() =>
      expect(spies.put).toHaveBeenCalledWith("application", "app-1", {
        enabled: true,
        retentionDays: 7,
      }),
    );
  });

  it("turns traces off, and shows what the turn-off could not remove", async () => {
    spies.read.mockResolvedValue(RUNNING);
    spies.put.mockResolvedValue(
      written({
        enabled: false,
        unreclaimedArtifacts: [
          {
            kind: "trace-store",
            appName: "web",
            serverId: null,
            path: "/etc/cloudgate/applications/web/traces",
          },
        ],
      }),
    );
    mount();
    await loaded();
    fireEvent.click(within(settings()).getByRole("button", { name: "Turn off" }));
    const dialog = await screen.findByRole("dialog");
    expect(spies.put).toHaveBeenCalledWith("application", "app-1", {
      enabled: false,
      retentionDays: 3,
    });
    expect(within(dialog).getByText("/etc/cloudgate/applications/web/traces")).toBeTruthy();
  });

  it("leaves every write control off, with the reason, for a role without service:update", async () => {
    refused.current = new Set(["service:update"]);
    spies.read.mockResolvedValue(RUNNING);
    mount();
    await loaded();
    for (const name of ["Turn off", "1 day", "3 days", "7 days"]) {
      const button = within(settings()).getByRole("button", { name });
      expect(button.getAttribute("aria-disabled")).toBe("true");
      expect(button.getAttribute("title")).toMatch(/^Your role in this Organization cannot/);
      fireEvent.click(button);
    }
    expect(spies.put).not.toHaveBeenCalled();
    // Reading is still allowed: the frame is there.
    expect(await frameOf()).toBeTruthy();
  });

  it("reads and writes a Compose's traces, and says its inner services share the store under their own names", async () => {
    spies.read.mockResolvedValue({ ...RUNNING, serviceType: "compose", serviceId: "cmp-1" });
    mount("compose", "cmp-1");
    await loaded();
    expect(spies.read).toHaveBeenCalledWith("compose", "cmp-1");
    expect(within(settings()).getByText(/Every service in this Compose sends to the one Trace store/)).toBeTruthy();
    const frame = await frameOf();
    expect(frame.getAttribute("src")).toBe("/backend/traces/cmp-1/ui/t/tok.sig/search");

    fireEvent.click(within(settings()).getByRole("button", { name: "7 days" }));
    await waitFor(() =>
      expect(spies.put).toHaveBeenCalledWith("compose", "cmp-1", {
        enabled: true,
        retentionDays: 7,
      }),
    );
    cleanup();
    // An Application's tab says nothing about inner services.
    spies.read.mockResolvedValue(RUNNING);
    mount();
    await loaded();
    expect(screen.queryByText(/Every service in this Compose/)).toBeNull();
  });

  it("never names the software behind the Trace store", async () => {
    for (const state of [OFF, RUNNING, { ...RUNNING, storeRunning: false }]) {
      spies.read.mockResolvedValue(state);
      mount();
      await loaded();
      expect(document.body.textContent).not.toMatch(/jaeger|collector|sidecar/i);
      cleanup();
    }
  });
});
