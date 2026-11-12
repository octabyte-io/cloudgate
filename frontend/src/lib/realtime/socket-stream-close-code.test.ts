import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SocketStreamStore } from "./socket-stream-store";

/**
 * A clean close keeps its code.
 *
 * `closed` is what a store reports before it has dialled at all, after a shell
 * exited, and after a gateway hung up without a word — and a terminal's pill has
 * to tell those apart. The reason stays `null` on a clean close: every log card
 * reads a reason as a refusal.
 */
class FakeSocket {
  static readonly OPEN = 1;
  static last: FakeSocket | null = null;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  send = vi.fn();
  close = vi.fn();

  constructor() {
    FakeSocket.last = this;
  }

  hangUp(code: number, reason = "") {
    this.onclose?.({ code, reason } as CloseEvent);
  }
}

beforeEach(() => {
  FakeSocket.last = null;
  vi.stubGlobal("WebSocket", FakeSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SocketStreamStore close codes", () => {
  const opened = () => {
    const store = new SocketStreamStore(100);
    store.open("ws://gateway/terminal");
    FakeSocket.last?.onopen?.();
    return store;
  };

  it("has no code before anything was dialled", () => {
    const store = new SocketStreamStore(100);
    store.open(null);
    expect(store.getSnapshot()).toMatchObject({
      status: "closed",
      closeCode: null,
    });
  });

  it("keeps 1000 when the gateway ends the stream cleanly", () => {
    const store = opened();
    FakeSocket.last?.hangUp(1000, "shell exited with code 0");
    expect(store.getSnapshot()).toMatchObject({
      status: "closed",
      closeCode: 1000,
      closeReason: null,
    });
  });

  it("keeps 1005 when the gateway hangs up without a code", () => {
    const store = opened();
    FakeSocket.last?.hangUp(1005);
    expect(store.getSnapshot()).toMatchObject({
      status: "closed",
      closeCode: 1005,
      closeReason: null,
    });
  });

  it("clears the code when it dials again", () => {
    const store = opened();
    FakeSocket.last?.hangUp(1000);
    store.reconnect();
    expect(store.getSnapshot()).toMatchObject({
      status: "connecting",
      closeCode: null,
    });
  });
});
