import { BANNED_SENTENCE } from "./auth-error";
import {
  SELECT_ORGANIZATION_PATH,
  SIGN_IN_PATH,
  SIGN_UP_PATH,
  signInWithNext,
  withNext,
} from "./routes";

/**
 * Whether the console shell may paint, decided from the session and — only when
 * the session is gone — from whether this instance has an owner yet.
 *
 * This is the whole of the one layout guard `CODING_STANDARDS.md` §3.7 permits,
 * pulled out of the component so the decision can be read as a table and tested
 * as one. It is pure on purpose: the inputs are three facts, the output is one of
 * three outcomes, and the component around it does nothing but supply the facts
 * and carry out the outcome.
 *
 * **The second thing that broke**
 * a *banned*
 * account kept a working console. This guard acted only on `absent`, which
 * means the session read answered 401 — so a refusal of any other status was
 * `unknown`, and `unknown` deliberately paints. The backend was refusing
 * correctly the whole time (`/servers` and `/projects` both 403), but the read
 * this guard gates on was not one of the readers that knew about the ban, and
 * the console rendered its full frame with "Your role in this Organization does
 * not allow this" over every empty card. The fix has two halves and needs both:
 * `backend/src/auth/ban.ts` makes the ban visible to `/api/auth/get-session`,
 * and the `banned` verdict below is what acts on it. A guard that acts only on
 * 401 cannot be told anything a 401 does not carry, which is why the signal is
 * a **code** rather than a status.
 *
 * **What broke**:
 * Chrome held a `better-auth.session_token` from an earlier run at the same
 * origin, against an instance whose database was empty. `src/proxy.ts` checks
 * cookie *presence, not validity* — deliberately, and it must stay that way — so
 * `/sign-up` was redirected to `/` and the console painted its full
 * authenticated frame: masthead, scope rail, ⌘K, a "This Organization" section.
 * The promise that made the optimistic check safe was that the first 401 would
 * correct it, and no 401 ever came: every shell and page query is
 * `enabled: organizationId !== null` (§3.5), and with no session there is no
 * organization, so **nothing fetched at all**. The Servers and Projects cards
 * held their skeletons for ever, and the one screen that could have fixed it —
 * `/sign-up`, on an instance with no owner — was the screen the gate had just
 * made unreachable.
 *
 * **Rejected: validating the cookie in `src/proxy.ts`.** That is a session lookup
 * in front of every navigation, which is the cost that layer exists not to pay,
 * and it is what its own docstring turns down. Also rejected: leaving it to the
 * 401 handler in `lib/api/query-client.ts`. It is the right place for a session
 * that dies *while* someone is working, because then something is fetching. It
 * cannot see a session that was already dead on arrival.
 *
 * **Rejected: a plain redirect.** The cookie is what `src/proxy.ts` reads, so a
 * redirect to `/sign-up` with the dead cookie still set is a loop — the gate
 * bounces them straight back to `/`. Ending the session is what makes the exit
 * hold, which is why §3.7 words the permission that way. It is also what
 * licenses the `?next=` on the expired branch below: the dead-session triage forbade the
 * parameter because a `next` pointing at the console is what turns the bounce
 * into a loop, and that hazard is the cookie's, not the parameter's. Both facts
 * rest on the same step, so they are written down together.
 */

/** What `useSession()` came back with, reduced to the facts that decide this. */
export type SessionRead = {
  /** A session arrived. */
  present: boolean;
  /**
   * `/get-session` has not answered yet. True on every server render too — the
   * auth client only fetches once it is mounted in a browser — which is what
   * keeps the shell in the streamed HTML rather than behind a round trip.
   */
  pending: boolean;
  /**
   * The refusal it answered with, or `null` when it answered at all.
   *
   * `code` is better-auth's, and it is the half that carries meaning — the
   * status alone cannot tell a banned account from an insufficient role, which
   * is the same reading `auth-error.ts` gives of the same surface. It is **not**
   * on better-fetch's declared error type and is there all the same: the
   * non-throwing path resolves to the parsed error body spread with `status` and
   * `statusText` (`@better-fetch/fetch` `betterFetch`), and better-auth's own
   * `AuthFailure` type in `auth-error.ts` already reads it that way. Not dead:
   * a `SessionRead` built from `useSession().error` carries it.
   */
  failure: { status?: number; code?: string } | null;
};

/**
 * The two verdicts this guard acts on are `absent` and `banned`, and they are
 * different facts: `absent` means the session read *answered* that there is no
 * session, `banned` means it answered that the account behind a perfectly good
 * session has been turned off.
 *
 * `unknown` is the distinction that keeps the guard from signing people out for
 * the wrong reason: better-auth's session atom keeps its last `data` and sets
 * `error` when the read throws or comes back 5xx, so a backend restart or a lost
 * connection also arrives as "no session data". A 401 is the session being gone;
 * anything else is the read having failed, and a failed read is not grounds for
 * ending a session that may still be perfectly good.
 */
export type SessionVerdict =
  | "pending"
  | "present"
  | "absent"
  | "banned"
  | "unknown";

/** `ApiError.isUnauthenticated`, for a refusal that never became an `ApiError`. */
const UNAUTHENTICATED = 401;

/**
 * better-auth's code for an account that has been banned, on both the endpoint
 * that refuses a *new* session (`plugins/admin/admin.mjs`) and the one the
 * backend added to refuse the sessions it already handed out
 * (`backend/src/auth/ban.ts`). One code, so this guard learns the fact once.
 */
const BANNED = "BANNED_USER";

export function sessionVerdict(read: SessionRead): SessionVerdict {
  // Before `present`, and that ordering is the whole of it
  // The refusal
  // is a **403**, because a banned account is not an unauthenticated one — and
  // better-auth's session atom only clears its cached `data` on a 401
  // (`client/session-atom.ts`), so a tab that was signed in when the ban landed
  // keeps answering `present` on every refetch afterwards. Reading `present`
  // first would paint the console over a refusal that had already arrived.
  if (read.failure?.code === BANNED) return "banned";
  if (read.pending) return "pending";
  if (read.present) return "present";
  if (read.failure !== null && read.failure.status !== UNAUTHENTICATED) {
    return "unknown";
  }
  return "absent";
}

/**
 * Whether anyone owns this instance yet — `GET /auth/sign-up-open`, read only
 * once the session is known to be gone.
 *
 * It is a much more actionable state than "your session expired": an instance
 * with no owner has nothing to sign in to, and the visitor's next move is to
 * claim it. `claimed` is also where a failed read lands, because sign-in is the
 * answer that is never wrong.
 */
export type InstanceClaim = "pending" | "unclaimed" | "claimed";

/**
 * Whether the session's user is still a member of the session's active
 * Organization.
 *
 * Removing a member does not end their sessions — `remove-member-modal.tsx`
 * tells the remover so, on purpose — so the removed person keeps a session
 * pointed at an Organization with no `member` row for them. Every screen was
 * refused, every refusal read as a role problem, the masthead lost the name and
 * the switcher kept offering the Organization they had just left.
 *
 * The facts are the session's active id and the ids better-auth's
 * `/organization/list` names, plus one more that is the whole difficulty:
 * **whether that list was read after the disagreement was seen.** The list is a
 * better-auth store refetched only off its `$listOrg` signal, and nothing raises
 * that after an invitation is accepted or an Organization is switched to, so a
 * list that does not name the active Organization is at least as likely to be
 * a list that is behind. Painting "you were removed" over somebody who has
 * just joined is the worse of the two mistakes, so a mismatch is only
 * `unconfirmed` — and paints — until a fresh read agrees.
 */
export type MembershipRead = {
  organizationId: string | null;
  /** The ids the membership list names, or `null` before it has answered. */
  memberOf: readonly string[] | null;
  /** The list has been read again since it stopped naming `organizationId`. */
  confirmed: boolean;
};

export type MembershipVerdict =
  | "unknown"
  | "member"
  | "unconfirmed"
  | "removed"
  | "unchosen";

export function membershipVerdict(read: MembershipRead): MembershipVerdict {
  if (read.memberOf === null) return "unknown";
  // A good session in no Organization. Sign-in settles this on
  // `/select-organization`, but a bookmark, a new tab or Back reaches the
  // console without passing through it — and every console read waits on the
  // id, so the frame would stand over skeletons for ever. With no memberships
  // at all it is the same screen's other state, "No organization yet".
  if (read.organizationId === null) return "unchosen";
  if (read.memberOf.includes(read.organizationId)) return "member";
  return read.confirmed ? "removed" : "unconfirmed";
}

export type ConsoleGate =
  /** Paint the shell. Nothing here says the visitor does not belong. */
  | { kind: "console" }
  /**
   * The session is good and its Organization is not theirs any more.
   * Replace the shell with the way out; do **not** end the session — it is the
   * one they will switch Organization with.
   */
  | { kind: "not-a-member" }
  /**
   * The session is good and in no Organization yet. Leave for `to`,
   * `/select-organization`, **without** ending the session — it is the one they
   * will choose with.
   */
  | { kind: "choosing"; to: string }
  /** The session is gone; hold the frame until we know where to send them. */
  | { kind: "waiting" }
  /** End the session and leave for `to`. `message` is what the wait says. */
  | { kind: "leaving"; to: string; message: string };

/**
 * The three sentences this guard can show, and it shows exactly one of them.
 *
 * Two of them are written here and the third is imported, and the split is not
 * arbitrary (H-49). These are **navigation-wait copy**: they hold the ground for
 * one round trip and their job is to say what is happening to the reader right
 * now, which is why both of the ones below end by naming the destination. That
 * is a different job from a refusal report, and a sentence written for one reads
 * badly in the other — so this file keeping its own words is the default, not a
 * lapse.
 *
 * The ban is the exception, and `BANNED_SENTENCE` is imported rather than
 * paraphrased. See the branch in `consoleGate` for why that one is not
 * navigation-wait copy at all.
 */
const UNCLAIMED_MESSAGE =
  "This instance has no owner yet. Taking you to set it up.";
/**
 * **Deliberately not `errorMessage()`'s sentence for a 401**, and not a
 * candidate for `AUTH_SENTENCES` — H-49 looked and this is the answer, so it
 * does not need looking at again.
 *
 * The paraphrase is real: `error-message.ts` answers a 401 with *"Your session
 * has ended. Sign in again to pick up where you left off."* and this says the
 * same fact. The two halves after the fact are what differ, and they are the
 * whole point. That one is said to somebody whose request failed **while they
 * were working**, and it asks them to do something. This one is said to somebody
 * the browser is **already taking** to the sign-in screen, and "sign in again"
 * is an instruction to do the thing being done to them. `?next=` is carrying the
 * screen they were on, so "pick up where you left off" is this branch's promise
 * to keep rather than its advice to give.
 *
 * There is also no code and no error here: nothing refused this guard. It read a
 * session, found none, and decided. `AUTH_SENTENCES` is keyed on a code that
 * arrived on the wire and there is no wire in this branch.
 */
const EXPIRED_MESSAGE = "This session has ended. Taking you back to sign in.";

/**
 * @param at The path they are on, so signing in finishes the navigation they
 *   started rather than dropping them at the console home.
 */
export function consoleGate(
  session: SessionVerdict,
  instance: InstanceClaim,
  at: string,
  membership: MembershipVerdict = "unknown",
): ConsoleGate {
  // A ban leaves at once, and it is the one branch that does not wait on
  // `instance`: the account exists, so whether anyone *owns* this
  // instance says nothing about where to send them, and the read that would
  // answer it is only started once the verdict is `absent`
  // (`shell/dead-session-exit.tsx`). Waiting for it would hold the frame for
  // ever.
  //
  // No `?next=`, and the reason is the unclaimed branch's rather than the
  // dead-session loop: there is nothing to come back to. Signing in again is
  // refused with the same ban (`plugins/admin/admin.mjs`), so a `next` would
  // only survive to be discarded — and if an owner does lift the ban, the
  // sign-in they make afterwards is a new decision about where to go, not the
  // resumption of a navigation from before they were banned.
  //
  // A sentence of its own, and that is still the point of the branch: a
  // banned operator used to keep a fully rendered console in which every card
  // refused with "Your role in this Organization does not allow this", and
  // EXPIRED_MESSAGE would be the same error one step quieter — their session did
  // not end, their account was turned off. What changed is *whose* sentence.
  //
  // `BANNED_SENTENCE`, and not a sentence of this file's own (H-49). This branch
  // used to carry *"This account has been banned, so it can no longer use this
  // instance. Ask an owner to lift the ban."* — the map's fact and the map's
  // move, with a clause in between, which is the shape H-29 exists to
  // stop. It is the one of these three that is **not** navigation-wait copy: it
  // names a fact about the account and the only move left, and it deliberately
  // does not say where the reader is being taken, because the answer is a
  // sign-in screen that will refuse them with this same ban. So it is a refusal
  // report, said by a guard that happens not to have an error object — and one
  // fact gets one sentence whether or not the reader is holding an `ApiError`.
  //
  // It is also the same person seconds apart: they read this on the way out and
  // read `AUTH_SENTENCES`' copy on their next sign-in attempt. H-29 fixed
  // exactly that shape on the backend's two ban surfaces; this was the console's.
  //
  // What the collapse costs is the clause "so it can no longer use this
  // instance", which explained why the console was vanishing. H-26 took the same
  // kind of reader-specific clause ("so it cannot sign in") out of the map for
  // the same reason, and the console going away is visible without being
  // narrated.
  if (session === "banned") {
    return { kind: "leaving", to: SIGN_IN_PATH, message: BANNED_SENTENCE };
  }

  // After the ban and before the paint. Only for a session that is
  // `present`: a membership says nothing about a session that is gone, and the
  // list read that decides it is the session's own.
  if (session === "present" && membership === "removed") {
    return { kind: "not-a-member" };
  }

  // After the removal, for the same reason, and with `?next=` so choosing
  // finishes the navigation they started. Never *from*
  // `/select-organization`: it lives outside this shell today, and this keeps a
  // move of it from becoming a redirect to itself.
  if (
    session === "present" &&
    membership === "unchosen" &&
    at !== SELECT_ORGANIZATION_PATH &&
    !at.startsWith(`${SELECT_ORGANIZATION_PATH}?`)
  ) {
    return { kind: "choosing", to: withNext(SELECT_ORGANIZATION_PATH, at) };
  }

  // `pending` and `unknown` both paint: the proxy saw a cookie, and optimism is
  // the whole design of that gate. Only an answer of "no session" overrides it.
  if (session !== "absent") return { kind: "console" };

  if (instance === "pending") return { kind: "waiting" };

  if (instance === "unclaimed") {
    // No `?next=`: they were sent to a console screen that does not exist yet on
    // an instance nobody owns, so there is nothing to come back to.
    return { kind: "leaving", to: SIGN_UP_PATH, message: UNCLAIMED_MESSAGE };
  }

  // This branch carries `?next=`, and it is a deliberate departure from the
  // dead-session triage ("No `?next=`"). That instruction's stated reason was
  // the loop: `src/proxy.ts` reads cookie *presence*, so leaving for `/sign-in`
  // with the dead cookie still set bounces straight back to `/`. This guard
  // ends the session before it navigates (`shell/dead-session-exit.tsx` ->
  // `lib/auth/end-session.ts`), so there is no cookie left to bounce off — and
  // `withNext` drops the parameter whenever it resolves to the console home,
  // which is the exact spelling the triage named. The other half of that
  // sentence, "nothing to come back to", is true of the unclaimed branch above
  // and false here: a claimed instance's expired session was on a real screen,
  // and losing that deep link costs something and buys nothing.
  //
  // If the exit ever stops ending the session first, this goes back to a bare
  // SIGN_IN_PATH. `lib/auth/end-session.test.ts` is what fails if it does.
  return { kind: "leaving", to: signInWithNext(at), message: EXPIRED_MESSAGE };
}
