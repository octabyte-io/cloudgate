import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  deploymentsApi,
  type Deployment,
} from "@/lib/api/endpoints/deployments";
import {
  LEASE_CLOSE_CODE,
  REAPED_LOG_CLOSE_CODE,
} from "@/lib/realtime/gateways";
import type { SocketStream } from "@/lib/realtime/use-socket-stream";

const useDeploymentLog = vi.hoisted(() => vi.fn());
const useActiveOrganizationId = vi.hoisted(() => vi.fn());

vi.mock("@/lib/realtime/gateways", async (original) => ({
  ...(await original<typeof import("@/lib/realtime/gateways")>()),
  useDeploymentLog,
}));

vi.mock("@/lib/auth/client", async (original) => ({
  ...(await original<typeof import("@/lib/auth/client")>()),
  useActiveOrganizationId,
}));

const { DeploymentLog } = await import("./deployment-log");

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useDeploymentLog.mockReset();
  useActiveOrganizationId.mockReset();
});

/**
 * What this view says when the stream stops, which for a
 * long time nothing asserted.
 *
 * An earlier change converted the three log views whose hints were connect-time
 * guesses to `LogRefusal`, and listed this fourth one as a **non-goal**: *"'The
 * build may still be running' stays true when a lease ends, so it needs no
 * gate."* It was converted anyway, with the sentence passed as `hint` — which
 * `LogRefusal` suppresses on a `4010`. So the one screen the gate was not
 * wanted on was the one that lost its sentence, and a live socket in a browser
 * was the only thing that had ever exercised the combination. This is that
 * non-goal as a test.
 *
 * A third case came later, and it is the one that made the sentence
 * conditional: the `4013` close
 * says the log was deleted for being past ADR-0020's window, and *"the build
 * may still be running — its output is written on the build Server"* is false
 * beside it. Two assertions hold that — the negative one, that the old sentence
 * is **not** there, and that what replaces it completes the elided close reason
 * rather than restating it.
 */

/** `pending` keeps `live` true, which is what puts the view on the socket. */
const BUILDING = {
  deploymentId: "dep-1",
  status: "pending",
  title: "Deploy hello-world",
  createdAt: "2026-01-01T00:00:00.000Z",
  startedAt: null,
} as unknown as Deployment;

const NOTE =
  "The build may still be running — its output is written on the build Server and read from there.";

function refusedWith(closeReason: string, closeCode: number) {
  return {
    lines: [],
    status: "refused",
    dropped: 0,
    closeReason,
    closeCode,
    following: true,
    send: () => false,
    setFollowing: () => {},
    clear: () => {},
    reconnect: () => {},
  } as unknown as SocketStream;
}

/**
 * `useQuery` at `deployment-log.tsx` runs on every render even though a live
 * Deployment leaves it `enabled: false`, so the provider is required whichever
 * branch is under test. `domains-card.test.tsx` is the same wrapper.
 */
function withQuery(children: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function said(stream: SocketStream): string {
  useActiveOrganizationId.mockReturnValue({ organizationId: "org-1" });
  useDeploymentLog.mockReturnValue(stream);
  render(withQuery(<DeploymentLog deployment={BUILDING} />));
  return document.body.textContent ?? "";
}

describe("DeploymentLog", () => {
  it("says the build may still be running when the stream is refused at connect", () => {
    const text = said(refusedWith("Not found or not permitted", 4003));

    expect(text).toContain("Not found or not permitted");
    expect(text).toContain(NOTE);
  });

  it("still says the build may still be running when an authorization lease ends", () => {
    // The conversion's non-goal, turned from prose into an assertion. A `4010`
    // is by construction a socket that *was* streaming, so the build being
    // alive is more likely here than anywhere — and this is the close on which
    // the sentence used to be withheld.
    const text = said(refusedWith("No longer authorized", LEASE_CLOSE_CODE));

    expect(text).toContain(NOTE);
    expect(text).toContain("authorized when it opened and is not any more");
  });

  it("stops saying the build may still be running when the log has been reaped", () => {
    // The reaped-log close, with the reason `closeFrameReason` actually
    // produces — the notice elided at a word boundary, byte-counted, which
    // drops the clause saying *this* Deployment is past the window and keeps
    // the rule. The backend half is pinned by `reaped-log-close.spec.ts`; what
    // is asserted here is that the console supplies the half the 123-byte cap
    // cut, and stops making the claim that contradicts it.
    const text = said(
      refusedWith(
        "This deployment's log is no longer on the machine that wrote it: Cloudgate keeps deployment logs for 90 days and this…",
        REAPED_LOG_CLOSE_CODE,
      ),
    );

    expect(text).toContain("keeps deployment logs for 90 days");
    expect(text).toContain("older than that window");
    expect(text).toContain("retention reaps the log, never the record");
    // The first job of the third case: the build is not still running, and its
    // output is not on the build host to be read from.
    expect(text).not.toContain(NOTE);
  });
});

/**
 * ANSI escapes at the component: both of this view's sources go through the
 * same strip, so neither a live build nor a finished one shows `[33m` as text.
 * The unit half, and the tone, is `log-tones.test.ts`.
 */
describe("DeploymentLog — terminal escapes", () => {
  const WARNING = "\x1b[33m1 warning found (use docker --debug to expand):";
  const CLEAN = "1 warning found (use docker --debug to expand):";

  it("renders a live build's coloured line without its escape", () => {
    said({
      lines: [WARNING],
      status: "open",
      dropped: 0,
      closeReason: null,
      closeCode: null,
    } as unknown as SocketStream);

    expect(screen.getByText(CLEAN)).toBeTruthy();
    expect(document.body.textContent).not.toContain("[33m");
  });

  it("renders a finished Deployment's log, read over HTTP, without its escapes", async () => {
    vi.spyOn(deploymentsApi, "readLogs").mockResolvedValue(
      `${WARNING}\n\x1b[0m - UndefinedVar: x\n`,
    );
    useActiveOrganizationId.mockReturnValue({ organizationId: "org-1" });
    useDeploymentLog.mockReturnValue({ lines: [], status: "closed" });
    render(
      withQuery(
        <DeploymentLog
          deployment={{ ...BUILDING, status: "done" } as Deployment}
        />,
      ),
    );

    expect(await screen.findByText(CLEAN)).toBeTruthy();
    expect(screen.getByText("- UndefinedVar: x")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/\[(0|33)m/);
  });
});

/**
 * Follow-tail lives on the Live log, so a log paused on its page is still
 * paused wherever it is read next. The well only shows it.
 */
describe("DeploymentLog — following", () => {
  function streaming(change: Partial<SocketStream>): SocketStream {
    return {
      lines: ["Step 1/4"],
      status: "open",
      dropped: 0,
      closeReason: null,
      closeCode: null,
      following: true,
      setFollowing: () => {},
      ...change,
    } as unknown as SocketStream;
  }

  it("shows Follow output while its Live log is paused, and pressing it follows again", () => {
    const setFollowing = vi.fn();
    said(streaming({ following: false, setFollowing }));

    fireEvent.click(screen.getByRole("button", { name: "Follow output" }));

    expect(setFollowing).toHaveBeenCalledWith(true);
  });

  it("shows no Follow output while its Live log is following", () => {
    said(streaming({ following: true }));

    expect(screen.queryByRole("button", { name: "Follow output" })).toBeNull();
  });
});
