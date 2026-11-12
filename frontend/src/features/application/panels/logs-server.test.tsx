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

import { Dock, DockProvider } from "@/components/shell/dock";
import { setDockView } from "@/components/shell/dock-state";
import {
  applicationsApi,
  type ApplicationDetail,
  type ApplicationStatus,
} from "@/lib/api/endpoints/applications";
import { keys } from "@/lib/api/keys";
import { clockTime } from "@/lib/format/time";
import { endAllTerminals } from "@/lib/realtime/gateways";

import Panel from "./logs";

// The session's Organization is better-auth's; nothing here is about it.
vi.mock("@/lib/auth/client", async (original) => ({
  ...(await original<typeof import("@/lib/auth/client")>()),
  useActiveOrganizationId: () => ({ organizationId: "org-1", pending: false }),
}));

/**
 * The Logs tab of an Application on a Server or the platform host (#1341):
 * the real panel, the real Dock under it and a real `QueryClient`. Only the
 * network is faked — the gateway is the fake socket, the row is
 * `applicationsApi.findOne` — and the page going away is the panel
 * unmounting.
 */

class FakeSocket {
  static readonly OPEN = 1;
  static all: FakeSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  send = vi.fn();
  close = vi.fn();
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  say(frame: string) {
    this.onmessage?.({ data: frame } as MessageEvent);
  }
}

class NoopObserver {
  observe() {}
  disconnect() {}
}

let status: ApplicationStatus;
let serverId: string | null;

const row = () =>
  ({
    applicationId: "app-1",
    name: "Hello",
    appName: "hello-x1y2",
    serverId,
    server: serverId ? { serverId, name: "worker-1" } : null,
    cloudPlace: null,
    configKind: "web",
    applicationStatus: status,
  }) as unknown as ApplicationDetail;

function renderConsole() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const tree = (onPage: boolean) => (
    <QueryClientProvider client={client}>
      <DockProvider>
        <main id="main" tabIndex={-1}>
          {onPage ? (
            <section aria-label="Logs tab">
              <Panel id="app-1" kind={null} label="Logs" icon="term" />
            </section>
          ) : null}
        </main>
        <Dock />
      </DockProvider>
    </QueryClientProvider>
  );
  const view = render(tree(true));
  return { client, leave: () => view.rerender(tree(false)) };
}

const wait = async (ms = 200) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

const followers = () =>
  FakeSocket.all.filter((socket) =>
    socket.url.includes("/docker-container-logs"),
  );
const tabPage = () => screen.getByRole("region", { name: "Logs tab" });
const logPanel = () => screen.queryByRole("region", { name: /^Log:/ });
const docked = () =>
  within(logPanel()!).getByRole("log", { name: "Hello · Runtime log" });

/** The row changes as another page's Start, Stop or Deploy leaves it. */
async function becomes(next: ApplicationStatus, client: QueryClient) {
  status = next;
  await act(async () => {
    await client.invalidateQueries({
      queryKey: keys.applications.detail("org-1", "app-1"),
    });
  });
  await wait();
}

const ONE = "2026-11-10T09:00:00.000000000Z hello-x1y2.1@worker-1    |";
const TWO = "2026-11-10T09:00:01.000000000Z hello-x1y2.2@worker-1    |";
const ONE_LATER = "2026-11-10T09:00:02.000000000Z hello-x1y2.1@worker-1    |";

beforeEach(() => {
  vi.useFakeTimers();
  status = "done";
  serverId = "srv-1";
  FakeSocket.all = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("ResizeObserver", NoopObserver);
  vi.spyOn(applicationsApi, "findOne").mockImplementation(async () => row());
});

afterEach(() => {
  cleanup();
  endAllTerminals();
  setDockView("normal");
  localStorage.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Panel — Runtime log on a Server or the platform host", () => {
  it("follows its Swarm service on its Server, from the last 200 lines, asking Docker to name each copy", async () => {
    renderConsole();
    await wait();

    const [socket] = followers();
    const url = new URL(socket!.url);
    expect(url.searchParams.get("containerId")).toBe("hello-x1y2");
    expect(url.searchParams.get("runType")).toBe("swarm");
    expect(url.searchParams.get("taskPrefix")).toBe("true");
    expect(url.searchParams.get("tail")).toBe("200");
    expect(url.searchParams.get("serverId")).toBe("srv-1");
  });

  it("follows it on the platform host, naming no Server", async () => {
    serverId = null;
    renderConsole();
    await wait();

    const url = new URL(followers()[0]!.url);
    expect(url.searchParams.get("serverId")).toBeNull();
    expect(tabPage().textContent).toContain("the platform host");
  });

  it("merges two copies' lines by time, each naming its copy", async () => {
    renderConsole();
    await wait();
    const [socket] = followers();
    act(() => socket!.open());
    // Docker reads each copy's tail on its own: copy 1's, then copy 2's.
    act(() =>
      socket!.say(
        `${ONE} one: booted\n${ONE_LATER} one: GET /\n${TWO} two: booted\n`,
      ),
    );
    await wait();

    const well = within(tabPage()).getByRole("log", {
      name: "Container output for Hello",
    });
    const text = well.textContent ?? "";
    expect(text).toContain("[hello-x1y2.1] one: booted");
    expect(text.indexOf("[hello-x1y2.1] one: booted")).toBeLessThan(
      text.indexOf("[hello-x1y2.2] two: booted"),
    );
    expect(text.indexOf("[hello-x1y2.2] two: booted")).toBeLessThan(
      text.indexOf("[hello-x1y2.1] one: GET /"),
    );
    expect(text).toContain(clockTime(Date.parse("2026-11-10T09:00:01Z")));
    expect(text).not.toContain("@worker-1");
    expect(tabPage().textContent).toContain(
      "Following every running copy of the Swarm service.",
    );
  });

  it("says a never-deployed Application has nothing to read, and dials nothing", async () => {
    status = "idle";
    renderConsole();
    await wait();

    expect(tabPage().textContent).toContain("Not deployed yet");
    expect(tabPage().textContent).not.toContain("closed the connection");
    expect(followers()).toHaveLength(0);
  });

  it("says a stopped Application writes nothing, with no cursor", async () => {
    status = "stopped";
    renderConsole();
    await wait();
    act(() => followers()[0]!.open());
    await wait();

    expect(tabPage().textContent).toContain(
      "Stopped — the Swarm service has no running task",
    );
    expect(tabPage().textContent).not.toContain("Following");
    expect(tabPage().querySelector('[data-slot="log-cursor"]')).toBeNull();
  });

  it("dials once a deploy finishes, having had nothing to follow", async () => {
    status = "idle";
    const { client } = renderConsole();
    await wait();
    expect(followers()).toHaveLength(0);

    await becomes("running", client);
    const dialled = followers().length;
    await becomes("done", client);

    // The converge finished, so the service exists now: dialled again, to
    // the same Swarm service, rather than left on a "no such service".
    expect(followers()).toHaveLength(dialled + 1);
    expect(followers().at(-1)!.url).toBe(followers()[0]!.url);
  });

  it("docks, and the docked log keeps following, its copies named, once the page is gone", async () => {
    const { leave } = renderConsole();
    await wait();
    const [socket] = followers();
    act(() => socket!.open());
    act(() => socket!.say(`${ONE} one: booted\n`));
    await wait();

    fireEvent.click(within(tabPage()).getByRole("button", { name: "Dock" }));
    expect(tabPage().textContent).toContain(
      "This log is in the Dock at the bottom of the console, still following.",
    );

    leave();
    act(() => socket!.say(`${TWO} two: booted\n`));
    await wait();

    expect(socket!.close).not.toHaveBeenCalled();
    expect(followers()).toHaveLength(1);
    expect(docked().textContent).toContain("[hello-x1y2.1] one: booted");
    expect(docked().textContent).toContain("[hello-x1y2.2] two: booted");
  });

  it("says it is stopped in the Dock once the Application stops with its page gone", async () => {
    const { client, leave } = renderConsole();
    await wait();
    act(() => followers()[0]!.open());
    await wait();
    fireEvent.click(within(tabPage()).getByRole("button", { name: "Dock" }));
    leave();

    await becomes("stopped", client);

    const tab = within(logPanel()!).getByRole("tab", {
      name: /Hello · Runtime log/,
    });
    expect(tab.textContent).toContain("Application stopped");
  });
});
