import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { lastReach, lastSetup, type Server } from "@/lib/api/endpoints/servers";

/**
 * What the Infrastructure tab says about reaching this Server and about
 * its last setup run is read off the row, so it survives leaving the tab.
 *
 * The two hooks that talk to the machine are the boundary, held idle — which is
 * exactly the state a freshly mounted tab is in, and the one that used to say
 * "Nothing has been checked yet" and "Run setup" whatever had happened before.
 */
const setupRun = vi.hoisted(() => ({ watch: vi.fn(), start: vi.fn() }));
vi.mock("../use-server", async (original) => ({
  ...(await original<typeof import("../use-server")>()),
  useValidateServer: () => ({
    mutate: vi.fn(),
    isPending: false,
    isSuccess: false,
    isError: false,
    error: null,
    submittedAt: 0,
  }),
  useServerSetupRun: () => ({
    state: "idle",
    lines: [],
    dropped: 0,
    connection: "idle",
    reason: null,
    start: setupRun.start,
    watch: setupRun.watch,
  }),
}));

const { ReachabilityCard } = await import("./reachability-card");
const { SetupCard } = await import("./setup-card");

const AN_HOUR_AGO = new Date(Date.now() - 60 * 60_000).toISOString();

const never = {
  reachCheckedAt: null,
  reachOk: null,
  reachMessage: null,
  setupRanAt: null,
  setupOk: null,
  setupMessage: null,
};

const server = (stored: Partial<Server>) =>
  ({
    serverId: "srv-1",
    name: "vps-a",
    ipAddress: "203.0.113.10",
    port: 22,
    username: "root",
    sshKeyId: "key-1",
    command: "",
    ...never,
    ...stored,
  }) as unknown as Server;

afterEach(cleanup);

describe("lastReach and lastSetup", () => {
  it("are null for a Server Cloudgate never tried", () => {
    expect(lastReach(server({}))).toBeNull();
    expect(lastSetup(server({}))).toBeNull();
  });

  it("read a stored failure with its message", () => {
    expect(
      lastReach(
        server({
          reachCheckedAt: AN_HOUR_AGO,
          reachOk: false,
          reachMessage: "connect ECONNREFUSED 203.0.113.10:22",
        }),
      ),
    ).toEqual({
      ok: false,
      at: AN_HOUR_AGO,
      message: "connect ECONNREFUSED 203.0.113.10:22",
    });
  });
});

describe("ReachabilityCard", () => {
  it("shows the stored failure, in SSH's words, on a fresh mount", () => {
    render(
      <ReachabilityCard
        server={server({
          reachCheckedAt: AN_HOUR_AGO,
          reachOk: false,
          reachMessage: "connect ECONNREFUSED 203.0.113.10:22",
        })}
      />,
    );

    expect(screen.getByText(/Cloudgate could not reach it/)).toBeTruthy();
    expect(
      screen.getByText("connect ECONNREFUSED 203.0.113.10:22"),
    ).toBeTruthy();
    expect(screen.getByText("1 hour ago")).toBeTruthy();
    // The sentence this ticket was filed about.
    expect(screen.queryByText(/Nothing has been checked yet/)).toBeNull();
  });

  it("shows a stored reach as reached", () => {
    render(
      <ReachabilityCard
        server={server({ reachCheckedAt: AN_HOUR_AGO, reachOk: true })}
      />,
    );
    expect(
      screen.getByText(/Cloudgate reached it and ran a command/),
    ).toBeTruthy();
  });

  it("still says nothing was checked when nothing was", () => {
    render(<ReachabilityCard server={server({})} />);
    expect(screen.getByText(/Nothing has been checked yet/)).toBeTruthy();
  });
});

describe("SetupCard", () => {
  it("offers Run setup again and the failure after a reload", () => {
    render(
      <SetupCard
        server={server({
          setupRanAt: AN_HOUR_AGO,
          setupOk: false,
          setupMessage: "Remote command failed with exit code 1",
        })}
      />,
    );

    expect(
      screen.getByRole("button", { name: /Run setup again/ }),
    ).toBeTruthy();
    expect(screen.getByText(/The last setup run failed/)).toBeTruthy();
    expect(
      screen.getByText("Remote command failed with exit code 1"),
    ).toBeTruthy();
  });

  describe("on a Bought Server", () => {
    it("watches the first run the backend started, and offers no press while it is Setting up", () => {
      setupRun.watch.mockClear();
      render(
        <SetupCard
          server={server({
            boughtServer: {
              stage: "setting_up",
              deletesOn: null,
              deletedAt: null,
            },
          })}
        />,
      );

      // A watch-dial, never a start: Buy was the press (ADR-0058, amended).
      expect(setupRun.watch).toHaveBeenCalledWith("setup:srv-1:first");
      expect(setupRun.start).not.toHaveBeenCalled();
      const button = screen.getByRole("button", { name: /Setting up/ });
      expect(button.getAttribute("aria-disabled")).toBe("true");
      expect(
        screen.getByText(/Cloudgate is setting this Server up by itself/),
      ).toBeTruthy();
    });

    it("shows a failed first run as the ordinary Setup failed, with Run setup again", () => {
      setupRun.watch.mockClear();
      render(
        <SetupCard
          server={server({
            boughtServer: { stage: "ready", deletesOn: null, deletedAt: null },
            setupRanAt: AN_HOUR_AGO,
            setupOk: false,
            setupMessage: "E: Unable to locate package docker-ce",
          })}
        />,
      );

      expect(setupRun.watch).not.toHaveBeenCalled();
      const button = screen.getByRole("button", { name: /Run setup again/ });
      expect(button.getAttribute("aria-disabled")).not.toBe("true");
      expect(screen.getByText(/The last setup run failed/)).toBeTruthy();
      expect(
        screen.getByText("E: Unable to locate package docker-ce"),
      ).toBeTruthy();
      expect(screen.queryByText(/setting this Server up by itself/)).toBeNull();
    });
  });

  it("says Run setup, and nothing about a last run, when setup never ran", () => {
    render(<SetupCard server={server({})} />);

    expect(screen.getByRole("button", { name: /^Run setup$/ })).toBeTruthy();
    expect(screen.queryByText(/The last setup run/)).toBeNull();
  });
});
