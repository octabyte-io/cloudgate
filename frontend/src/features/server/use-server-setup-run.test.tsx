import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Server } from "@/lib/api/endpoints/servers";

import { RunPanel } from "./infrastructure/setup-run-panel";
import { SETUP_NOT_RUNNING_CLOSE_CODE, useServerSetupRun } from "./use-server";

/**
 * Only a confirmed press starts a Setup run (ADR-0058).
 *
 * `/listen-server-setup` starts a run on a dial that carries `start=true`, and
 * the store redials on its own after a transport drop. So the flag has to ride on
 * exactly one dial — the one `start()` makes — and never on the backoff redials
 * after it, or a drop in a run's last seconds provisions the host again.
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

  /** Whether this dial asked to start a run. */
  get starts(): boolean {
    return new URL(this.url).searchParams.get("start") === "true";
  }

  open() {
    this.readyState = 1;
    this.onopen?.();
  }

  say(frame: string) {
    this.onmessage?.({ data: frame } as MessageEvent);
  }

  hangUp(code: number, reason = "") {
    this.readyState = 3;
    this.onclose?.({ code, reason } as CloseEvent);
  }
}

const last = () => FakeSocket.dials.at(-1)!;

function withQuery({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.dials = [];
  vi.stubGlobal("WebSocket", FakeSocket);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** Past the longest jittered backoff step, and past the store's flush. */
const waitOutBackoff = () => act(() => vi.advanceTimersByTime(16_000));

describe("useServerSetupRun", () => {
  it("dials nothing until start(), and that dial starts a run", () => {
    const { result } = renderHook(() => useServerSetupRun("srv-1"), {
      wrapper: withQuery,
    });
    expect(FakeSocket.dials).toHaveLength(0);

    act(() => result.current.start());

    expect(FakeSocket.dials).toHaveLength(1);
    expect(last().starts).toBe(true);
    expect(new URL(last().url).searchParams.get("serverId")).toBe("srv-1");
  });

  it("redials after an abnormal close without the start flag", () => {
    const { result } = renderHook(() => useServerSetupRun("srv-1"), {
      wrapper: withQuery,
    });
    act(() => result.current.start());
    act(() => last().open());
    act(() => last().hangUp(1006));
    expect(result.current.state).toBe("running");

    waitOutBackoff();

    expect(FakeSocket.dials).toHaveLength(2);
    expect(last().starts).toBe(false);

    // And the redial after that one, too.
    act(() => last().hangUp(1006));
    waitOutBackoff();
    expect(FakeSocket.dials).toHaveLength(3);
    expect(last().starts).toBe(false);
  });

  it("starts again only on another start(), and its redials still only watch", () => {
    const { result } = renderHook(() => useServerSetupRun("srv-1"), {
      wrapper: withQuery,
    });
    act(() => result.current.start());
    act(() => last().open());
    act(() => last().say("\n✅ Setup finished.\n"));
    act(() => last().hangUp(1000, "Setup finished"));
    expect(result.current.state).toBe("finished");

    act(() => result.current.start());
    expect(FakeSocket.dials).toHaveLength(2);
    expect(last().starts).toBe(true);

    act(() => last().hangUp(1006));
    waitOutBackoff();
    expect(FakeSocket.dials).toHaveLength(3);
    expect(last().starts).toBe(false);
  });

  it("does not start a run on another Server because the target changed", () => {
    const { result, rerender } = renderHook(
      ({ serverId }) => useServerSetupRun(serverId),
      { wrapper: withQuery, initialProps: { serverId: "srv-1" } },
    );
    act(() => result.current.start());

    rerender({ serverId: "srv-2" });

    expect(FakeSocket.dials.filter((dial) => dial.starts)).toHaveLength(1);
    expect(
      FakeSocket.dials.some((dial) => dial.url.includes("serverId=srv-2")),
    ).toBe(false);
    expect(result.current.state).toBe("idle");
  });

  describe("a run that ended while the log was disconnected", () => {
    function endedWhileAway() {
      const hook = renderHook(() => useServerSetupRun("srv-1"), {
        wrapper: withQuery,
      });
      act(() => hook.result.current.start());
      act(() => last().open());
      act(() => last().say("1. Installing required packages\n"));
      act(() => last().say("2. Installing Docker\n"));
      act(() => last().hangUp(1006));
      waitOutBackoff();
      act(() => last().open());
      act(() =>
        last().hangUp(SETUP_NOT_RUNNING_CLOSE_CODE, "No setup run in flight"),
      );
      return hook;
    }

    it("is ended, not refused, and keeps every line it had", () => {
      const { result } = endedWhileAway();

      expect(result.current.state).toBe("ended");
      expect(result.current.reason).toBeNull();
      expect(result.current.lines).toEqual([
        "1. Installing required packages",
        "2. Installing Docker",
      ]);
      // Nothing redials on its own after that: the run is over.
      waitOutBackoff();
      expect(FakeSocket.dials).toHaveLength(2);
    });

    const server = (stored: Partial<Server>) =>
      ({
        serverId: "srv-1",
        ipAddress: "203.0.113.10",
        username: "root",
        setupRanAt: new Date().toISOString(),
        setupOk: true,
        setupMessage: null,
        ...stored,
      }) as unknown as Server;

    it("says so, with the outcome stored on the Server, and offers no start", () => {
      const { result } = endedWhileAway();
      render(<RunPanel run={result.current} server={server({})} />);
      const text = document.body.textContent ?? "";

      expect(text).toContain("ended while this log was disconnected");
      expect(text).toContain("finished");
      expect(text).toContain("Installing Docker");
      expect(text).not.toMatch(/run setup/i);
    });

    it("names a stored failure in the run's own words", () => {
      const { result } = endedWhileAway();
      render(
        <RunPanel
          run={result.current}
          server={server({
            setupOk: false,
            setupMessage: "Remote command failed with exit code 1",
          })}
        />,
      );
      const text = document.body.textContent ?? "";

      expect(text).toContain("failed");
      expect(text).toContain("Remote command failed with exit code 1");
    });
  });
});

/**
 * Follow-tail lives on the run's Live log, so the panel's well shows it
 * rather than keeping a flag of its own that a move would lose.
 */
describe("the setup run's following", () => {
  const server = { ipAddress: "203.0.113.10", username: "root" } as Server;

  it("is the Live log's: paused, the panel offers Follow output, and pressing it follows again", () => {
    const { result } = renderHook(() => useServerSetupRun("srv-1"), {
      wrapper: withQuery,
    });
    act(() => result.current.start());
    act(() => last().open());
    act(() => result.current.setFollowing(false));
    expect(result.current.following).toBe(false);

    const { rerender } = render(
      <RunPanel run={result.current} server={server} />,
    );
    act(() => {
      screen.getByRole("button", { name: "Follow output" }).click();
    });

    expect(result.current.following).toBe(true);
    rerender(<RunPanel run={result.current} server={server} />);
    expect(screen.queryByRole("button", { name: "Follow output" })).toBeNull();
  });
});
