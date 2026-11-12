import { useState } from "react";

import { ConfirmDeleteModal } from "@/components/console/confirm-delete-modal";
import { Field } from "@/components/console/field";
import { KVList, KVRow } from "@/components/console/kv-list";
import {
  TeardownReportModal,
  useTeardownReport,
} from "@/components/console/teardown-report-modal";
import { toast } from "@/components/console/toast";
import { Switch } from "@/components/ui/switch";
import type { ComposeDetail } from "@/lib/api/endpoints/compose";
import type { TeardownReport } from "@/lib/api/endpoints/teardown";

import { useComposeDeployments } from "../use-compose";

/**
 * Delete the stack, and be exact about what happens to its data.
 *
 * Two facts from `compose.service.ts`, and the dialog is shaped around them:
 *
 * 1. **`deleteVolumes` only reaches a `docker-compose` stack.** The teardown for a
 *    Swarm stack is `docker stack rm` plus `rm -rf` on the project directory, with
 *    no volume handling at all (`teardownCommand`) — so for a stack the switch
 *    would be a control that does nothing, and it is absent with the reason
 *    instead. F11's delete dialog says the same thing about a database, from the
 *    same evidence.
 * 2. **A stack that cannot be confirmed gone keeps its row.** After the
 *    teardown `ComposeService.remove` asks the deploy target whether its
 *    containers are still there; `present` or `unknown` is a 409 and the stack
 *    stays. `ConfirmDeleteModal` then offers "Remove from Cloudgate
 *    anyway", the forced Delete, which drops the row and names what may still
 *    be running. This used to say the row went either way, which the
 *    backend had stopped doing.
 *
 * And one fact from the Deployment history: **a stack that was never
 * deployed has no volumes.** The first deploy is what clones or writes the
 * project and brings it up, and every deploy writes a Deployment row that
 * nothing ever deletes (`deployments/log-retention.ts`) — so an empty history
 * proves nothing was created on the deploy target, and the dialog and the toast
 * say so instead of calling volumes "still on the deploy target" that never
 * existed. Until the history has loaded the dialog claims nothing either way
 * and keeps the switch.
 */
export function DeleteComposeModal({
  compose,
  open,
  onOpenChange,
  remove,
  onDeleted,
}: {
  compose: ComposeDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  remove: (deleteVolumes: boolean, force?: boolean) => Promise<TeardownReport>;
  /** Where to go afterwards. This screen cannot stay — its row is gone. */
  onDeleted: () => void;
}) {
  const [volumes, setVolumes] = useState(false);
  const swarm = compose.composeType === "stack";
  const history = useComposeDeployments(compose.composeId);
  const neverDeployed = history.data !== undefined && history.data.length === 0;

  const teardown = useTeardownReport();

  async function finish(force: boolean) {
    const clean = await teardown.runDelete(() =>
      remove(swarm || neverDeployed ? false : volumes, force),
    );
    onOpenChange(false);
    if (!clean) {
      // The report holds the only copy of what was left behind, and
      // `onDeleted` navigates. It runs from the report's own dismissal.
      return;
    }
    toast.done(`${compose.name} deleted.`, {
      description: neverDeployed
        ? "It was never deployed, so nothing was left on the deploy target."
        : swarm || !volumes
          ? "Its named volumes are still on the deploy target."
          : "Its named volumes were removed with it.",
    });
    onDeleted();
  }

  return (
    <>
      <ConfirmDeleteModal
        open={open}
        onOpenChange={(next) => {
          // The switch is part of the decision, so it resets with the typed name.
          if (!next) setVolumes(false);
          onOpenChange(next);
        }}
        title={`Delete ${compose.name}`}
        confirmWord={compose.name}
        mismatch="That does not match the stack's name."
        button="Delete stack"
        onConfirm={() => finish(false)}
        forceRemove={{
          onConfirm: () => finish(true),
          leftBehind: (
            <>
              Removing it anyway deletes this row and its history now, without
              confirming anything on the deploy target. Whatever is still there
              stays: the containers of{" "}
              <code className="font-mono">{compose.appName}</code> may keep
              running with nothing in Cloudgate to stop them, and its project
              directory and volumes may remain. Cloudgate then lists what it
              could not confirm, for you to remove on the Server.
            </>
          ),
        }}
      >
        <p className="rounded-lg border border-bad-line bg-bad-tint px-3.5 py-3 text-body text-tx">
          Every container in this stack will be{" "}
          {swarm ? "removed" : "taken down"}, its project directory on the
          deploy target will be deleted, and this row will go with it — the
          compose file stored here, its variables, its domains and its
          Deployment history.
        </p>

        <KVList>
          <KVRow
            label={swarm ? "Will remove stack" : "Will take down project"}
            value={compose.appName}
            title={compose.appName}
            mono
          />
          <KVRow
            label="Will delete directory"
            value={`compose/${compose.appName}`}
            title={`compose/${compose.appName}`}
            mono
          />
        </KVList>

        {neverDeployed ? (
          <p className="text-meta text-tx-2">
            It was never deployed, so it has no volumes on the deploy target
            and nothing is left behind.
          </p>
        ) : swarm ? (
          <p className="text-meta text-tx-2">
            <strong className="font-medium text-tx-2">
              Named volumes are left behind.
            </strong>{" "}
            A Swarm stack&rsquo;s teardown is{" "}
            <code className="font-mono">docker stack rm</code>, which does not
            touch volumes, and this backend offers no way to include them — so
            anything this stack declared a volume for is still on the deploy
            target. Remove those there if you want the disk back.
          </p>
        ) : (
          <Field
            name="deleteVolumes"
            label="Delete its volumes too"
            hint="Adds --volumes to docker compose down. Anything the stack stored — a database's data directory, an upload folder — goes with it."
            orientation="horizontal"
            manual
          >
            <Switch
              checked={volumes}
              onCheckedChange={(next) => setVolumes(next)}
            />
          </Field>
        )}

        <p className="text-meta text-tx-2">
          If the deploy target cannot be reached, or its containers are still
          there after the teardown, the stack is kept and this dialog says why,
          then offers to remove it from Cloudgate anyway.
        </p>
      </ConfirmDeleteModal>

      <TeardownReportModal
        report={teardown.report}
        serviceName={compose.name}
        open={teardown.open}
        onOpenChange={teardown.setOpen}
        onDismissed={onDeleted}
      />
    </>
  );
}
