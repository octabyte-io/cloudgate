"use client";

import { useSession } from "@/lib/auth/client";

/**
 * Holds the authenticated panels back until there is a session.
 *
 * Not politeness — necessity. A query that runs without a session gets a 401,
 * and `query-client.ts` answers a 401 by navigating to the sign-in screen, which
 * would take this page with it before anyone could use the form on it. Which is
 * itself the 401 path working: it is how this page proves it.
 */
export function SignedIn({ children }: { children: React.ReactNode }) {
  const { data: session, isPending } = useSession();
  if (isPending || !session) return null;
  return <>{children}</>;
}
