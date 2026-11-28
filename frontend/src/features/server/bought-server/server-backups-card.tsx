import { useState } from "react";

import { Card } from "@/components/console/card";
import { Modal } from "@/components/console/modal";
import { QAList, QARow } from "@/components/console/qa-row";
import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import type { BoughtServerView } from "@/lib/api/endpoints/bought-servers";
import type { Server } from "@/lib/api/endpoints/servers";
import { usePermission } from "@/lib/auth/use-permission";

import { useSetBackups } from "../buy/use-bought-servers";
import { BACKUPS_READY_NOTE_ID } from "./bought-server-reasons";
import { perMonth } from "./per-month";
import { ServerBackupList } from "./server-backup-list";

/**
 * A Bought Server's **Server backups** on its tab (ADR-0071, ADR-0093): the
 * switch, and while backups are on the strip and the list with Restore
 * (`ServerBackupList`). Back up now is in the tab's header.
 *
 * Turning backups on asks first, says what it costs and that today's part
 * is charged now; turning them off warns that every backup is deleted at
 * once and says the unused part is credited. While a change runs the
 * switch shows where it is going and waits.
 */
export function ServerBackupsCard({
  view,
  server,
  rowWhy,
}: {
  view: BoughtServerView;
  server: Server;
  /** Why the Server can't be changed now (role, or not Ready), or null. */
  rowWhy: string | null;
}) {
  const canChange = usePermission({ server: ["create"] });
  const setBackups = useSetBackups(view.id);
  const [asking, setAsking] = useState<"on" | "off" | null>(null);

  const backupsLine = view.lines.find((line) => line.kind === "backups");
  const offer = view.backupsOfferCents;
  const shownOn =
    view.stage === "changing" && view.change?.backups !== undefined
      ? view.change.backups
      : view.backups;
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
        title="Server backups"
        sub="A copy of the Server's own disk every day, the last 7 kept."
        headingLevel={2}
      />
      <Card.Body>
        <QAList>
          <QARow
            title="Backups"
            description={
              view.backups && backupsLine
                ? `On · ${perMonth(backupsLine.monthlyCents)}. They don't include extra storage.`
                : `Off${offer !== null ? ` · ${perMonth(offer)} when on` : ""}.`
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
        </QAList>
        {why && canChange.allowed ? (
          <p id={BACKUPS_READY_NOTE_ID} className="mt-2 text-meta text-tx-3">
            {why}
          </p>
        ) : null}
      </Card.Body>
      <ServerBackupList view={view} server={server} />

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
