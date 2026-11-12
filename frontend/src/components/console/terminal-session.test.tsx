import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Dock, DockProvider } from "@/components/shell/dock";
import { useDock } from "@/components/shell/dock-context";
import {
  DOCK_SHELLS_FULL_SENTENCE,
  MAX_DOCK_SHELLS,
} from "@/components/shell/dock-store";
import {
  LEASE_CLOSE_CODE,
  TERMINALS_ENDED_REASON,
  endAllTerminals,
} from "@/lib/realtime/gateways";
// Not re-exported: only a test plays the gateway's side of the protocol.
import { SHELL_OPEN_FRAME } from "@/lib/realtime/terminals";

import type { TerminalTarget } from "./terminal-target";

/**
 * A page's terminal and its Dock control.
 *
 * Docking **moves** the live session: same socket, same xterm, same running
 * process — no redial and no second emulator. These pin that on the real
 * session, with xterm itself faked at the module boundary because jsdom has no
 * canvas or layout.
 */
const terms = vi.hoisted(
  () => [] as Array<{ written: string[]; disposed: boolean }>,
);

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    written: string[] = [];
    disposed = false;
    constructor() {
      terms.push(this);
    }
    loadAddon() {}
    open() {}
    write(frame: string) {
      this.written.push(frame);
    }
    onData() {}
    resize() {}
    refresh() {}
    focus() {}
    attachCustomKeyEventHandler() {}
    dispose() {
      this.disposed = true;
    }
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    proposeDimensions() {
      return { cols: 100, rows: 20 };
    }
  },
}));
vi.mock("./terminal-theme", () => ({
  monoStack: () => "monospace",
  wellTheme: () => ({}),
  resolveColor: () => "rgb(20, 20, 20)",
}));

const { default: TerminalSession } = await import("./terminal-session");

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
  say(data: string) {
    this.onmessage?.({ data } as MessageEvent);
  }
  end(code: number, reason = "") {
    this.readyState = 3;
    this.onclose?.({ code, reason } as CloseEvent);
  }
}

class NoopObserver {
  observe() {}
  disconnect() {}
}

const server: TerminalTarget = {
  kind: "server",
  serverId: "srv-1",
  name: "main-vps",
  address: "root@10.0.0.1:22",
};

beforeEach(() => {
  FakeSocket.all = [];
  terms.length = 0;
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("ResizeObserver", NoopObserver);
});

afterEach(() => {
  cleanup();
  endAllTerminals();
  vi.unstubAllGlobals();
});

/** Opens a shell straight into the Dock, as Servers → Docker does. */
function OpenElsewhere() {
  const dock = useDock();
  return (
    <button type="button" onClick={() => dock?.open(server)}>
      Open one in the Dock
    </button>
  );
}

/** The Server's Terminal tab, under the console layout's dock. */
function Console({ page = true }: { page?: boolean }) {
  return (
    <DockProvider>
      <OpenElsewhere />
      {page ? <TerminalSession target={server} /> : <p>Another page</p>}
      <Dock />
    </DockProvider>
  );
}

const dock = () => screen.queryByRole("region", { name: /^Terminal:/ });

describe("a page's terminal", () => {
  it("docks its running session in one click — same socket, same scrollback", async () => {
    const { rerender } = render(<Console />);
    await vi.waitFor(() => expect(terms).toHaveLength(1));
    act(() => FakeSocket.all[0]?.open());
    act(() => FakeSocket.all[0]?.say("$ sleep 600\r\n"));

    fireEvent.click(screen.getByRole("button", { name: "Dock" }));

    expect(dock()).not.toBeNull();
    expect(screen.getByText("Server main-vps")).toBeTruthy();
    expect(
      screen.getByText(
        /This shell is in the Dock at the bottom of the console/,
      ),
    ).toBeTruthy();
    // No redial, no second emulator, nothing ended.
    expect(FakeSocket.all).toHaveLength(1);
    expect(FakeSocket.all[0]?.close).not.toHaveBeenCalled();
    expect(terms).toHaveLength(1);
    expect(terms[0]?.disposed).toBe(false);
    expect(terms[0]?.written).toEqual(["$ sleep 600\r\n"]);

    // Navigating away unmounts the page, and the docked shell carries on.
    rerender(<Console page={false} />);
    expect(FakeSocket.all[0]?.close).not.toHaveBeenCalled();
    expect(dock()).not.toBeNull();
  });

  it("ends a session it still holds when the page goes", async () => {
    const { rerender } = render(<Console />);
    await vi.waitFor(() => expect(terms).toHaveLength(1));

    rerender(<Console page={false} />);

    expect(FakeSocket.all[0]?.close).toHaveBeenCalled();
    expect(terms[0]?.disposed).toBe(true);
  });

  it("offers a fresh shell beside the docked one", async () => {
    render(<Console />);
    await vi.waitFor(() => expect(terms).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "Dock" }));

    fireEvent.click(
      screen.getByRole("button", { name: "Open a new shell here" }),
    );

    expect(FakeSocket.all).toHaveLength(2);
    expect(FakeSocket.all[0]?.close).not.toHaveBeenCalled();
  });

  it("docking beside a docked shell is a second tab, and the first keeps running", async () => {
    render(<Console />);
    await vi.waitFor(() => expect(terms).toHaveLength(1));
    act(() => FakeSocket.all[0]?.open());
    act(() => FakeSocket.all[0]?.say("$ sleep 600\r\n"));
    fireEvent.click(screen.getByRole("button", { name: "Dock" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Open a new shell here" }),
    );
    await vi.waitFor(() => expect(terms).toHaveLength(2));

    fireEvent.click(screen.getByRole("button", { name: "Dock" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(2);
    expect(tabs[1]?.getAttribute("aria-selected")).toBe("true");
    fireEvent.click(tabs[0]!);
    expect(FakeSocket.all[0]?.close).not.toHaveBeenCalled();
    expect(terms[0]?.disposed).toBe(false);
    expect(terms[0]?.written).toEqual(["$ sleep 600\r\n"]);
  });

  it("Dock is disabled at the cap, with the sentence, and comes back when a tab closes", async () => {
    render(<Console />);
    await vi.waitFor(() => expect(terms).toHaveLength(1));
    for (let i = 0; i < MAX_DOCK_SHELLS; i++) {
      fireEvent.click(
        screen.getByRole("button", { name: "Open one in the Dock" }),
      );
    }

    const dockButton = screen.getByRole("button", { name: "Dock" });
    // Base UI keeps an off action focusable and marks it `aria-disabled`.
    expect(dockButton.getAttribute("aria-disabled")).toBe("true");
    expect(
      screen.getAllByText(DOCK_SHELLS_FULL_SENTENCE).length,
    ).toBeGreaterThan(0);

    fireEvent.click(
      screen.getAllByRole("button", { name: "Close Server main-vps" })[0]!,
    );

    expect(
      screen
        .getByRole("button", { name: "Dock" })
        .getAttribute("aria-disabled"),
    ).not.toBe("true");
    expect(screen.queryByText(DOCK_SHELLS_FULL_SENTENCE)).toBeNull();
  });

  it("says it ended when an Organization switch ends it, and Connect again redials", async () => {
    render(<Console />);
    await vi.waitFor(() => expect(terms).toHaveLength(1));
    act(() => FakeSocket.all[0]?.open());
    act(() => FakeSocket.all[0]?.say(SHELL_OPEN_FRAME));

    act(() => endAllTerminals());

    expect(FakeSocket.all[0]?.close).toHaveBeenCalled();
    expect(
      screen.getByText(new RegExp(`^${TERMINALS_ENDED_REASON}`)),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Connect again" }));

    expect(FakeSocket.all).toHaveLength(2);
    expect(FakeSocket.all[1]?.url).toContain("/terminal?serverId=srv-1");
    expect(screen.getByText("Connecting.")).toBeTruthy();
    // The same session and emulator: the page still holds it.
    expect(terms).toHaveLength(1);
    expect(terms[0]?.disposed).toBe(false);
  });

  it("stops calling a docked shell running once it has ended in the Dock", async () => {
    render(<Console />);
    await vi.waitFor(() => expect(terms).toHaveLength(1));
    act(() => FakeSocket.all[0]?.open());
    act(() => FakeSocket.all[0]?.say(SHELL_OPEN_FRAME));
    fireEvent.click(screen.getByRole("button", { name: "Dock" }));
    expect(screen.getByText(/still running/)).toBeTruthy();

    // The lease ends while it is docked: its Dock tab says so, and the page it
    // came from has to stop claiming otherwise.
    act(() =>
      FakeSocket.all[0]?.end(
        LEASE_CLOSE_CODE,
        "This session is no longer authorized",
      ),
    );

    expect(screen.queryByText(/still running/)).toBeNull();
    expect(
      screen.getByText(
        "This shell moved to the Dock and has ended there: no longer authorized.",
      ),
    ).toBeTruthy();
    // A fresh one here is the way on, and the Dock still shows why.
    expect(
      screen.getByRole("button", { name: "Open a new shell here" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show the Dock" })).toBeTruthy();
  });

  it("does not call a docked shell running before its shell has opened", async () => {
    render(<Console />);
    await vi.waitFor(() => expect(terms).toHaveLength(1));
    act(() => FakeSocket.all[0]?.open());
    fireEvent.click(screen.getByRole("button", { name: "Dock" }));

    expect(
      screen.getByText(
        "This shell is in the Dock at the bottom of the console.",
      ),
    ).toBeTruthy();
  });

  it("has no Dock control outside the console layout", async () => {
    render(<TerminalSession target={server} />);
    await vi.waitFor(() => expect(terms).toHaveLength(1));

    expect(screen.queryByRole("button", { name: "Dock" })).toBeNull();
  });
});
