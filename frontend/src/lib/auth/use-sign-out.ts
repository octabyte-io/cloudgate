import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";

import { toast } from "@/components/console/toast";

import { endSession } from "./end-session";
import { SIGN_IN_PATH } from "./routes";

/**
 * Signing out because someone pressed a button.
 *
 * The three steps and the reason for each are in `end-session.ts`, which the
 * 401 handler in `lib/api/query-client.ts` shares — it is not a component and
 * cannot call this hook.
 * What this adds is the two things only a button needs: a `pending` flag while
 * the request is in flight, and words when it fails.
 *
 * A failure leaves them signed in and says so, rather than clearing the tab and
 * pretending: the cookie is still valid, so "signed out" would be a lie.
 *
 * `to` is where the last step goes, and `/sign-in` is right for almost every
 * button a person presses. Two callers need another. The console shell's
 * dead-session exit: on an instance nobody owns there is nothing to sign in to,
 * so it ends the session and leaves for `/sign-up`. And an invitation link's
 * Sign outs, which exist so the recipient can sign in instead, and so carry the
 * invitation back as `?next=`. An option rather than an argument to
 * `signOutNow` on purpose — `sessions-card.tsx` passes it straight to `onClick`,
 * which would hand it a `MouseEvent`.
 */
export function useSignOut(options: { to?: string } = {}): {
  signOutNow: () => Promise<void>;
  pending: boolean;
} {
  const { to = SIGN_IN_PATH } = options;
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);

  const signOutNow = useCallback(async () => {
    setPending(true);
    try {
      await endSession(queryClient, to);
    } catch (error) {
      setPending(false);
      toast.error(error);
    }
  }, [queryClient, to]);

  return { signOutNow, pending };
}
