import { useMutation, useQuery } from "@tanstack/react-query";

import { keys } from "@/lib/api/keys";
import { useInvalidate } from "@/lib/api/use-invalidate";
import {
  organizationsApi,
  type CreateOrganizationInput,
  type OrganizationCreation,
} from "@/lib/api/endpoints/organizations";
import type { Gate } from "@/lib/auth/use-permission";

/**
 * The Organizations this person belongs to.
 *
 * **Under `keys.account`, not under `keys.org`** — the list belongs to the
 * signed-in person and does not change when they switch tenant, which is the
 * split `keys.ts` opens with. It is also why `invalidate.membership()` widens to
 * both roots: creating an Organization changes this list *and* the membership
 * table inside the one you are in.
 *
 * `GET /organizations` answers with each Organization **plus the caller's own
 * `member` row**, which is what makes this screen possible without a second
 * request per row: whether you may rename or delete one is `member.role` and
 * `organization.ownerId`, and both arrive here.
 *
 * Create, update and delete go through `organizations.controller.ts` rather than
 * better-auth's client — `auth.config.ts` puts `/organization/create|update|delete`
 * on `disabledPaths` precisely so the self-hosted owner rules are enforced in one
 * place. Switching the *active* one is the opposite case and is better-auth's;
 * F05's `OrgSwitcher` owns that call.
 */

export function useOrganizations() {
  return useQuery({
    queryKey: keys.myOrganizations(),
    queryFn: organizationsApi.list,
  });
}

/**
 * Whether "New organization" is on for this person, and the sentence when it
 * is not (`GET /organizations/creation`). Settings > Organizations and the
 * masthead switcher both read this one query, so the two are always in the
 * same state.
 */
export function useOrganizationCreation() {
  return useQuery({
    queryKey: keys.myOrganizationCreation(),
    queryFn: organizationsApi.creation,
  });
}

/**
 * Whether "New organization" is on, and the backend's sentence when not. Off
 * while the answer is unknown, so it never looks clickable a moment before it
 * is greyed out; on when the read itself failed, so a broken read does not
 * stand in for a refusal — the route still answers for itself. The gate is the
 * route's own answer, not a role read in the browser (`gated-controls.ts`,
 * `"answer"`). Settings > Organizations and the switcher both gate on it.
 */
export function newOrganizationGate(query: {
  data: OrganizationCreation | undefined;
  error: unknown;
}): Gate {
  if (query.error) return { allowed: true, refusal: "" };
  return {
    allowed: query.data?.allowed === true,
    refusal: query.data?.reason ?? "",
  };
}

export function useCreateOrganization() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: CreateOrganizationInput) =>
      organizationsApi.create(input),
    onSettled: () => invalidate.membership(),
  });
}

export function useUpdateOrganization() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({
      organizationId,
      name,
    }: {
      organizationId: string;
      name: string;
    }) => organizationsApi.update(organizationId, { name }),
    onSettled: () => invalidate.membership(),
  });
}

export function useDeleteOrganization() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (organizationId: string) =>
      organizationsApi.remove(organizationId),
    // Billing too: an Attached Organization deleted from the move-to-Starter
    // checklist leaves its Paying Organization's list and pool.
    onSettled: () =>
      Promise.all([invalidate.membership(), invalidate.billing()]),
  });
}

/**
 * Which Organization new sessions start in.
 *
 * `setDefault` clears `isDefault` on **every** membership this person has and
 * sets it on one, so the whole list is stale after it — not just the two rows
 * that visibly changed.
 */
export function useSetDefaultOrganization() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (organizationId: string) =>
      organizationsApi.setDefault(organizationId),
    onSettled: () => invalidate.membership(),
  });
}
