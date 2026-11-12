import { cloneElement, useState } from "react";

import { Picker } from "@/components/console/picker";
import { SearchInput } from "@/components/console/search-input";
import { Toolbar, ToolbarGap } from "@/components/console/toolbar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  AUDIT_ACTIONS,
  AUDIT_OUTCOMES,
  AUDIT_RESOURCE_TYPES,
  type AuditAction,
  type AuditActorKind,
  type AuditOutcome,
  type AuditResourceType,
} from "@/lib/api/endpoints/audit-logs";

export type AuditFilterState = {
  userEmail: string;
  actor: AuditActorKind | "";
  resourceName: string;
  action: AuditAction | "";
  resourceType: AuditResourceType | "";
  outcome: AuditOutcome | "";
  from: string;
  to: string;
};

export const EMPTY_FILTERS: AuditFilterState = {
  userEmail: "",
  actor: "",
  resourceName: "",
  action: "",
  resourceType: "",
  outcome: "",
  from: "",
  to: "",
};

/**
 * The filter row, built from `listAuditLogsSchema` and nothing else.
 *
 * **The two text filters and the two pickers do not behave the same way**, and
 * that is stated on the controls rather than left to be discovered: `userEmail`
 * and `resourceName` are `ilike '%…%'` substring matches, while `action` and
 * `resourceType` are exact and closed. So the text boxes say "contains" and the
 * pickers offer exactly the vocabulary the trail writes, straight from the DTO's
 * own enums.
 *
 * The enums here are **the DTO's**, and they hold what the trail
 * writes and nothing more: every entry it records is filterable here, and no
 * option names a kind or action that nothing writes — which is what the Kind
 * picker used to be for twenty-seven of its thirty options.
 *
 * `userId` is in the schema and is deliberately not offered as a control: it
 * is an exact match on a nanoid, and a filter you can only use by pasting an id
 * out of a database is a control that looks usable and is not. It arrives by
 * link instead — `?userId=` on the page's address, from the Agents section —
 * and `AuditSection` says so above the table.
 *
 * **Outcome** is exact and closed like the other pickers: `succeeded`,
 * `refused` or `failed`. Its value lives in the page's address (`?outcome=`)
 * rather than in local state, so a link can open the trail on one Agent's
 * refusals; `AuditSection` does that plumbing and this control does not know.
 *
 * **Actor** is the one way to find the rows the platform wrote with no
 * caller, an expired Requested preview's teardown among them: they have no
 * address, so "Email contains" can never match one. Exact and closed, like
 * the other pickers.
 *
 * The dates are `datetime-local` inputs and are sent as ISO strings, because
 * `from`/`to` are `z.coerce.date()`. A native picker rather than a component:
 * this is one bounded range on one screen, and it is the one control on it that
 * the operating system already renders in the reader's own locale and calendar.
 *
 * **Below the `hd` breakpoint the exact filters fold behind a Filters button**.
 * Six labelled controls wrapped raggedly at 390px and filled the first
 * screen before any entry. The two "contains" boxes stay out, since they are
 * the filters someone reaches for first; the button says how many of the folded
 * ones are set, so a narrowed trail never looks like the whole one. At `hd` and
 * up the group is `display: contents` and the row is exactly as it was.
 */
export function AuditFilters({
  value,
  onChange,
}: {
  value: AuditFilterState;
  onChange: (next: AuditFilterState) => void;
}) {
  const set = <K extends keyof AuditFilterState>(
    key: K,
    next: AuditFilterState[K],
  ) => onChange({ ...value, [key]: next });

  const dirty = Object.values(value).some((entry) => entry !== "");
  const [open, setOpen] = useState(false);
  const folded = FOLDED.filter((key) => value[key] !== "").length;

  return (
    <Toolbar className="px-4 py-3">
      <SearchInput
        label="Filter by who did it"
        placeholder="Email contains…"
        value={value.userEmail}
        onChange={(event) => set("userEmail", event.target.value)}
      />
      <SearchInput
        label="Filter by what it was done to"
        placeholder="Name contains…"
        value={value.resourceName}
        onChange={(event) => set("resourceName", event.target.value)}
      />
      <Button
        type="button"
        size="sm"
        className="hd:hidden"
        aria-expanded={open}
        aria-controls={MORE_ID}
        onClick={() => setOpen((was) => !was)}
      >
        {folded > 0 ? `Filters (${folded})` : "Filters"}
      </Button>
      <div
        id={MORE_ID}
        data-open={open || undefined}
        className="contents max-hd:hidden max-hd:data-open:contents"
      >
        <Labelled label="Actor">
          <Picker
            value={value.actor}
            onValueChange={(next) => set("actor", next as AuditActorKind | "")}
            className="w-36"
            options={[
              { value: "", label: "Anyone" },
              { value: "platform", label: "The platform" },
            ]}
          />
        </Labelled>
        <Labelled label="Action">
          <Picker
            value={value.action}
            onValueChange={(next) => set("action", next as AuditAction | "")}
            className="w-40"
            options={[{ value: "", label: "Any action" }, ...ACTION_OPTIONS]}
          />
        </Labelled>
        <Labelled label="Kind">
          <Picker
            value={value.resourceType}
            onValueChange={(next) =>
              set("resourceType", next as AuditResourceType | "")
            }
            className="w-44"
            options={[{ value: "", label: "Any kind" }, ...KIND_OPTIONS]}
          />
        </Labelled>
        <Labelled label="Outcome">
          <Picker
            value={value.outcome}
            onValueChange={(next) => set("outcome", next as AuditOutcome | "")}
            className="w-36"
            options={[{ value: "", label: "Any outcome" }, ...OUTCOME_OPTIONS]}
          />
        </Labelled>
        <ToolbarGap />
        <Labelled label="From">
          <Input
            type="datetime-local"
            value={value.from}
            className="w-auto"
            onChange={(event) => set("from", event.target.value)}
          />
        </Labelled>
        <Labelled label="To">
          <Input
            type="datetime-local"
            value={value.to}
            className="w-auto"
            onChange={(event) => set("to", event.target.value)}
          />
        </Labelled>
      </div>
      <Button
        type="button"
        size="sm"
        variant="qt"
        aria-disabled={dirty ? undefined : true}
        onClick={() => dirty && onChange(EMPTY_FILTERS)}
      >
        Clear filters
      </Button>
    </Toolbar>
  );
}

const MORE_ID = "audit-filters-more";

/** The filters the Filters button folds away below `hd`. */
const FOLDED = [
  "actor",
  "action",
  "resourceType",
  "outcome",
  "from",
  "to",
] as const satisfies readonly (keyof AuditFilterState)[];

/**
 * A label beside a control that is not an `<input>`.
 *
 * `Picker` is a **button**, so it cannot be labelled by wrapping it — a `<label>`
 * around a button labels nothing. `htmlFor`/`id` is the wiring that works for
 * both, which is why the id is generated here rather than left to the caller.
 */
function Labelled({
  label,
  children,
}: {
  label: string;
  children: React.ReactElement<{ id?: string }>;
}) {
  const id = `audit-filter-${label.toLowerCase()}`;
  return (
    <div className="flex items-center gap-1.75">
      <label htmlFor={id} className="text-meta whitespace-nowrap text-tx-2">
        {label}
      </label>
      {cloneElement(children, { id })}
    </div>
  );
}

/**
 * The two vocabularies, **sorted** rather than in the DTO's own order.
 *
 * `design-system.md` says a list past ~20 options wants a filterable control
 * rather than a `Picker`, and the resource types are well over that line. The rule
 * was written for the unbounded case — a git connection's repositories, which
 * nobody can guess the contents of. This is the opposite: a **closed, fixed
 * vocabulary of known words**, and Base UI's Select brings typeahead, so
 * typing `dep` lands on `deployment`. Sorting is what makes that true; the DTO's
 * order is the order somebody wrote the union in, which is meaningless to a
 * person hunting for `sshKey`.
 */
const ACTION_OPTIONS = [...AUDIT_ACTIONS]
  .sort((a, b) => a.localeCompare(b))
  .map((action) => ({ value: action, label: action }));

const KIND_OPTIONS = [...AUDIT_RESOURCE_TYPES]
  .sort((a, b) => a.localeCompare(b))
  .map((kind) => ({ value: kind, label: kind }));

/**
 * The three outcomes in the schema's order, which is also the reading order —
 * the usual case first. Capitalised as words, because unlike an action or a
 * kind nobody types these to find them.
 */
export const OUTCOME_LABELS: Record<AuditOutcome, string> = {
  succeeded: "Succeeded",
  refused: "Refused",
  failed: "Failed",
};

const OUTCOME_OPTIONS = AUDIT_OUTCOMES.map((outcome) => ({
  value: outcome,
  label: OUTCOME_LABELS[outcome],
}));

/**
 * A `datetime-local` value as the ISO string the DTO coerces.
 *
 * The input hands back local wall-clock time with no zone (`2026-08-06T14:30`),
 * so `new Date` reads it as local — which is what somebody typing a time means —
 * and `toISOString` puts it in the zone the backend compares in. An unparseable
 * value yields `undefined` rather than `Invalid Date`, which would otherwise
 * reach the query string as the literal text and come back a 400.
 */
export function toIso(value: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}
