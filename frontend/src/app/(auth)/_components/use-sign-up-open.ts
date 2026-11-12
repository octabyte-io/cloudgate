import { useQuery } from "@tanstack/react-query";

import { type SignUpState, signUpOpen } from "@/lib/api/endpoints/auth";
import { keys } from "@/lib/api/keys";

export type SignUpOpen = {
  /**
   * What an uninvited sign-up meets here — `SignUpState` in
   * `endpoints/auth.ts`. Meaningless until `ready`.
   */
  state: SignUpState;
  /** The answer is in. Until then the screen holds its place. */
  ready: boolean;
  /**
   * The Hosted instance's Turnstile site key, which the public form
   * renders the widget with. Absent Self-hosted and on an invited sign-up,
   * which its invitation authorises instead.
   */
  turnstileSiteKey?: string;
};

/**
 * Whether this instance is still open to an uninvited sign-up.
 *
 * Before this read existed, `/sign-up` could only find out by rendering five
 * fields, letting someone fill them in, and showing them a refusal — a form
 * nobody was ever going to be allowed to submit.
 *
 * **An invitation skips the query entirely.** `assertSignUpAllowed` checks the
 * token *instead of* the owner rule, so an invited sign-up works on a claimed
 * instance and the answer here would be both `false` and irrelevant. Passing
 * `invited` rather than letting the caller decide keeps that from being read as
 * "closed" by a future edit.
 *
 * **A failure fails open to the form**, the same way `useSsoConfig` fails open to
 * the password form. Treating an unreachable backend as "closed" would replace the
 * only way to set this instance up with a dead end; rendering the form instead
 * produces a refusal that names the real problem.
 *
 * That is the opposite of what the other reader of this key does, and deliberately
 * so: `components/shell/dead-session-exit.tsx` fails **closed** to sign-in
 * `keys.signUpOpen`
 * says why the two share a key and must not be merged into one hook.
 */
export function useSignUpOpen(invited: boolean): SignUpOpen {
  const query = useQuery({
    queryKey: keys.signUpOpen(),
    queryFn: ({ signal }) => signUpOpen(signal),
    enabled: !invited,
    // Once an owner exists this can never change back, and before one does it is
    // read on a screen loaded far more often than an instance is claimed. The
    // Hosted instance's one change, not open yet to open, is made once, by a
    // command on the box, before anyone is told the address.
    staleTime: 5 * 60_000,
  });

  // Invited: the token opens the form whatever the instance says.
  if (invited) return { state: "open", ready: true };

  return {
    // A failure reads as the Self-hosted setup form — see "fails open" above.
    state: query.isError ? "unclaimed" : (query.data?.state ?? "closed"),
    ready: !query.isPending,
    turnstileSiteKey: query.data?.turnstileSiteKey,
  };
}
