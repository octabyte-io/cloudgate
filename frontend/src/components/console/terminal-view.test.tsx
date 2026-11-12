import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DENIED_CLOSE_CODE,
  NO_SHELL_CLOSE_CODE,
  TERMINAL_CLOSE,
  type TerminalStream,
} from "@/lib/realtime/gateways";

import { TerminalView } from "./terminal-view";

afterEach(cleanup);

/**
 * The header's pill says what happened to the session.
 *
 * It knew two words, `running` while the socket was open and `idle` for
 * everything else — so a refused dial, a key the far end would not take and a
 * shell that exited all read as grey "idle", directly above a status line saying
 * the connection had failed.
 */
const stream = (snapshot: Partial<TerminalStream>): TerminalStream =>
  ({
    status: "closed",
    lines: [],
    following: true,
    closeReason: null,
    closeCode: null,
    dropped: 0,
    shellOpen: false,
    send: vi.fn(),
    setFollowing: vi.fn(),
    clear: vi.fn(),
    reconnect: vi.fn(),
    attach: vi.fn(),
    resize: vi.fn(),
    ...snapshot,
  }) as TerminalStream;

const pill = () =>
  document.querySelector('[data-slot="status-pill"]')?.textContent?.trim();

describe("TerminalView's pill", () => {
  it.each<[string, string, Partial<TerminalStream>]>([
    ["an open shell", "running", { status: "open", shellOpen: true }],
    // The socket opens before the SSH handshake has started.
    ["an open socket whose shell is not open yet", "pending", { status: "open" }],
    ["a session still dialling", "pending", { status: "connecting" }],
    ["a dropped session dialling again", "pending", { status: "reconnecting" }],
    [
      "a shell that exited",
      "done",
      { status: "closed", closeCode: TERMINAL_CLOSE.shellClosed },
    ],
    [
      "a dial that failed",
      "error",
      {
        status: "refused",
        closeCode: TERMINAL_CLOSE.sshFailed,
        closeReason: "ssh: connect ECONNREFUSED 127.0.0.1:1",
      },
    ],
    [
      "a key the far end refused",
      "error",
      { status: "refused", closeCode: TERMINAL_CLOSE.authFailed },
    ],
    [
      "an id this caller may not reach",
      "error",
      { status: "refused", closeCode: DENIED_CLOSE_CODE },
    ],
    [
      "an image with no shell",
      "error",
      { status: "refused", closeCode: NO_SHELL_CLOSE_CODE },
    ],
    [
      "a gateway that hung up without a code",
      "error",
      { status: "closed", closeCode: 1005 },
    ],
    ["a socket the browser would not open", "error", { status: "blocked" }],
    ["a session never dialled", "idle", { status: "closed", closeCode: null }],
  ])("reads %s as %s", (_name, expected, snapshot) => {
    render(
      <TerminalView
        stream={stream(snapshot)}
        target="web-1"
        grid={{ cols: 115, rows: 20 }}
        well={null}
        noun="the Server"
      />,
    );

    expect(pill()).toContain(expected);
  });
});
