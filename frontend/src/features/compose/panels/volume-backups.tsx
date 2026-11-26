"use client";

import { useState } from "react";

import { Card } from "@/components/console/card";
import { Page } from "@/components/console/page";
import { PageHeader } from "@/components/console/page-header";
import { ResourceList } from "@/components/console/resource-list";
import { TabPending } from "@/components/console/tab-pending";
import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";
import {
  RESTORE_REFUSAL,
  RUN_NOW_REFUSAL,
} from "@/features/bucket/bucket-volume-backups";
import type { VolumeBackup } from "@/lib/api/endpoints/volume-backups";
import { usePermission } from "@/lib/auth/use-permission";
import { Icon } from "@/lib/design/icons";
import type { PanelProps } from "@/lib/shell/tab-registry";

import { RestoreModal } from "../../application/advanced/restore-modal";
import { RunHistoryCard } from "../../application/advanced/run-history-card";
import {
  useDestinations,
  useVolumeBackupMutations,
  useVolumeBackupRuns,
  useVolumeBackups,
} from "../../application/advanced/use-advanced";
import { volumeBackupsSpec } from "../../application/advanced/volume-backups-spec";
import { useCompose, useComposeVolumes } from "../use-compose";
import { StackBackupsNote } from "../volume-backups/stack-backups-note";

/**
 * A Compose stack's **Volume backups** tab (#163): one-volume backups of
 * the stack's named volumes, picked as a service and then a volume it
 * mounts (`GET /compose/:id/volumes`), with Run now, the run history and
 * the Application's Restore card. Absent on a stack in a Cloud account
 * (`tabs/compose.ts`), which has no Server to tar on (ADR-0092).
 *
 * The same pieces as the Application's tab and a bucket's; what differs is
 * the picker (`stack-volume-picker.ts`) and the note above the list.
 */
export default function Panel({ id, label, icon }: PanelProps) {
  const compose = useCompose(id);
  const volumes = useComposeVolumes(id);
  const backups = useVolumeBackups(id, "compose");
  const destinations = useDestinations();
  const mutations = useVolumeBackupMutations(id);
  // `POST /volume-backups/:id/run` is `volumeBackup: ['create']`, and
  // `POST /volume-backups/restore` is `volumeBackup: ['restore']`.
  const canRun = usePermission({ volumeBackup: ["create"] });
  const canRestore = usePermission({ volumeBackup: ["restore"] });

  const [restoring, setRestoring] = useState(false);
  const [seed, setSeed] = useState<VolumeBackup | null>(null);
  const [opening, setOpening] = useState(0);
  const [historyOf, setHistoryOf] = useState<string | null>(null);
  const runs = useVolumeBackupRuns(historyOf);

  const row = compose.data;
  if (!row) return <TabPending />;

  const unavailableReason = volumes.data?.unavailableReason ?? null;

  function openRestore(from: VolumeBackup | null) {
    if (!canRestore.allowed) return;
    setSeed(from);
    setOpening((n) => n + 1);
    setRestoring(true);
  }

  const spec = volumeBackupsSpec({
    serviceId: id,
    serviceType: "compose",
    stack: {
      services: volumes.data?.services ?? [],
      unavailableReason,
      pending: volumes.isPending,
    },
    destinations: destinations.data ?? [],
    destinationsPending: destinations.isPending,
    create: (input) => mutations.create.mutateAsync(input as never),
    update: (volumeBackupId, input) =>
      mutations.update.mutateAsync({ volumeBackupId, input: input as never }),
    remove: (volumeBackupId) => mutations.remove.mutateAsync(volumeBackupId),
  });

  return (
    <Page className="grid gap-3">
      <PageHeader
        title={label}
        icon={icon}
        lede="Copies of this stack's named volumes, written off its Server on a cron."
      />

      <ResourceList
        spec={{
          ...spec,
          rowExtras: (item) => (
            <>
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
                        ? "The service is stopped for the tar and started again afterwards. The outcome lands in the run history below."
                        : "The volume is tarred while the stack keeps running. The outcome lands in the run history below.",
                    });
                  } catch (error) {
                    toast.error(error);
                  }
                }}
              >
                Run now
              </Button>
              <Button
                size="xs"
                disabled={!canRestore.allowed}
                title={canRestore.allowed ? undefined : RESTORE_REFUSAL}
                onClick={() => openRestore(item)}
              >
                Restore
              </Button>
            </>
          ),
        }}
        query={backups}
        note={
          <StackBackupsNote
            composeType={row.composeType}
            unavailableReason={unavailableReason}
          />
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
          sub="Unpack a tarball over one of this stack's volumes on its Server."
          headingLevel={2}
          actions={
            <Button
              size="sm"
              disabled={!canRestore.allowed}
              title={canRestore.allowed ? undefined : RESTORE_REFUSAL}
              onClick={() => openRestore(null)}
            >
              <Icon name="back" size={14} />
              Restore a volume
            </Button>
          }
        />
        <Card.Body>
          <p className="max-w-lede text-body text-tx-2">
            A volume cannot be restored while a container still holds it, so
            use Remove containers on the stack first, and Start afterwards. It{" "}
            <strong className="font-medium text-tx">
              replaces the volume&rsquo;s current contents
            </strong>
            , with no copy of what was there.
          </p>
        </Card.Body>
      </Card>

      <RestoreModal
        key={`restore-${opening}`}
        serviceId={id}
        serviceType="compose"
        serviceName={row.name}
        serverId={row.serverId}
        destinations={destinations.data ?? []}
        destinationsPending={destinations.isPending}
        suggestedVolume={seed?.volumeName ?? ""}
        // A run writes `<appName>_<service>/<prefix>/…` for a backup that
        // names its service, `<appName>/<prefix>/…` otherwise; with no
        // seed, no slash, so the listing finds both.
        suggestedPrefix={
          seed
            ? `${row.appName}${seed.serviceName ? `_${seed.serviceName}` : ""}/${seed.prefix}/`
            : `${row.appName}`
        }
        open={restoring}
        onOpenChange={setRestoring}
        restore={(input) => mutations.restore.mutateAsync(input)}
      />
    </Page>
  );
}
