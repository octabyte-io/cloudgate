import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OUTPUT_ENDED_CLOSE_CODE } from "@/lib/realtime/gateways";
import type { SocketStream } from "@/lib/realtime/use-socket-stream";

const useContainerLogs = vi.hoisted(() => vi.fn());

vi.mock("@/lib/realtime/gateways", async (original) => ({
  ...(await original<typeof import("@/lib/realtime/gateways")>()),
  useContainerLogs,
}));

const { ContainerOutput } = await import("./container-output");

afterEach(() => {
  cleanup();
  useContainerLogs.mockReset();
});

/**
 * What the output view says when the follower ends.
 *
 * A container that restarted ended its `docker logs --follow`, and the screen
 * kept reading `Following compose-…-web-1's output.` over a socket attached to
 * nothing. The gateway now closes `4014` with a sentence; this is the half that
 * has to turn it into an ending and not into "Following", nor into the refusal
 * box whose hint guesses at a connect this stream got past.
 */

const REASON = "The container's output ended: it stopped, restarted or was removed";

function stream(change: Partial<SocketStream>): SocketStream {
  return {
    lines: ["2026/09/15 13:27:27 Starting up on port 80"],
    status: "open",
    dropped: 0,
    closeReason: null,
    closeCode: null,
    following: true,
    send: () => false,
    setFollowing: () => {},
    clear: () => {},
    reconnect: vi.fn(),
    ...change,
  } as SocketStream;
}

function said(value: SocketStream): string {
  useContainerLogs.mockReturnValue(value);
  render(
    <ContainerOutput
      containerId="abc123"
      serverId={null}
      label="Output of web"
      describe="compose-2dtyio-web-1's output"
    />,
  );
  return document.body.textContent ?? "";
}

describe("ContainerOutput", () => {
  it("says it is following while the stream is open", () => {
    expect(said(stream({}))).toContain("Following compose-2dtyio-web-1's output.");
  });

  it("says the output ended, in the gateway's words, once the follower has exited", () => {
    const text = said(
      stream({
        status: "refused",
        closeReason: REASON,
        closeCode: OUTPUT_ENDED_CLOSE_CODE,
      }),
    );

    expect(text).toContain(`${REASON}. Reconnect to follow it again.`);
    expect(text).not.toContain("Following");
    expect(text).not.toContain("The gateway closed the connection.");
    // The refusal box's connect-time guess is not true of a stream that ran.
    expect(text).not.toContain("since this list was read");
    // What was already received stays on screen.
    expect(text).toContain("Starting up on port 80");
  });

  it("offers Reconnect on an ended stream, and it redials", () => {
    const value = stream({
      status: "refused",
      closeReason: REASON,
      closeCode: OUTPUT_ENDED_CLOSE_CODE,
    });
    said(value);

    screen.getByRole("button", { name: /reconnect/i }).click();

    expect(value.reconnect).toHaveBeenCalledTimes(1);
  });

  it("still reads a real refusal as one", () => {
    const text = said(
      stream({
        status: "refused",
        closeReason: "Not found or not permitted",
        closeCode: 4003,
      }),
    );

    expect(text).toContain("The gateway closed the connection.");
    expect(text).toContain("Not found or not permitted");
    expect(text).not.toContain("Reconnect to follow it again.");
  });
});
