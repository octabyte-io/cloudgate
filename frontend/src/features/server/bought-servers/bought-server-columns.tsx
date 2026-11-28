import { Dash } from "@/components/console/dash";
import type { Column } from "@/components/console/data-table";
import { LinkButton } from "@/components/console/link-button";
import { StatusPill } from "@/components/console/status-pill";
import { Button } from "@/components/ui/button";
import type {
  BoughtServerRow,
  BoughtServerStage,
} from "@/lib/api/endpoints/bought-servers";
import type { Mark } from "@/lib/design/status";

import { perMonth } from "../bought-server/per-month";
import { FAMILIES, countryName, sizeLabel } from "../buy/buy-model";

/**
 * How each stage the page lists reads. Ready is the one at rest; waiting on
 * the customer stands out; Deleting is only shown going, as on the Servers
 * page's "Servers being bought".
 */
const STAGE_MARKS: Partial<Record<BoughtServerStage, Mark>> = {
  ready: { glyph: "●", tone: "ok", label: "Ready" },
  changing: { glyph: "◐", tone: "info", label: "Changing" },
  setting_up: { glyph: "◐", tone: "info", label: "Setting up" },
  creating: { glyph: "◐", tone: "info", label: "Creating" },
  waiting_for_payment: {
    glyph: "◐",
    tone: "warn",
    label: "Waiting for payment",
  },
  deleting: { glyph: "○", tone: "mute", label: "Deleting" },
};

/** A size by what it is, as the Server's About this Server names it. */
function sizeOf(row: BoughtServerRow): string | null {
  if (!row.size) return null;
  const family = FAMILIES.find((each) => each.value === row.size?.family);
  return [family?.label, sizeLabel(row.size)].filter(Boolean).join(" · ");
}

/**
 * Whether a Bought Server in this stage is on the plan's invoice: not while
 * it waits for payment, and no longer once it is Deleting, which takes it off
 * the subscription before the provider deletes it.
 */
export function isCharged(stage: BoughtServerStage): boolean {
  return stage !== "waiting_for_payment" && stage !== "deleting";
}

/**
 * The Bought Servers table: name and Location, stage, size, backups, monthly
 * price, then Manage (its Server's Bought Server tab) or, while it waits for
 * payment, *Finish paying*. One being created or deleted has no Server to
 * open, so no action.
 */
export function boughtServerColumns({
  onFinishPaying,
  paying,
}: {
  onFinishPaying: (row: BoughtServerRow) => void;
  paying: boolean;
}): Column<BoughtServerRow>[] {
  return [
    {
      id: "name",
      head: "Server",
      tone: "key",
      cell: (row) => (
        <span className="flex flex-col">
          <span className="font-medium text-tx wrap-anywhere">{row.name}</span>
          <span className="text-meta text-tx-3">
            {row.location
              ? `${row.location.city}, ${countryName(row.location.country)}`
              : null}
          </span>
        </span>
      ),
    },
    {
      id: "stage",
      head: "Stage",
      cell: (row) => (
        <StatusPill
          mark={
            STAGE_MARKS[row.stage] ?? {
              glyph: "◐",
              tone: "info",
              label: row.stage,
            }
          }
        />
      ),
    },
    {
      id: "size",
      head: "Size",
      tone: "muted",
      cell: (row) => sizeOf(row) ?? <Dash word="Unknown" />,
    },
    {
      id: "backups",
      head: "Backups",
      cell: (row) =>
        row.backups ? (
          <span className="text-tx-2">On</span>
        ) : (
          <span className="text-tx-3">Off</span>
        ),
    },
    {
      id: "monthly",
      head: "Monthly",
      tone: "num",
      cell: (row) =>
        row.stage === "deleting" ? (
          <Dash word="Not charged" />
        ) : (
          perMonth(row.monthlyCents)
        ),
    },
    {
      id: "actions",
      head: <span className="sr-only">Actions</span>,
      cell: (row) =>
        row.stage === "waiting_for_payment" ? (
          <Button
            type="button"
            size="xs"
            variant="pri"
            disabled={paying}
            onClick={() => onFinishPaying(row)}
          >
            Finish paying
          </Button>
        ) : row.serverId ? (
          <LinkButton
            href={`/servers/${encodeURIComponent(row.serverId)}/bought-server`}
            size="xs"
          >
            Manage
          </LinkButton>
        ) : null,
    },
  ];
}
