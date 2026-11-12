import { useState } from "react";

import { FormError } from "@/components/console/field";
import { MenuRow } from "@/components/console/menu";
import { Outcome } from "@/components/console/outcome";
import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/api/error-message";
import { useInvalidate } from "@/lib/api/use-invalidate";
import { unwrap } from "@/lib/auth/auth-error";
import { organization, useListOrganizations } from "@/lib/auth/client";
import { useSignOut } from "@/lib/auth/use-sign-out";

/**
 * What the console shell is replaced by when the session's user is no longer a
 * member of its active Organization.
 *
 * Every screen used to answer this with *"Your role in this Organization does
 * not allow this"*, the masthead read "Organization" with no name, and the
 * switcher kept offering the Organization they had just been removed from. One
 * screen that says the fact and carries the two ways out is the whole fix; the
 * shell behind it would only be a frame of refusals.
 *
 * **The session is not ended**, which is the difference from `Leaving` beside
 * it: the session is good, and it is what they switch Organization with. So the
 * way out is a choice of the Organizations they still belong to — the same
 * `setActive` and `organizationChanged()` the masthead switcher makes — and Sign
 * out. The list is read off the same store as the switcher, which the gate has
 * just refreshed, so it cannot offer the Organization it is reporting on.
 *
 * **With no memberships left there is nothing to switch to**, and the words are
 * `/select-organization`'s "No organization yet" ones: an invitation link is the
 * way back in, and Sign out is the control. Not Create an Organization — that
 * would be one more screen's worth of form to carry here, for a person whose
 * next move is almost always the invitation they are waiting on, and signing in
 * again lands on the screen that already says so.
 *
 * `Outcome`, not `EmptyState`: nothing here is empty and waiting to be created;
 * a membership ended. `info`, not `bad` — nothing is broken.
 *
 * No `"use client"`: only `dead-session-exit.tsx` renders this, and that is
 * already the client boundary (§3.2).
 */
export function NotAMember() {
  const { data: organizations, isPending } = useListOrganizations();
  const invalidate = useInvalidate();
  const { signOutNow, pending: signingOut } = useSignOut();
  const [switching, setSwitching] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const others = organizations ?? [];

  async function switchTo(id: string) {
    setSwitching(id);
    setFailure(null);
    try {
      // `unwrap`, or a refusal is silent: better-auth resolves to
      // `{ data, error }` rather than throwing, and the live check of this
      // screen found a 403 `INVALID_ORIGIN` doing nothing at all here.
      await unwrap(organization.setActive({ organizationId: id }));
      await invalidate.organizationChanged();
    } catch (error) {
      // Inline as well as the toast: this screen is the whole console for
      // them, and a toast that has gone leaves no trace of why they are
      // still here.
      setFailure(errorMessage(error));
      toast.error(error);
    } finally {
      setSwitching(null);
    }
  }

  const signOut = (
    <Button
      variant={others.length === 0 ? "pri" : "gh"}
      // `aria-disabled`, not `disabled` (§3.10): an action keeps its place in
      // the tab order while it is off, so the click is refused here instead.
      aria-disabled={signingOut || undefined}
      onClick={() => {
        if (!signingOut) void signOutNow();
      }}
    >
      Sign out
    </Button>
  );

  return (
    <main className="min-h-dvh bg-ground">
      {others.length === 0 && !isPending ? (
        <Outcome
          tone="info"
          icon="layers"
          title="You are no longer in any Organization"
          action={signOut}
        >
          You were removed from the Organization this session was working in,
          and everything in Cloudgate belongs to one. If you were invited to an
          Organization, open the link in your invitation to join it — then sign
          in again.
        </Outcome>
      ) : (
        <Outcome
          tone="info"
          icon="layers"
          title="You are no longer a member of this Organization"
          action={
            <div className="grid w-full min-w-66 justify-items-stretch gap-3">
              <FormError
                message={failure ?? undefined}
                className="text-left"
              />
              <ul
                aria-label="Organizations you belong to"
                className="grid gap-0.5 text-left"
              >
                {others.map((each) => (
                  <li key={each.id}>
                    <MenuRow
                      icon="net"
                      aria-disabled={switching !== null || undefined}
                      onClick={() => {
                        if (switching === null) void switchTo(each.id);
                      }}
                    >
                      {each.name}
                    </MenuRow>
                  </li>
                ))}
              </ul>
              {signOut}
            </div>
          }
        >
          Someone removed you from it, or it was deleted. Switch to an
          Organization you still belong to, or sign out.
        </Outcome>
      )}
    </main>
  );
}
