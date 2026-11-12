import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useContainerLogs, useDeploymentLog } from "./gateways";
import { LiveLog } from "./live-log";

/**
 * A page's log box reads a Live log, and the page holds it only until it is
 * docked. Docking itself is tested in the Dock; here the hand-over is the owner
 * changing, which is all the page box looks at.
 */
class FakeSocket {
  static readonly OPEN = 1;
  static dials: FakeSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  send = vi.fn();
  close = vi.fn();

  constructor(readonly url: string) {
    FakeSocket.dials.push(this);
  }

  open() {
    this.readyState = 1;
    this.onopen?.();
  }

  say(frame: string) {
    this.onmessage?.({ data: frame } as MessageEvent);
  }
}

beforeEach(() => {
  FakeSocket.dials = [];
  vi.stubGlobal("WebSocket", FakeSocket);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("a page's socket log box", () => {
  it("closes its socket on unmount while the page holds its Live log", () => {
    const { unmount } = renderHook(() =>
      useDeploymentLog({ deploymentId: "dep-1" }),
    );
    expect(FakeSocket.dials).toHaveLength(1);

    unmount();

    expect(FakeSocket.dials[0].close).toHaveBeenCalled();
  });

  it("leaves the socket and its lines alone once the Live log is the Dock's", () => {
    vi.useFakeTimers();
    const { result, unmount } = renderHook(() =>
      useDeploymentLog({ deploymentId: "dep-1" }),
    );
    const live = result.current.log!;
    act(() => {
      FakeSocket.dials[0].open();
      FakeSocket.dials[0].say("Step 1/4\n");
      vi.advanceTimersByTime(100);
    });

    live.owner = "dock";
    unmount();

    expect(FakeSocket.dials[0].close).not.toHaveBeenCalled();
    expect(live.getSnapshot().lines).toEqual(["Step 1/4"]);
    expect(live.getSnapshot().status).toBe("open");

    live.dispose();
    expect(FakeSocket.dials[0].close).toHaveBeenCalled();
  });

  it("keeps the following flag on the Live log, where the box reads it", () => {
    const { result } = renderHook(() =>
      useContainerLogs({ containerId: "c-1" }),
    );
    expect(result.current.following).toBe(true);

    act(() => result.current.setFollowing(false));

    expect(result.current.following).toBe(false);
    expect(result.current.log!.getSnapshot().following).toBe(false);
  });

  it("names the log it holds by what it is, not by how it was dialled", () => {
    const { result, rerender } = renderHook(
      ({ tail }) => useContainerLogs({ containerId: "c-1", tail }),
      { initialProps: { tail: 100 } },
    );
    const first = result.current.log!;
    expect(first.key).toBe("container:local:c-1");

    rerender({ tail: 200 });

    // Same log, dialled again: the old socket goes, the Live log stays.
    expect(result.current.log).toBe(first);
    expect(FakeSocket.dials).toHaveLength(2);
    expect(FakeSocket.dials[0].close).toHaveBeenCalled();
  });
});

describe("a Live log's watches", () => {
  it("lets a watch that could not start yet — no Organization known — start on the next try", () => {
    const log = new LiveLog("deployment:dep-1", "page", { cap: 100 });
    const stop = vi.fn();
    const start = vi.fn<() => (() => void) | null>(() => null);

    log.watch("deployment-status", start);
    start.mockImplementation(() => stop);
    log.watch("deployment-status", start);
    log.watch("deployment-status", start);

    expect(start).toHaveBeenCalledTimes(2);
    log.dispose();
    expect(stop).toHaveBeenCalledTimes(1);
  });
});

describe("a Live log changing hands", () => {
  it("tells whoever reads it, so a page box sees it docked without asking the Dock", () => {
    const log = new LiveLog("deployment:dep-1", "page", { cap: 100 });
    const listener = vi.fn();
    log.subscribe(listener);

    log.owner = "dock";

    expect(listener).toHaveBeenCalledTimes(1);
    expect(log.owner).toBe("dock");
    log.owner = "dock";
    expect(listener).toHaveBeenCalledTimes(1);
    log.dispose();
  });
});
