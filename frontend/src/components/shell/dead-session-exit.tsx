"use client";

import { useQuery } from "@tanstack/react-query";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";

import { signUpOpen } from "@/lib/api/endpoints/auth";
import { keys } from "@/lib/api/keys";
import { useSession } from "@/lib/auth/client";
import {
  consoleGate,
  type InstanceClaim,
  sessionVerdict,
} from "@/lib/auth/console-gate";
import { useMembershipVerdict } from "@/lib/auth/membership";
import { useSignOut } from "@/lib/auth/use-sign-out";

import { NotAMember } from "./not-a-member";

/**
 * The console shell's dead-session exit — the one layout guard
 * `CODING_STANDARDS.md` §3.7 permits.
 *
 * `src/proxy.ts` checks cookie presence, not validity, on the understanding that
 * the first 401 corrects an expired one. Nothing under this shell sends a first
 * request: every query here and on every screen is
 * `enabled: organizationId !== null`, and with no session there is no
 * Organization — so a stale cookie painted the full authenticated frame,
 * masthead and rail and all, over skeletons that never resolved. This closes
 * exactly that gap and nothing wider. Anything a route can protect stays in the
 * proxy; **a second layout guard means the matcher was wrong.**
 *
 * `console-gate.ts` holds the decision and says what was rejected. What is left
 * here is the two halves that need React:
 *
 * 1. **Asking whether anyone owns this instance**, and only once the session is
 *    known to be gone — so the happy path costs no request. Not
 *    `useSignUpOpen`, which the auth screens use: that one *fails open* to the
 *    form, which is right for a screen offering to claim the instance and wrong
 *    here, where an unreachable backend must not be read as "nobody owns this".
 *    Same key (`keys.signUpOpen`), so the two share the cache entry — and,
 *    because their failure semantics are opposites, not the hook.
 * 2. **Ending the session** rather than merely redirecting. A redirect leaves the
 *    cookie set, and the cookie is what the proxy reads, so `/sign-up` would
 *    bounce straight back to `/` — the redirect that put them here to begin
 *    with. `useSignOut` does the three steps §3.7 names, with the destination the
 *    gate chose.
 *
 * The shell is *replaced* while that happens rather than left standing behind a
 * spinner: an authenticated frame is a claim about who is looking at it, and by
 * this point we know it is false.
 *
 * **One more fact, and it does not end the session**
 * A member
 * removed while signed in keeps a good session pointed at an Organization that
 * has no `member` row for them, and the frame is then a claim about *where*
 * they are that is just as false — every card refused with the role sentence,
 * the masthead nameless, the switcher offering the Organization they left.
 * `useMembershipVerdict` supplies that fact and `consoleGate` decides on it, so
 * this is still the one guard rather than a second one beside it; the frame is
 * replaced by `NotAMember`, whose way out is the session itself.
 */
export function DeadSessionExit({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const session = useSession();

  const verdict = sessionVerdict({
    present: session.data != null,
    pending: session.isPending,
    failure: session.error ?? null,
  });

  const claim = useQuery({
    queryKey: keys.signUpOpen(),
    queryFn: ({ signal }) => signUpOpen(signal),
    enabled: verdict === "absent",
    // Once an owner exists this can never change back (`endpoints/auth.ts`), and
    // this read happens on a path that is about to navigate away regardless.
    staleTime: 5 * 60_000,
  });

  // Only a Self-hosted instance with no owner is "unclaimed". The Hosted
  // instance is never offered to a visitor to claim, open or not.
  const instance: InstanceClaim = claim.data
    ? claim.data.state === "unclaimed"
      ? "unclaimed"
      : "claimed"
    : claim.isError
      ? "claimed"
      : "pending";

  const membership = useMembershipVerdict();

  const gate = consoleGate(verdict, instance, pathname, membership);

  const { signOutNow } = useSignOut(
    gate.kind === "leaving" ? { to: gate.to } : {},
  );

  // Once, and not again on a re-render while the request is in flight — a second
  // sign-out would race the navigation the first one is about to make.
  const left = useRef(false);

  // In no Organization: the session is good, so this navigates rather
  // than signing out. `replace`, so Back does not return to a frame that only
  // forwards.
  const choosingAt = gate.kind === "choosing" ? gate.to : null;
  useEffect(() => {
    if (choosingAt !== null) window.location.replace(choosingAt);
  }, [choosingAt]);

  useEffect(() => {
    if (gate.kind !== "leaving" || left.current) return;
    left.current = true;
    // A failure here is the network being down: better-auth's `/sign-out` clears
    // the cookie and answers 200 whether or not the session was still good
    // (`api/routes/sign-out.ts`), so there is no refusal to handle. `useSignOut`
    // says so in a toast and leaves the frame standing, which a reload retries.
    // Navigating anyway would be the redirect loop this guard exists to end.
    void signOutNow();
  }, [gate.kind, signOutNow]);

  if (gate.kind === "console") return children;
  if (gate.kind === "not-a-member") return <NotAMember />;
  if (gate.kind === "choosing") return <Leaving message={CHOOSING_MESSAGE} />;

  return <Leaving message={gate.kind === "leaving" ? gate.message : null} />;
}

/** Navigation-wait copy, in the shape of `console-gate.ts`'s own two. */
const CHOOSING_MESSAGE =
  "This session is not in an Organization yet. Taking you to choose one.";

/**
 * The frame the shell is replaced by while the session is being ended.
 *
 * Not `AuthOutcome`, and not `Outcome`: the four terminal states §3.10 lists are
 * each the *end* of something, and `AuthOutcome` specifically lives in the auth
 * column, which this is not. This is a wait of one round trip that ends in a full
 * navigation, so it holds the ground and says the one sentence that is true —
 * and says nothing at all until the gate knows which sentence that is, rather
 * than printing a guess and swapping it.
 */
function Leaving({ message }: { message: string | null }) {
  return (
    <div
      aria-busy="true"
      className="grid h-dvh place-items-center bg-ground px-pad"
    >
      {/* `role="status"` and not a bare paragraph: this text arrives after the
          document has, so a screen reader is only told about it if the region
          announces itself. */}
      <p role="status" className="max-w-lede text-center text-body text-tx-2">
        {message ?? <span className="sr-only">Signing you out.</span>}
      </p>
    </div>
  );
}
