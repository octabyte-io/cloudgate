import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  SHELL_OPEN_FRAME,
  TERMINALS_ENDED_REASON,
  TERMINALS_LEFT_REASON,
  TerminalChannel,
  containerTerminalUrl,
  endAllTerminals,
  onTerminalsEnded,
  serverTerminalUrl,
} from "./terminals";

/**
 * A terminal's socket, owned outside React.
 *
 * The docked panel moves a live session from a page into the console layout,
 * so the socket cannot belong to the component that opened it. These pin the
 * channel the hooks and the Dock now share.
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

  say(data: string) {
    this.onmessage?.({ data } as MessageEvent);
  }
}

beforeEach(() => {
  FakeSocket.all = [];
  vi.stubGlobal("WebSocket", FakeSocket);
});

afterEach(() => {
  endAllTerminals();
  vi.unstubAllGlobals();
});

describe("TerminalChannel", () => {
  it("dials only when opened, and hands frames to whatever is attached", () => {
    const channel = new TerminalChannel();
    const written: string[] = [];
    channel.attach((frame) => written.push(frame));
    expect(FakeSocket.all).toHaveLength(0);

    channel.open(serverTerminalUrl({ serverId: "srv-1" }));
    expect(FakeSocket.all).toHaveLength(1);
    expect(FakeSocket.all[0]?.url).toContain("/terminal?serverId=srv-1");

    FakeSocket.all[0]?.open();
    FakeSocket.all[0]?.say("Connecting...\r\n");
    FakeSocket.all[0]?.say(SHELL_OPEN_FRAME);
    FakeSocket.all[0]?.say("$ ");

    expect(written).toEqual(["Connecting...\r\n", "$ "]);
    expect(channel.getSnapshot()).toMatchObject({
      status: "open",
      shellOpen: true,
    });
  });

  it("keeps one snapshot identity between changes, as useSyncExternalStore needs", () => {
    const channel = new TerminalChannel();
    channel.open(serverTerminalUrl({ serverId: "srv-1" }));
    expect(channel.getSnapshot()).toBe(channel.getSnapshot());

    const before = channel.getSnapshot();
    FakeSocket.all[0]?.open();
    expect(channel.getSnapshot()).not.toBe(before);
  });

  it("sends the resize control frame only on an open socket", () => {
    const channel = new TerminalChannel();
    channel.open(serverTerminalUrl({ serverId: "srv-1" }));
    expect(channel.resize(120, 30)).toBe(false);

    FakeSocket.all[0]?.open();
    expect(channel.resize(120, 30)).toBe(true);
    expect(FakeSocket.all[0]?.send).toHaveBeenCalledWith(
      '\x00{"cols":120,"rows":30}',
    );
  });

  it("closing the socket is the whole teardown — the gateway reaps on close", () => {
    const channel = new TerminalChannel();
    channel.open(serverTerminalUrl({ serverId: "srv-1" }));
    FakeSocket.all[0]?.open();

    channel.close();
    expect(FakeSocket.all[0]?.close).toHaveBeenCalled();
  });
});

describe("the gateway URLs", () => {
  it("a local shell carries the port and user the gateway cannot look up", () => {
    expect(
      serverTerminalUrl({ serverId: "local", port: 22, username: "root" }),
    ).toMatch(/\/terminal\?serverId=local&port=22&username=root$/);
    expect(serverTerminalUrl({ serverId: "local" })).toBeNull();
  });

  it("a container's shell is the gateway's activeWay", () => {
    expect(
      containerTerminalUrl({ containerId: "c-1", serverId: null, shell: "sh" }),
    ).toMatch(/\/docker-container-terminal\?containerId=c-1&activeWay=sh$/);
  });
});

describe("endAllTerminals", () => {
  it("closes every open terminal at once and says so — an organization switch or a sign-out", () => {
    const one = new TerminalChannel();
    const two = new TerminalChannel();
    one.open(serverTerminalUrl({ serverId: "srv-1" }));
    two.open(containerTerminalUrl({ containerId: "c-1", serverId: "srv-1" }));
    const heard = vi.fn();
    const stop = onTerminalsEnded(heard);

    endAllTerminals();

    expect(FakeSocket.all[0]?.close).toHaveBeenCalled();
    expect(FakeSocket.all[1]?.close).toHaveBeenCalled();
    expect(heard).toHaveBeenCalledTimes(1);
    stop();
  });

  it("a channel it ends says so, rather than still reading open", () => {
    const channel = new TerminalChannel();
    channel.open(serverTerminalUrl({ serverId: "srv-1" }));
    FakeSocket.all[0]?.open();
    FakeSocket.all[0]?.say(SHELL_OPEN_FRAME);

    endAllTerminals();

    expect(channel.getSnapshot()).toMatchObject({
      status: "closed",
      shellOpen: false,
      closeReason: TERMINALS_ENDED_REASON,
    });
  });

  it("a channel it ended dials again on Connect again — the page still holds it", () => {
    const channel = new TerminalChannel();
    channel.open(serverTerminalUrl({ serverId: "srv-1" }));
    FakeSocket.all[0]?.open();
    endAllTerminals();

    channel.reconnect();
    expect(FakeSocket.all).toHaveLength(2);
    expect(FakeSocket.all[1]?.url).toContain("/terminal?serverId=srv-1");
    expect(channel.getSnapshot()).toMatchObject({
      status: "connecting",
      closeReason: null,
    });

    // And it is live again, so the next switch reaches it too.
    FakeSocket.all[1]?.open();
    endAllTerminals();
    expect(FakeSocket.all[1]?.close).toHaveBeenCalled();
  });

  it("a channel closed for good stays closed on Connect again", () => {
    const channel = new TerminalChannel();
    channel.open(serverTerminalUrl({ serverId: "srv-1" }));
    channel.close();

    channel.reconnect();
    expect(FakeSocket.all).toHaveLength(1);
  });

  it("does not reach a channel that was already closed", () => {
    const channel = new TerminalChannel();
    channel.open(serverTerminalUrl({ serverId: "srv-1" }));
    channel.close();
    FakeSocket.all[0]?.close.mockClear();

    endAllTerminals();
    expect(FakeSocket.all[0]?.close).not.toHaveBeenCalled();
  });
});

describe("leaving the page into the back/forward cache", () => {
  const pageHide = (persisted: boolean) =>
    window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted }));

  it("ends every terminal, which the gateway reaps, rather than leaving them open behind a frozen page", () => {
    const docked = new TerminalChannel();
    const onPage = new TerminalChannel();
    docked.open(serverTerminalUrl({ serverId: "srv-1" }));
    onPage.open(containerTerminalUrl({ containerId: "c-1", serverId: "srv-1" }));
    FakeSocket.all[0]?.open();
    FakeSocket.all[1]?.open();
    const heard = vi.fn();
    const stop = onTerminalsEnded(heard);

    pageHide(true);

    expect(FakeSocket.all[0]?.close).toHaveBeenCalled();
    expect(FakeSocket.all[1]?.close).toHaveBeenCalled();
    expect(heard).toHaveBeenCalledTimes(1);
    expect(onPage.getSnapshot()).toMatchObject({
      status: "closed",
      shellOpen: false,
      closeReason: TERMINALS_LEFT_REASON,
    });
    stop();
  });

  it("does not dial a new shell when the restored page finds its socket dropped", () => {
    const channel = new TerminalChannel();
    channel.open(serverTerminalUrl({ serverId: "srv-1" }));
    FakeSocket.all[0]?.open();

    pageHide(true);
    FakeSocket.all[0]?.onclose?.({ code: 1006, reason: "" } as CloseEvent);

    expect(FakeSocket.all).toHaveLength(1);
    expect(channel.getSnapshot().closeReason).toBe(TERMINALS_LEFT_REASON);

    // Connect again is still the operator's to press.
    channel.reconnect();
    expect(FakeSocket.all).toHaveLength(2);
  });

  it("leaves terminals alone on a pagehide that is a real unload, which closes them anyway", () => {
    const channel = new TerminalChannel();
    channel.open(serverTerminalUrl({ serverId: "srv-1" }));
    FakeSocket.all[0]?.open();

    pageHide(false);

    expect(FakeSocket.all[0]?.close).not.toHaveBeenCalled();
    expect(channel.getSnapshot().status).toBe("open");
  });

  it("an Organization switch still says its own reason", () => {
    const channel = new TerminalChannel();
    channel.open(serverTerminalUrl({ serverId: "srv-1" }));
    endAllTerminals();
    expect(channel.getSnapshot().closeReason).toBe(TERMINALS_ENDED_REASON);
  });
});
