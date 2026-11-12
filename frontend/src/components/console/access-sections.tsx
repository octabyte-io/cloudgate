import { useId } from "react";

import { Chip } from "@/components/console/chip";
import { Skeleton } from "@/components/console/skeleton";
import { Checkbox } from "@/components/ui/checkbox";
import { errorMessage } from "@/lib/api/error-message";
import { counted } from "@/lib/format/plural";

import type { GrantScope } from "@/lib/api/use-member-grants";

/**
 * The furniture the three access columns are built from.
 *
 * Split out of `manage-access-modal.tsx` rather than nested in it because the
 * dialog is three of the same thing at three depths — a flat list of Projects,
 * Environments grouped under their Project, Services grouped under their
 * Environment — and writing that shape three times is how the middle one ends
 * up with a different loading state from the other two.
 *
 * `ScopeGroup` is where §3.5's terminal-state order lives: **error, then
 * pending, then empty**. It matters more here than in most places, because a
 * fan-out half-fails. One Environment refusing must render as "this group could
 * not be read" under that group's own heading — not as an empty group, which
 * would say the Project has no Environments, and not as a failed dialog, which
 * would throw away the two columns that read fine.
 */

export function AccessSection({
  title,
  lede,
  children,
}: {
  title: string;
  lede: React.ReactNode;
  children: React.ReactNode;
}) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId}>
      <h3 id={headingId} className="text-body font-medium text-tx">
        {title}
      </h3>
      <p className="mt-0.5 text-meta text-tx-2">{lede}</p>
      <div className="mt-2 rounded-lg border border-line">{children}</div>
    </section>
  );
}

/** One tickable thing, with room for what kind of thing it is. */
export function AccessCheck({
  id,
  checked,
  onCheckedChange,
  name,
  sub,
  chip,
}: {
  id: string;
  checked: boolean;
  onCheckedChange: (on: boolean) => void;
  name: string;
  sub?: string;
  chip?: string;
}) {
  return (
    <li className="flex items-center gap-2.5 border-b border-line px-3 py-2.25 last:border-b-0">
      <Checkbox
        id={id}
        checked={checked}
        onCheckedChange={(next) => onCheckedChange(next === true)}
      />
      <label
        htmlFor={id}
        className="min-w-0 flex-1 cursor-pointer text-body text-tx"
      >
        <span className="block truncate">{name}</span>{" "}
        {/* The `{" "}` is load-bearing: the two spans are block-level, so
            without a text node between them the accessible name of the
            checkbox this label names comes out as "webweb-a1b2c3". */}
        {sub ? (
          <span className="block truncate text-meta text-tx-3">{sub}</span>
        ) : null}
      </label>
      {chip ? <Chip className="flex-none">{chip}</Chip> : null}
    </li>
  );
}

/**
 * One parent's rows — a Project's Environments, or an Environment's Services.
 *
 * The heading is always drawn, in every state, so a group that is loading or
 * refusing still says *which* Project or Environment it is talking about.
 */
export function ScopeGroup<T>({
  heading,
  scope,
  empty,
  row,
}: {
  heading: string;
  scope: GrantScope<T>;
  /** What to say when the parent really holds nothing. */
  empty: string;
  /** Returns an `AccessCheck`, keyed by the caller — it is already the `<li>`. */
  row: (item: T) => React.ReactNode;
}) {
  return (
    <div className="border-b border-line last:border-b-0">
      <p className="px-3 pt-2.25 pb-1 text-meta font-medium text-tx-2">
        {heading}
      </p>
      {scope.error ? (
        <p className="px-3 pb-2.25 text-meta text-bad">
          {errorMessage(scope.error)} Nothing under this heading can be ticked
          until it can be read — the other groups are unaffected.
        </p>
      ) : scope.isPending || scope.rows === undefined ? (
        <div className="grid gap-2 px-3 pt-1 pb-3" aria-busy="true">
          <Skeleton className="h-ctl" />
          <Skeleton className="h-ctl" />
        </div>
      ) : scope.rows.length === 0 ? (
        <p className="px-3 pb-2.25 text-meta text-tx-3">{empty}</p>
      ) : (
        <ul className="pb-1">{scope.rows.map(row)}</ul>
      )}
    </div>
  );
}

/** What a section says when nothing above it has been ticked yet. */
export function NothingAbove({ children }: { children: React.ReactNode }) {
  return <p className="px-3 py-2.75 text-meta text-tx-3">{children}</p>;
}

/**
 * Grants that name something the Member cannot be given.
 *
 * **Shown rather than dropped in silence**, because both ways of getting here
 * are things an owner would want to know: the row was deleted, or it sits under
 * a Project this dialog is about to untick. The sentence covers both, since the
 * Member is in the same position either way and claiming "no longer exists" of
 * the second would be false.
 *
 * The count is derived and the noun agrees with it — writing "3 grants" beside a
 * computed number is exactly the "1 variables" defect. Nothing renders at all when the
 * count is zero.
 */
export function StrandedGrants({
  ids,
  subject = "person",
}: {
  ids: string[];
  /** Who the grant is for — an Agent's dialog says so. */
  subject?: "person" | "Agent";
}) {
  if (ids.length === 0) return null;
  return (
    <p className="text-meta text-tx-2">
      {counted(ids.length, "grant names", "grants name")} a Project, Environment
      or Service this {subject} cannot be given — it has been deleted, or it
      sits under something {subject === "Agent" ? "it is" : "they are"} not
      being granted. Saving removes{" "}
      {ids.length === 1 ? "it" : "them"}:{" "}
      <span className="font-mono wrap-anywhere text-tx-3">{ids.join(", ")}</span>
    </p>
  );
}
