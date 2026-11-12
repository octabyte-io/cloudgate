import { useState } from "react";

import { Card } from "@/components/console/card";
import { MetaStrip } from "@/components/console/meta-strip";
import { ResourceList } from "@/components/console/resource-list";
import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";
import type { Bucket } from "@/lib/api/endpoints/buckets";
import { usePermission } from "@/lib/auth/use-permission";
import { Icon } from "@/lib/design/icons";

import { RestoreModal } from "../application/advanced/restore-modal";
import { RunHistoryCard } from "../application/advanced/run-history-card";
import {
  useDestinations,
  useVolumeBackupMutations,
  useVolumeBackupRuns,
  useVolumeBackups,
} from "../application/advanced/use-advanced";
import { volumeBackupsSpec } from "../application/advanced/volume-backups-spec";

/** Why Run now is off for a role without `volumeBackup: create`. */
export const RUN_NOW_REFUSAL =
  "Your role cannot run a volume backup — that needs volume backup create.";

/** Why Restore is off for a role without `volumeBackup: restore`. */
export const RESTORE_REFUSAL =
  "Your role cannot restore a volume — that needs volume backup restore.";

/**
 * A Server bucket's files, copied off the Server by the volume backup every
 * other Service has: the same list, the same Run now and run history,
 * started on the bucket's own volume. None exists until one is added here —
 * a bucket is made with no backup, and nothing in the Project config sets one.
 *
 * Restore is the Application's dialog pointed at the bucket's volume: the
 * restore stops the bucket's Garage itself for the unpack and starts it again
 * at the count it ran, whatever the outcome, so no Stop comes first.
 */
export function BucketVolumeBackups({
  bucket,
  volumeName,
}: {
  bucket: Bucket;
  /** Its volume: a bucket on a Server always has one; one on S3 none. */
  volumeName: string;
}) {
  const backups = useVolumeBackups(bucket.bucketId, "bucket");
  const destinations = useDestinations();
  const mutations = useVolumeBackupMutations(bucket.bucketId);
  const [historyOf, setHistoryOf] = useState<string | null>(null);
  const runs = useVolumeBackupRuns(historyOf);
  // `POST /volume-backups/:id/run` is `volumeBackup: ['create']`.
  const canRun = usePermission({ volumeBackup: ["create"] });
  // `POST /volume-backups/restore` is `volumeBackup: ['restore']`.
  const canRestore = usePermission({ volumeBackup: ["restore"] });
  const [restoring, setRestoring] = useState(false);
  const [opening, setOpening] = useState(0);

  const spec = volumeBackupsSpec({
    serviceId: bucket.bucketId,
    serviceType: "bucket",
    ownVolume: volumeName,
    destinations: destinations.data ?? [],
    destinationsPending: destinations.isPending,
    create: (input) => mutations.create.mutateAsync(input as never),
    update: (volumeBackupId, input) =>
      mutations.update.mutateAsync({ volumeBackupId, input: input as never }),
    remove: (volumeBackupId) => mutations.remove.mutateAsync(volumeBackupId),
  });

  return (
    <>
      <ResourceList
        spec={{
          ...spec,
          rowExtras: (item) => (
            <Button
              size="xs"
              disabled={!canRun.allowed || mutations.run.isPending}
              title={canRun.allowed ? undefined : RUN_NOW_REFUSAL}
              onClick={async () => {
                if (!canRun.allowed) return;
                try {
                  await mutations.run.mutateAsync(item.volumeBackupId);
                  setHistoryOf(item.volumeBackupId);
                  toast.done(`Running ${item.name} now.`, {
                    description: item.turnOff
                      ? "The bucket is stopped for the tar and started again afterwards. The outcome lands in the run history below."
                      : "The volume is tarred while the bucket keeps serving. The outcome lands in the run history below.",
                  });
                } catch (error) {
                  toast.error(error);
                }
              }}
            >
              Run now
            </Button>
          ),
        }}
        query={backups}
        note={
          <MetaStrip>
            This bucket&rsquo;s files are on{" "}
            <strong className="font-mono">{volumeName}</strong>, on its Server
            only. Losing the host loses them unless one of these has run.
          </MetaStrip>
        }
      />

      <RunHistoryCard
        noun="volume backup"
        entries={(backups.data ?? []).map((item) => ({
          id: item.volumeBackupId,
          label: item.name,
          detail: item.volumeName,
        }))}
        selectedId={historyOf}
        onSelect={setHistoryOf}
        runs={runs}
      />

      <Card>
        <Card.Header
          title="Restore"
          sub="Unpack a tarball over this bucket's volume on its Server."
          headingLevel={2}
          actions={
            <Button
              size="sm"
              disabled={!canRestore.allowed}
              title={canRestore.allowed ? undefined : RESTORE_REFUSAL}
              onClick={() => {
                if (!canRestore.allowed) return;
                setOpening((n) => n + 1);
                setRestoring(true);
              }}
            >
              <Icon name="back" size={14} />
              Restore a volume
            </Button>
          }
        />
        <Card.Body>
          <p className="max-w-lede text-body text-tx-2">
            The restore stops the bucket for the unpack and starts it again
            afterwards, at the replicas it ran, even when the unpack fails. It{" "}
            <strong className="font-medium text-tx">
              replaces the volume&rsquo;s current contents
            </strong>
            , objects and Garage&rsquo;s own records alike, with no copy of
            what was there.
          </p>
        </Card.Body>
      </Card>

      <RestoreModal
        key={`restore-${opening}`}
        serviceId={bucket.bucketId}
        serviceType="bucket"
        serviceName={bucket.name}
        serverId={bucket.serverId}
        destinations={destinations.data ?? []}
        destinationsPending={destinations.isPending}
        suggestedVolume={volumeName}
        // A run writes `<appName>/<prefix>/<timestamp>.tar`.
        suggestedPrefix={`${bucket.appName}/`}
        open={restoring}
        onOpenChange={setRestoring}
        restore={(input) => mutations.restore.mutateAsync(input)}
      />
    </>
  );
}
