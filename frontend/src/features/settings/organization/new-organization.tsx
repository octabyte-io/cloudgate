import type { OrganizationCreation } from "@/lib/api/endpoints/organizations";

/**
 * The one-Organization limit's two lines that Settings > Organizations alone
 * draws. The refusal line both it and the switcher draw is
 * `components/console/new-organization-reason.tsx`, and the gate both read is
 * `newOrganizationGate` in `lib/api/use-organizations.ts`.
 */

/**
 * "You own 1 of 1 you can own yourself. Attached ones you own do not count." —
 * the Hosted limit (ADR-0059), on Settings > Organizations only. Nothing on a
 * Self-hosted instance, where the limit is the instance's, not the person's.
 */
export function OwnedOrganizationsLine({
  creation,
}: {
  creation: OrganizationCreation | undefined;
}) {
  const owned = creation?.ownedPayingForThemselves;
  if (!owned) return null;
  return (
    <p className="border-b border-line px-4 py-2 text-meta text-tx-3">
      You own {owned.count} of {owned.of} you can own yourself. Attached ones
      you own do not count.
    </p>
  );
}

/**
 * "This instance is over the free version's limit of one Organization." —
 * told once, on Settings > Organizations only, to the open Organization's
 * owners and admins. The Instance organization's also get the count. Nothing is
 * removed, which the sentence says.
 */
export function OverOrganizationLimitNotice({
  creation,
}: {
  creation: OrganizationCreation | undefined;
}) {
  const over = creation?.overLimit;
  if (!over) return null;
  return (
    <div
      role="note"
      className="border-b border-line bg-info-tint px-4 py-2.75 text-body text-tx"
    >
      This instance is over the free version&apos;s limit of one Organization.
      Existing ones keep working.
      {over.count === null ? null : (
        <span className="text-tx-2"> It has {over.count} Organizations.</span>
      )}
    </div>
  );
}
