import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import RuntimeLogPanel from "@/features/application/panels/logs";
import { RUNTIME_LOG_LOOKBACK_MS } from "@/features/application/runtime-log/runtime-log-lines";
import {
  applicationsApi,
  type ApplicationDetail,
  type RuntimeLog,
  type RuntimeLogLine,
} from "@/lib/api/endpoints/applications";
import { ApiError } from "@/lib/api/api-error";
import { endAllTerminals } from "@/lib/realtime/gateways";

import { Dock, DockProvider } from "./dock";
import { setDockView } from "./dock-state";

// The session's Organization is better-auth's; nothing here is about it.
vi.mock("@/lib/auth/client", async (original) => ({
  ...(await original<typeof import("@/lib/auth/client")>()),
  useActiveOrganizationId: () => ({ organizationId: "org-1", pending: false }),
}));

/**
 * A cloud Service's Runtime log docked, in the Dock's harness
 * (`dock.test.tsx`): the real Dock and the real Runtime log page under it, a
 * real `QueryClient`, fake timers for the 4 s poll. Only REST is stubbed —
 * the Service row and the Runtime log read. The page going away is the panel
 * unmounting.
 *
 * What these pin is the cost rule: a docked cloud log reads only while
 * someone can see it, picks up at once from its cursor when they can again, and
 * marks a span the backend's lookback no longer reaches.
 */

class NoopObserver {
  observe() {}
  disconnect() {}
}

const SERVICES: Record<string, string> = {
  "app-1": "storefront",
  "app-2": "billing",
};

/** What each Service's next read hands back, by Service. */
let pending: Record<string, RuntimeLogLine[]>;
/** A Service whose reads are now refused, with the status they answer. */
let refused: Record<string, number>;
/** The `since` of every read made, by Service. */
let reads: Record<string, (number | undefined)[]>;
let clockAt = 0;

const line = (id: string, message: string): RuntimeLogLine => ({
  id,
  at: clockAt,
  task: "aaaaaaaa1111",
  message,
});

function stubRest() {
  vi.spyOn(applicationsApi, "findOne").mockImplementation(
    async (id) =>
      ({
        applicationId: id,
        name: SERVICES[id],
        cloudPlace: {
          cloudAccountId: "ca-1",
          cloudAccountName: "Production AWS",
          region: "eu-central-1",
        },
      }) as unknown as ApplicationDetail,
  );
  vi.spyOn(applicationsApi, "runtimeLog").mockImplementation(
    async (id, since): Promise<RuntimeLog> => {
      (reads[id] ??= []).push(since);
      const status = refused[id];
      if (status !== undefined) {
        throw new ApiError(status, "refused", { method: "GET" });
      }
      const lines = pending[id] ?? [];
      pending[id] = [];
      return { lines, next: Date.now(), more: false };
    },
  );
}

function renderConsole(ids: string[] = ["app-1"]) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const tree = (onPage: boolean) => (
    <QueryClientProvider client={client}>
      <DockProvider>
        <main id="main" tabIndex={-1}>
          {onPage
            ? ids.map((id) => (
                <section key={id} aria-label={SERVICES[id]}>
                  <RuntimeLogPanel
                    id={id}
                    kind={null}
                    label="Runtime log"
                    icon="term"
                  />
                </section>
              ))
            : null}
        </main>
        <Dock />
      </DockProvider>
    </QueryClientProvider>
  );
  const view = render(tree(true));
  return { leave: () => view.rerender(tree(false)) };
}

/** Let the fake clock run: query reads, polls. */
const wait = async (ms = 200) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

const page = (name: string) => screen.getByRole("region", { name });
const logPanel = () => screen.queryByRole("region", { name: /^Log:/ });
const dockFrom = (name: string) =>
  fireEvent.click(within(page(name)).getByRole("button", { name: "Dock" }));
const readsOf = (id: string) => reads[id] ?? [];

let hidden = false;
function setHidden(value: boolean) {
  hidden = value;
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

/** The storefront's page, reading, with a line in hand. */
async function reading(ids?: string[]) {
  pending["app-1"] = [line("1", "listening on :8080")];
  const view = renderConsole(ids);
  await wait();
  return view;
}

beforeEach(() => {
  vi.useFakeTimers();
  clockAt = new Date(2026, 9, 17, 10, 0, 0).getTime();
  vi.setSystemTime(clockAt);
  pending = {};
  refused = {};
  reads = {};
  hidden = false;
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => (hidden ? "hidden" : "visible"),
  });
  vi.stubGlobal("ResizeObserver", NoopObserver);
  stubRest();
});

afterEach(() => {
  cleanup();
  endAllTerminals();
  setDockView("normal");
  localStorage.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(document, "visibilityState");
});

describe("a docked cloud Runtime log", () => {
  it("moves the lines held and the cursor into the Dock, and keeps one poll", async () => {
    await reading();
    expect(readsOf("app-1")).toEqual([undefined]);
    const cursor = Date.now();

    dockFrom("storefront");

    const docked = within(logPanel()!).getByRole("log", {
      name: "storefront · Runtime log",
    });
    expect(docked.textContent).toContain("[aaaaaaaa] listening on :8080");
    expect(document.activeElement).toBe(docked);
    expect(page("storefront").textContent).toContain(
      "This log is in the Dock at the bottom of the console, still following.",
    );

    pending["app-1"] = [line("2", "GET / 200")];
    await wait(4_000);

    expect(readsOf("app-1")).toEqual([undefined, cursor]);
    expect(docked.textContent).toContain("[aaaaaaaa] GET / 200");
  });

  it("keeps polling once its page is gone", async () => {
    const { leave } = await reading();
    dockFrom("storefront");
    leave();

    pending["app-1"] = [line("2", "GET / 200")];
    await wait(4_000);

    expect(readsOf("app-1")).toHaveLength(2);
    expect(logPanel()!.textContent).toContain("[aaaaaaaa] GET / 200");
  });

  it("reads nothing while the browser tab is hidden, and at once from its cursor when it is shown", async () => {
    await reading();
    dockFrom("storefront");
    // The page's own box would keep reading; this pins the docked one.
    setHidden(true);
    const cursor = Date.now();

    await wait(60_000);
    expect(readsOf("app-1")).toHaveLength(1);

    setHidden(false);
    await wait(0);

    expect(readsOf("app-1")).toEqual([undefined, cursor]);
  });

  it("reads nothing while the Dock is minimised, and at once when it is restored", async () => {
    await reading();
    dockFrom("storefront");
    const panel = logPanel()!;

    fireEvent.click(
      within(panel).getByRole("button", { name: "Minimise the Dock" }),
    );
    await wait(60_000);
    expect(readsOf("app-1")).toHaveLength(1);

    fireEvent.click(
      within(panel).getByRole("button", { name: "Restore the Dock" }),
    );
    await wait(0);

    expect(readsOf("app-1")).toHaveLength(2);
  });

  it("reads nothing while another Dock tab is in front, and at once when it is back", async () => {
    await reading(["app-1", "app-2"]);
    dockFrom("storefront");
    dockFrom("billing");
    const before = readsOf("app-1").length;

    await wait(60_000);
    expect(readsOf("app-1")).toHaveLength(before);
    expect(readsOf("app-2").length).toBeGreaterThan(1);

    fireEvent.click(
      within(logPanel()!).getByRole("tab", {
        name: /storefront · Runtime log/,
      }),
    );
    await wait(0);

    expect(readsOf("app-1")).toHaveLength(before + 1);
  });

  it("marks the span a pause over an hour could not read, once", async () => {
    await reading();
    dockFrom("storefront");
    setHidden(true);

    await wait(2 * RUNTIME_LOG_LOOKBACK_MS);
    setHidden(false);
    await wait(0);

    const docked = within(logPanel()!).getByRole("log");
    const marked = within(docked).getAllByText(
      "Lines between 10:00 and 11:00 were not read.",
    );
    expect(marked).toHaveLength(1);
    expect(docked.textContent).toContain("[aaaaaaaa] listening on :8080");
  });

  it("leaves no mark after a pause within the hour", async () => {
    await reading();
    dockFrom("storefront");
    setHidden(true);

    await wait(30 * 60_000);
    setHidden(false);
    await wait(0);

    expect(logPanel()!.textContent).not.toContain("were not read");
  });

  it("closing its tab stops the poll", async () => {
    const { leave } = await reading();
    dockFrom("storefront");
    leave();

    fireEvent.click(
      within(logPanel()!).getByRole("button", {
        name: "Close storefront · Runtime log",
      }),
    );
    await wait(60_000);

    expect(readsOf("app-1")).toHaveLength(1);
  });
});

describe("a docked cloud Runtime log that loses access", () => {
  it("ends the tab on a forbidden read: every line kept, ⊘ No longer authorized, the sentence, and no further reads", async () => {
    const { leave } = await reading();
    dockFrom("storefront");
    leave();

    refused["app-1"] = 403;
    await wait(4_000);
    await wait(60_000);

    const panel = logPanel()!;
    const tab = within(panel).getByRole("tab", {
      name: /storefront · Runtime log/,
    });
    const mark = within(tab).getByRole("img", { name: "Stopped" });
    expect(mark.textContent).toBe("⊘");
    expect(tab.textContent).toContain("No longer authorized");
    expect(panel.textContent).toContain("[aaaaaaaa] listening on :8080");
    expect(panel.textContent).toContain(
      "Your role in this Organization does not allow this.",
    );
    expect(readsOf("app-1")).toHaveLength(2);
  });

  it("ends the tab on a read answered not found — a deleted Service — as Could not connect", async () => {
    await reading();
    dockFrom("storefront");

    refused["app-1"] = 404;
    await wait(4_000);
    await wait(60_000);

    const tab = within(logPanel()!).getByRole("tab", {
      name: /storefront · Runtime log/,
    });
    expect(tab.textContent).toContain("Could not connect");
    expect(readsOf("app-1")).toHaveLength(2);
    expect(page("storefront").textContent).toContain(
      "This log is in the Dock at the bottom of the console. That is not here any more.",
    );
  });

  it("keeps reading through a failure that is not a refusal", async () => {
    await reading();
    dockFrom("storefront");

    refused["app-1"] = 503;
    await wait(4_000);
    await wait(4_000);

    expect(readsOf("app-1")).toHaveLength(3);
  });
});

describe("the page's own Runtime log box", () => {
  it("keeps reading after a refused read, as before", async () => {
    await reading();

    refused["app-1"] = 403;
    await wait(8_000);

    expect(readsOf("app-1")).toHaveLength(3);
  });

  it("keeps reading while the browser tab is hidden, as before", async () => {
    await reading();
    setHidden(true);

    await wait(8_000);

    expect(readsOf("app-1")).toHaveLength(3);
  });

  it("stops reading when its page goes, if it was never docked", async () => {
    const { leave } = await reading();

    leave();
    await wait(60_000);

    expect(readsOf("app-1")).toHaveLength(1);
  });

  it("Read it here too opens a second poll on the page, and the docked one carries on", async () => {
    await reading();
    dockFrom("storefront");

    fireEvent.click(
      within(page("storefront")).getByRole("button", {
        name: "Read it here too",
      }),
    );
    await wait(0);

    expect(readsOf("app-1")).toEqual([undefined, undefined]);
    expect(
      within(page("storefront")).getByRole("log", {
        name: "Runtime log of storefront",
      }),
    ).toBeTruthy();
    expect(logPanel()).not.toBeNull();
  });
});
