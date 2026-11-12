import { Chip } from "@/components/console/chip";
import { Dash } from "@/components/console/dash";
import { DiffView } from "@/components/console/diff-view";
import { KVList, KVRow } from "@/components/console/kv-list";
import { Modal } from "@/components/console/modal";
import { Button } from "@/components/ui/button";
import type { AuditLogEntry } from "@/lib/api/endpoints/audit-logs";
import { timeExact } from "@/lib/format/time";

import { ActorName, actorName, auditActor } from "./audit-actor";
import { OUTCOME_LABELS } from "./audit-filters";

/**
 * One entry, read in full.
 *
 * The table can carry six columns; a row has thirteen fields and the two that
 * matter most for "what actually changed" — `metadata` and `resourceId` — are
 * the two a table has no room for. So this is the detail view the brief asks
 * for, and its whole job is to be readable rather than complete-looking.
 *
 * ## The change is a diff only when the row really is one
 *
 * The prototype's `.diff` (`e-console.html:782-798`) is the reference for this
 * screen, and `metadata` is where a change would live — but the column is `text`
 * and every writer serialises into it independently. What is actually in there,
 * on a real instance: `{"before":"member","after":"read-only"}` from a role
 * change, and `{"type":"inviteMember","role":"member"}` from an invitation.
 *
 * So the rule is: a `before`/`after` pair **is** a diff and is rendered as one,
 * with F04's `DiffView` and its own vocabulary. Anything else is rendered as
 * what it is — a list of pairs — because dressing an arbitrary object as a diff
 * would put `−` and `+` signs against values that were never a change.
 *
 * Everything here parses defensively. A malformed `metadata` shows the raw
 * string rather than throwing: one bad row must not take the trail with it, and
 * the raw text is still the most useful thing available when it happens.
 */
export function AuditDetailModal({
  entry,
  onClose,
}: {
  entry: AuditLogEntry;
  onClose: () => void;
}) {
  const metadata = parseMetadata(entry.metadata);
  const actor = auditActor(entry);

  return (
    <Modal open onOpenChange={(next) => !next && onClose()}>
      <Modal.Header
        title={`${entry.action} · ${entry.resourceType}`}
        description={
          entry.resourceName
            ? `On ${entry.resourceName}.`
            : "This entry records no name for what it acted on."
        }
      />
      <Modal.Body className="grid gap-4">
        <KVList>
          {/* An Agent is named with its marker and never by its synthetic
              address — see `auditActor`. */}
          <KVRow
            label="Who"
            value={<ActorName actor={actor} />}
            title={actorName(actor) ?? undefined}
          />
          <KVRow
            label="Their role at the time"
            value={<Chip>{actor.role}</Chip>}
          />
          <KVRow
            label="Outcome"
            value={OUTCOME_LABELS[entry.outcome] ?? entry.outcome}
          />
          <KVRow
            label="When"
            value={
              <time dateTime={entry.createdAt}>
                {timeExact(entry.createdAt)}
              </time>
            }
            title={timeExact(entry.createdAt)}
          />
          <KVRow label="Action" value={entry.action} />
          <KVRow label="Kind" value={entry.resourceType} />
          <KVRow
            label="Name"
            value={entry.resourceName ?? <Dash word="None" />}
            title={entry.resourceName ?? undefined}
          />
          <KVRow
            label="Id"
            mono
            title={entry.resourceId ?? undefined}
            value={entry.resourceId ?? <Dash word="None" />}
          />
          {/* `''` is what a request with no resolvable address records, and
              `null` is what a write with no request behind it does — a cron, a
              boot hook. Two absences, two words. */}
          <KVRow
            label="From"
            mono={!!entry.ip}
            value={
              entry.ip ? (
                entry.ip
              ) : entry.ip === "" ? (
                <Dash word="Not recorded" />
              ) : (
                <Dash word="No request" />
              )
            }
          />
        </KVList>

        {metadata.kind === "change" ? (
          <div className="grid gap-1.5">
            <p className="text-meta font-medium text-tx-3">What changed</p>
            <DiffView
              label={`${entry.resourceName ?? entry.resourceType}, before and after`}
              rows={[
                { kind: "del", text: metadata.before },
                { kind: "add", text: metadata.after },
              ]}
            />
          </div>
        ) : metadata.kind === "pairs" ? (
          <div className="grid gap-1.5">
            <p className="text-meta font-medium text-tx-3">Recorded with it</p>
            <KVList>
              {metadata.pairs.map(([key, value]) => (
                <KVRow key={key} label={key} mono title={value} value={value} />
              ))}
            </KVList>
          </div>
        ) : metadata.kind === "raw" ? (
          <div className="grid gap-1.5">
            <p className="text-meta font-medium text-tx-3">
              Recorded with it, as stored
            </p>
            <pre className="overflow-x-auto rounded-lg border border-line bg-panel-2 p-3 font-mono text-meta text-tx-2">
              {metadata.text}
            </pre>
          </div>
        ) : null}
      </Modal.Body>
      <Modal.Footer>
        <Button type="button" onClick={onClose}>
          Close
        </Button>
      </Modal.Footer>
    </Modal>
  );
}

type ParsedMetadata =
  | { kind: "none" }
  | { kind: "change"; before: string; after: string }
  | { kind: "pairs"; pairs: [string, string][] }
  | { kind: "raw"; text: string };

/**
 * `metadata` as something renderable, without ever claiming more than it says.
 *
 * A `before`/`after` pair of scalars is the only shape treated as a change.
 * Nesting is stringified rather than walked: a recursive renderer for a column
 * nothing validates would be a lot of code for rows that do not exist yet.
 */
function parseMetadata(raw: string | null): ParsedMetadata {
  if (!raw) return { kind: "none" };

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { kind: "raw", text: raw };
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { kind: "raw", text: raw };
  }

  const record = value as Record<string, unknown>;
  if ("before" in record && "after" in record) {
    return {
      kind: "change",
      before: scalar(record.before),
      after: scalar(record.after),
    };
  }

  const pairs = Object.entries(record).map(
    ([key, entry]) => [key, scalar(entry)] as [string, string],
  );
  return pairs.length > 0 ? { kind: "pairs", pairs } : { kind: "none" };
}

const scalar = (value: unknown): string =>
  typeof value === "string" ? value : JSON.stringify(value);
