import { useState } from "react";

import { Card } from "@/components/console/card";
import { Chip } from "@/components/console/chip";
import { Modal } from "@/components/console/modal";
import { QAList, QARow } from "@/components/console/qa-row";
import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import type { BoughtServerView } from "@/lib/api/endpoints/bought-servers";
import type { Server } from "@/lib/api/endpoints/servers";
import { usePermission } from "@/lib/auth/use-permission";

import { wholeUsd } from "../buy/buy-model";
import { useBoughtServer, useSetBackups } from "../buy/use-bought-servers";
import { BoughtServerSizeRow } from "./bought-server-size";
import { ExtraStorageRow } from "./extra-storage-row";

/** Said on the switch to a role that may not change what the Organization pays for. */
export const BOUGHT_SERVER_CHANGE_REFUSAL =
  "Your role in this Organization cannot change what this Server is charged for. Ask an owner or an admin.";

/** Said while the switch is off because the Server is busy or not made yet. */
export const CHANGE_WAITS_FOR_READY =
  "This Server can be changed once it is Ready.";

/** US cents a month as whole dollars: `$5/month`. */
function perMonth(cents: number): string {
  return `${wholeUsd(cents / 100)}/month`;
}

/**
 * What a **Bought Server** is charged for, and the changes to it (ADR-0071):
 * backups, extra storage (`ExtraStorageRow`) and size (`BoughtServerSizeRow`).
 * Shown only for a Server bought from Cloudgate, on the Hosted instance.
 *
 * Each change asks first. Turning backups on says what it costs and that
 * today's part is charged now; turning them off warns that every backup is
 * deleted at once and says the unused part is credited. While a change runs
 * the card says **Changing** and every switch waits.
 */
export function BoughtServerCard({ server }: { server: Server }) {
  const bought = useBoughtServer(server.serverId);
  if (!bought.data) return null;
  return <BoughtServerChanges view={bought.data} />;
}

function BoughtServerChanges({ view }: { view: BoughtServerView }) {
  const canChange = usePermission({ server: ["create"] });
  const setBackups = useSetBackups(view.id);
  const [asking, setAsking] = useState<"on" | "off" | null>(null);

  const changing = view.stage === "changing";
  const ready = view.stage === "ready";
  const backupsLine = view.lines.find((line) => line.kind === "backups");
  const offer = view.backupsOfferCents;
  const shownOn =
    changing && view.change?.backups !== undefined
      ? view.change.backups
      : view.backups;

  /** Why the extra storage and size rows wait, if they do. */
  const rowWhy = !canChange.allowed
    ? BOUGHT_SERVER_CHANGE_REFUSAL
    : !ready
      ? CHANGE_WAITS_FOR_READY
      : null;
  const why =
    rowWhy ??
    (!view.backups && offer === null
      ? "Backups can't be turned on: this size is no longer sold here."
      : null);

  async function confirm(enabled: boolean) {
    setAsking(null);
    try {
      await setBackups.mutateAsync(enabled);
      toast.done(
        enabled
          ? `Backups are on for ${view.name}.`
          : `Backups are off for ${view.name}, and its backups are deleted.`,
      );
    } catch (error) {
      toast.error(error);
    }
  }

  return (
    <Card>
      <Card.Header
        title="Bought Server"
        sub={`${perMonth(view.monthlyCents)} on your plan's invoice.`}
        headingLevel={2}
        actions={changing ? <Chip variant="warn">Changing</Chip> : null}
      />
      <Card.Body>
        <QAList>
          <QARow
            title="Backups"
            description={
              view.backups && backupsLine
                ? `On · ${perMonth(backupsLine.monthlyCents)}. A copy of the Server's own disk every day, the last 7 kept. They don't include extra storage.`
                : `Off${offer !== null ? ` · ${perMonth(offer)} when on` : ""}. A copy of the Server's own disk every day, the last 7 kept.`
            }
            action={
              <Switch
                checked={shownOn}
                disabled={why !== null || setBackups.isPending}
                title={why ?? undefined}
                aria-label="Backups"
                onCheckedChange={(next) => setAsking(next ? "on" : "off")}
              />
            }
          />
          <ExtraStorageRow view={view} why={rowWhy} />
          <BoughtServerSizeRow view={view} why={rowWhy} />
        </QAList>
        {why && canChange.allowed ? (
          <p className="mt-2 text-meta text-tx-3">{why}</p>
        ) : null}
      </Card.Body>

      <Modal
        open={asking === "on"}
        onOpenChange={(open) => !open && setAsking(null)}
      >
        <Modal.Header
          title={`Turn on backups for ${view.name}?`}
          description={
            offer !== null
              ? `Backups cost ${perMonth(offer)}. The rest of this month of your plan is charged now, then they renew with it.`
              : "The rest of this month of your plan is charged now, then they renew with it."
          }
        />
        <Modal.Body>
          <p className="text-body text-tx-2">
            Backups don&rsquo;t include extra storage. Turning them off later
            deletes every backup at once.
          </p>
        </Modal.Body>
        <Modal.Footer>
          <Modal.Gap />
          <Modal.Close render={<Button type="button">Cancel</Button>} />
          <Button
            type="button"
            variant="pri"
            onClick={() => void confirm(true)}
          >
            Pay and turn on backups
          </Button>
        </Modal.Footer>
      </Modal>

      <Modal
        open={asking === "off"}
        onOpenChange={(open) => !open && setAsking(null)}
      >
        <Modal.Header
          title={`Turn off backups for ${view.name}?`}
          description="Every backup of this Server is deleted at once, and can't be brought back."
        />
        <Modal.Body>
          <p className="text-body text-tx-2">
            The unused part of this month is credited on your next invoice.
          </p>
        </Modal.Body>
        <Modal.Footer>
          <Modal.Gap />
          <Modal.Close render={<Button type="button">Keep backups</Button>} />
          <Button
            type="button"
            variant="dngr"
            onClick={() => void confirm(false)}
          >
            Turn off and delete backups
          </Button>
        </Modal.Footer>
      </Modal>
    </Card>
  );
}
