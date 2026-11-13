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

import { TerminalStatus } from "@/components/console/terminal-status";
import type { Database } from "@/lib/api/endpoints/databases";
import type { Deployment } from "@/lib/api/endpoints/deployments";
import { ContainerOutput } from "@/features/compose/logs/container-output";
import { ContainerLog } from "@/features/database/container-log";
import { LiveReadings } from "@/features/monitoring/live/live-readings";
import {
  HOST,
  liveTargetCopy,
} from "@/features/monitoring/live/target-options";
import { RunPanel } from "@/features/server/infrastructure/setup-run-panel";
import { useServerSetupRun } from "@/features/server/use-server";
import type { Server } from "@/lib/api/endpoints/servers";

import { SocketStreamStore } from "./socket-stream-store";
import { useServerTerminal } from "./terminals";

vi.mock("@/lib/auth/client", async (original) => ({
  ...(await original<typeof import("@/lib/auth/client")>()),
  useActiveOrganizationId: () => ({ organizationId: "org-1" }),
}));

const { DeploymentLog } = await import(
  "@/features/application/deploy/deployment-log"
);

/**
 * A socket the browser will not even construct.
 *
 * A console served over `https://` with an `http://` `CLOUDGATE_API_URL` makes
 * `new WebSocket(url)` throw `SecurityError` synchronously — there is no socket,
 * so no `close` event, and the throw left `open()` from inside an effect and
 * took the whole screen to the error boundary. The stub below is that throw.
 */
class UnconstructableSocket {
  static readonly OPEN = 1;
  constructor() {
    throw new DOMException(
      "Failed to construct 'WebSocket': An insecure WebSocket connection may not be initiated from a page loaded over HTTPS.",
      "SecurityError",
    );
  }
}

let dials = 0;

beforeEach(() => {
  dials = 0;
  vi.stubGlobal(
    "WebSocket",
    class extends UnconstructableSocket {
      constructor() {
        dials += 1;
        super();
      }
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/**
 * The words every card shares for it: *the browser* would not open the
 * connection. Not "closed" — that is a stream that ended — and not "refused",
 * which every card words as the gateway's decision about a role or a parameter.
 * A review of the first fix caught it saying "Stream closed", identical to a
 * finished build.
 */
const BLOCKED = /This browser would not open the live connection/;

function withQuery(children: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("SocketStreamStore, when the socket cannot be constructed", () => {
  it("settles on blocked instead of throwing", () => {
    const store = new SocketStreamStore(100);

    expect(() => store.open("ws://api.example:4000/terminal")).not.toThrow();
    expect(store.getSnapshot().status).toBe("blocked");
  });

  it("does not back off and dial again, because the refusal is permanent", () => {
    vi.useFakeTimers();
    const store = new SocketStreamStore(100);

    store.open("ws://api.example:4000/terminal");
    vi.advanceTimersByTime(60_000);

    expect(dials).toBe(1);
  });

  it("settles on blocked again when asked to reconnect", () => {
    const store = new SocketStreamStore(100);
    store.open("ws://api.example:4000/terminal");

    expect(() => store.reconnect()).not.toThrow();
    expect(store.getSnapshot().status).toBe("blocked");
    expect(dials).toBe(2);
  });
});

/**
 * Every consumer of `SocketStatus`, each through its real hook where it has one,
 * so a card that forgets the state fails here rather than in a browser on an
 * https console.
 */
describe("a live card whose socket cannot be constructed", () => {
  it("the deploy log says the browser would not connect, and the page around it still renders", () => {
    const building = {
      deploymentId: "dep-1",
      status: "running",
      title: "Deploy hello-world",
      createdAt: "2026-01-01T00:00:00.000Z",
      startedAt: null,
    } as unknown as Deployment;

    render(
      withQuery(
        <>
          <button type="button">Stop</button>
          <DeploymentLog deployment={building} />
        </>,
      ),
    );

    expect(dials).toBe(1);
    expect(document.body.textContent).toMatch(BLOCKED);
    expect(document.body.textContent).toContain("The build is unaffected");
    expect(document.body.textContent).not.toContain("Stream closed");
    expect(screen.getByText("Deploy hello-world")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
  });

  it("the terminal says so, and that nothing reached the far end", () => {
    function Harness() {
      const stream = useServerTerminal({ serverId: "srv-1" });
      return <TerminalStatus stream={stream} noun="ui-self" />;
    }
    render(<Harness />);

    expect(document.body.textContent).toMatch(BLOCKED);
    expect(document.body.textContent).toContain("Nothing was sent to ui-self");
    expect(document.body.textContent).not.toContain("session has ended");
  });

  it("the live readings say so, not that the stats stream closed", () => {
    render(
      <LiveReadings
        sample={null}
        status="blocked"
        closeReason={null}
        closeCode={null}
        ended={false}
        unmeasured={false}
        copy={liveTargetCopy(HOST)}
        thresholds={null}
      />,
    );

    expect(document.body.textContent).toMatch(BLOCKED);
    expect(document.body.textContent).not.toContain("closed");
  });

  it("a container's output says so, not \"Not connected.\"", () => {
    render(
      <ContainerOutput containerId="c-1" serverId={null} label="Output" />,
    );

    expect(document.body.textContent).toMatch(BLOCKED);
    expect(document.body.textContent).not.toContain("Not connected.");
  });

  it("a never-deployed database says so and dials nothing", () => {
    const database = {
      appName: "pg-1",
      serverId: null,
      applicationStatus: "idle",
    } as unknown as Database;
    render(withQuery(<ContainerLog database={database} />));

    expect(document.body.textContent).toContain("Not deployed yet");
    expect(document.body.textContent).not.toContain("closed the connection");
    expect(dials).toBe(0);
  });

  it("a database's log says so, not \"Not connected.\"", () => {
    const database = {
      appName: "pg-1",
      serverId: null,
      applicationStatus: "done",
    } as unknown as Database;
    render(withQuery(<ContainerLog database={database} />));

    expect(document.body.textContent).toMatch(BLOCKED);
    expect(document.body.textContent).not.toContain("Not connected.");
  });

  it("a Server setup run reports that it never started, not that its output was lost", () => {
    // `/listen-server-setup` starts the run by being opened, so a socket that
    // was never constructed started nothing — "the run carries on on the
    // machine" (`interrupted`) would be false.
    const { result } = renderHook(() => useServerSetupRun("srv-1"), {
      wrapper: ({ children }) => withQuery(children),
    });
    act(() => result.current.start());

    expect(result.current.state).toBe("blocked");

    const server = { ipAddress: "10.0.0.1", username: "root" } as Server;
    render(<RunPanel run={result.current} server={server} />);
    expect(document.body.textContent).toMatch(BLOCKED);
    expect(document.body.textContent).toContain("Nothing was run on the machine");
    expect(document.body.textContent).not.toContain("carries on");
  });
});
