"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import { useEffect } from "react";

import { FormError } from "@/components/console/field";
import { MenuRow } from "@/components/console/menu";
import { Skeleton } from "@/components/console/skeleton";
import { SubmitButton } from "@/components/console/submit-button";
import { errorMessage } from "@/lib/api/error-message";
import { keys } from "@/lib/api/keys";
import { useBrandingOrDefault } from "@/lib/api/use-branding";
import { resolveOrganizationDestination } from "@/lib/auth/active-organization";
import { unwrap } from "@/lib/auth/auth-error";
import { organization } from "@/lib/auth/client";
import { NEXT_PARAM, safeNextPath } from "@/lib/auth/routes";
import { useSignOut } from "@/lib/auth/use-sign-out";
import { brandName } from "@/lib/branding/branding";

import { AuthOutcome } from "./auth-outcome";
import { AuthPanel } from "./auth-panel";

/**
 * Which Organization to work in, asked only when the answer is not already known.
 *
 * Reached from the sign-in flow when the session has no `activeOrganizationId` and
 * the person belongs to more than one with none marked default — the backend
 * leaves that unset on purpose — see `src/lib/auth/active-organization.ts`
 * for why it matters: every console read waits on that id, so a session that
 * skips this is a console that never loads.
 *
 * It also handles belonging to *none*, which is the invited-but-not-accepted case.
 * There is nothing to choose there, so it says so and offers the way out rather
 * than rendering an empty list with a disabled button.
 *
 * **It decides for itself rather than trusting how it was reached.** The SSO
 * button sends the identity provider's callback here, because that sign-in never
 * comes back through a form that could ask `resolveOrganizationDestination` —
 * so a session whose Organization is already settled is forwarded to `next`
 * without being shown a question it does not have.
 */
export function SelectOrganization() {
  const params = useSearchParams();
  const next = safeNextPath(params.get(NEXT_PARAM));
  const { signOutNow, pending: signingOut } = useSignOut();

  const branding = useBrandingOrDefault();

  const destination = useQuery({
    queryKey: keys.myOrganizationDestination(next),
    queryFn: () => resolveOrganizationDestination(next),
    retry: false,
  });

  const ready =
    destination.data?.kind === "ready" ? destination.data.href : null;
  // `replace`, so Back does not return to a screen that only forwards.
  useEffect(() => {
    if (ready !== null) window.location.replace(ready);
  }, [ready]);

  const choose = useMutation({
    mutationFn: (organizationId: string) =>
      unwrap(organization.setActive({ organizationId })),
    // A full navigation: the tenant boundary just moved, and the console is about
    // to be rendered against a session this tab has not seen yet.
    onSuccess: () => window.location.assign(next),
  });

  if (destination.isError) {
    return (
      <AuthPanel title="Choose an Organization">
        <FormError message={errorMessage(destination.error)} />
      </AuthPanel>
    );
  }

  // Held while it is read, and while a settled session is being forwarded.
  if (destination.isPending || destination.data.kind === "ready") {
    return (
      <AuthPanel title="Choose an Organization">
        <div className="grid gap-2" aria-busy="true">
          <Skeleton className="h-nav" />
          <Skeleton className="h-nav" />
        </div>
      </AuthPanel>
    );
  }

  if (destination.data.kind === "none") {
    return (
      <AuthPanel title="No organization yet">
        {/* The route's title is the question this screen usually asks, and it
            is not the one it is asking here — so the tab says what the heading
            says. React's hoisted `<title>`, as `app/not-found.tsx` does it:
            mounted after the route's own, so it is the one the tab shows. */}
        <title>{`No organization yet · ${brandName(branding)}`}</title>
        <AuthOutcome
          tone="info"
          icon="layers"
          title="Your account is not in an Organization"
          action={
            <SubmitButton
              block
              type="button"
              pending={signingOut}
              onClick={() => void signOutNow()}
            >
              Sign out
            </SubmitButton>
          }
        >
          Everything in Cloudgate belongs to one. If you were invited to an
          organization, open the link in your invitation to join it — then sign in
          again.
        </AuthOutcome>
      </AuthPanel>
    );
  }

  const { organizations } = destination.data;

  return (
    <AuthPanel
      title="Choose an Organization"
      lede="You belong to more than one. Pick the one to work in — you can switch from the masthead later."
    >
      <div className="grid gap-3">
        <FormError
          message={choose.error ? errorMessage(choose.error) : undefined}
        />

        {/*
          `MenuRow` is F03's menu row outside a menu, which is exactly this: a list
          of one-click choices. A `PickCard` would be the wrong shape — these have
          nothing to explain about themselves, only a name.
        */}
        <ul className="grid gap-0.5">
          {organizations.map((org) => (
            <li key={org.id}>
              <MenuRow
                icon="layers"
                aria-disabled={choose.isPending || undefined}
                // `MenuRow` is a native button, so nothing swallows the click
                // for the attribute above: the handler refuses it.
                onClick={() => {
                  if (!choose.isPending) choose.mutate(org.id);
                }}
              >
                {org.name}
              </MenuRow>
            </li>
          ))}
        </ul>
      </div>
    </AuthPanel>
  );
}
