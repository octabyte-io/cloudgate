import { useState } from "react";

import { Modal } from "@/components/console/modal";
import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";
import type { BoughtServerView } from "@/lib/api/endpoints/bought-servers";
import { usePermission } from "@/lib/auth/use-permission";
import { Icon } from "@/lib/design/icons";

import { useBackUpNow, useServerBackups } from "../buy/use-bought-servers";
import {
  BACKUPS_NOTE_ID,
  BACKUPS_READY_NOTE_ID,
  CHANGE_WAITS_FOR_READY,
} from "./bought-server-reasons";
import { BACKUPS_REFUSAL, SLOTS } from "./server-backup-list";

/**
 * The backup a confirmation names, "Tuesday 03:00": the 7 slots span a week
 * at most, so the weekday picks it out. Made per call, so it reads the
 * reader's zone as it is then.
 */
function weekdayAndTime(iso: string): string {
  const parts = new Intl.DateTimeFormat("en", {
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(iso));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((each) => each.type === type)?.value ?? "";
  return `${part("weekday")} ${part("hour")}:${part("minute")}`;
}

/**
 * **Back up now** (ADR-0093), in the Bought Server tab's header: one more
 * Server backup at once, in the same 7 slots and at no cost. Offered only
 * while backups are on and listed. It asks first and, once all 7 are full, names the
 * oldest it will push out; the list is read again until the new one is
 * made. It waits, with its reason, for a Ready Server and a role that may
 * change it (`server: ['create']`), pointing `aria-describedby` at the
 * Server backups card's sentence for it; a frozen Organization's refusal
 * comes back from the API as a toast, as the other changes' do.
 */
export function BackUpNow({ view }: { view: BoughtServerView }) {
  const backups = useServerBackups(
    view.id,
    view.backups,
    view.stage === "changing",
  );
  const backUpNow = useBackUpNow(view.id);
  const canChange = usePermission({ server: ["create"] });
  const [asking, setAsking] = useState(false);
  // Offered once the list is in, as it was beside it: until then its
  // confirmation could not name the backup it pushes out.
  if (!view.backups || !backups.data) return null;

  const rows = backups.data;
  const pushedOut = rows.length >= SLOTS ? rows[rows.length - 1] : null;
  const why = !canChange.allowed
    ? BACKUPS_REFUSAL
    : view.stage !== "ready"
      ? CHANGE_WAITS_FOR_READY
      : null;
  const whyId =
    why === CHANGE_WAITS_FOR_READY ? BACKUPS_READY_NOTE_ID : BACKUPS_NOTE_ID;

  async function confirm() {
    setAsking(false);
    try {
      await backUpNow.mutateAsync();
      toast.done(`A backup of ${view.name} is being made.`);
    } catch (error) {
      toast.error(error);
    }
  }

  return (
    <>
      <Button
        type="button"
        disabled={why !== null || backUpNow.isPending}
        title={why ?? undefined}
        aria-describedby={why !== null ? whyId : undefined}
        onClick={() => setAsking(true)}
      >
        <Icon name="refresh" size={15} />
        Back up now
      </Button>

      <Modal open={asking} onOpenChange={(open) => !open && setAsking(false)}>
        <Modal.Header
          title={`Back up ${view.name} now?`}
          description="A copy of the Server's own disk, kept with the daily ones in the same 7 slots, at no extra cost."
        />
        {pushedOut ? (
          <Modal.Body>
            <p className="text-body text-tx-2">
              All 7 slots are full, so{" "}
              <strong className="text-tx">
                {weekdayAndTime(pushedOut.takenAt)}
              </strong>{" "}
              will be pushed out.
            </p>
          </Modal.Body>
        ) : null}
        <Modal.Footer>
          <Modal.Gap />
          <Modal.Close render={<Button type="button">Cancel</Button>} />
          <Button
            type="button"
            variant="pri"
            disabled={why !== null}
            onClick={() => void confirm()}
          >
            Back up now
          </Button>
        </Modal.Footer>
      </Modal>
    </>
  );
}
