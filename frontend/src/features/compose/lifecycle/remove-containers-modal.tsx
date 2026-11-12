import Link from "next/link";

import { KVList, KVRow } from "@/components/console/kv-list";
import { Modal } from "@/components/console/modal";
import { Button } from "@/components/ui/button";
import type { ComposeDetail } from "@/lib/api/endpoints/compose";
import { settingsHref } from "@/lib/settings/sections";

/**
 * The rung between Stop and Delete, confirmed.
 *
 * **A plain dialog rather than `ConfirmDeleteModal`, and that is a decision
 * rather than a shortcut.** Typing the stack's name is this console's signal for
 * the irreversible destruction of a record; this action destroys no durable state
 * and is undone by pressing Start, so ADR-0011 keeps the typed-name ritual off it
 * — reusing it here would dilute what it means on Delete. `delete-resource-modal`
 * argues the same thing from the other side: a typed name for something
 * recoverable is how people learn to type names without reading them.
 *
 * What it does have to be exact about is the pair of lists. Every word here
 * distinguishes this from its two neighbours, because the three read alike and do
 * not act alike: Stop leaves the containers exited and still holding their
 * volumes, this removes them and nothing else, and Delete takes the project
 * directory and the Cloudgate row too. So the containers going is one sentence
 * and what survives is a second — including the writable layer, which is the one
 * thing Stop keeps and this does not.
 *
 * **"Volumes kept: all of them" was true and read as a promise the stack does
 * not keep**. The
 * command carries no `-v`, so an unnamed mount's volume does survive the removal
 * with its contents — but `docker compose up -d` carries an anonymous volume
 * across a *recreate* by copying the mount off the previous container, and that
 * container is exactly what was destroyed, so Start mints a fresh empty one and
 * leaves the old one dangling. Five cycles on a real target left five orphans.
 * Surviving and coming back are not the same thing, and only this dialog
 * conflated them, so this dialog is where it is fixed.
 *
 * **Re-attachment was the alternative and is rejected.** The only way to point
 * `up` at the preserved volume is to write its id into the operator's compose
 * file, which converts an unnamed mount into a named one behind their back and
 * leaves a 64-hex id in a file they own — worse than the orphan. Adding `-v` is
 * rejected harder: it destroys the data outright, which ADR-0011 already turned
 * down and this does not reopen. So the deliverable is an honest sentence plus
 * the sweep the console already owns — Settings → Maintenance → "Remove unused
 * volumes" — named as a control rather than as `docker volume prune`, because
 * sending an operator to a host shell is what Remove containers exists to stop.
 *
 * **That pointer was still half a promise**
 * The destination
 * carried the warning and the pointer did not: `maintenance-cleanup-card.tsx`
 * says "Every volume with no container attached — including a stopped database's
 * data", and on a real target the sweep this dialog recommended would have taken
 * 8 volumes to clear 3 orphans. So the blast radius is named where the remedy is
 * *recommended*, in the card's own words rather than a second formulation of
 * them — two screens saying the same warning at two distances drift apart the
 * moment one of them is paraphrased. It names *this Cloudgate host* on purpose:
 * Remove containers runs on the stack's `serverId` (`ComposeService.removeContainers`)
 * and the Maintenance card sends none — its `CLEANUPS` rows call
 * `settingsApi.cleanup(kind)` and there is no server to pass — so for a stack on
 * a Server the sweep is not even the same machine. The dialog says which machine
 * rather than pointing at a per-Server control that does not exist, or at a
 * shell — that control is genuinely missing and is its own issue,
 * not a sentence in a confirm dialog.
 *
 * **The outcome is reported outside this dialog**, unlike the delete dialogs,
 * which hold their refusal in place. All four controls in `compose-actions.tsx`
 * share one outcome path, and its interesting answer is not a refusal: the
 * command runs inside the request, so a 5xx most often means the connection
 * closed while Docker carried on, and the sentence for that is "watch the status
 * beside the name". A dialog held open to say so would make this the one control
 * in the row that reports differently — and `SetupConfirmModal` already confirms
 * an action whose progress appears behind it.
 */
export function RemoveContainersModal({
  compose,
  open,
  onOpenChange,
  onConfirm,
}: {
  compose: ComposeDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Runs it. The caller closes this and reports the outcome. */
  onConfirm: () => void;
}) {
  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <Modal.Header
        title={`Remove the containers in ${compose.name}?`}
        description="This removes the containers this stack is running, and nothing else."
      />
      <Modal.Body>
        <p className="text-body text-tx-2">
          Every container in this stack is removed from the deploy target. Start
          brings the stack back up from the project directory that is still
          there, so the containers are recreated rather than resumed — anything
          written inside a container, rather than into a volume your compose
          file names, goes with them. That is the difference from Stop, which
          leaves them exited and keeps what they had written.
        </p>

        <KVList>
          <KVRow
            label="Containers removed"
            value={compose.appName}
            title={compose.appName}
            mono
          />
          <KVRow label="Named volumes kept" value="all of them" />
          <KVRow label="Unnamed volumes" value="left behind, not re-attached" />
          <KVRow
            label="Directory kept"
            value={`compose/${compose.appName}`}
            title={`compose/${compose.appName}`}
            mono
          />
        </KVList>

        <p className="text-body text-tx-2">
          A mount your compose file gives no name to is not re-attached: Start
          gives the service a new empty one, and the old volume stays on the
          deploy target with nothing using it.{" "}
          <Link
            href={settingsHref("maintenance")}
            className="font-medium text-brand-tx underline-offset-3 hover:underline focus-visible:underline"
          >
            Settings → Maintenance
          </Link>{" "}
          → Remove unused volumes clears those, and it does not stop at those: it takes
          every volume on this Cloudgate host with no container attached,
          including a stopped database&rsquo;s data, whether or not it belongs to
          this stack.
        </p>

        <p className="text-body text-tx-2">
          The project network, this stack in Cloudgate, its compose file, its
          variables, its domains and its Deployment history are all untouched.
          This is not Delete.
        </p>

        <p className="text-meta text-tx-3">
          This is the rung a volume restore needs: Docker counts an exited
          container as still using its volume, so a restore refuses while the
          containers Stop left behind are still on the deploy target.
        </p>
      </Modal.Body>
      <Modal.Footer>
        <Modal.Gap />
        <Modal.Close render={<Button type="button">Cancel</Button>} />
        {/* The same words as the control that opened this dialog: an action
            keeps its name all the way through. */}
        <Button type="button" variant="dngr" onClick={onConfirm}>
          Remove containers
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
