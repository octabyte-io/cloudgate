import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DENIED_CLOSE_CODE,
  LEASE_CLOSE_CODE,
  MALFORMED_CLOSE_CODE,
  NO_SHELL_CLOSE_CODE,
  TERMINAL_CLOSE,
  UNREACHABLE_CLOSE_CODE,
  type TerminalStream,
} from "@/lib/realtime/gateways";

import { TerminalStatus } from "./terminal-status";

afterEach(cleanup);

/**
 * One sentence per *kind* of close, and the noun that names the far end.
 *
 * `socket-stream-store.ts` turns every code from 4000 to 4999 into
 * `status: "refused"`, and until this fix one sentence covered all of it bar
 * `4010`: "The Server refused this session: {reason}". So a failed SSH dial, a
 * key the far end would not accept, a key that was never generated and a request
 * the gateway threw out for being malformed all wore a refusal's words — and all
 * four said "The Server" even on the *This host* card, whose own header says the
 * machine has no Server row.
 *
 * `refusalSentence` is module-private, so these drive the component, which is
 * also the only thing that proves the `noun` reaches it.
 */
const stream = (snapshot: Partial<TerminalStream>): TerminalStream =>
  ({
    status: "refused",
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

const body = () => document.body.textContent ?? "";

describe("TerminalStatus", () => {
  it("says the shell is still opening on an open socket, not the session's footer", () => {
    render(
      <TerminalStatus
        stream={stream({ status: "open" })}
        footer="Typed straight into the Server."
        noun="the Server"
      />,
    );
    expect(body()).toContain("Opening a shell on the Server.");
    expect(body()).not.toContain("Typed straight into");
  });

  it("shows the footer once the shell is open", () => {
    render(
      <TerminalStatus
        stream={stream({ status: "open", shellOpen: true })}
        footer="Typed straight into the Server."
        noun="the Server"
      />,
    );
    expect(body()).toContain("Typed straight into the Server.");
  });

  /**
   * The table this issue's fix is: one row per close code, in the words the
   * operator reads. The gateway's own reason is never rewritten (ADR-0012 §18)
   * — what each sentence adds is the tense and the actor.
   */
  it.each([
    [
      "4000, a malformed parameter",
      MALFORMED_CLOSE_CODE,
      "containerId is required",
      "Cloudgate would not open this session: containerId is required. Opening it again with the same values will end the same way.",
    ],
    [
      "4003, the one denial frame",
      DENIED_CLOSE_CODE,
      "Not found or not permitted",
      "Not found or not permitted. Cloudgate answers the same way for a target that does not exist and one this session may not reach.",
    ],
    [
      "4010, a lease that ended mid-session",
      LEASE_CLOSE_CODE,
      "No longer authorized",
      "No longer authorized. The access it was opened with ended while the session was open — connecting again is authorized from scratch.",
    ],
    [
      "4400, a request that was wrong",
      TERMINAL_CLOSE.badRequest,
      "port must be a whole number from 1 to 65535",
      "Cloudgate would not open this session: port must be a whole number from 1 to 65535. Opening it again with the same values will end the same way.",
    ],
    [
      "4403, a role that may not have a host shell",
      TERMINAL_CLOSE.forbidden,
      "Only an owner or admin may open a shell on the platform host",
      "Only an owner or admin may open a shell on the platform host. That is a decision about your role on this instance, not a problem with this host.",
    ],
    [
      "4500, a dial that failed",
      TERMINAL_CLOSE.sshFailed,
      "ssh: connect ETIMEDOUT",
      "Cloudgate could not hold an SSH connection to this host: ssh: connect ETIMEDOUT",
    ],
    [
      "4501, a key the far end refused",
      TERMINAL_CLOSE.authFailed,
      "ssh: All configured authentication methods failed",
      "this host did not accept the key Cloudgate signed in with: ssh: All configured authentication methods failed. What to run to fix that is printed above the cursor.",
    ],
    [
      "4502, no key to dial with",
      TERMINAL_CLOSE.keyUnavailable,
      "no local SSH key on this host",
      "Cloudgate has no SSH key to reach this host with: no local SSH key on this host",
    ],
    [
      "4012, a machine that was never reached",
      UNREACHABLE_CLOSE_CODE,
      "This Server could not be reached",
      "This Server could not be reached. Nothing was judged: the session never opened, so this says neither that your access was refused nor that the container is gone.",
    ],
    [
      "4012, on the platform host rather than a Server",
      UNREACHABLE_CLOSE_CODE,
      "The platform host could not be reached",
      "The platform host could not be reached. Nothing was judged: the session never opened, so this says neither that your access was refused nor that the container is gone.",
    ],
    [
      "4404, an image with no shell",
      NO_SHELL_CLOSE_CODE,
      "This image has no shell to open: sh is not in it",
      "This image has no shell to open: sh is not in it. Some images carry none at all — distroless ones, and those built from scratch — so connecting again will end the same way.",
    ],
  ])("says what happened on %s", (_name, code, reason, sentence) => {
    render(
      <TerminalStatus
        stream={stream({ closeCode: code, closeReason: reason })}
        noun="this host"
      />,
    );

    expect(screen.getByText(sentence)).toBeTruthy();
    // The defect being fixed, asserted as an absence: every one of these codes
    // rendered "The Server refused this session" before, including on the card
    // whose header says the machine has no Server row.
    expect(body()).not.toContain("The Server refused this session");
  });

  /**
   * `4012` against `4003`, because the pairing is what the gateway added and the
   * console had not spent: an unreachable machine's socket closed `4003` and
   * therefore read as *"Cloudgate answers the same way for a target that does
   * not exist and one this session may not reach"* — an authorization claim
   * about a resolution that never ran. Compared to each other rather than to a
   * literal, since the property is that they differ.
   */
  it("does not say a never-reached session was judged", () => {
    const sentenceFor = (code: number, reason: string) => {
      cleanup();
      render(
        <TerminalStatus
          stream={stream({ closeCode: code, closeReason: reason })}
          noun="the container"
        />,
      );
      return body();
    };

    const unreachable = sentenceFor(
      UNREACHABLE_CLOSE_CODE,
      "This Server could not be reached",
    );
    const denied = sentenceFor(
      DENIED_CLOSE_CODE,
      "Not found or not permitted",
    );

    expect(unreachable).not.toBe(denied);
    expect(unreachable).toContain("Nothing was judged");
    // The denial's claim, which is the sentence this used to wear.
    expect(unreachable).not.toContain("may not reach");
    expect(unreachable).not.toContain("does not exist");
    expect(denied).toContain("may not reach");
  });

  /**
   * Finding 3. The four `/terminal`-only codes plus the ended sentence are the
   * ones that name the machine, and the negative is the assertion: on the
   * platform host's card the word "Server" must not appear at all.
   */
  it.each([
    ["refused", TERMINAL_CLOSE.forbidden],
    ["refused", TERMINAL_CLOSE.sshFailed],
    ["refused", TERMINAL_CLOSE.authFailed],
    ["refused", TERMINAL_CLOSE.keyUnavailable],
    ["closed", null],
  ] as const)(
    "calls the platform host 'this host' and never a Server (%s, %s)",
    (status, code) => {
      render(
        <TerminalStatus
          stream={stream({ status, closeCode: code, closeReason: "nope" })}
          noun="this host"
        />,
      );

      expect(body()).toContain("this host");
      expect(body()).not.toContain("Server");
    },
  );

  it.each([
    ["refused", TERMINAL_CLOSE.forbidden],
    ["refused", TERMINAL_CLOSE.sshFailed],
    ["refused", TERMINAL_CLOSE.authFailed],
    ["refused", TERMINAL_CLOSE.keyUnavailable],
    ["closed", null],
  ] as const)(
    "calls a registered Server the Server and never a host (%s, %s)",
    (status, code) => {
      render(
        <TerminalStatus
          stream={stream({ status, closeCode: code, closeReason: "nope" })}
          noun="the Server"
        />,
      );

      expect(body()).toContain("the Server");
      expect(body()).not.toContain("host");
    },
  );

  it("says the session has ended without claiming it was refused", () => {
    // `1000` and `1005` land on `status: "closed"` and never reach
    // `refusalSentence` — the shell exited, or the socket was closed codelessly
    // (ADR-0008, ADR-0010), and neither is a refusal.
    render(
      <TerminalStatus
        stream={stream({ status: "closed", closeCode: null })}
        noun="the container"
      />,
    );

    expect(
      screen.getByText(
        "This session has ended. Nothing you type now reaches the container.",
      ),
    ).toBeTruthy();
  });

  it("quotes an unmapped code and claims nothing about it", () => {
    // The `default` arm, covered rather than assumed: a seventh code added to
    // either gateway gets the gateway's own words and no story bolted on.
    render(
      <TerminalStatus
        stream={stream({ closeCode: 4999, closeReason: "something new" })}
        noun="the Server"
      />,
    );

    expect(screen.getByText("something new")).toBeTruthy();
    expect(body()).not.toContain("refused this session");
    expect(body()).not.toContain("SSH");
  });

  it("still has something to say when the gateway sent no reason", () => {
    // A close code with an empty reason is what a proxy leaves behind, and the
    // fallbacks must not render "undefined" or an empty sentence.
    render(
      <TerminalStatus
        stream={stream({ closeCode: TERMINAL_CLOSE.sshFailed })}
        noun="the Server"
      />,
    );

    expect(
      screen.getByText(
        "Cloudgate could not hold an SSH connection to the Server.",
      ),
    ).toBeTruthy();
  });

  /**
   * An image with no shell is the one ended session a second dial cannot fix,
   * and its own sentence says so — so it offers no button that would only end
   * the same way. Every other ended session keeps "Connect again".
   */
  it("offers no Connect again when the image has no shell", () => {
    render(
      <TerminalStatus
        stream={stream({
          closeCode: NO_SHELL_CLOSE_CODE,
          closeReason: "This image has no shell to open: sh is not in it",
        })}
        noun="the container"
      />,
    );

    expect(screen.queryByRole("button", { name: /connect again/i })).toBeNull();
  });

  it("still offers Connect again after a shell that exited", () => {
    render(
      <TerminalStatus
        stream={stream({
          status: "closed",
          closeCode: TERMINAL_CLOSE.shellClosed,
        })}
        noun="the container"
      />,
    );

    expect(
      screen.getByRole("button", { name: /connect again/i }),
    ).toBeTruthy();
  });
});
