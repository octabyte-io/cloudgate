import { KVList, KVRow } from "@/components/console/kv-list";
import { Modal } from "@/components/console/modal";
import { Dash } from "@/components/console/dash";
import { Button } from "@/components/ui/button";
import type { Deployment } from "@/lib/api/endpoints/deployments";
import { timeExact, timeTaken } from "@/lib/format/time";

import { DeploymentLog } from "./deployment-log";

/**
 * One Deployment, in full — the drill-in from the Deployments table.
 *
 * A dialog rather than its own route, and that is a deliberate choice: there is
 * **no `GET /deployments/:id`**. The row is only ever obtained from a service's
 * list, so a `/deployments/<id>` address would have nothing to fetch on a reload
 * and would 404 the one thing a URL is for. A dialog cannot make that promise and
 * therefore cannot break it.
 *
 * `wide`, because a build log with 24 characters of timestamp and a docker digest
 * on the same line does not fit a 600px box.
 */
export function DeploymentModal({
  deployment,
  open,
  onOpenChange,
  /** What was deployed, for the one sentence that names it (F12 passes "stack"). */
  noun = "Application",
}: {
  deployment: Deployment | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  noun?: string;
}) {
  if (!deployment) return null;

  return (
    <Modal wide open={open} onOpenChange={onOpenChange}>
      <Modal.Header
        title={deployment.title}
        description={
          deployment.description ||
          `One attempt to build this ${noun} and release it.`
        }
      />
      <Modal.Body>
        <KVList>
          <KVRow
            label="Queued"
            title={timeExact(deployment.createdAt)}
            value={
              <time dateTime={deployment.createdAt}>
                {timeExact(deployment.createdAt)}
              </time>
            }
          />
          <KVRow
            label="Started"
            title={timeExact(deployment.startedAt) ?? undefined}
            value={
              deployment.startedAt ? (
                <time dateTime={deployment.startedAt}>
                  {timeExact(deployment.startedAt)}
                </time>
              ) : (
                <Dash word="Not yet" />
              )
            }
          />
          <KVRow
            label="Finished"
            title={timeExact(deployment.finishedAt) ?? undefined}
            value={
              deployment.finishedAt ? (
                <time dateTime={deployment.finishedAt}>
                  {timeExact(deployment.finishedAt)}
                </time>
              ) : (
                <Dash word="Still running" />
              )
            }
          />
          <KVRow
            label="Took"
            value={
              timeTaken(deployment.startedAt, deployment.finishedAt) ?? (
                <Dash word="Unknown" />
              )
            }
          />
          <KVRow
            label="Log file"
            value={deployment.logPath}
            title={deployment.logPath}
            mono
          />
        </KVList>

        <DeploymentLog
          deployment={deployment}
          label={`Output of ${deployment.title}`}
        />
      </Modal.Body>
      <Modal.Footer>
        <Modal.Gap />
        <Modal.Close render={<Button type="button">Close</Button>} />
      </Modal.Footer>
    </Modal>
  );
}
