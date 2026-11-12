import { Skeleton } from "@/components/console/skeleton";
import {
  STATIC_ROLES,
  type RolePermissions,
  type RoleVocabulary,
} from "@/lib/api/endpoints/roles";

import { PermissionGrid } from "./permission-grid";

/**
 * What the chosen role is allowed to do, read-only.
 *
 * `explainBypass` is on only for a built-in role, because "not checked for the
 * built-in roles" is a true statement about owner and admin and a meaningless one
 * about a role somebody defined. A failed vocabulary read leaves the change possible
 * but undescribed, which is the honest pairing — the grid is an explanation, not a
 * precondition.
 *
 * "Is this a built-in role" is asked of `STATIC_ROLES`, the reserved-name
 * contract, rather than of the vocabulary's `staticRoles` — the two agree,
 * and this one is answerable without a request, which the branch above needs
 * because it also runs when the vocabulary is the thing that did not arrive.
 *
 * ## `pending` exists because "undefined" was two different answers
 *
 * **What broke first: this panel told the operator a read had failed while it
 * was still happening**.
 * The fallback ran on `vocabulary === undefined`, and a query in flight has no
 * data either — so opening the change-role dialog on a cold cache showed
 * *"Cloudgate could not read the permission table"* for the length of the round
 * trip that was about to succeed. §3.5 orders the terminal states `error` →
 * `isPending` → `empty` for precisely this, and §3.10 makes choosing the wrong
 * one a defect rather than a rough edge: a request in flight is not a failure,
 * on the same reasoning as "a refusal is not an empty list".
 *
 * Pre-existing rather than new: the query was `usePermissionStatements`
 * before and the window is identical. It is noted on its own because the
 * care went into `use-permission.ts` answering `pending: true` instead of "not
 * allowed" in exactly this window — the hook got it right and this component
 * did not.
 *
 * **A `pending` prop rather than reading the query here.** `ChangeRoleModal`
 * already holds `useRoleVocabulary()` — it needs `data.staticRoles[role]` for
 * the `permissions` it passes — so a second call would be the same cache entry
 * read twice and this component would stop being a pure function of what it
 * renders. Threading it is the one thing that change declined to do, being a change to
 * a component it had no other reason to touch.
 *
 * **The skeleton is sized to the grid's row rhythm and not to its height**,
 * which is the honest reading of §3.10 here rather than a shortcut: the grid
 * renders one row per declared statement, so the height it will occupy *is* the
 * answer being waited for and cannot be reserved before it arrives. Six rows at
 * the grid's own spacing is what keeps the dialog from resizing under the
 * pointer while the picker above it stays where it is.
 *
 * `SectionPending` is the console's version of this and does not fit: it draws
 * its own `Card`, and this panel is already inside a dialog body — nesting one
 * would double the border and the padding, which is `section-states.tsx`' own
 * argument against nesting a `Page`.
 */
export function RolePreview({
  role,
  permissions,
  vocabulary,
  /** The vocabulary read is in flight, so its absence is not a refusal. */
  pending,
}: {
  role: string;
  permissions: RolePermissions;
  vocabulary: RoleVocabulary | undefined;
  pending: boolean;
}) {
  return (
    <div
      className="rounded-lg border border-line bg-panel-2 p-3.5"
      aria-busy={!vocabulary && pending ? "true" : undefined}
    >
      <p className="mb-1.5 text-body font-medium text-tx">
        What {role} is allowed to do
      </p>
      {vocabulary ? (
        <PermissionGrid
          vocabulary={vocabulary}
          value={permissions}
          readOnly
          explainBypass={STATIC_ROLES.includes(role)}
        />
      ) : pending ? (
        <div className="grid gap-0">
          {Array.from({ length: 6 }, (_, index) => (
            <div
              key={index}
              className="flex items-baseline gap-x-4 border-b border-line py-2.5 last:border-b-0"
            >
              <Skeleton
                className="h-4"
                style={{ width: `${8 - (index % 3)}rem` }}
              />
              <Skeleton className="h-4 w-24" />
            </div>
          ))}
        </div>
      ) : (
        <p className="text-meta text-tx-2">
          Cloudgate could not read the permission table, so this change can still be
          made but not described.
        </p>
      )}
    </div>
  );
}
