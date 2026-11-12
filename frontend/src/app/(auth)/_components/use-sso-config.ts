import { useQuery } from "@tanstack/react-query";

import { enforceSso, showSsoSignIn } from "@/lib/api/endpoints/sso";
import { keys } from "@/lib/api/keys";

export type SsoConfig = {
  /** Offer the SSO button. */
  enabled: boolean;
  /**
   * SSO is the only way in, so no password form is rendered. Only while the
   * button is offered: with SSO sign-in off (no Business plan, no valid key)
   * an enforced instance would otherwise show a button that signs
   * nobody in and no password form, which is a lock-out.
   */
  enforced: boolean;
  /** Both answers are in. Until then the form area holds its place. */
  ready: boolean;
};

/**
 * What the sign-in screen is allowed to show, asked before it shows it.
 *
 * Both reads have to land first. Rendering the password form and removing it when
 * `enforced` arrives would show someone a form, then take it away — and the half
 * second they spent starting to type in it is the half second they will remember.
 * So the form area holds its place until this resolves.
 *
 * **A failure fails open to the password form.** If the backend cannot be reached,
 * treating that as "SSO is enforced" would replace the only working way in with a
 * button that also cannot work; the password form at least produces a refusal that
 * names the real problem. Two queries rather than one because they are two
 * endpoints, and `useQueries` would buy nothing here — they are independent and
 * both cheap.
 */
export function useSsoConfig(): SsoConfig {
  const show = useQuery({
    queryKey: keys.ssoSignIn(),
    queryFn: ({ signal }) => showSsoSignIn(signal),
    // Neither answer changes without an admin changing a setting, and this screen
    // is loaded far more often than that happens.
    staleTime: 5 * 60_000,
  });

  const enforce = useQuery({
    queryKey: [...keys.ssoSignIn(), "enforced"],
    queryFn: ({ signal }) => enforceSso(signal),
    staleTime: 5 * 60_000,
  });

  const enabled = show.data?.enabled ?? false;
  return {
    enabled,
    enforced: enabled && (enforce.data?.enforced ?? false),
    ready: !show.isPending && !enforce.isPending,
  };
}
