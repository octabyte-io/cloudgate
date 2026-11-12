"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";

import { Card } from "@/components/console/card";
import { Chip } from "@/components/console/chip";
import { DataTable } from "@/components/console/data-table";
import { Dash } from "@/components/console/dash";
import { EmptyState } from "@/components/console/empty-state";
import { MetaStrip } from "@/components/console/meta-strip";
import { Pager } from "@/components/console/pager";
import { RowSub, RowTime } from "@/components/console/rows/cells";
import { Button } from "@/components/ui/button";
import {
  AUDIT_OUTCOMES,
  type AuditLogEntry,
  type AuditOutcome,
  type AuditScope,
} from "@/lib/api/endpoints/audit-logs";
import { useArrival } from "@/components/console/use-arrival";
import { cn } from "@/lib/utils";

import { SectionFailed, SectionPending } from "../../settings/section-states";
import { ActorName, actorLabel, auditActor } from "./audit-actor";
import {
  AuditFilters,
  EMPTY_FILTERS,
  OUTCOME_LABELS,
  toIso,
  type AuditFilterState,
} from "./audit-filters";
import { AuditDetailModal } from "./audit-detail-modal";
import { useAuditLogs } from "./use-audit-logs";

const PAGE_SIZE = 25;

/**
 * The trail: who did what, and when.
 *
 * **Not behind `LicenseGate`, and that is the audit rather than an oversight.**
 * `audit-log.controller.ts` says out loud that this route deliberately carries no
 * licence gate; the only check is `@RequirePermission('auditLog', 'read')`. So it works on an
 * unlicensed instance, and putting it behind the gate would have invented a
 * refusal — the exact mistake the gate exists to prevent, in the other
 * direction.
 *
 * What it *is* gated by is a permission, and the refusal is a **403 about the
 * reader's role** — which is the one case where F02's "your role does not allow
 * this" is precisely right. `auditLog` sits in `ENTERPRISE_ONLY_RESOURCES`, so
 * owner and admin bypass the check and a plain member is denied.
 *
 * ## Sorting is the server's, and the header does not pretend otherwise
 *
 * `findAll` orders by `createdAt` descending and takes no sort input, so the
 * columns carry **no `compare`** — a sortable header here would reorder the 25
 * rows in front of you and silently leave the other 300 where they were, which
 * is worse than not offering it. Newest first is the only order, and the meta
 * strip says the window rather than implying the whole.
 *
 * ## The header says what is recorded, not "every security-relevant action"
 *
 * That sentence was the card's subtitle while only sign-ins, users and
 * invitations were written. `AuditInterceptor` records every successful
 * mutating request a signed-in person makes; their reads, connection tests and
 * refused requests are not recorded, and neither is anything with no signed-in
 * caller behind it. An Agent is the other way round: every call it
 * makes is a row, reads included, whether it succeeded, was refused or failed.
 * The copy says exactly that, and the Outcome filter finds the refusals.
 *
 * ## Two filters live in the address
 *
 * `?userId=` and `?outcome=` are read from the URL rather than held here, so
 * the Agents section can link to one Agent's trail, or to its refusals.
 * `userId` has no control — nobody types a nanoid — so when it is set a strip
 * names whose entries these are and offers the way back to everyone. The page
 * is rendered on demand for the reason `page.tsx` gives.
 *
 * ## An Agent is named, never addressed
 *
 * An Agent's row is recognised by its role and named by the name written with
 * the row, with an "Agent" marker; its synthetic address never renders. See
 * `auditActor`.
 *
 * ## Entries from deleted Organizations
 *
 * Deleting an Organization keeps its entries (the FK is `set null`) but they no
 * longer belong to any Organization, so this Organization's trail cannot show
 * them. The backend answers `deletedOrganizationEntries` — how many
 * there are — to a caller with instance authority, and serves them under
 * `scope=deleted-organizations`; everyone else gets `null` and a sentence
 * saying who can read them, so the trail never shrinks silently.
 */
export function AuditSection() {
  const address = useAuditAddress();
  const [local, setLocal] = useState<AuditFilterState>(EMPTY_FILTERS);
  // The page is remembered against the address it was turned on, so a link
  // that changes `userId` or `outcome` opens its own first page rather than
  // page four of somebody else's question — derived, not reset in an effect.
  const [paged, setPaged] = useState({ address: address.key, offset: 0 });
  const offset = paged.address === address.key ? paged.offset : 0;
  const setOffset = (next: number) =>
    setPaged({ address: address.key, offset: next });
  const [open, setOpen] = useState<AuditLogEntry | null>(null);
  const [scope, setScope] = useState<AuditScope>("organization");

  const filters: AuditFilterState = {
    ...local,
    outcome: address.outcome ?? "",
  };

  const query = useAuditLogs(
    useMemo(
      () => ({
        scope,
        userId: address.userId,
        userEmail: local.userEmail || undefined,
        actor: local.actor || undefined,
        resourceName: local.resourceName || undefined,
        action: local.action || undefined,
        resourceType: local.resourceType || undefined,
        outcome: address.outcome,
        from: toIso(local.from),
        to: toIso(local.to),
        limit: PAGE_SIZE,
        offset,
      }),
      [address.userId, address.outcome, local, offset, scope],
    ),
  );

  const arrival = useArrival(query.isPending);
  if (query.isPending) return <SectionPending title="Audit log" rows={6} />;

  if (query.error) {
    return (
      <SectionFailed title="Audit log" error={query.error}>
        Reading the trail needs the <code className="font-mono">auditLog</code>{" "}
        permission, which the owner and admin roles hold and the member role does
        not. It does not need an enterprise license.
      </SectionFailed>
    );
  }

  const { logs, total, deletedOrganizationEntries } = query.data;
  const filtered =
    Object.values(filters).some((entry) => entry !== "") || !!address.userId;
  const deletedScope = scope === "deleted-organizations";
  const switchTo = (next: AuditScope) => {
    setScope(next);
    setOffset(0);
  };

  return (
    <div className={cn("grid gap-5.5", arrival)}>
      <Card aria-busy={query.isFetching || undefined}>
        <Card.Header
          title="Audit log"
          sub={
            deletedScope
              ? "Entries recorded in Organizations that have since been deleted, newest first. They no longer say which Organization they came from."
              : "Every create, change, delete and deploy a signed-in member made in this Organization, through the console or the API, every sign-in and sign-out, and every call an Agent makes, whether it succeeded, was refused or failed — newest first."
          }
          headingLevel={2}
        />

        <AuditFilters
          value={filters}
          onChange={({ outcome, ...next }) => {
            setLocal({ ...next, outcome: "" });
            if (outcome !== filters.outcome) {
              address.set({ outcome: outcome || undefined });
            }
            // A narrowed question starts at its own first page. Keeping the
            // offset would open a filtered list on page four of a result set
            // that may only have one — an empty table that looks like "no
            // matches" and is really "past the end".
            setOffset(0);
          }}
        />

        <MetaStrip>
          {filtered ? (
            <>
              <strong className="num">{total}</strong>{" "}
              {total === 1 ? "entry matches" : "entries match"} these filters.
              Email and name match on any part of the value; action and kind
              match exactly.
            </>
          ) : (
            <>
              <strong className="num">{total}</strong>{" "}
              {total === 1 ? "entry" : "entries"}{" "}
              recorded. A person&apos;s reads, connection tests and refused
              requests are not recorded.
              {/* The trail is append-only: nothing in the console edits or
                  removes an entry, so there is no control for it here. */}
            </>
          )}
        </MetaStrip>

        {address.userId ? (
          <OneActorStrip
            logs={logs}
            onShowEveryone={() => address.set({ userId: undefined })}
          />
        ) : null}

        <DeletedOrganizationsStrip
          scope={scope}
          count={deletedOrganizationEntries}
          onSwitch={switchTo}
        />

        <Card.Body flush>
          <DataTable<AuditLogEntry>
            label="Audit log entries"
            rows={logs}
            getRowId={(row) => row.auditLogId}
            empty={
              <EmptyState
                icon="list"
                title={
                  filtered
                    ? "Nothing matches those filters"
                    : deletedScope
                      ? "No entries from deleted Organizations"
                      : "Nothing yet"
                }
              >
                {filtered
                  ? "Try a wider date range, or clear one of the filters."
                  : deletedScope
                    ? "Every entry on this instance belongs to an Organization that still exists."
                    : "Actions are recorded as they happen. Invite somebody, create a Project, or change a role and the entry appears here."}
              </EmptyState>
            }
            columns={[
              {
                id: "when",
                head: "When",
                className: "w-44",
                cell: (row) => <RowTime iso={row.createdAt} />,
              },
              {
                id: "who",
                head: "Who",
                tone: "key",
                cell: (row) => <WhoCell entry={row} />,
              },
              {
                id: "action",
                head: "Action",
                cell: (row) => <Chip>{row.action}</Chip>,
              },
              {
                id: "outcome",
                head: "Outcome",
                className: "w-28",
                cell: (row) => OUTCOME_LABELS[row.outcome] ?? row.outcome,
              },
              {
                id: "subject",
                head: "What",
                tone: "wrap",
                cell: (row) => (
                  <span className="block min-w-0">
                    {row.resourceName ?? <Dash word="Unnamed" />}
                    <RowSub>{row.resourceType}</RowSub>
                  </span>
                ),
              },
              {
                id: "detail",
                head: <span className="sr-only">Detail</span>,
                className: "w-24",
                cell: (row) => (
                  <Button
                    type="button"
                    size="xs"
                    variant="qt"
                    onClick={() => setOpen(row)}
                  >
                    Details
                  </Button>
                ),
              },
            ]}
          />
        </Card.Body>

        {total > PAGE_SIZE ? (
          <Pager
            shown={logs.length}
            total={total}
            noun="Audit log"
            from={offset + 1}
            onPrevious={
              offset > 0
                ? () => setOffset(Math.max(0, offset - PAGE_SIZE))
                : undefined
            }
            onNext={
              offset + logs.length < total
                ? () => setOffset(offset + PAGE_SIZE)
                : undefined
            }
          />
        ) : null}
      </Card>

      {open ? (
        <AuditDetailModal entry={open} onClose={() => setOpen(null)} />
      ) : null}
    </div>
  );
}

/**
 * The two filters the page's address carries, and the one way to
 * change them.
 *
 * An `outcome` the trail does not write is read as none: the DTO would answer
 * it with a 400, and a hand-edited link is not worth a failed screen. `set`
 * replaces rather than pushes, because narrowing a list is not a place Back
 * should step through.
 */
function useAuditAddress() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const userId = params.get("userId") || undefined;
  const raw = params.get("outcome");
  const outcome: AuditOutcome | undefined = AUDIT_OUTCOMES.find(
    (known) => known === raw,
  );

  const set = (next: { userId?: string; outcome?: AuditOutcome }) => {
    const updated = new URLSearchParams(params.toString());
    for (const [name, value] of Object.entries(next)) {
      if (value) updated.set(name, value);
      else updated.delete(name);
    }
    const search = updated.toString();
    router.replace(search ? `${pathname}?${search}` : pathname, {
      scroll: false,
    });
  };

  return { userId, outcome, key: `${userId ?? ""}|${outcome ?? ""}`, set };
}

/**
 * Who acted: an Agent by name with an "Agent" marker and its role, a person by
 * address and role. An Agent's address is never rendered — see `auditActor`.
 */
function WhoCell({ entry }: { entry: AuditLogEntry }) {
  const actor = auditActor(entry);
  return (
    <span className="block min-w-0">
      <ActorName actor={actor} />
      <RowSub>{actor.role}</RowSub>
    </span>
  );
}

/**
 * Says the list is one actor's, because `?userId=` has no control of its own
 * to show it. The actor is named from a row when there is one; an empty
 * page names nobody rather than printing an id.
 */
function OneActorStrip({
  logs,
  onShowEveryone,
}: {
  logs: AuditLogEntry[];
  onShowEveryone: () => void;
}) {
  const who = logs[0] ? actorLabel(auditActor(logs[0])) : "one member";
  return (
    <MetaStrip>
      Showing only the entries of {who}.{" "}
      <Button type="button" size="xs" variant="qt" onClick={onShowEveryone}>
        Show everyone
      </Button>
    </MetaStrip>
  );
}

/**
 * Where the entries of deleted Organizations are, in one line.
 *
 * `count` is `null` for a caller without instance authority: they are told who
 * can read those entries and nothing about how many there are, since the
 * number would describe other Organizations. A reader who can see them gets
 * the count and a way there — and nothing at all when there are none, which is
 * every single-Organization install that has never deleted one.
 */
function DeletedOrganizationsStrip({
  scope,
  count,
  onSwitch,
}: {
  scope: AuditScope;
  count: number | null;
  onSwitch: (next: AuditScope) => void;
}) {
  if (scope === "deleted-organizations") {
    return (
      <MetaStrip>
        These entries survived the deletion of their Organization. Only an
        owner or admin of the instance organization can read them.{" "}
        <Button
          type="button"
          size="xs"
          variant="qt"
          onClick={() => onSwitch("organization")}
        >
          Back to this Organization
        </Button>
      </MetaStrip>
    );
  }
  if (count === null) {
    return (
      <MetaStrip>
        Entries recorded in an Organization that has since been deleted are
        kept, and only an owner or admin of the instance organization can read
        them.
      </MetaStrip>
    );
  }
  if (count === 0) return null;
  return (
    <MetaStrip>
      <strong className="num">{count}</strong> more{" "}
      {count === 1 ? "entry was" : "entries were"} recorded in Organizations
      that have since been deleted, and this list cannot show{" "}
      {count === 1 ? "it" : "them"}.{" "}
      <Button
        type="button"
        size="xs"
        variant="qt"
        onClick={() => onSwitch("deleted-organizations")}
      >
        Show {count === 1 ? "it" : "them"}
      </Button>
    </MetaStrip>
  );
}
