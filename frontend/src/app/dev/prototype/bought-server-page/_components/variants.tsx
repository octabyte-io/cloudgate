import { Card } from "@/components/console/card";
import { Cols } from "@/components/console/cols";
import { DataTable, type Column } from "@/components/console/data-table";
import { MetaStrip } from "@/components/console/meta-strip";
import { Page } from "@/components/console/page";
import { PageHeader } from "@/components/console/page-header";
import { StatusPill } from "@/components/console/status-pill";
import { Button } from "@/components/ui/button";
import { Icon } from "@/lib/design/icons";
import type { Mark } from "@/lib/design/status";

import {
  BackupTable,
  BackupsCard,
  BackupsSwitchRow,
  CostCard,
  DeleteCard,
  FactsCard,
  MachineCard,
} from "./cards";
import {
  BACKUPS,
  BOUGHT,
  SERVER,
  perMonth,
  takenOn,
  type BoughtRow,
} from "./fixtures";
import { Frame, organizationRail, serverRail } from "./frame";
import { QAList } from "@/components/console/qa-row";

const READY: Mark = { glyph: "●", tone: "ok", label: "Ready" };
const STAGE: Record<BoughtRow["stage"], Mark> = {
  ready: READY,
  changing: { glyph: "◐", tone: "info", label: "Changing" },
  setting_up: { glyph: "◐", tone: "info", label: "Setting up" },
  waiting_for_payment: {
    glyph: "◐",
    tone: "warn",
    label: "Waiting for payment",
  },
};

/**
 * **A · One tab on each Bought Server.** The Server's own rail gets a
 * "Bought Server" row above Settings, shown only on a Server bought from
 * Cloudgate. Everything it is charged for and its backups are on that one
 * page; Settings keeps only what every Server has.
 */
export function VariantA() {
  return (
    <Frame
      crumb={`Servers / ${SERVER.name}`}
      rail={serverRail("Bought Server", [
        { kind: "item", label: "Bought Server", icon: "cash", isNew: true },
      ])}
    >
      <Page>
        <PageHeader
          title="Bought Server"
          icon="cash"
          badges={<StatusPill mark={READY} />}
          lede={`${SERVER.name}'s backups, size and storage, and what it costs.`}
          actions={
            <Button type="button">
              <Icon name="refresh" size={15} />
              Back up now
            </Button>
          }
        />
        <Cols
          asideLabel={`About ${SERVER.name}`}
          aside={
            <>
              <CostCard />
              <FactsCard />
            </>
          }
        >
          <BackupsCard withButton={false} />
          <MachineCard />
          <DeleteCard />
        </Cols>
      </Page>
    </Frame>
  );
}

const FLEET: Column<BoughtRow>[] = [
  {
    id: "name",
    head: "Server",
    tone: "key",
    cell: (row) => (
      <span className="flex flex-col">
        <span className="font-medium text-tx">{row.name}</span>
        <span className="text-meta text-tx-3">{row.location}</span>
      </span>
    ),
  },
  {
    id: "stage",
    head: "Stage",
    cell: (row) => <StatusPill mark={STAGE[row.stage]} />,
  },
  {
    id: "size",
    head: "Size",
    tone: "muted",
    cell: (row) => row.size.split(" · ").slice(0, 3).join(" · "),
  },
  {
    id: "backups",
    head: "Backups",
    cell: (row) =>
      row.backups && row.lastBackup ? (
        <span className="text-tx-2">On · last {takenOn(row.lastBackup)}</span>
      ) : (
        <span className="text-tx-3">Off</span>
      ),
  },
  {
    id: "cost",
    head: "Monthly",
    tone: "num",
    cell: (row) => perMonth(row.monthlyCents),
  },
  {
    id: "actions",
    head: <span className="sr-only">Actions</span>,
    cell: (row) =>
      row.stage === "waiting_for_payment" ? (
        <Button type="button" size="xs" variant="pri">
          Finish paying
        </Button>
      ) : (
        <Button type="button" size="xs">
          Manage
        </Button>
      ),
  },
];

/**
 * **B · A "Bought Servers" page in the Organization rail.** Every Server
 * bought from Cloudgate in one table, with its stage, backups and price,
 * the ones still being bought among them, and Buy a Server at the top.
 * Manage opens that Server's own page (variant A's).
 */
export function VariantB() {
  const total = BOUGHT.filter(
    (row) => row.stage !== "waiting_for_payment",
  ).reduce((sum, row) => sum + row.monthlyCents, 0);
  return (
    <Frame
      crumb="Bought Servers"
      rail={organizationRail("Bought Servers", [
        { kind: "item", label: "Bought Servers", icon: "cash", isNew: true },
      ])}
    >
      <Page>
        <PageHeader
          title="Bought Servers"
          icon="cash"
          lede="The Servers you bought from Cloudgate: their backups, size and what they cost."
          actions={
            <Button type="button" variant="pri">
              <Icon name="plus" size={15} />
              Buy a Server
            </Button>
          }
        />
        <Cols>
          <Card>
            <MetaStrip>
              <strong>3 Bought Servers</strong>,{" "}
              <strong>{perMonth(total)}</strong>
              {" on your plan's invoice. 1 is waiting for payment."}
            </MetaStrip>
            <Card.Body flush>
              <DataTable
                label="Bought Servers"
                columns={FLEET}
                rows={BOUGHT}
                getRowId={(row) => row.id}
              />
            </Card.Body>
          </Card>
        </Cols>
      </Page>
    </Frame>
  );
}

/**
 * **C · Backups as their own tab, the rest under Plan.** Backups are what a
 * customer comes back for, so they get a tab named for them, with the
 * newest backup and Back up now at the top. Size, storage, price and
 * Delete move to a "Plan" tab beside it.
 */
export function VariantC({ view }: { view: "backups" | "plan" }) {
  const rail = serverRail(view === "plan" ? "Plan" : "Backups", [
    { kind: "item", label: "Backups", icon: "restore", isNew: true },
    { kind: "item", label: "Plan", icon: "cash", isNew: true },
  ]);
  if (view === "plan") {
    return (
      <Frame crumb={`Servers / ${SERVER.name}`} rail={rail}>
        <Page>
          <PageHeader
            title="Plan"
            icon="cash"
            badges={<StatusPill mark={READY} />}
            lede={`What ${SERVER.name} is, and what it costs each month.`}
          />
          <Cols asideLabel="What you pay" aside={<CostCard />}>
            <MachineCard />
            <FactsCard />
            <DeleteCard />
          </Cols>
        </Page>
      </Frame>
    );
  }
  return (
    <Frame crumb={`Servers / ${SERVER.name}`} rail={rail}>
      <Page>
        <PageHeader
          title="Backups"
          icon="restore"
          lede={`Copies of ${SERVER.name}'s whole disk, to put it back as it was.`}
          actions={
            <Button type="button" variant="pri">
              <Icon name="refresh" size={15} />
              Back up now
            </Button>
          }
        />
        <Cols>
          <div className="grid gap-3 sm:grid-cols-3">
            {[
              ["Newest backup", takenOn(BACKUPS[0].takenAt)],
              ["Kept", "6 of 7"],
              ["Next daily backup", "Sat 29 Nov, around 03:00"],
            ].map(([label, value]) => (
              <Card key={label}>
                <Card.Body>
                  <p className="text-meta text-tx-3">{label}</p>
                  <p className="mt-1 text-sect text-tx">{value}</p>
                </Card.Body>
              </Card>
            ))}
          </div>
          <Card>
            <Card.Header
              title="Server backups"
              sub="Restore puts the disk back as it was then, after taking a safety copy."
              headingLevel={2}
            />
            <Card.Body flush>
              <BackupTable />
            </Card.Body>
          </Card>
          <Card>
            <Card.Body>
              <QAList>
                <BackupsSwitchRow />
              </QAList>
            </Card.Body>
          </Card>
        </Cols>
      </Page>
    </Frame>
  );
}
