import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { useEffect, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LiveTerminal } from "@/components/console/live-terminal";
import type { XtermKit } from "@/components/console/terminal-emulator";
import type { TerminalTarget } from "@/components/console/terminal-target";
import { DeploymentLog } from "@/features/application/deploy/deployment-log";
import { useApplicationDeployments } from "@/features/application/use-application";
import { ContainerOutput } from "@/features/compose/logs/container-output";
import {
  deploymentsApi,
  type Deployment,
  type DeploymentStatus,
} from "@/lib/api/endpoints/deployments";
import { ContainerLog } from "@/features/database/container-log";
import { useDatabase } from "@/features/database/use-database";
import { SetupCard } from "@/features/server/infrastructure/setup-card";
import {
  SETUP_NOT_RUNNING_CLOSE_CODE,
  useServer,
} from "@/features/server/use-server";
import type { ApplicationStatus } from "@/lib/api/endpoints/applications";
import { ApiError } from "@/lib/api/api-error";
import { databasesApi, type Database } from "@/lib/api/endpoints/databases";
import { serversApi, type Server } from "@/lib/api/endpoints/servers";
import { keys } from "@/lib/api/keys";
import {
  DENIED_CLOSE_CODE,
  LEASE_CLOSE_CODE,
  OUTPUT_ENDED_CLOSE_CODE,
  endAllTerminals,
} from "@/lib/realtime/gateways";

import { setDockView } from "./dock-state";
import { Dock, DockProvider } from "./dock";
import { useDock, useTerminalOffers, type DockApi } from "./dock-context";
import {
  DOCK_LOGS_FULL_SENTENCE,
  DOCK_SHELLS_FULL_SENTENCE,
  MAX_DOCK_LOGS,
  MAX_DOCK_SHELLS,
} from "./dock-store";
import type { TerminalOffer } from "./terminal-offers";

// The session's Organization is better-auth's; nothing here is about it.
vi.mock("@/lib/auth/client", async (original) => ({
  ...(await original<typeof import("@/lib/auth/client")>()),
  useActiveOrganizationId: () => ({ organizationId: "org-1", pending: false }),
}));

/**
 * The docked terminal panel, driven the way an operator drives it.
 *
 * The socket is a fake WebSocket and xterm a fake kit — the emulator's own
 * contract is `terminal-emulator.test.ts`'s — so what these pin is the
 * panel: what its header and its tabs say, what each control does to each
 * shell, the cap, the `+` offers, and ⌃`.
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
  end(code: number, reason = "") {
    this.readyState = 3;
    this.onclose?.({ code, reason } as CloseEvent);
  }
  say(frame: string) {
    this.onmessage?.({ data: frame } as MessageEvent);
  }
}

const focused = vi.fn();
/** What the fit addon measures the frame at — a Dock dragged taller, say. */
let proposed = { cols: 100, rows: 20 };
const kit: XtermKit = {
  create: () => ({
    term: {
      cols: 80,
      rows: 24,
      open: () => {},
      write: () => {},
      onData: () => {},
      resize: () => {},
      refresh: () => {},
      focus: focused,
      attachCustomKeyEventHandler: () => {},
      dispose: () => {},
    } as never,
    fit: { proposeDimensions: () => ({ ...proposed }) } as never,
  }),
  paint: () => {},
};

function create(target: TerminalTarget) {
  const session = new LiveTerminal(target, "dock", { kit: async () => kit });
  session.start();
  return session;
}

const container: TerminalTarget = {
  kind: "container",
  containerId: "c-1",
  serverId: "srv-1",
  name: "app-9uiusu.1.x7",
  host: "main-vps",
  shell: "sh",
};
const server: TerminalTarget = {
  kind: "server",
  serverId: "srv-1",
  name: "main-vps",
  address: "root@10.0.0.1:22",
};

/** The Dock's API, as the page last saw it. */
let seen: DockApi | null = null;

/** A page with the Dock under it, and a way to ask it for shells. */
function Page({ offers = [] }: { offers?: TerminalOffer[] }) {
  const dock = useDock();
  useEffect(() => {
    seen = dock;
  });
  useTerminalOffers(offers);
  return (
    <>
      <button type="button" onClick={() => dock?.open(container)}>
        Open a shell
      </button>
      <button type="button" onClick={() => dock?.open(server)}>
        Open the Server
      </button>
      <input aria-label="Search" />
    </>
  );
}

function renderDock({ offers }: { offers?: TerminalOffer[] } = {}) {
  return render(
    <DockProvider create={create}>
      <main id="main" tabIndex={-1}>
        <Page offers={offers} />
      </main>
      <Dock />
    </DockProvider>,
  );
}

const panel = () => screen.queryByRole("region", { name: /^Terminal:/ });

class NoopObserver {
  observe() {}
  disconnect() {}
}

const openShell = () =>
  fireEvent.click(screen.getByRole("button", { name: "Open a shell" }));
const openServer = () =>
  fireEvent.click(screen.getByRole("button", { name: "Open the Server" }));
const tabs = () => within(panel()!).queryAllByRole("tab");
/** The resize frames a socket was sent, as `cols×rows`. */
const resizes = (socket: FakeSocket | undefined) =>
  (socket?.send.mock.calls ?? [])
    .map(([frame]) => String(frame))
    .filter((frame) => frame.startsWith("\x00"))
    .map((frame) => {
      const { cols, rows } = JSON.parse(frame.slice(1));
      return `${cols}×${rows}`;
    });

beforeEach(() => {
  seen = null;
  proposed = { cols: 100, rows: 20 };
  FakeSocket.all = [];
  focused.mockReset();
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("ResizeObserver", NoopObserver);
});

afterEach(() => {
  cleanup();
  endAllTerminals();
  setDockView("normal");
  localStorage.clear();
  document.documentElement.style.removeProperty("--dock-h");
  vi.unstubAllGlobals();
});

describe("the docked terminal", () => {
  it("is closed until a shell is opened, and then names what the shell is in", () => {
    renderDock();
    expect(panel()).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Open a shell" }));

    expect(panel()).not.toBeNull();
    expect(
      within(panel()!).getByText("container app-9uiusu.1.x7 on main-vps"),
    ).toBeTruthy();
    expect(FakeSocket.all).toHaveLength(1);
    expect(FakeSocket.all[0]?.url).toContain("/docker-container-terminal?");
  });

  it("says which shell it opens without claiming every image has one", () => {
    renderDock();
    fireEvent.click(screen.getByRole("button", { name: "Open a shell" }));
    act(() => FakeSocket.all[0]?.open());
    act(() =>
      FakeSocket.all[0]?.onmessage?.({
        data: '\x00{"shell":"open"}',
      } as MessageEvent),
    );

    expect(panel()?.textContent).toContain(
      "This opens sh, which most images carry — not all do. Run bash inside it if the image has one.",
    );
  });

  it("Close with one shell ends it without asking — the socket closes, so the gateway reaps it", () => {
    renderDock();
    fireEvent.click(screen.getByRole("button", { name: "Open a shell" }));
    act(() => FakeSocket.all[0]?.open());

    fireEvent.click(screen.getByRole("button", { name: "Close the Dock" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(FakeSocket.all[0]?.close).toHaveBeenCalled();
    expect(panel()).toBeNull();
  });

  it("Minimise keeps the shell running, and Maximise and Restore change only the view", () => {
    renderDock();
    fireEvent.click(screen.getByRole("button", { name: "Open a shell" }));
    act(() => FakeSocket.all[0]?.open());

    fireEvent.click(screen.getByRole("button", { name: "Minimise the Dock" }));
    expect(document.documentElement.getAttribute("data-dock")).toBe(
      "minimised",
    );
    expect(FakeSocket.all[0]?.close).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Restore the Dock" }));
    expect(document.documentElement.hasAttribute("data-dock")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Maximise the Dock" }));
    expect(document.documentElement.getAttribute("data-dock")).toBe(
      "maximised",
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Restore the Dock's height" }),
    );
    expect(document.documentElement.hasAttribute("data-dock")).toBe(false);
    expect(FakeSocket.all[0]?.close).not.toHaveBeenCalled();
  });

  it("a lease that ends while minimised says so in the header bar (ADR-0012)", () => {
    renderDock();
    fireEvent.click(screen.getByRole("button", { name: "Open a shell" }));
    act(() => FakeSocket.all[0]?.open());
    fireEvent.click(screen.getByRole("button", { name: "Minimise the Dock" }));

    act(() =>
      FakeSocket.all[0]?.end(
        LEASE_CLOSE_CODE,
        "This session is no longer authorized",
      ),
    );

    expect(panel()?.textContent).toContain("No longer authorized");
  });

  it("a shell opened into a minimised Dock shows it", () => {
    setDockView("minimised");
    renderDock();

    fireEvent.click(screen.getByRole("button", { name: "Open a shell" }));

    expect(document.documentElement.hasAttribute("data-dock")).toBe(false);
  });

  describe("several shells, as tabs", () => {
    it("a second shell is a second tab, made active, named like the header", () => {
      renderDock();
      openShell();
      openServer();

      expect(screen.queryByRole("dialog")).toBeNull();
      expect(tabs().map((tab) => tab.textContent)).toEqual([
        expect.stringContaining("container app-9uiusu.1.x7 on main-vps"),
        expect.stringContaining("Server main-vps"),
      ]);
      expect(tabs()[1]?.getAttribute("aria-selected")).toBe("true");
      expect(FakeSocket.all).toHaveLength(2);
      expect(FakeSocket.all[0]?.close).not.toHaveBeenCalled();
    });

    it("the tab row labels both groups with how many of their four are open, an empty one too", () => {
      renderDock();
      openShell();
      expect(within(panel()!).getByText("Shells 1/4")).toBeTruthy();

      openServer();
      expect(within(panel()!).getByText("Shells 2/4")).toBeTruthy();
      expect(within(panel()!).getByText("Logs 0/4")).toBeTruthy();
    });

    it("switching tabs shows the other shell and ends neither", () => {
      renderDock();
      openShell();
      openServer();

      fireEvent.click(tabs()[0]!);

      expect(tabs()[0]?.getAttribute("aria-selected")).toBe("true");
      expect(panel()?.getAttribute("aria-label")).toBe(
        "Terminal: container app-9uiusu.1.x7 on main-vps",
      );
      expect(FakeSocket.all[0]?.close).not.toHaveBeenCalled();
      expect(FakeSocket.all[1]?.close).not.toHaveBeenCalled();
    });

    it("closing one tab ends that shell only", () => {
      renderDock();
      openShell();
      openServer();

      fireEvent.click(
        within(panel()!).getByRole("button", {
          name: "Close container app-9uiusu.1.x7 on main-vps",
        }),
      );

      expect(FakeSocket.all[0]?.close).toHaveBeenCalled();
      expect(FakeSocket.all[1]?.close).not.toHaveBeenCalled();
      expect(tabs()).toHaveLength(1);
      expect(tabs()[0]?.textContent).toContain("Server main-vps");
    });

    it("a shell revoked (4010) in a background tab says so on its tab", () => {
      renderDock();
      openShell();
      act(() => FakeSocket.all[0]?.open());
      openServer();

      act(() =>
        FakeSocket.all[0]?.end(
          LEASE_CLOSE_CODE,
          "This session is no longer authorized",
        ),
      );

      expect(tabs()[0]?.textContent).toContain("No longer authorized");
      expect(tabs()[1]?.textContent).not.toContain("No longer authorized");
    });

    it("switching to a tab refits its terminal and tells the shell the size it missed", async () => {
      renderDock();
      openShell();
      act(() => FakeSocket.all[0]?.open());
      await vi.waitFor(() =>
        expect(resizes(FakeSocket.all[0])).toContain("100×20"),
      );
      openServer();
      act(() => FakeSocket.all[1]?.open());
      await vi.waitFor(() =>
        expect(resizes(FakeSocket.all[1])).toContain("100×20"),
      );

      // The Dock is dragged taller while the first shell is out of sight.
      proposed = { cols: 100, rows: 31 };
      fireEvent.click(tabs()[0]!);

      await vi.waitFor(() =>
        expect(resizes(FakeSocket.all[0])).toContain("100×31"),
      );
    });

    describe("Close with several open", () => {
      it("asks first, and Cancel keeps them all", () => {
        renderDock();
        openShell();
        openServer();

        fireEvent.click(screen.getByRole("button", { name: "Close the Dock" }));

        const dialog = screen.getByRole("dialog");
        expect(dialog.textContent).toContain("Close 2 shells?");
        fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

        expect(FakeSocket.all[0]?.close).not.toHaveBeenCalled();
        expect(FakeSocket.all[1]?.close).not.toHaveBeenCalled();
        expect(tabs()).toHaveLength(2);
      });

      it("confirmed, ends every one and closes the Dock", () => {
        renderDock();
        openShell();
        openServer();

        fireEvent.click(screen.getByRole("button", { name: "Close the Dock" }));
        fireEvent.click(
          within(screen.getByRole("dialog")).getByRole("button", {
            name: "Close 2 shells",
          }),
        );

        expect(FakeSocket.all[0]?.close).toHaveBeenCalled();
        expect(FakeSocket.all[1]?.close).toHaveBeenCalled();
        expect(panel()).toBeNull();
      });
    });

    describe(`the cap of ${MAX_DOCK_SHELLS}`, () => {
      const plus = () =>
        within(panel()!).getByRole("button", { name: "Open another shell" });
      const disabled = (element: HTMLElement) =>
        element.hasAttribute("disabled") ||
        element.getAttribute("aria-disabled") === "true";

      function fill() {
        renderDock({ offers: [{ target: server }] });
        for (let i = 0; i < MAX_DOCK_SHELLS; i++) openShell();
      }

      it("at the cap, + is disabled with the sentence, and nothing more opens", () => {
        fill();

        expect(disabled(plus())).toBe(true);
        expect(panel()?.textContent).toContain(DOCK_SHELLS_FULL_SENTENCE);
        expect(seen?.shellsFull).toBe(true);

        let result: string | undefined;
        act(() => {
          result = seen?.open(server);
        });
        expect(result).toBe("full");
        expect(FakeSocket.all).toHaveLength(MAX_DOCK_SHELLS);
      });

      it("closing one re-enables them", () => {
        fill();

        fireEvent.click(
          within(panel()!).getAllByRole("button", {
            name: "Close container app-9uiusu.1.x7 on main-vps",
          })[0]!,
        );

        expect(disabled(plus())).toBe(false);
        expect(panel()?.textContent).not.toContain(DOCK_SHELLS_FULL_SENTENCE);
        expect(seen?.shellsFull).toBe(false);
      });
    });
  });

  describe("+", () => {
    it("lists the shells this page offers, by the name their tab will carry, and opens one", async () => {
      renderDock({ offers: [{ target: server }] });
      openShell();

      fireEvent.click(
        within(panel()!).getByRole("button", { name: "Open another shell" }),
      );
      const item = await screen.findByRole("menuitem", {
        name: "Server main-vps",
      });
      fireEvent.click(item);

      expect(FakeSocket.all).toHaveLength(2);
      expect(FakeSocket.all[1]?.url).toContain("/terminal?");
      expect(tabs()[1]?.getAttribute("aria-selected")).toBe("true");
    });

    it("says so on a page that offers none", async () => {
      renderDock();
      openShell();

      fireEvent.click(
        within(panel()!).getByRole("button", { name: "Open another shell" }),
      );

      expect(
        await screen.findByText(
          "This page offers no shells to open. A Server, a Service or the Servers screen does.",
        ),
      ).toBeTruthy();
      expect(screen.queryAllByRole("menuitem")).toHaveLength(0);
    });
  });

  it("an organization switch or a sign-out ends every shell at once", () => {
    renderDock();
    openShell();
    openServer();
    openShell();
    for (const socket of FakeSocket.all) act(() => socket.open());

    act(() => endAllTerminals());

    expect(FakeSocket.all).toHaveLength(3);
    for (const socket of FakeSocket.all) {
      expect(socket.close).toHaveBeenCalled();
    }
    expect(panel()).toBeNull();
  });

  it("the layout going ends the shell", () => {
    const { unmount } = renderDock();
    fireEvent.click(screen.getByRole("button", { name: "Open a shell" }));

    unmount();

    expect(FakeSocket.all[0]?.close).toHaveBeenCalled();
  });

  describe("the resize handle", () => {
    it("follows a drag of the top edge and stores the height once, at the end", () => {
      renderDock();
      fireEvent.click(screen.getByRole("button", { name: "Open a shell" }));
      vi.spyOn(panel()!, "getBoundingClientRect").mockReturnValue({
        height: 300,
      } as DOMRect);
      const handle = screen.getByRole("separator", {
        name: "Resize the Dock",
      });

      fireEvent.pointerDown(handle, { clientY: 500, pointerId: 1 });
      fireEvent.pointerMove(handle, { clientY: 400, pointerId: 1 });

      expect(document.documentElement.style.getPropertyValue("--dock-h")).toBe(
        "400px",
      );
      expect(localStorage.getItem("cloudgate.dock")).toBeNull();

      fireEvent.pointerUp(handle, { clientY: 380, pointerId: 1 });
      expect(
        JSON.parse(localStorage.getItem("cloudgate.dock") ?? "{}"),
      ).toMatchObject({
        height: 420,
      });
    });

    it("moves with the arrow keys", () => {
      renderDock();
      fireEvent.click(screen.getByRole("button", { name: "Open a shell" }));
      vi.spyOn(panel()!, "getBoundingClientRect").mockReturnValue({
        height: 300,
      } as DOMRect);

      fireEvent.keyDown(screen.getByRole("separator"), { key: "ArrowUp" });

      expect(document.documentElement.style.getPropertyValue("--dock-h")).toBe(
        "324px",
      );
    });
  });

  describe("⌃`", () => {
    const press = (target: Element) =>
      fireEvent.keyDown(target, { key: "`", code: "Backquote", ctrlKey: true });

    it("a shell arriving in the Dock gets the keyboard", async () => {
      renderDock();
      fireEvent.click(screen.getByRole("button", { name: "Open a shell" }));

      // xterm arrives with its chunk, and takes the focus it was asked for then.
      await vi.waitFor(() => expect(focused).toHaveBeenCalled());
    });

    it("from the page restores the Dock and puts focus in the terminal", async () => {
      renderDock();
      fireEvent.click(screen.getByRole("button", { name: "Open a shell" }));
      await vi.waitFor(() => expect(focused).toHaveBeenCalled());
      focused.mockClear();
      fireEvent.click(
        screen.getByRole("button", { name: "Minimise the Dock" }),
      );
      const search = screen.getByRole("textbox", { name: "Search" });
      search.focus();

      press(search);

      expect(document.documentElement.hasAttribute("data-dock")).toBe(false);
      await vi.waitFor(() => expect(focused).toHaveBeenCalled());
    });

    it("from inside the terminal minimises and gives focus back to the page — even past xterm", () => {
      renderDock();
      fireEvent.click(screen.getByRole("button", { name: "Open a shell" }));
      const search = screen.getByRole("textbox", { name: "Search" });
      search.focus();
      press(search);

      // xterm's textarea handles its keys and stops them propagating; the
      // Dock's listener is on window in the capture phase, ahead of it.
      const textarea = document.createElement("textarea");
      textarea.addEventListener("keydown", (event) => event.stopPropagation());
      panel()!.append(textarea);
      textarea.focus();
      press(textarea);

      expect(document.documentElement.getAttribute("data-dock")).toBe(
        "minimised",
      );
      expect(document.activeElement).toBe(search);
    });

    it("acts on the active tab", () => {
      renderDock();
      openShell();
      openServer();
      fireEvent.click(tabs()[0]!);
      const [first, second] = seen!.sessions;
      const firstFocus = vi.spyOn(first!.emulator, "focus");
      const secondFocus = vi.spyOn(second!.emulator, "focus");
      const search = screen.getByRole("textbox", { name: "Search" });
      search.focus();

      press(search);

      expect(firstFocus).toHaveBeenCalled();
      expect(secondFocus).not.toHaveBeenCalled();
    });

    it("does nothing while the Dock is closed", () => {
      renderDock();
      const search = screen.getByRole("textbox", { name: "Search" });
      search.focus();

      const event = press(search);

      // `fireEvent` answers false when the default was prevented.
      expect(event).toBe(true);
    });
  });
});

/**
 * A Deployment log docked from its card, with the real card mounted
 * under the Dock. Only the network is faked: the gateway is the fake socket
 * above, and the Deployments read is `deploymentsApi`. The page going away is
 * the card unmounting; coming back is it mounting again.
 */
describe("a docked Deployment log", () => {
  let rows: Deployment[];

  const row = (number: number, status: DeploymentStatus = "running") =>
    ({
      deploymentId: `dep-${number}`,
      status,
      title: `Deploy #${number}`,
      applicationId: "app-1",
      composeId: null,
      createdAt: "2026-01-01T10:00:00.000Z",
      startedAt: "2026-01-01T10:00:00.000Z",
    }) as unknown as Deployment;

  /** The Service's Deployments screen: one log card per Deployment. */
  function DeploymentsPage() {
    const deployments = useApplicationDeployments("app-1");
    return (
      <>
        {(deployments.data ?? []).map((each) => (
          <section key={each.deploymentId} aria-label={each.title}>
            <DeploymentLog deployment={each} subject="storefront" />
          </section>
        ))}
      </>
    );
  }

  function renderConsole() {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const tree = (onPage: boolean) => (
      <QueryClientProvider client={client}>
        <DockProvider create={create}>
          <main id="main" tabIndex={-1}>
            <Page />
            {onPage ? <DeploymentsPage /> : null}
          </main>
          <Dock />
        </DockProvider>
      </QueryClientProvider>
    );
    const view = render(tree(true));
    return {
      leave: () => view.rerender(tree(false)),
      comeBack: () => view.rerender(tree(true)),
    };
  }

  /** Let the fake clock run: socket line flushes, query reads, polls. */
  const wait = async (ms = 200) => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  };
  const builds = () =>
    FakeSocket.all.filter((socket) =>
      socket.url.includes("/listen-deployment"),
    );
  const card = (title: string) => screen.getByRole("region", { name: title });
  const logPanel = () => screen.queryByRole("region", { name: /^Log:/ });
  const logTab = (name: RegExp) =>
    within(logPanel()!).getByRole("tab", { name });
  const dockFrom = (title: string) =>
    fireEvent.click(within(card(title)).getByRole("button", { name: "Dock" }));

  /** The page shows Deploy #54 building, with a line in hand. */
  async function building() {
    const view = renderConsole();
    await wait();
    const [socket] = builds();
    act(() => socket!.open());
    act(() => socket!.say("Step 1/4 : FROM node:22\n"));
    await wait();
    return { ...view, socket: socket! };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    rows = [row(54)];
    vi.spyOn(deploymentsApi, "listByApplication").mockImplementation(async () =>
      rows.map((each) => ({ ...each })),
    );
    vi.spyOn(deploymentsApi, "readLogs").mockResolvedValue("");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("moves the same socket and the lines it holds into the Dock, and focuses them there", async () => {
    const { socket } = await building();

    dockFrom("Deploy #54");

    const docked = within(logPanel()!).getByRole("log", {
      name: "storefront · Deploy #54",
    });
    expect(docked.textContent).toContain("Step 1/4 : FROM node:22");
    expect(builds()).toHaveLength(1);
    expect(socket.close).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(docked);
    expect(card("Deploy #54").textContent).toContain(
      "This log is in the Dock at the bottom of the console, still following.",
    );
  });

  it("keeps the docked log connected and following once its page is gone", async () => {
    const { socket, leave } = await building();
    dockFrom("Deploy #54");

    leave();
    act(() => socket.say("Step 2/4 : RUN npm ci\n"));
    await wait();

    expect(socket.close).not.toHaveBeenCalled();
    expect(logPanel()!.textContent).toContain("Step 2/4 : RUN npm ci");
  });

  it("closes a page box's socket when its page goes, if it was never docked", async () => {
    const { socket, leave } = await building();

    leave();

    expect(socket.close).toHaveBeenCalled();
    expect(logPanel()).toBeNull();
  });

  it("draws a log tab in a Logs group with the lines icon, a labelled running mark and its name", async () => {
    await building();
    dockFrom("Deploy #54");

    const tab = logTab(/storefront · Deploy #54/);
    expect(
      within(logPanel()!).getByText(`Logs 1/${MAX_DOCK_LOGS}`),
    ).toBeTruthy();
    expect(tab.querySelector("svg.lucide-logs")).not.toBeNull();
    expect(within(tab).getByRole("img", { name: "Running" })).toBeTruthy();
    expect(within(logPanel()!).getByText("Shells 0/4")).toBeTruthy();
  });

  it("fills the Dock with the docked log rather than the page's fixed well", async () => {
    await building();
    dockFrom("Deploy #54");

    const docked = within(logPanel()!).getByRole("log");
    expect(docked.className).toContain("flex-1");
    expect(docked.className).not.toContain("max-h-log");
  });

  it("ends a docked log's socket when its build succeeds, and the tab says so with every line kept", async () => {
    const { socket, leave } = await building();
    dockFrom("Deploy #54");
    leave();

    rows = [row(54, "done")];
    await wait(4_000);

    expect(socket.close).toHaveBeenCalled();
    const tab = logTab(/storefront · Deploy #54/);
    expect(tab.textContent).toContain("Succeeded");
    expect(within(tab).getByRole("img", { name: "Finished" })).toBeTruthy();
    expect(logPanel()!.textContent).toContain("Step 1/4 : FROM node:22");
  });

  it("marks a failed build's tab ✕ with a red underline and the word Failed", async () => {
    const { leave } = await building();
    dockFrom("Deploy #54");
    leave();

    rows = [row(54, "error")];
    await wait(4_000);

    const tab = logTab(/storefront · Deploy #54/);
    expect(tab.textContent).toContain("Failed");
    expect(within(tab).getByRole("img", { name: "Failed" })).toBeTruthy();
    expect(tab.closest('[role="presentation"]')!.className).toContain(
      "border-bad",
    );
  });

  it("reads the Deployments once per poll while the page is also mounted", async () => {
    await building();
    dockFrom("Deploy #54");
    const listed = vi.mocked(deploymentsApi.listByApplication);
    listed.mockClear();

    await wait(4_000);

    expect(listed).toHaveBeenCalledTimes(1);
  });

  it("says how the build ended on the page note", async () => {
    await building();
    dockFrom("Deploy #54");

    rows = [row(54, "done")];
    await wait(4_000);

    expect(card("Deploy #54").textContent).toContain(
      "This log is in the Dock at the bottom of the console. The build succeeded.",
    );
  });

  it("Read it here too opens a second, independent connection on the page", async () => {
    const { socket } = await building();
    dockFrom("Deploy #54");

    fireEvent.click(
      within(card("Deploy #54")).getByRole("button", {
        name: "Read it here too",
      }),
    );
    await wait();

    expect(builds()).toHaveLength(2);
    expect(
      within(card("Deploy #54")).getByRole("log", {
        name: "Deployment output",
      }),
    ).toBeTruthy();

    fireEvent.click(
      within(logPanel()!).getByRole("button", {
        name: "Close storefront · Deploy #54",
      }),
    );
    expect(socket.close).toHaveBeenCalled();
    expect(builds()[1]!.close).not.toHaveBeenCalled();
  });

  it("shows a fresh box of its own when the page is come back to", async () => {
    const { leave, comeBack } = await building();
    dockFrom("Deploy #54");
    leave();

    comeBack();
    await wait();

    expect(builds()).toHaveLength(2);
    expect(
      within(card("Deploy #54")).getByRole("button", { name: "Dock" }),
    ).toBeTruthy();
  });

  it("docking a log already docked shows its tab, and the page keeps its box", async () => {
    await building();
    dockFrom("Deploy #54");
    fireEvent.click(
      within(card("Deploy #54")).getByRole("button", {
        name: "Read it here too",
      }),
    );
    await wait();
    screen.getByRole("textbox", { name: "Search" }).focus();

    dockFrom("Deploy #54");

    expect(within(logPanel()!).getAllByRole("tab")).toHaveLength(1);
    // Docked again is shown again: the keyboard goes to its scroller.
    expect(document.activeElement).toBe(within(logPanel()!).getByRole("log"));
    expect(
      within(card("Deploy #54")).getByRole("log", {
        name: "Deployment output",
      }),
    ).toBeTruthy();
    expect(builds()[1]!.close).not.toHaveBeenCalled();
  });

  it("docking a log already docked behind a shell brings its tab to the front with the keyboard on it", async () => {
    await building();
    dockFrom("Deploy #54");
    fireEvent.click(
      within(card("Deploy #54")).getByRole("button", {
        name: "Read it here too",
      }),
    );
    await wait();
    openShell();
    await wait();
    expect(panel()).toBeTruthy();
    screen.getByRole("textbox", { name: "Search" }).focus();

    dockFrom("Deploy #54");
    await wait();

    expect(document.activeElement).toBe(
      within(logPanel()!).getByRole("log", { name: "storefront · Deploy #54" }),
    );
  });

  it("Show the Dock brings the docked log back into view", async () => {
    await building();
    dockFrom("Deploy #54");
    fireEvent.click(screen.getByRole("button", { name: "Minimise the Dock" }));
    screen.getByRole("textbox", { name: "Search" }).focus();

    fireEvent.click(
      within(card("Deploy #54")).getByRole("button", { name: "Show the Dock" }),
    );

    expect(document.documentElement.hasAttribute("data-dock")).toBe(false);
    expect(document.activeElement).toBe(within(logPanel()!).getByRole("log"));
  });

  it(`holds ${MAX_DOCK_LOGS} logs, then disables every Dock button with the sentence until one is closed`, async () => {
    rows = [1, 2, 3, 4, 5].map((number) => row(number));
    renderConsole();
    await wait();

    for (const number of [1, 2, 3, 4]) dockFrom(`Deploy #${number}`);

    // An off action is `aria-disabled` and stays in the tab order (Base UI).
    const off = (element: HTMLElement) =>
      element.hasAttribute("disabled") ||
      element.getAttribute("aria-disabled") === "true";
    const fifth = within(card("Deploy #5"));
    expect(off(fifth.getByRole("button", { name: "Dock" }))).toBe(true);
    expect(fifth.getByText(DOCK_LOGS_FULL_SENTENCE)).toBeTruthy();
    dockFrom("Deploy #5");
    expect(within(logPanel()!).getAllByRole("tab")).toHaveLength(MAX_DOCK_LOGS);

    fireEvent.click(
      within(logPanel()!).getByRole("button", {
        name: "Close storefront · Deploy #1",
      }),
    );

    const again = within(card("Deploy #5"));
    expect(off(again.getByRole("button", { name: "Dock" }))).toBe(false);
    expect(again.queryByText(DOCK_LOGS_FULL_SENTENCE)).toBeNull();
  });

  it("docks a log while the shells group is full", async () => {
    await building();
    for (let index = 0; index < MAX_DOCK_SHELLS; index += 1) openShell();

    dockFrom("Deploy #54");

    expect(logTab(/storefront · Deploy #54/)).toBeTruthy();
    expect(
      within(logPanel()!).getByText(DOCK_SHELLS_FULL_SENTENCE),
    ).toBeTruthy();
  });

  it("closing a log tab ends that log only", async () => {
    rows = [row(1), row(2)];
    renderConsole();
    await wait();
    dockFrom("Deploy #1");
    dockFrom("Deploy #2");
    const [first, second] = builds();

    fireEvent.click(
      within(logPanel()!).getByRole("button", {
        name: "Close storefront · Deploy #1",
      }),
    );

    expect(first!.close).toHaveBeenCalled();
    expect(second!.close).not.toHaveBeenCalled();
    expect(logTab(/storefront · Deploy #2/)).toBeTruthy();
  });

  it("an organization switch or a sign-out ends every docked log, ended ones included, and leaves a page's own alone", async () => {
    rows = [row(1), row(2), row(3)];
    renderConsole();
    await wait();
    dockFrom("Deploy #1");
    dockFrom("Deploy #2");
    const [first, second, third] = builds();
    rows = [row(1, "done"), row(2), row(3)];
    await wait(4_000);
    expect(logTab(/storefront · Deploy #1/).textContent).toContain("Succeeded");

    act(() => endAllTerminals());

    expect(logPanel()).toBeNull();
    expect(second!.close).toHaveBeenCalled();
    expect(first!.close).toHaveBeenCalled();
    expect(third!.close).not.toHaveBeenCalled();
  });

  describe("losing access while docked", () => {
    const DENIED_SENTENCE =
      "Not found or not permitted. Cloudgate answers the same way for a target that does not exist and one this session may not reach.";

    it("a lease close (4010) ends the tab: every line kept, ⊘ No longer authorized, the lease sentence, and no further dial", async () => {
      const { socket, leave } = await building();
      dockFrom("Deploy #54");
      leave();

      act(() => socket.end(LEASE_CLOSE_CODE, "No longer authorized"));
      await wait(60_000);

      const tab = logTab(/storefront · Deploy #54/);
      const mark = within(tab).getByRole("img", { name: "Stopped" });
      expect(mark.textContent).toBe("⊘");
      expect(tab.textContent).toContain("No longer authorized");
      expect(logPanel()!.textContent).toContain("Step 1/4 : FROM node:22");
      expect(logPanel()!.textContent).toContain(LEASE_SENTENCE);
      expect(
        within(logPanel()!).queryByRole("button", {
          name: /Reconnect|Connect again/,
        }),
      ).toBeNull();
      expect(builds()).toHaveLength(1);
    });

    it("a refusal on redial — a deleted Deployment answers the same — ends the tab with no retry loop", async () => {
      const { socket, leave } = await building();
      dockFrom("Deploy #54");
      leave();

      act(() => socket.end(1006));
      await wait(2_000);
      const redial = builds()[1]!;
      act(() => redial.end(DENIED_CLOSE_CODE, "Not found or not permitted"));
      await wait(120_000);

      const tab = logTab(/storefront · Deploy #54/);
      expect(within(tab).getByRole("img", { name: "Stopped" })).toBeTruthy();
      expect(tab.textContent).toContain("Could not connect");
      expect(logPanel()!.textContent).toContain("Step 1/4 : FROM node:22");
      expect(logPanel()!.textContent).toContain(DENIED_SENTENCE);
      expect(builds()).toHaveLength(2);
      // Nothing picked up again: no reconnect mark under the lines.
      expect(logPanel()!.textContent).not.toContain("↻ Reconnected");
    });

    it("says the refusal in its follow bar, once, in place of Following and Pause, and keeps Go to its page", async () => {
      window.history.pushState({}, "", "/applications/app-1/deployments");
      const { socket, leave } = await building();
      dockFrom("Deploy #54");
      leave();

      act(() => socket.end(LEASE_CLOSE_CODE, "No longer authorized"));
      await wait();

      const bar = followBar();
      expect(within(bar).getByRole("status").textContent).toBe(LEASE_SENTENCE);
      expect(bar.textContent).not.toContain("Following");
      expect(within(bar).queryByRole("button", { name: "Pause" })).toBeNull();
      expect(
        within(bar).getByRole("link", { name: "Go to its page" }),
      ).toBeTruthy();
      expect(logPanel()!.textContent!.split(LEASE_SENTENCE).length - 1).toBe(1);
      window.history.pushState({}, "", "/");
    });

    it("a refusal is not picked up again by a later drop's resume", async () => {
      const { socket, leave } = await building();
      dockFrom("Deploy #54");
      leave();

      act(() => socket.end(LEASE_CLOSE_CODE, "No longer authorized"));
      await wait(60_000);
      act(() => socket.end(1006));
      await wait(60_000);

      expect(builds()).toHaveLength(1);
      expect(logPanel()!.textContent).not.toContain("↻ Reconnected");
      expect(followBar().textContent).toContain(LEASE_SENTENCE);
    });

    it("says how it ended on the page note while the page is still there", async () => {
      const { socket } = await building();
      dockFrom("Deploy #54");

      act(() => socket.end(LEASE_CLOSE_CODE, "No longer authorized"));
      await wait();

      expect(card("Deploy #54").textContent).toContain(
        `This log is in the Dock at the bottom of the console. ${LEASE_SENTENCE}`,
      );
    });

    it("a log refused on its page and docked after ends its tab at once", async () => {
      const { socket } = await building();
      act(() => socket.end(LEASE_CLOSE_CODE, "No longer authorized"));
      await wait();

      dockFrom("Deploy #54");

      expect(logTab(/storefront · Deploy #54/).textContent).toContain(
        "No longer authorized",
      );
      expect(builds()).toHaveLength(1);
    });

    it("leaves a page box that was never docked its own refusal", async () => {
      const { socket } = await building();

      act(() => socket.end(LEASE_CLOSE_CODE, "No longer authorized"));
      await wait();

      expect(card("Deploy #54").textContent).toContain(
        "This stream was authorized when it opened and is not any more",
      );
      expect(card("Deploy #54").textContent).not.toContain(LEASE_SENTENCE);
      expect(logPanel()).toBeNull();
    });
  });

  /**
   * Reading a docked log: its follow bar, a background tab's count,
   * and ⌃`. jsdom lays nothing out, so a scroller's size is given to it and
   * a scroll is its `scrollTop` moving and the event the browser would send —
   * which is also all End is.
   */
  describe("reading it", () => {
    const bar = () => logPanel()!.querySelector("[data-follow-bar]")!;
    const dockedWell = () => within(logPanel()!).getByRole("log");
    /** Give a scroller a height to scroll in, and start it at the bottom. */
    const sized = (well: HTMLElement) => {
      Object.defineProperty(well, "scrollHeight", {
        configurable: true,
        value: 1_000,
      });
      Object.defineProperty(well, "clientHeight", {
        configurable: true,
        value: 200,
      });
      Object.defineProperty(well, "scrollTop", {
        configurable: true,
        writable: true,
        value: 800,
      });
      return well;
    };
    const scrollTo = (well: HTMLElement, top: number) => {
      well.scrollTop = top;
      fireEvent.scroll(well);
    };

    it("says it is following, how many lines it has and when the last came in", async () => {
      vi.setSystemTime(new Date(2026, 0, 1, 10, 0, 5));
      await building();
      dockFrom("Deploy #54");

      expect(bar().textContent).toContain(
        "● Following · 1 line · last line 10:00:05",
      );
      expect(
        within(logPanel()!).queryByRole("button", { name: "Follow output" }),
      ).toBeNull();
    });

    it("scrolled up, says how many lines came in below, and Jump to latest follows again", async () => {
      const { socket } = await building();
      dockFrom("Deploy #54");
      const well = sized(dockedWell());

      scrollTo(well, 100);
      act(() => socket.say("Step 2/4 : RUN npm ci\nStep 3/4 : COPY . .\n"));
      await wait();

      expect(bar().textContent).toContain("Paused · 2 new lines below");
      expect(well.scrollTop).toBe(100);
      // The page's floating control is the page's: the bar is the Dock's.
      expect(
        within(logPanel()!).queryByRole("button", { name: "Follow output" }),
      ).toBeNull();

      fireEvent.click(
        within(bar() as HTMLElement).getByRole("button", {
          name: "Jump to latest",
        }),
      );

      expect(bar().textContent).toContain("● Following · 3 lines");
      expect(well.scrollTop).toBe(1_000);
    });

    it("Pause stops it moving, and scrolling to the bottom — End, or the wheel — follows again", async () => {
      const { socket } = await building();
      dockFrom("Deploy #54");
      const well = sized(dockedWell());

      fireEvent.click(
        within(bar() as HTMLElement).getByRole("button", { name: "Pause" }),
      );
      well.scrollTop = 400;
      act(() => socket.say("Step 2/4 : RUN npm ci\n"));
      await wait();

      expect(bar().textContent).toContain("Paused · 1 new line below");
      expect(well.scrollTop).toBe(400);

      scrollTo(well, 800);

      expect(bar().textContent).toContain("● Following · 2 lines");
    });

    it("a log paused on its page is still paused in the Dock", async () => {
      const { socket } = await building();
      const pageWell = sized(
        within(card("Deploy #54")).getByRole("log", {
          name: "Deployment output",
        }),
      );
      scrollTo(pageWell, 100);
      expect(
        within(card("Deploy #54")).getByRole("button", {
          name: "Follow output",
        }),
      ).toBeTruthy();

      dockFrom("Deploy #54");
      act(() => socket.say("Step 2/4 : RUN npm ci\n"));
      await wait();

      expect(bar().textContent).toContain("Paused · 1 new line below");
    });

    it("Go to its page goes back to the page it was docked from", async () => {
      window.history.pushState({}, "", "/applications/app-1/deployments");
      await building();
      dockFrom("Deploy #54");

      const link = within(bar() as HTMLElement).getByRole("link", {
        name: "Go to its page",
      });

      expect(link.getAttribute("href")).toBe("/applications/app-1/deployments");
      window.history.pushState({}, "", "/");
    });

    it("says how many earlier lines were dropped, as on the page", async () => {
      const { socket } = await building();
      dockFrom("Deploy #54");

      const flood = Array.from({ length: 5_002 }, (_, at) => `line ${at}`);
      act(() => socket.say(`${flood.join("\n")}\n`));
      await wait();

      expect(dockedWell().textContent).toContain(
        "earlier lines dropped to stay inside the buffer.",
      );
    });

    it("a tab not in front counts its new lines, and the count clears when it is shown", async () => {
      rows = [row(1), row(2)];
      renderConsole();
      await wait();
      dockFrom("Deploy #1");
      dockFrom("Deploy #2");
      const [first] = builds();

      act(() => first!.open());
      act(() => first!.say("one\ntwo\n"));
      await wait();

      const tab = logTab(/storefront · Deploy #1/);
      expect(tab.textContent).toContain("+2 new lines");
      expect(logTab(/storefront · Deploy #2/).textContent).not.toContain(
        "new line",
      );

      fireEvent.click(tab);

      expect(logTab(/storefront · Deploy #1/).textContent).not.toContain(
        "new line",
      );
    });

    describe("⌃`", () => {
      const press = (target: Element) =>
        fireEvent.keyDown(target, {
          key: "`",
          code: "Backquote",
          ctrlKey: true,
        });
      /** Dock Deploy #54 the way a keyboard user does: from its button. */
      const dockByKeyboard = () => {
        const button = within(card("Deploy #54")).getByRole("button", {
          name: "Dock",
        });
        button.focus();
        fireEvent.click(button);
      };

      it("from the page restores the Dock and puts focus in the active log", async () => {
        await building();
        dockFrom("Deploy #54");
        fireEvent.click(
          screen.getByRole("button", { name: "Minimise the Dock" }),
        );
        const search = screen.getByRole("textbox", { name: "Search" });
        search.focus();

        press(search);

        expect(document.documentElement.hasAttribute("data-dock")).toBe(false);
        expect(document.activeElement).toBe(dockedWell());
      });

      it("from inside a docked log minimises and gives focus back to the page note's Show the Dock", async () => {
        await building();
        dockByKeyboard();
        expect(document.activeElement).toBe(dockedWell());

        press(dockedWell());

        expect(document.documentElement.getAttribute("data-dock")).toBe(
          "minimised",
        );
        expect(document.activeElement).toBe(
          within(card("Deploy #54")).getByRole("button", {
            name: "Show the Dock",
          }),
        );
      });

      it("from inside a docked log gives focus back to where it was on the page", async () => {
        await building();
        dockFrom("Deploy #54");
        const search = screen.getByRole("textbox", { name: "Search" });
        search.focus();
        press(search);

        press(dockedWell());

        expect(document.activeElement).toBe(search);
      });

      it("acts on the active log tab", async () => {
        rows = [row(1), row(2)];
        renderConsole();
        await wait();
        dockFrom("Deploy #1");
        dockFrom("Deploy #2");
        fireEvent.click(logTab(/storefront · Deploy #1/));
        const search = screen.getByRole("textbox", { name: "Search" });
        search.focus();

        press(search);

        expect(document.activeElement).toBe(
          within(logPanel()!).getByRole("log", {
            name: "storefront · Deploy #1",
          }),
        );
      });

      it("leaves a maximised Dock maximised", async () => {
        await building();
        dockFrom("Deploy #54");
        fireEvent.click(
          screen.getByRole("button", { name: "Maximise the Dock" }),
        );
        const search = screen.getByRole("textbox", { name: "Search" });
        search.focus();

        press(search);

        expect(document.documentElement.getAttribute("data-dock")).toBe(
          "maximised",
        );
        expect(document.activeElement).toBe(dockedWell());
      });

      it("does nothing once the last log tab is closed", async () => {
        await building();
        dockFrom("Deploy #54");
        fireEvent.click(
          within(logPanel()!).getByRole("button", {
            name: "Close storefront · Deploy #54",
          }),
        );
        const search = screen.getByRole("textbox", { name: "Search" });
        search.focus();

        // `fireEvent` answers false when the default was prevented.
        expect(press(search)).toBe(true);
      });

      it("Escape does nothing in a docked log, and Tab is left to the browser", async () => {
        await building();
        dockFrom("Deploy #54");
        const well = dockedWell();

        const escape = fireEvent.keyDown(well, { key: "Escape" });
        const tab = fireEvent.keyDown(well, { key: "Tab" });

        expect(escape).toBe(true);
        expect(tab).toBe(true);
        expect(document.documentElement.hasAttribute("data-dock")).toBe(false);
        expect(document.activeElement).toBe(well);
        expect(logPanel()).not.toBeNull();
      });
    });
  });

  describe("across a dropped connection", () => {
    it("keeps its lines, marks where it reconnected, and skips the replay's lines it holds", async () => {
      const { socket, leave } = await building();
      dockFrom("Deploy #54");
      leave();
      act(() => socket.say("Step 2/4 : RUN npm ci\nStep 3/4 : CO"));
      await wait();

      act(() => socket.end(1006));
      await wait(2_000);
      const redial = builds()[1]!;
      act(() => redial.open());
      act(() =>
        redial.say(
          "Step 1/4 : FROM node:22\nStep 2/4 : RUN npm ci\nStep 3/4 : COPY . .\nStep 4/4 : RUN npm run build\n",
        ),
      );
      await wait();

      const lines = wellLines();
      expect(lines.map((line) => line.textContent)).toEqual([
        "Step 1/4 : FROM node:22",
        "Step 2/4 : RUN npm ci",
        expect.stringMatching(/^↻ Reconnected at \d\d:\d\d:\d\d$/),
        "Step 3/4 : COPY . .",
        "Step 4/4 : RUN npm run build",
      ]);
      expect(lines[2]!.className).toContain("text-well-hl");
    });

    it("counts what it skips across a second drop", async () => {
      const { socket } = await building();
      dockFrom("Deploy #54");

      act(() => socket.end(1006));
      await wait(2_000);
      const second = builds()[1]!;
      act(() => second.open());
      act(() => second.say("Step 1/4 : FROM node:22\nStep 2/4 : RUN npm ci\n"));
      await wait();
      act(() => second.end(1006));
      await wait(2_000);
      const third = builds()[2]!;
      act(() => third.open());
      act(() =>
        third.say(
          "Step 1/4 : FROM node:22\nStep 2/4 : RUN npm ci\nStep 3/4 : COPY . .\n",
        ),
      );
      await wait();

      expect(
        wellLines()
          .map((line) => line.textContent)
          .filter((text) => !text?.startsWith("↻")),
      ).toEqual([
        "Step 1/4 : FROM node:22",
        "Step 2/4 : RUN npm ci",
        "Step 3/4 : COPY . .",
      ]);
    });

    it("leaves a page box that was never docked starting over on a redial", async () => {
      const { socket } = await building();

      act(() => socket.end(1006));
      await wait(2_000);
      const redial = builds()[1]!;
      act(() => redial.open());
      act(() => redial.say("Step 1/4 : FROM node:22\n"));
      await wait();

      const box = within(card("Deploy #54")).getByRole("log");
      expect(box.textContent).not.toContain("Reconnected");
      expect(box.textContent?.match(/Step 1\/4/g)).toHaveLength(1);
    });
  });

  /**
   * A finished Deployment's log docked (#1340): the stored read, moved into
   * the Dock as a fixed record. No socket is ever dialled for it — not on
   * the page, not on docking, not on Reload.
   */
  describe("a finished Deployment", () => {
    const REAPED =
      "This deployment's log is no longer on the machine that wrote it: Cloudgate keeps deployment logs for 90 days and this deployment is older than that.\n";
    const readLogs = () => vi.mocked(deploymentsApi.readLogs);

    /** The page shows Deploy #54 finished, with its stored log read. */
    async function finished(status: DeploymentStatus = "done") {
      rows = [row(54, status)];
      readLogs().mockResolvedValue("Step 1/4 : FROM node:22\nDone in 41s\n");
      const view = renderConsole();
      await wait();
      return view;
    }

    it("offers Dock once its lines are read, and docks an ended tab with those lines, Reload and Go to its page", async () => {
      await finished();

      dockFrom("Deploy #54");

      const tab = logTab(/storefront · Deploy #54/);
      expect(tab.textContent).toContain("Succeeded");
      expect(within(tab).getByRole("img", { name: "Finished" })).toBeTruthy();
      const docked = within(logPanel()!).getByRole("log", {
        name: "storefront · Deploy #54",
      });
      expect(docked.textContent).toContain("Step 1/4 : FROM node:22");
      expect(docked.textContent).toContain("Done in 41s");
      expect(logPanel()!.textContent).toContain("The build succeeded.");
      expect(followBar().textContent).toContain("2 lines");
      expect(
        within(followBar()).getByRole("button", { name: "Reload" }),
      ).toBeTruthy();
      expect(
        within(followBar()).getByRole("link", { name: "Go to its page" }),
      ).toBeTruthy();
      // An ended record has nothing to pause.
      expect(
        within(followBar()).queryByRole("button", { name: "Pause" }),
      ).toBeNull();
      expect(card("Deploy #54").textContent).toContain(
        "This log is in the Dock at the bottom of the console. The build succeeded.",
      );
      expect(
        within(card("Deploy #54")).getByRole("button", {
          name: "Show the Dock",
        }),
      ).toBeTruthy();
      expect(builds()).toHaveLength(0);
    });

    it("says how a failed build ended, on its tab and the page note", async () => {
      await finished("error");

      dockFrom("Deploy #54");

      const tab = logTab(/storefront · Deploy #54/);
      expect(within(tab).getByRole("img", { name: "Failed" })).toBeTruthy();
      expect(card("Deploy #54").textContent).toContain("The build failed.");
    });

    it("Reload re-reads the stored log and replaces the lines, with its page gone, and never opens a socket", async () => {
      const { leave } = await finished();
      dockFrom("Deploy #54");
      leave();
      readLogs().mockClear();
      readLogs().mockResolvedValue("Step 1/4 : FROM node:22\nRe-read\n");

      fireEvent.click(
        within(followBar()).getByRole("button", { name: "Reload" }),
      );
      await wait();

      expect(readLogs()).toHaveBeenCalledTimes(1);
      expect(wellLines().map((line) => line.textContent)).toEqual([
        "Step 1/4 : FROM node:22",
        "Re-read",
      ]);
      expect(logTab(/storefront · Deploy #54/).textContent).toContain(
        "Succeeded",
      );
      expect(builds()).toHaveLength(0);
    });

    it("a Reload after the retention sweep ends with the reaped sentence, keeps the lines held and adds none", async () => {
      await finished();
      dockFrom("Deploy #54");
      readLogs().mockResolvedValue(REAPED);

      fireEvent.click(
        within(followBar()).getByRole("button", { name: "Reload" }),
      );
      await wait();

      expect(wellLines().map((line) => line.textContent)).toEqual([
        "Step 1/4 : FROM node:22",
        "Done in 41s",
      ]);
      expect(logTab(/storefront · Deploy #54/).textContent).toContain(
        "Log deleted",
      );
      expect(logPanel()!.textContent).toContain(REAPED.trim());
      // The sentence is the ending, not a line of the log.
      expect(within(logPanel()!).getByRole("log").textContent).not.toContain(
        "no longer on the machine",
      );
    });

    it("a Reload refused (the Deployment deleted) ends the tab in its bar, keeps the lines and offers no Reload after", async () => {
      await finished();
      dockFrom("Deploy #54");
      readLogs().mockRejectedValue(
        new ApiError(404, "Deployment not found", { method: "GET" }),
      );

      fireEvent.click(
        within(followBar()).getByRole("button", { name: "Reload" }),
      );
      await wait();

      expect(logTab(/storefront · Deploy #54/).textContent).toContain(
        "Could not connect",
      );
      expect(
        within(followBar()).getByRole("status").textContent,
      ).toContain("the lines it had read stay");
      expect(
        within(followBar()).queryByRole("button", { name: "Reload" }),
      ).toBeNull();
      expect(wellLines()).toHaveLength(2);
    });

    it("docking it again shows the existing tab, and a page come back to shows the docked note", async () => {
      const { leave, comeBack } = await finished();
      dockFrom("Deploy #54");
      leave();

      comeBack();
      await wait();

      expect(card("Deploy #54").textContent).toContain(
        "This log is in the Dock at the bottom of the console. The build succeeded.",
      );

      fireEvent.click(
        within(card("Deploy #54")).getByRole("button", {
          name: "Read it here too",
        }),
      );
      await wait();
      expect(
        within(card("Deploy #54")).getByRole("log", {
          name: "Deployment output",
        }),
      ).toBeTruthy();

      dockFrom("Deploy #54");

      expect(within(logPanel()!).getAllByRole("tab")).toHaveLength(1);
      expect(document.activeElement).toBe(
        within(logPanel()!).getByRole("log"),
      );
      expect(builds()).toHaveLength(0);
    });

    it("a live log docked whose build then finished is the tab a finished box's Dock shows", async () => {
      await building();
      dockFrom("Deploy #54");
      rows = [row(54, "done")];
      await wait(4_000);

      fireEvent.click(
        within(card("Deploy #54")).getByRole("button", {
          name: "Read it here too",
        }),
      );
      await wait();
      dockFrom("Deploy #54");

      const tabs = within(logPanel()!).getAllByRole("tab");
      expect(tabs).toHaveLength(1);
      // The live one, with the line its socket gave, not a second record.
      expect(logPanel()!.textContent).toContain("Step 1/4 : FROM node:22");
    });

    it(`counts towards the ${MAX_DOCK_LOGS} logs like a live one`, async () => {
      rows = [1, 2, 3, 4, 5].map((number) => row(number, "done"));
      readLogs().mockResolvedValue("Done\n");
      renderConsole();
      await wait();

      for (const number of [1, 2, 3, 4]) dockFrom(`Deploy #${number}`);
      dockFrom("Deploy #5");

      expect(within(logPanel()!).getAllByRole("tab")).toHaveLength(
        MAX_DOCK_LOGS,
      );
      expect(
        within(card("Deploy #5")).getByText(DOCK_LOGS_FULL_SENTENCE),
      ).toBeTruthy();
    });

    it("offers no Dock until its lines are read", async () => {
      rows = [row(54, "done")];
      readLogs().mockReturnValue(new Promise(() => {}));
      renderConsole();
      await wait();

      expect(
        within(card("Deploy #54")).queryByRole("button", { name: "Dock" }),
      ).toBeNull();
    });
  });
});

/** What a docked log says in its follow bar once its lease closes (4010). */
const LEASE_SENTENCE =
  "No longer authorized. The access it was opened with ended while the session was open — connecting again is authorized from scratch.";

/** The docked log's follow bar. */
function followBar(): HTMLElement {
  return screen
    .getByRole("region", { name: /^Log:/ })
    .querySelector<HTMLElement>("[data-follow-bar]")!;
}

/** The lines of the docked log on screen, one element each. */
function wellLines(): HTMLElement[] {
  const panel = screen.getByRole("region", { name: /^Log:/ });
  return Array.from(
    within(panel)
      .getByRole("log")
      .querySelectorAll<HTMLElement>("span.wrap-anywhere"),
  );
}

/**
 * A Compose stack container's Runtime log docked from its output card
 *, with the real card mounted under the Dock. Only the network is
 * faked: the gateway is the fake socket above, and the container ending is
 * its `4014` close.
 */
describe("a docked Compose Runtime log", () => {
  const REASON =
    "The container's output ended: it stopped, restarted or was removed";

  /** A stack's Containers screen: one output card per container. */
  function StackPage({ containers }: { containers: string[] }) {
    return (
      <>
        {containers.map((name) => (
          <section key={name} aria-label={name}>
            <ContainerOutput
              containerId={`c-${name}`}
              serverId={null}
              label={`Output of ${name}`}
              subject="shop"
              container={name}
            />
          </section>
        ))}
      </>
    );
  }

  function renderConsole(containers = ["web"], extra?: ReactNode) {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const tree = (onPage: boolean) => (
      <QueryClientProvider client={client}>
        <DockProvider create={create}>
          <main id="main" tabIndex={-1}>
            <Page />
            {onPage ? <StackPage containers={containers} /> : null}
            {extra}
          </main>
          <Dock />
        </DockProvider>
      </QueryClientProvider>
    );
    const view = render(tree(true));
    return { leave: () => view.rerender(tree(false)) };
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
  const card = (name: string) => screen.getByRole("region", { name });
  const logPanel = () => screen.queryByRole("region", { name: /^Log:/ });
  const logTab = (name: RegExp) =>
    within(logPanel()!).getByRole("tab", { name });
  const dockFrom = (name: string) =>
    fireEvent.click(within(card(name)).getByRole("button", { name: "Dock" }));

  /** The page follows web's output, with a line in hand. */
  async function following() {
    const view = renderConsole();
    await wait();
    const [socket] = followers();
    act(() => socket!.open());
    act(() => socket!.say("listening on :80\n"));
    await wait();
    return { ...view, socket: socket! };
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("moves the same socket and the lines it holds into the Dock, named stack · container", async () => {
    const { socket } = await following();

    dockFrom("web");

    const docked = within(logPanel()!).getByRole("log", {
      name: "shop · web",
    });
    expect(docked.textContent).toContain("listening on :80");
    expect(followers()).toHaveLength(1);
    expect(socket.close).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(docked);
    expect(card("web").textContent).toContain(
      "This log is in the Dock at the bottom of the console, still following.",
    );
  });

  it("ends the tab as Container stopped on a 4014, keeping its lines and dialling nothing more", async () => {
    const { socket, leave } = await following();
    dockFrom("web");
    leave();

    act(() => socket.end(OUTPUT_ENDED_CLOSE_CODE, REASON));
    await wait(30_000);

    const tab = logTab(/shop · web/);
    expect(tab.textContent).toContain("Container stopped");
    expect(within(tab).getByRole("img", { name: "Stopped" }).textContent).toBe(
      "⊘",
    );
    expect(logPanel()!.textContent).toContain("listening on :80");
    expect(followers()).toHaveLength(1);
  });

  it("says on the page note how the container's output ended", async () => {
    const { socket } = await following();
    dockFrom("web");

    act(() => socket.end(OUTPUT_ENDED_CLOSE_CODE, REASON));
    await wait();

    expect(card("web").textContent).toContain(
      `This log is in the Dock at the bottom of the console. ${REASON}.`,
    );
  });

  it("leaves a page box that was never docked its own ending and Reconnect", async () => {
    const { socket } = await following();

    act(() => socket.end(OUTPUT_ENDED_CLOSE_CODE, REASON));
    await wait();
    expect(card("web").textContent).toContain(
      `${REASON}. Reconnect to follow it again.`,
    );

    fireEvent.click(
      within(card("web")).getByRole("button", { name: /Reconnect/ }),
    );
    expect(followers()).toHaveLength(2);
  });

  it(`counts towards the ${MAX_DOCK_LOGS} logs like a Deployment log`, async () => {
    vi.spyOn(deploymentsApi, "listByApplication").mockResolvedValue([]);
    const build = {
      deploymentId: "dep-7",
      status: "running",
      title: "Deploy #7",
      applicationId: "app-1",
      composeId: null,
      createdAt: "2026-01-01T10:00:00.000Z",
      startedAt: "2026-01-01T10:00:00.000Z",
    } as unknown as Deployment;
    renderConsole(
      ["web", "db", "cache", "worker"],
      <section aria-label="Deploy #7">
        <DeploymentLog deployment={build} subject="storefront" />
      </section>,
    );
    await wait();

    for (const name of ["web", "Deploy #7", "db", "cache"]) dockFrom(name);

    const off = (element: HTMLElement) =>
      element.hasAttribute("disabled") ||
      element.getAttribute("aria-disabled") === "true";
    const worker = within(card("worker"));
    expect(off(worker.getByRole("button", { name: "Dock" }))).toBe(true);
    expect(worker.getByText(DOCK_LOGS_FULL_SENTENCE)).toBeTruthy();

    fireEvent.click(
      within(logPanel()!).getByRole("button", { name: "Close shop · web" }),
    );
    expect(
      off(within(card("worker")).getByRole("button", { name: "Dock" })),
    ).toBe(false);
  });

  describe("across a dropped connection", () => {
    const BOOT = "2026-11-06T10:00:00.000000000Z booting";
    const READY = "2026-11-06T10:00:05.000000000Z listening on :80";
    const LATER = "2026-11-06T10:00:40.000000000Z GET / 200";

    /** web's output docked, two stamped lines held, its page gone. */
    async function dockedAndDropped() {
      vi.setSystemTime(new Date("2026-11-06T10:01:00.000Z"));
      const view = renderConsole();
      await wait();
      const [socket] = followers();
      act(() => socket!.open());
      act(() => socket!.say(`${BOOT}\n${READY}\n`));
      await wait();
      dockFrom("web");
      view.leave();
      act(() => socket!.end(1006));
      await wait(2_000);
      return followers()[1]!;
    }

    it("redials asking for output since the last line held, not the last 200 lines", async () => {
      const redial = await dockedAndDropped();

      const url = new URL(redial.url);
      expect(url.searchParams.get("tail")).toBe("10000");
      const since = url.searchParams.get("since") ?? "";
      expect(since).toMatch(/^\d+s$/);
      // At least back to 10:00:05 from about 10:01:02, and not much further.
      const seconds = Number.parseInt(since, 10);
      expect(seconds).toBeGreaterThanOrEqual(57);
      expect(seconds).toBeLessThan(70);
    });

    it("keeps its lines, marks where it reconnected, and shows no held line twice", async () => {
      const redial = await dockedAndDropped();
      act(() => redial.open());
      act(() => redial.say(`${READY}\n${LATER}\n`));
      await wait();

      const lines = wellLines();
      expect(lines.map((line) => line.textContent)).toEqual([
        BOOT,
        READY,
        expect.stringMatching(/^↻ Reconnected at \d\d:\d\d:\d\d$/),
        LATER,
      ]);
      expect(lines[2]!.className).toContain("text-well-hl");
    });

    it("leaves a page box that was never docked asking for its last 200 lines", async () => {
      renderConsole();
      await wait();
      const [socket] = followers();
      act(() => socket!.open());
      act(() => socket!.say(`${READY}\n`));
      await wait();

      act(() => socket!.end(1006));
      await wait(2_000);

      const url = new URL(followers()[1]!.url);
      expect(url.searchParams.get("tail")).toBe("200");
      expect(url.searchParams.get("since")).toBe("all");
    });
  });
});

/**
 * A database's Runtime log, docked: the real `ContainerLog` card under the
 * Dock, its row read through the page's own `useDatabase`. Only the network is
 * faked — the gateway is the fake socket, the row is `databasesApi.findOne` —
 * and the page going away is the card unmounting.
 */
describe("a docked database Runtime log", () => {
  let status: ApplicationStatus;

  const database = () =>
    ({
      databaseId: "db-1",
      kind: "postgres",
      name: "orders-db",
      appName: "orders-db-x1y2",
      serverId: null,
      applicationStatus: status,
    }) as unknown as Database;

  /** The database's Overview: its row, read the page's way, and the card. */
  function DatabasePage() {
    const row = useDatabase("postgres", "db-1");
    return row.data ? (
      <section aria-label="Container output">
        <ContainerLog database={row.data} />
      </section>
    ) : null;
  }

  function renderConsole() {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const tree = (onPage: boolean) => (
      <QueryClientProvider client={client}>
        <DockProvider create={create}>
          <main id="main" tabIndex={-1}>
            <Page />
            {onPage ? <DatabasePage /> : null}
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
  const engines = () =>
    FakeSocket.all.filter((socket) =>
      socket.url.includes("/docker-container-logs"),
    );
  const card = () => screen.getByRole("region", { name: "Container output" });
  const dockFromCard = () =>
    fireEvent.click(within(card()).getByRole("button", { name: "Dock" }));
  const logPanel = () => screen.queryByRole("region", { name: /^Log:/ });
  const docked = () =>
    within(logPanel()!).getByRole("log", { name: "orders-db · Runtime log" });
  const tab = () =>
    within(logPanel()!).getByRole("tab", { name: /orders-db · Runtime log/ });
  const cursorShown = () =>
    docked().querySelector('[data-slot="log-cursor"]') !== null;

  /** The Overview shows the engine following, with a line in hand. */
  async function following() {
    const view = renderConsole();
    await wait();
    const [socket] = engines();
    act(() => socket!.open());
    act(() => socket!.say("database system is ready to accept connections\n"));
    await wait();
    return { ...view, socket: socket! };
  }

  /** The row changes as another page's Start, Stop or Deploy leaves it. */
  async function becomes(next: ApplicationStatus, client: QueryClient) {
    status = next;
    await act(async () => {
      await client.invalidateQueries({
        queryKey: keys.databases.all("org-1"),
      });
    });
    await wait();
  }

  beforeEach(() => {
    vi.useFakeTimers();
    status = "done";
    vi.spyOn(databasesApi, "findOne").mockImplementation(async () =>
      database(),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("moves the same socket and the lines it holds into the Dock", async () => {
    const { socket } = await following();

    dockFromCard();

    expect(docked().textContent).toContain(
      "database system is ready to accept connections",
    );
    expect(engines()).toHaveLength(1);
    expect(socket.close).not.toHaveBeenCalled();
    expect(within(tab()).getByRole("img", { name: "Running" })).toBeTruthy();
    expect(card().textContent).toContain(
      "This log is in the Dock at the bottom of the console, still following.",
    );
  });

  it("shows no cursor once the database is stopped with its page gone, and says so on its tab", async () => {
    const { socket, client, leave } = await following();
    dockFromCard();
    leave();
    expect(cursorShown()).toBe(true);

    await becomes("stopped", client);

    expect(cursorShown()).toBe(false);
    expect(socket.close).not.toHaveBeenCalled();
    expect(within(tab()).getByRole("img", { name: "Stopped" })).toBeTruthy();
    expect(tab().textContent).toContain("Database stopped");
    expect(
      logPanel()!.querySelector("[data-follow-bar]")!.textContent,
    ).not.toContain("Following");
  });

  it("ends on a lease close (4010) like the others: every line, ⊘ No longer authorized, the sentence in its bar, and no dial when it deploys again", async () => {
    const { socket, client, leave } = await following();
    dockFromCard();
    leave();

    act(() => socket.end(LEASE_CLOSE_CODE, "No longer authorized"));
    await wait(60_000);

    expect(
      within(tab()).getByRole("img", { name: "Stopped" }).textContent,
    ).toBe("⊘");
    expect(tab().textContent).toContain("No longer authorized");
    expect(docked().textContent).toContain(
      "database system is ready to accept connections",
    );
    expect(within(followBar()).getByRole("status").textContent).toBe(
      LEASE_SENTENCE,
    );
    expect(cursorShown()).toBe(false);

    await becomes("running", client);
    await becomes("done", client);

    expect(engines()).toHaveLength(1);
  });

  it("dials again once the database finishes deploying, with the page gone", async () => {
    const { socket, client, leave } = await following();
    dockFromCard();
    leave();

    await becomes("running", client);
    expect(engines()).toHaveLength(1);
    await becomes("done", client);

    expect(socket.close).toHaveBeenCalled();
    expect(engines()).toHaveLength(2);
    expect(engines()[1]!.url).toBe(socket.url);
    act(() => engines()[1]!.open());
    await wait();
    expect(cursorShown()).toBe(true);
    expect(within(tab()).getByRole("img", { name: "Running" })).toBeTruthy();
  });

  it("never dials while the row says idle, and dials once it is deployed", async () => {
    const { socket, client, leave } = await following();
    dockFromCard();
    leave();

    await becomes("idle", client);
    expect(socket.close).toHaveBeenCalled();
    await wait(60_000);
    expect(engines()).toHaveLength(1);

    await becomes("done", client);
    expect(engines()).toHaveLength(2);
  });

  it("polls the row itself while it deploys with the page gone", async () => {
    const { client, leave } = await following();
    dockFromCard();
    await becomes("running", client);
    leave();
    const read = vi.mocked(databasesApi.findOne);

    // Nothing invalidates the row: only the docked log's own poll can see it.
    status = "done";
    read.mockClear();
    await wait(3_000);

    expect(read).toHaveBeenCalledTimes(1);
    expect(engines()).toHaveLength(2);
  });

  it("reads the Database row once per poll while the page is also mounted", async () => {
    const { client } = await following();
    dockFromCard();
    await becomes("running", client);
    const read = vi.mocked(databasesApi.findOne);
    read.mockClear();

    await wait(3_000);

    expect(read).toHaveBeenCalledTimes(1);
  });

  it("dials once, not twice, when the deploy finishes with the page still mounted", async () => {
    const { client } = await following();
    dockFromCard();

    await becomes("running", client);
    await becomes("done", client);

    expect(engines()).toHaveLength(2);
  });
});

/**
 * A Server's setup run, docked from the real Setup card (ADR-0058).
 *
 * The run's gateway starts a run only on a dial carrying `start=true`, so
 * what these pin is which dials carry it: the first after a confirmed Run
 * setup, and nothing the Dock, a redial or Read it here too makes.
 */
describe("a docked setup run", () => {
  const stored = {
    setupRanAt: null as string | null,
    setupOk: null as boolean | null,
    setupMessage: null as string | null,
  };

  const serverRow = () =>
    ({
      serverId: "srv-1",
      name: "main-vps",
      ipAddress: "10.0.0.1",
      port: 22,
      username: "root",
      sshKeyId: "key-1",
      command: "",
      reachCheckedAt: null,
      reachOk: null,
      reachMessage: null,
      ...stored,
    }) as unknown as Server;

  /** The Server page's Setup card, reading the row the way the page does. */
  function ServerPage() {
    const row = useServer("srv-1");
    return row.data ? (
      <section aria-label="Server page">
        <SetupCard server={row.data} />
      </section>
    ) : null;
  }

  function renderConsole() {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    // The readiness check the Infrastructure tab read before setup ran.
    client.setQueryData(keys.servers.audit("org-1", "srv-1"), {});
    const tree = (onPage: boolean) => (
      <QueryClientProvider client={client}>
        <DockProvider create={create}>
          <main id="main" tabIndex={-1}>
            <Page />
            {onPage ? <ServerPage /> : null}
          </main>
          <Dock />
        </DockProvider>
      </QueryClientProvider>
    );
    const view = render(tree(true));
    return {
      client,
      leave: () => view.rerender(tree(false)),
      comeBack: () => view.rerender(tree(true)),
    };
  }

  const wait = async (ms = 200) => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  };
  /** Past the longest jittered backoff step. */
  const waitOutBackoff = () => wait(16_000);
  const runs = () =>
    FakeSocket.all.filter((socket) =>
      socket.url.includes("/listen-server-setup"),
    );
  const starts = (socket: FakeSocket) =>
    new URL(socket.url).searchParams.get("start") === "true";
  const page = () => screen.getByRole("region", { name: "Server page" });
  const logPanel = () => screen.queryByRole("region", { name: /^Log:/ });
  const logTab = () =>
    within(logPanel()!).getByRole("tab", { name: /main-vps · Setup run/ });

  /** Run setup, confirmed, with the script's first step in hand. */
  async function running() {
    const view = renderConsole();
    await wait();
    fireEvent.click(within(page()).getByRole("button", { name: "Run setup" }));
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Run setup",
      }),
    );
    await wait();
    const [socket] = runs();
    act(() => socket!.open());
    act(() => socket!.say("1. Installing required packages\n"));
    await wait();
    return { ...view, socket: socket! };
  }

  const dock = () =>
    fireEvent.click(within(page()).getByRole("button", { name: "Dock" }));

  beforeEach(() => {
    vi.useFakeTimers();
    stored.setupRanAt = null;
    stored.setupOk = null;
    stored.setupMessage = null;
    vi.spyOn(serversApi, "findOne").mockImplementation(async () => serverRow());
    vi.spyOn(serversApi, "audit").mockResolvedValue({} as never);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("moves the same socket and its lines into the Dock, and only the confirmed press's dial starts a run", async () => {
    const { socket } = await running();

    dock();

    expect(runs()).toHaveLength(1);
    expect(starts(socket)).toBe(true);
    expect(socket.close).not.toHaveBeenCalled();
    expect(within(logPanel()!).getByRole("log").textContent).toContain(
      "1. Installing required packages",
    );
    expect(page().textContent).toContain(
      "This log is in the Dock at the bottom of the console, still following.",
    );
  });

  it("redials from the Dock only to watch, after its page is gone", async () => {
    const { socket, leave } = await running();
    dock();
    leave();

    act(() => socket.end(1006));
    await waitOutBackoff();

    expect(runs()).toHaveLength(2);
    expect(starts(runs()[1]!)).toBe(false);
    expect(logPanel()!.textContent).toContain(
      "1. Installing required packages",
    );
  });

  it("keeps its lines across a drop, marks where it reconnected, and skips the run's replay", async () => {
    const { socket, leave } = await running();
    dock();
    leave();
    act(() => socket.say("2. Initialising Swarm\n"));
    await wait();

    act(() => socket.end(1006));
    await waitOutBackoff();
    const watch = runs()[1]!;
    expect(starts(watch)).toBe(false);
    act(() => watch.open());
    act(() =>
      watch.say(
        "1. Installing required packages\n2. Initialising Swarm\n3. Creating the network\n",
      ),
    );
    await wait();

    const lines = wellLines();
    expect(lines.map((line) => line.textContent)).toEqual([
      "1. Installing required packages",
      "2. Initialising Swarm",
      expect.stringMatching(/^↻ Reconnected at \d\d:\d\d:\d\d$/),
      "3. Creating the network",
    ]);
  });

  it("Read it here too opens a box of the page's own that only watches", async () => {
    await running();
    dock();

    fireEvent.click(
      within(page()).getByRole("button", { name: "Read it here too" }),
    );
    await wait();

    expect(runs()).toHaveLength(2);
    expect(starts(runs()[1]!)).toBe(false);
    expect(
      within(page()).getByRole("log", { name: "Setup output" }),
    ).toBeTruthy();
  });

  it("ends the tab when a watch finds nothing running, with every line, the stored outcome and the disconnected sentence", async () => {
    const { socket, leave } = await running();
    dock();
    leave();
    act(() => socket.end(1006));
    await waitOutBackoff();
    stored.setupRanAt = "2026-01-01T10:05:00.000Z";
    stored.setupOk = false;
    stored.setupMessage = "Remote command failed with exit code 1";

    act(() => runs()[1]!.open());
    act(() =>
      runs()[1]!.end(SETUP_NOT_RUNNING_CLOSE_CODE, "No setup run in flight"),
    );
    await wait();

    const tab = logTab();
    expect(tab.textContent).toContain("Failed");
    expect(within(tab).getByRole("img", { name: "Failed" })).toBeTruthy();
    const text = logPanel()!.textContent ?? "";
    expect(text).toContain("This run ended while this log was disconnected.");
    expect(text).toContain("Remote command failed with exit code 1");
    expect(text).toContain("1. Installing required packages");
    await waitOutBackoff();
    expect(runs()).toHaveLength(2);
  });

  it("ends on a lease close (4010) like the others: every line, ⊘ No longer authorized, the sentence in its bar, and no watch dialled after", async () => {
    const { socket, leave } = await running();
    dock();
    leave();

    act(() => socket.end(LEASE_CLOSE_CODE, "No longer authorized"));
    await waitOutBackoff();

    const tab = logTab();
    expect(within(tab).getByRole("img", { name: "Stopped" }).textContent).toBe(
      "⊘",
    );
    expect(tab.textContent).toContain("No longer authorized");
    expect(logPanel()!.textContent).toContain(
      "1. Installing required packages",
    );
    expect(within(followBar()).getByRole("status").textContent).toBe(
      LEASE_SENTENCE,
    );
    expect(runs()).toHaveLength(1);
  });

  it("offers no Run again on the tab, running or ended", async () => {
    const { socket } = await running();
    dock();
    const offered = () =>
      within(logPanel()!).queryByRole("button", {
        name: /run setup|run again|watch again|start/i,
      });

    expect(offered()).toBeNull();

    act(() => socket.say("✅ Setup finished.\n"));
    act(() => socket.end(1000, "Setup finished"));
    await wait();

    expect(logTab().textContent).toContain("Succeeded");
    expect(offered()).toBeNull();
  });

  it("a finished run can still be docked, with the lines it holds and no Reload", async () => {
    const { socket } = await running();
    act(() => socket.say("✅ Setup finished.\n"));
    act(() => socket.end(1000, "Setup finished"));
    await wait();

    dock();

    expect(logTab().textContent).toContain("Succeeded");
    expect(within(logPanel()!).getByRole("log").textContent).toContain(
      "1. Installing required packages",
    );
    expect(
      within(followBar()).queryByRole("button", { name: "Reload" }),
    ).toBeNull();
    expect(page().textContent).toContain(
      "This log is in the Dock at the bottom of the console. Setup finished.",
    );
    await waitOutBackoff();
    expect(runs()).toHaveLength(1);
  });

  it("the Setup card says Running, in the Dock, with its button off and a link that shows the tab", async () => {
    const { leave, comeBack } = await running();
    dock();
    leave();
    comeBack();
    await wait();

    const button = within(page()).getByRole("button", {
      name: "Running, in the Dock",
    });
    expect(
      button.hasAttribute("disabled") ||
        button.getAttribute("aria-disabled") === "true",
    ).toBe(true);
    expect(runs()).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Minimise the Dock" }));
    fireEvent.click(
      within(page()).getByRole("button", { name: "Show it in the Dock" }),
    );
    expect(document.activeElement).toBe(within(logPanel()!).getByRole("log"));

    // A fresh card's Read it here too watches the docked run, never starts one.
    fireEvent.click(
      within(page()).getByRole("button", { name: "Read it here too" }),
    );
    await wait();
    expect(runs()).toHaveLength(2);
    expect(starts(runs()[1]!)).toBe(false);
  });

  it("re-reads the Server's readiness when a docked run ends after its page is gone", async () => {
    const { socket, leave, client } = await running();
    dock();
    leave();
    const audit = keys.servers.audit("org-1", "srv-1");
    expect(client.getQueryState(audit)?.isInvalidated).toBe(false);

    act(() => socket.say("✅ Setup finished.\n"));
    act(() => socket.end(1000, "Setup finished"));
    await wait();

    expect(client.getQueryState(audit)?.isInvalidated).toBe(true);
    expect(logTab().textContent).toContain("Succeeded");
  });
});
