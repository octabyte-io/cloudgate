import { useId, useState } from "react";

import { Card } from "@/components/console/card";
import { QAList, QARow } from "@/components/console/qa-row";
import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";
import { settingsApi } from "@/lib/api/endpoints/settings";
import { useInvalidate } from "@/lib/api/use-invalidate";

import { useInstanceGate } from "./use-platform";

/**
 * One row per prune, each naming exactly what it runs.
 *
 * **Every one of them refreshes the disk usage above afterwards**, and that is
 * not housekeeping — it is the point of the screen. Found by driving it: pruning
 * the build cache really emptied it on the daemon and the table went on saying
 * `9 objects, 70.31MB`, which is the exact failure this card's own argument
 * warns about. A figure that does not move when you act on it is worse than no
 * figure, because the reader concludes the button did nothing and presses the
 * bigger one.
 *
 * **Every row is off for a caller without instance authority**, which
 * all five routes take (ADR-0013) — read off the refusal `useInstanceGate`
 * gets, with the backend's sentence once above the rows rather than five times.
 */
export function CleanupCard() {
  const invalidate = useInvalidate();
  const [running, setRunning] = useState<string | null>(null);
  const gate = useInstanceGate();
  const refusalId = useId();

  return (
    <Card>
      <Card.Header
        title="Reclaim disk"
        sub="Each Docker prune here runs one Docker command, first waiting up to 10 minutes for any build, pull or other Docker command to finish. Deleting metrics is Cloudgate's own store, not Docker's."
        headingLevel={2}
      />
      <Card.Body>
        {gate.allowed ? null : (
          <p id={refusalId} className="mb-3 text-meta text-tx-2">
            {gate.refusal}
          </p>
        )}
        <QAList>
          {CLEANUPS.map((cleanup) => (
            <QARow
              key={cleanup.id}
              title={cleanup.title}
              description={
                <>
                  {cleanup.description}{" "}
                  <code className="font-mono text-tx-3">{cleanup.command}</code>
                </>
              }
              action={
                <Button
                  type="button"
                  size="sm"
                  disabled={!gate.allowed || running !== null}
                  title={gate.allowed ? undefined : gate.refusal}
                  aria-describedby={gate.allowed ? undefined : refusalId}
                  aria-busy={running === cleanup.id || undefined}
                  onClick={async () => {
                    if (!gate.allowed) return;
                    setRunning(cleanup.id);
                    try {
                      await cleanup.run();
                      await (cleanup.id === "monitoring"
                        ? invalidate.hostMetricsDeleted()
                        : invalidate.instanceSettings());
                      toast.done(cleanup.done);
                    } catch (error) {
                      toast.error(error);
                    } finally {
                      setRunning(null);
                    }
                  }}
                >
                  {cleanup.button}
                </Button>
              }
            />
          ))}
        </QAList>
      </Card.Body>
      <Card.Footer>
        A press during a build queues behind it rather than fighting with it.
        Log and stats views do not hold it up. If Docker is still busy after 10
        minutes the prune does not run, and says what kept it waiting.
      </Card.Footer>
    </Card>
  );
}

/**
 * The five ordinary cleanups.
 *
 * `docker-prune` and `all` are deliberately **not** in this list — they are the
 * DangerZone's, in `maintenance-danger-zone.tsx`. The brief's rule, in one
 * sentence: they must not sit next to a harmless one without distinction.
 */
const CLEANUPS = [
  {
    id: "images",
    title: "Remove unused images",
    description: "Every image with no container using it, tagged or not.",
    command: "docker image prune --all --force",
    button: "Remove images",
    done: "Unused images are removed.",
    run: () => settingsApi.cleanup("images"),
  },
  {
    id: "stopped-containers",
    title: "Remove stopped containers",
    description: "Containers that have exited. Running ones are untouched.",
    command: "docker container prune --force",
    button: "Remove containers",
    done: "Stopped containers are removed.",
    run: () => settingsApi.cleanup("stopped-containers"),
  },
  {
    id: "docker-builder",
    title: "Empty the build cache",
    description:
      "BuildKit's whole cache. The next build of anything starts from scratch and is slower.",
    command: "docker builder prune --all --force",
    button: "Empty the cache",
    done: "The build cache is empty.",
    run: () => settingsApi.cleanup("docker-builder"),
  },
  {
    id: "volumes",
    title: "Remove unused volumes",
    description:
      "Every volume with no container attached — including a stopped database's data. Never run on a schedule for that reason.",
    command: "docker volume prune --all --force",
    button: "Remove volumes",
    done: "Unused volumes are removed.",
    run: () => settingsApi.cleanup("volumes"),
  },
  {
    // This emptied the directory and left every stored row, which is
    // where the history it promised to restart actually lives. The rows are
    // this host's only — a Server's samples are its Organization's, and its own
    // retention prunes them whether or not it is still collecting. The
    // live stream writes no directory, so there is none left to empty.
    id: "monitoring",
    title: "Delete collected metrics",
    description:
      "Deletes every sample stored for this host and its containers. This host's history on the Monitoring screen starts again from now; a Server's samples are kept until its own retention deletes them.",
    command: "DELETE this host's server_metric and container_metric rows",
    button: "Delete metrics",
    done: "This host's collected metrics are deleted.",
    run: () => settingsApi.cleanup("monitoring"),
  },
];
