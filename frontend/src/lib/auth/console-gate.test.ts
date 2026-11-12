import { describe, expect, it } from "vitest";

import { ApiError } from "@/lib/api/api-error";
import { errorMessage } from "@/lib/api/error-message";

import { BANNED_SENTENCE } from "./auth-error";
import {
  consoleGate,
  membershipVerdict,
  sessionVerdict,
} from "./console-gate";

/**
 * The one layout guard §3.7 permits, and the only part of the dead-session exit
 * that is pure logic rather than a browser: three facts in, one of three
 * outcomes out.
 *
 * Worth pinning because both of the ways to get it wrong are silent. Too eager
 * and it signs out a live session over a dropped connection — nobody reproduces
 * that on purpose. Too shy and the dead-session loop comes straight back: a
 * stale cookie, an empty console, and skeletons that never resolve.
 */

const LIVE = { present: true, pending: false, failure: null };
const NO_SESSION = { present: false, pending: false, failure: null };

describe("sessionVerdict", () => {
  it("holds while the session read is still in flight", () => {
    // Also every server render: the auth client fetches only once it is mounted
    // in a browser, so this is the verdict the streamed HTML is built from.
    expect(
      sessionVerdict({ present: false, pending: true, failure: null }),
    ).toBe("pending");
  });

  it("reads a session that arrived as present", () => {
    expect(sessionVerdict(LIVE)).toBe("present");
  });

  it("calls an answer of no session a dead session", () => {
    expect(sessionVerdict(NO_SESSION)).toBe("absent");
  });

  it("calls a 401 from the session read a dead session", () => {
    expect(
      sessionVerdict({
        present: false,
        pending: false,
        failure: { status: 401 },
      }),
    ).toBe("absent");
  });

  it("refuses to call a failed session read a dead session", () => {
    // better-auth keeps the last `data` and sets `error` when the read throws or
    // answers 5xx, so a backend restart looks exactly like "no session" from the
    // outside. Signing someone out for it would end a session that is fine.
    expect(
      sessionVerdict({
        present: false,
        pending: false,
        failure: { status: 503 },
      }),
    ).toBe("unknown");
    expect(
      sessionVerdict({ present: false, pending: false, failure: {} }),
    ).toBe("unknown");
  });

  /**
   * A banned account. The backend refuses a banned account's session read with
   * a **403** and better-auth's `BANNED_USER`, so without the code this would
   * land in `unknown` — the branch that deliberately paints. A 403 on its own
   * still must: it is what a role refusal looks like, and the dead-session
   * lesson is that signing someone out for a refusal that is not about their
   * session is the expensive mistake.
   */
  it("calls a banned session read a ban rather than a failed read", () => {
    expect(
      sessionVerdict({
        present: false,
        pending: false,
        failure: { status: 403, code: "BANNED_USER" },
      }),
    ).toBe("banned");
    expect(
      sessionVerdict({
        present: false,
        pending: false,
        failure: { status: 403, code: "FORBIDDEN" },
      }),
    ).toBe("unknown");
  });

  /**
   * The ordering that makes the branch reachable at all, and it is a fact about
   * better-auth rather than a preference. Its session atom clears the cached
   * `data` only for a 401 (`client/session-atom.ts`), so the tab that was signed
   * in when the ban landed keeps answering `present` on every refetch afterwards
   * — which is exactly the tab this exists for.
   */
  it("calls a ban a ban even while the last good session is still cached", () => {
    expect(
      sessionVerdict({
        present: true,
        pending: false,
        failure: { status: 403, code: "BANNED_USER" },
      }),
    ).toBe("banned");
  });
});

describe("consoleGate", () => {
  it("paints the console while the session is still loading", () => {
    expect(consoleGate("pending", "pending", "/servers")).toEqual({
      kind: "console",
    });
  });

  it("paints the console for a live session", () => {
    expect(consoleGate("present", "pending", "/servers")).toEqual({
      kind: "console",
    });
  });

  it("paints the console when the session read failed rather than refused", () => {
    expect(consoleGate("unknown", "pending", "/servers")).toEqual({
      kind: "console",
    });
  });

  /**
   * A ban, and the sentence is the half that matters. A banned operator used to
   * keep the whole console and read "Your role in this Organization does not
   * allow this" over every empty card — an answer that sends them to ask an
   * owner for a role change that would fix nothing. EXPIRED_MESSAGE would be the
   * same error one step quieter: the session did not end, the account was turned
   * off.
   */
  it("leaves for sign-in with the ban named when the account is banned", () => {
    expect(consoleGate("banned", "pending", "/servers")).toEqual({
      kind: "leaving",
      to: "/sign-in",
      message: BANNED_SENTENCE,
    });
  });

  /**
   * H-49: one sentence for one fact, across two files that never speak to each
   * other. This guard had its own longer wording for the ban, and it is read by
   * the same person seconds before the sign-in screen renders `AUTH_SENTENCES`'
   * — better-auth refuses the next sign-in with the same ban, so the second
   * reading is not hypothetical, it is the very next thing that happens.
   *
   * Asserted as an identity rather than against a literal on purpose. A test
   * naming the sentence twice passes when the two copies drift apart, which is
   * the whole of what this pins.
   */
  it("says what the sign-in screen will say about the same ban", () => {
    const gate = consoleGate("banned", "pending", "/servers");

    expect(gate.kind === "leaving" && gate.message).toBe(
      errorMessage(
        new ApiError(403, "This account is banned", { code: "BANNED_USER" }),
      ),
    );
  });

  /**
   * The one branch that does not wait on the instance claim, and the reason is
   * mechanical rather than stylistic: `shell/dead-session-exit.tsx` only starts
   * that read once the verdict is `absent`, so a ban that waited for it would
   * hold the frame for ever. Nothing about who owns this instance bears on a
   * banned account anyway — it exists, and it is turned off.
   */
  it("leaves on a ban without waiting to hear who owns the instance", () => {
    for (const claim of ["pending", "unclaimed", "claimed"] as const) {
      expect(consoleGate("banned", claim, "/servers")).toMatchObject({
        kind: "leaving",
        to: "/sign-in",
      });
    }
  });

  /**
   * No `?next=`, unlike the expired branch. Signing in again is refused with the
   * same ban, so the parameter would only survive to be discarded — and the
   * deep path must not leak into the URL of a screen the person is about to be
   * turned away from a second time.
   */
  it("carries nothing back into sign-in from a deep path when banned", () => {
    expect(consoleGate("banned", "claimed", "/servers/abc/logs")).toMatchObject(
      { to: "/sign-in" },
    );
  });

  it("holds the frame before the instance has answered", () => {
    expect(consoleGate("absent", "pending", "/servers")).toEqual({
      kind: "waiting",
    });
  });

  it("leaves for the sign-up screen when this instance has no owner yet", () => {
    expect(consoleGate("absent", "unclaimed", "/servers")).toEqual({
      kind: "leaving",
      to: "/sign-up",
      message: "This instance has no owner yet. Taking you to set it up.",
    });
  });

  it("sends an unclaimed instance to sign-up with no query string, from anywhere", () => {
    // The other half of "No `?next=`", and the half that is unqualified:
    // there is genuinely nothing to come back to on an instance nobody owns, so
    // no path — however deep — may put a parameter on this destination.
    for (const at of ["/", "/servers", "/servers/abc/logs?tail=200#line-4"]) {
      expect(consoleGate("absent", "unclaimed", at)).toMatchObject({
        to: "/sign-up",
      });
    }
  });

  it("carries where they were into sign-in when the instance is claimed", () => {
    // The dead-session triage said "No `?next=`". That governs the unclaimed
    // branch above and was superseded here: the reason it gave was the loop,
    // and the loop is the *cookie's* — `src/proxy.ts` reads presence, so a
    // redirect with a dead cookie still set bounces back to `/`. The exit ends
    // the session before it navigates, so the parameter is safe on this branch
    // and is not on that one. Do not "fix" this test to match that triage;
    // read `console-gate.ts`'s comment on the return, and
    // `end-session.test.ts` for what it leans on.
    expect(consoleGate("absent", "claimed", "/servers")).toEqual({
      kind: "leaving",
      to: "/sign-in?next=%2Fservers",
      message: "This session has ended. Taking you back to sign in.",
    });
  });

  it("carries a deep console path into sign-in, which is safe only because the exit has already ended the session", () => {
    expect(consoleGate("absent", "claimed", "/servers/abc/logs")).toMatchObject(
      { to: "/sign-in?next=%2Fservers%2Fabc%2Flogs" },
    );
  });

  it("drops the next parameter when they were at the console home", () => {
    expect(consoleGate("absent", "claimed", "/")).toMatchObject({
      to: "/sign-in",
    });
  });
});

/**
 * A session whose user was removed from its active Organization.
 * The session is perfectly good — only its Organization is not theirs any more
 * — so this never ends it; it replaces the shell with a screen that says so and
 * offers the way out.
 *
 * Both ways of being wrong are loud this time, which is why the verdict waits
 * for a *second* read of the list before it says "removed". better-auth's
 * membership list is only refetched off its own signal, and nothing raises it
 * after an invitation is accepted or an Organization is switched to — so a
 * list that does not name the active Organization is, on its own, just as
 * likely to be a list that is behind.
 */
describe("membershipVerdict", () => {
  it("has nothing to say before the list has answered", () => {
    expect(
      membershipVerdict({ organizationId: "a", memberOf: null, confirmed: false }),
    ).toBe("unknown");
  });

  it("calls a session with no active Organization unchosen once the list has answered", () => {
    // Sign-in settles it, but a bookmark or a new tab skips sign-in.
    expect(
      membershipVerdict({
        organizationId: null,
        memberOf: ["a", "b"],
        confirmed: false,
      }),
    ).toBe("unchosen");
    // No memberships at all is the same screen's "No organization yet".
    expect(
      membershipVerdict({ organizationId: null, memberOf: [], confirmed: true }),
    ).toBe("unchosen");
  });

  it("waits for the list before calling a session unchosen", () => {
    expect(
      membershipVerdict({ organizationId: null, memberOf: null, confirmed: false }),
    ).toBe("unknown");
  });

  it("reads an active Organization the list names as a membership", () => {
    expect(
      membershipVerdict({
        organizationId: "a",
        memberOf: ["a", "b"],
        confirmed: false,
      }),
    ).toBe("member");
  });

  it("does not believe a list that may be behind", () => {
    expect(
      membershipVerdict({ organizationId: "a", memberOf: ["b"], confirmed: false }),
    ).toBe("unconfirmed");
  });

  it("calls it a removal once a fresh read of the list agrees", () => {
    expect(
      membershipVerdict({ organizationId: "a", memberOf: ["b"], confirmed: true }),
    ).toBe("removed");
  });

  it("calls it a removal with no memberships left at all", () => {
    expect(
      membershipVerdict({ organizationId: "a", memberOf: [], confirmed: true }),
    ).toBe("removed");
  });
});

describe("consoleGate, for a session its Organization no longer has", () => {
  it("replaces the console, and does not end the session", () => {
    expect(consoleGate("present", "pending", "/projects", "removed")).toEqual({
      kind: "not-a-member",
    });
  });

  it("paints the console while the removal is unconfirmed", () => {
    expect(
      consoleGate("present", "pending", "/projects", "unconfirmed"),
    ).toEqual({ kind: "console" });
  });

  it("lets a ban win over a removal", () => {
    expect(consoleGate("banned", "pending", "/", "removed")).toMatchObject({
      kind: "leaving",
    });
  });

  it("lets a dead session win over a removal", () => {
    expect(consoleGate("absent", "claimed", "/", "removed")).toMatchObject({
      kind: "leaving",
    });
  });
});

/**
 * **A session in no Organization is sent to choose one**.
 *
 * The backend leaves a member of several Organizations with no default in none,
 * and sign-in asks. Anything that reaches the console without passing sign-in —
 * a bookmark, a second tab, Back — painted a frame whose every read waits on
 * that id: skeletons for ever and a nameless switcher.
 */
describe("consoleGate, for a session in no Organization", () => {
  it("leaves for /select-organization carrying where they were, without ending the session", () => {
    expect(
      consoleGate("present", "pending", "/projects/p_1", "unchosen"),
    ).toEqual({
      kind: "choosing",
      to: "/select-organization?next=%2Fprojects%2Fp_1",
    });
  });

  it("drops the next parameter from the console home", () => {
    expect(consoleGate("present", "pending", "/", "unchosen")).toEqual({
      kind: "choosing",
      to: "/select-organization",
    });
  });

  it("never sends /select-organization to itself", () => {
    expect(
      consoleGate("present", "pending", "/select-organization", "unchosen"),
    ).toEqual({ kind: "console" });
  });

  it("lets a dead session win over choosing", () => {
    expect(consoleGate("absent", "claimed", "/", "unchosen")).toMatchObject({
      kind: "leaving",
    });
  });
});
