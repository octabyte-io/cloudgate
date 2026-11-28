import { Card } from "@/components/console/card";
import { DataTable, type Column } from "@/components/console/data-table";
import { MetaStrip } from "@/components/console/meta-strip";
import { QAList, QARow } from "@/components/console/qa-row";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Icon } from "@/lib/design/icons";

import {
  BACKUPS,
  LINES,
  SERVER,
  perMonth,
  takenOn,
  type BackupRow,
} from "./fixtures";

/**
 * The pieces of today's Bought Server card (`settings/bought-server-card.tsx`
 * and `server-backup-list.tsx`), drawn from fixtures so each variant can lay
 * them out its own way. Copy follows the shipped card; nothing here is new
 * wording except where a variant needs a heading.
 */

const COLUMNS: Column<BackupRow>[] = [
  {
    id: "taken",
    head: "Taken",
    tone: "key",
    cell: (backup) => takenOn(backup.takenAt),
  },
  {
    id: "kind",
    head: "Kind",
    tone: "muted",
    cell: (backup) => (backup.id === 6 ? "Taken now" : "Daily"),
  },
  {
    id: "size",
    head: "Size",
    tone: "num",
    cell: (backup) =>
      backup.sizeGb === null ? "Being made" : `${backup.sizeGb} GB`,
  },
  {
    id: "actions",
    head: <span className="sr-only">Actions</span>,
    cell: () => (
      <Button type="button" size="xs">
        <Icon name="restore" size={13} />
        Restore
      </Button>
    ),
  },
];

/** The Server backups, newest first, with Restore on each. */
export function BackupTable() {
  return (
    <DataTable
      label={`Server backups of ${SERVER.name}`}
      columns={COLUMNS}
      rows={BACKUPS}
      getRowId={(backup) => String(backup.id)}
    />
  );
}

/** The switch row, as the card has it today. */
export function BackupsSwitchRow() {
  return (
    <QARow
      title="Daily backups"
      description={`On · ${perMonth(400)}. A copy of the Server's own disk every day, the last 7 kept. They don't include extra storage.`}
      action={<Switch checked aria-label="Backups" />}
    />
  );
}

/** Everything about backups in one card: switch, strip, list. */
export function BackupsCard({ withButton = true }: { withButton?: boolean }) {
  return (
    <Card>
      <Card.Header
        title="Server backups"
        sub="A copy of the whole disk, one a day, the last 7 kept."
        headingLevel={2}
        actions={
          withButton ? (
            <Button type="button" size="sm">
              Back up now
            </Button>
          ) : null
        }
      />
      <Card.Body>
        <QAList>
          <BackupsSwitchRow />
        </QAList>
      </Card.Body>
      <MetaStrip className="border-t">
        <strong>6 Server backups</strong> kept, at most 7. The newest is from{" "}
        <strong>{takenOn(BACKUPS[0].takenAt)}</strong>.
      </MetaStrip>
      <Card.Body flush>
        <BackupTable />
      </Card.Body>
    </Card>
  );
}

/** Size and extra storage, each with its own change. */
export function MachineCard() {
  return (
    <Card>
      <Card.Header
        title="Size and storage"
        sub="Each change asks first and says what it costs."
        headingLevel={2}
      />
      <Card.Body>
        <QAList>
          <QARow
            title="Size"
            description={`${SERVER.size}. A bigger size restarts the Server; the disk never shrinks.`}
            action={
              <Button type="button" size="sm">
                Change size
              </Button>
            }
          />
          <QARow
            title="Extra storage"
            description={`100 GB · ${perMonth(1100)}. A volume beside the Server's own disk, not in its backups.`}
            action={
              <Button type="button" size="sm">
                Change storage
              </Button>
            }
          />
        </QAList>
      </Card.Body>
    </Card>
  );
}

/** What it costs, line by line. */
export function CostCard() {
  return (
    <Card>
      <Card.Header
        title="What you pay"
        sub="On your plan's invoice, monthly in advance."
        headingLevel={2}
      />
      <Card.Body className="grid gap-2 text-body">
        {LINES.map((line) => (
          <div
            key={line.label}
            className="flex justify-between gap-3 text-tx-2"
          >
            <span>{line.label}</span>
            <span className="tabular-nums">{perMonth(line.monthlyCents)}</span>
          </div>
        ))}
        <div className="flex justify-between gap-3 border-t border-line pt-2 font-semibold text-tx">
          <span>Total</span>
          <span className="tabular-nums">{perMonth(SERVER.monthlyCents)}</span>
        </div>
      </Card.Body>
    </Card>
  );
}

/** Where and what it is, for the aside. */
export function FactsCard() {
  const facts = [
    ["Location", SERVER.location],
    ["Image", SERVER.image],
    ["Bought", "12 Oct 2026"],
    ["Renews", "1 Dec 2026"],
  ];
  return (
    <Card>
      <Card.Header title="About this Server" headingLevel={2} />
      <Card.Body className="grid gap-2 text-body">
        {facts.map(([label, value]) => (
          <div key={label} className="flex justify-between gap-3">
            <span className="text-tx-3">{label}</span>
            <span className="text-right text-tx">{value}</span>
          </div>
        ))}
      </Card.Body>
    </Card>
  );
}

/** Delete, which for a Bought Server destroys the machine (PR #195's wording). */
export function DeleteCard() {
  return (
    <Card>
      <Card.Body>
        <QAList>
          <QARow
            title={`Delete ${SERVER.name}`}
            description="Cloudgate deletes the machine it bought, with its data and its backups. This cannot be undone."
            action={
              <Button type="button" size="sm" variant="dngr">
                Delete Server
              </Button>
            }
          />
        </QAList>
      </Card.Body>
    </Card>
  );
}
