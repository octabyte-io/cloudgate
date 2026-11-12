import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SHELL_OPEN_FRAME, useServerTerminal } from "./terminals";

/**
 * A terminal is `running` once the gateway says the shell is open, not
 * once the WebSocket is — the socket opens before the SSH handshake starts, so
 * an unreachable Server wore green for the whole 20–30 s dial.
 */
class FakeSocket {
  static readonly OPEN = 1;
  static last: FakeSocket | null = null;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  send = vi.fn();
  close = vi.fn();

  constructor() {
    FakeSocket.last = this;
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
  FakeSocket.last = null;
  vi.stubGlobal("WebSocket", FakeSocket);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("useServerTerminal's shellOpen", () => {
  it("stays false on an open socket until the gateway says the shell is open", () => {
    const { result } = renderHook(() => useServerTerminal({ serverId: "srv-1" }));
    const written: string[] = [];
    act(() => result.current.attach((frame) => written.push(frame)));

    act(() => FakeSocket.last?.open());
    act(() => FakeSocket.last?.say("Connecting...\r\n"));
    expect(result.current.status).toBe("open");
    expect(result.current.shellOpen).toBe(false);

    act(() => FakeSocket.last?.say(SHELL_OPEN_FRAME));
    expect(result.current.shellOpen).toBe(true);
    // The protocol's frame is not the shell's output.
    expect(written).toEqual(["Connecting...\r\n"]);
  });

  it("writes the same bytes through once the shell is open — output is never inspected", () => {
    const { result } = renderHook(() => useServerTerminal({ serverId: "srv-1" }));
    const written: string[] = [];
    act(() => result.current.attach((frame) => written.push(frame)));
    act(() => FakeSocket.last?.open());
    act(() => FakeSocket.last?.say(SHELL_OPEN_FRAME));

    // A program printing the same bytes later is printing them.
    act(() => FakeSocket.last?.say(SHELL_OPEN_FRAME));
    expect(written).toEqual([SHELL_OPEN_FRAME]);
  });

  it("goes back to waiting when the session dials again", () => {
    const { result } = renderHook(() => useServerTerminal({ serverId: "srv-1" }));
    act(() => FakeSocket.last?.open());
    act(() => FakeSocket.last?.say(SHELL_OPEN_FRAME));
    expect(result.current.shellOpen).toBe(true);

    act(() => result.current.reconnect());
    act(() => FakeSocket.last?.open());
    expect(result.current.status).toBe("open");
    expect(result.current.shellOpen).toBe(false);

    act(() => FakeSocket.last?.say(SHELL_OPEN_FRAME));
    expect(result.current.shellOpen).toBe(true);
  });
});
