import Link from "next/link";
import { useEffect, useState } from "react";

import { Menu } from "@/components/console/menu";
import { NewOrganizationReason } from "@/components/console/new-organization-reason";
import { OrganizationFormModal } from "@/components/console/organization-form-modal";
import { Skeleton } from "@/components/console/skeleton";
import { toast } from "@/components/console/toast";
import { useInvalidate } from "@/lib/api/use-invalidate";
import {
  newOrganizationGate,
  useOrganizationCreation,
  useOrganizations,
} from "@/lib/api/use-organizations";
import { unwrap } from "@/lib/auth/auth-error";
import type { OrganizationMembership } from "@/lib/api/endpoints/organizations";
import { organization, useActiveOrganizationId } from "@/lib/auth/client";
import { Icon } from "@/lib/design/icons";
import { cn } from "@/lib/utils";

import { RailTip } from "./rail-tip";
import { useHydrated } from "./use-hydrated";

/**
 * The Organization cell's switcher (e-console.html:2248-2260).
 *
 * Switching Organization is the tenant boundary moving, so it is not just a
 * navigation: every cached row belongs to the Organization it was fetched for,
 * and `organizationChanged()` drops that whole subtree rather than letting one
 * tenant's Projects be handed to the next (`src/lib/api/keys.ts`).
 *
 * The name takes whatever width the masthead can spare: the cell grows
 * past the rail's width for a name that needs it (`masthead.tsx`), and what
 * still does not fit truncates with the whole name in a `title`. On a phone the
 * name stays, truncated — it used to drop to its initial at `lbl`, and "M" told
 * nobody which Organization they were in while the masthead had room to say.
 * Only the 60px icon strip shows the initial, with the name in a tooltip.
 *
 * "New organization" sits under the list in the same state as on Settings >
 * Organizations — the one `useOrganizationCreation` read — greyed out with its
 * reason on the line below when it is refused, and never hidden.
 *
 * **The list is a tree** (ADR-0059). It is `GET /organizations` rather
 * than better-auth's `/organization/list`, because only Nest's says who pays:
 * an Attached Organization whose Paying Organization the caller also belongs to
 * sits indented under it, and one whose payer they do not belong to stays at
 * the top level with "Paid by another Organization" — the backend never tells
 * them which (`switcherTree`). With nothing attached the list is as flat as it
 * always was. The shell's membership gate still reads better-auth's list;
 * `invalidate.membership()` refreshes both together.
 */
export function OrgSwitcher() {
  const { organizationId } = useActiveOrganizationId();
  const { data: organizations, refetch } = useOrganizations();
  const invalidate = useInvalidate();
  const creation = useOrganizationCreation();
  const newOrganization = newOrganizationGate(creation);
  const [creating, setCreating] = useState(false);

  // No fallback word. This used to print "Organization" when the list
  // did not name the active one, which read as an Organization *called* that —
  // and the one time it happened for long was a session whose user had been
  // removed, where a name-shaped placeholder hid the very fact to report. The
  // list not naming it is now either a moment's wait, or the shell's gate
  // replacing this whole frame with `NotAMember`; neither needs a name made up.
  //
  // Nor a name before hydration is over: the server has no list, so it
  // renders the skeleton, and a client whose list is already cached would
  // otherwise hydrate a name over it — a mismatch on every console page.
  const hydrated = useHydrated();
  const active = organizations?.find((each) => each.id === organizationId);

  // A list that does not name the session's Organization is read once more:
  // the session can move to one joined in another tab, and this list is a
  // cached query. An answer that has not changed keeps the same object
  // (TanStack's structural sharing), so this does not loop; one that still
  // does not name it is the shell's gate's to report.
  const behind =
    organizations !== undefined && organizationId !== null && !active;
  useEffect(() => {
    if (behind) void refetch();
  }, [behind, organizations, refetch]);
  const name = hydrated ? (active?.name ?? null) : null;

  async function switchTo(id: string) {
    if (id === organizationId) return;
    try {
      await unwrap(organization.setActive({ organizationId: id }));
      await invalidate.organizationChanged();
    } catch (error) {
      toast.error(error);
    }
  }

  return (
    <>
      <Menu
        align="start"
        className="min-w-66"
        trigger={
          // Below the cell, not beside it: to its right is the masthead's
          // breadcrumb, and a tooltip there would sit on top of the page's name.
          <RailTip label={name ?? "Switch Organization"} side="bottom">
            <button
              type="button"
              aria-label={
                name === null
                  ? "Switch Organization"
                  : `Organization: ${name}. Switch Organization`
              }
              aria-busy={name === null || undefined}
              className="flex h-7.5 min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 text-ui font-medium text-tx transition-colors duration-100 hover:bg-raise railc:flex-none railc:justify-center railc:px-1"
            >
              {name === null ? (
                <Skeleton className="h-3.5 w-24 railc:hidden" />
              ) : (
                <span title={name} className="truncate railc:hidden">
                  {name}
                </span>
              )}
              {/* The initial is decoration once the name is hidden — the button's
                own label is what says which Organization this is. It stands in
                for the name on the 60px icon strip only, where an initial is
                worth more than the chevron it replaces. */}
              <span aria-hidden="true" className="hidden railc:inline">
                {name?.slice(0, 1).toUpperCase()}
              </span>
              <Icon
                name="chevUD"
                size={13}
                className="flex-none text-tx-3 railc:hidden"
              />
            </button>
          </RailTip>
        }
      >
        <Menu.Group label="Organizations">
          {switcherTree(organizations ?? []).map(({ row, payer }) => (
            <Menu.Item
              key={row.id}
              icon={payer ? undefined : "net"}
              selected={row.id === organizationId}
              onClick={() => void switchTo(row.id)}
              aria-label={
                payer === undefined
                  ? undefined
                  : `${row.name}, paid by ${payer?.name ?? "another Organization"}`
              }
              className={cn(
                // Under the payer's name, past its icon.
                payer && "pl-8.5",
                payer === null && "h-auto py-1.25",
              )}
            >
              {payer === null ? (
                <>
                  <span className="block truncate">{row.name}</span>
                  <span className="block truncate text-meta font-normal text-tx-3">
                    Paid by another Organization
                  </span>
                </>
              ) : (
                row.name
              )}
            </Menu.Item>
          ))}
        </Menu.Group>
        <Menu.Item
          icon="plus"
          disabled={!newOrganization.allowed}
          onClick={() => setCreating(true)}
        >
          New organization
        </Menu.Item>
        <NewOrganizationReason
          creation={creation.data}
          className="max-w-66 px-2.25 pb-1.5 text-meta text-tx-3"
        />
        <Menu.Separator />
        <Menu.Item icon="cog" render={<Link href="/settings" />}>
          Organization settings
        </Menu.Item>
      </Menu>
      {creating ? (
        <OrganizationFormModal key="create" open onOpenChange={setCreating} />
      ) : null}
    </>
  );
}

/** One row of the switcher's list, and where it sits in the tree. */
interface SwitcherRow {
  row: OrganizationMembership;
  /**
   * `undefined` for an Organization that pays for itself; the Paying
   * Organization's row for one nested under it; `null` for an Attached
   * Organization whose payer is not in the caller's list — top level, "Paid by
   * another Organization".
   */
  payer: OrganizationMembership | null | undefined;
}

/**
 * The caller's Organizations in switcher order: each top-level row in the
 * list's own order, with the Attached Organizations it pays for straight
 * after it. One level only — an Attached Organization never pays for another
 * (ADR-0059).
 */
function switcherTree(list: OrganizationMembership[]): SwitcherRow[] {
  const byId = new Map(list.map((each) => [each.id, each]));
  const payerOf = (each: OrganizationMembership) =>
    each.paidBy?.organizationId
      ? byId.get(each.paidBy.organizationId)
      : undefined;
  const rows: SwitcherRow[] = [];
  for (const each of list) {
    if (payerOf(each)) continue;
    rows.push({ row: each, payer: each.paidBy ? null : undefined });
    for (const attached of list) {
      if (payerOf(attached) === each) rows.push({ row: attached, payer: each });
    }
  }
  return rows;
}
