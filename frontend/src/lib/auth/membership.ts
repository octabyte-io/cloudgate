import { useEffect, useState } from "react";

import { isApiError } from "@/lib/api/api-error";

import { NOT_A_MEMBER_CODE } from "./auth-error";
import {
  organizationListNow,
  refetchOrganizationList,
  useActiveOrganizationId,
  useListOrganizations,
  useSession,
} from "./client";
import { type MembershipVerdict, membershipVerdict } from "./console-gate";

/**
 * Is the session's user still a member of the session's active Organization
 *?
 *
 * `console-gate.ts`'s `membershipVerdict` makes the decision; this supplies its
 * three facts, and the one that takes a hook is `confirmed`. A list that does
 * not name the active Organization is read **once more** before anyone is told
 * they were removed, because better-auth refetches `/organization/list` only off
 * its own `$listOrg` signal and does not raise it after an accepted invitation
 * or a switch — so the list can be behind in the *other* direction too, and
 * that reader has just joined.
 *
 * A confirmation belongs to the session and the list it was made against, by
 * identity. better-auth keeps a store's object when a refetch answers the same
 * JSON (`client/query.mjs`), so an unchanged pair stays confirmed across
 * renders, and any change to either — a switch, a newly joined Organization, a
 * refetch that answered differently — makes the verdict earn it again.
 */
export function useMembershipVerdict(): MembershipVerdict {
  const { data: session } = useSession();
  const { organizationId } = useActiveOrganizationId();
  const list = useListOrganizations();
  const [checked, setChecked] = useState<{
    session: unknown;
    list: unknown;
  } | null>(null);

  const verdict = membershipVerdict({
    organizationId,
    memberOf: list.data ? list.data.map((each) => each.id) : null,
    confirmed:
      checked !== null &&
      checked.session === session &&
      checked.list === list.data,
  });

  const { refetch } = list;

  useEffect(() => {
    if (verdict !== "unconfirmed") return;
    let live = true;
    void refetch().then(() => {
      if (!live) return;
      // Off the store rather than the render's `list.data`, which is the list
      // *before* this read — the one being checked, not the one that checks.
      setChecked({ session, list: organizationListNow()?.data });
    });
    return () => {
      live = false;
    };
  }, [verdict, refetch, session]);

  return verdict;
}

/**
 * Take a refusal as the cue to read the membership list again.
 *
 * Called for every query and mutation error from `query-client.ts`. Removal is
 * something another session does, so nothing in this one knows it happened
 * until a request is refused for it — and the list the switcher and the gate
 * both read is a better-auth store that would otherwise keep naming the
 * Organization until a reload. Every card on a screen is
 * refused at once, so a read already in flight is not started again.
 */
export function recheckMembership(error: unknown): void {
  if (!isApiError(error) || error.code !== NOT_A_MEMBER_CODE) return;
  if (organizationListNow()?.isRefetching) return;
  refetchOrganizationList();
}
