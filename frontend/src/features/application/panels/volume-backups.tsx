"use client";

import { useState } from "react";

import { Card } from "@/components/console/card";
import { MetaStrip } from "@/components/console/meta-strip";
import { Page } from "@/components/console/page";
import { PageHeader } from "@/components/console/page-header";
import { TabPending } from "@/components/console/tab-pending";
import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";
import type { VolumeBackup } from "@/lib/api/endpoints/volume-backups";
import { Icon } from "@/lib/design/icons";
import type { PanelProps } from "@/lib/shell/tab-registry";

import { ResourceList } from "@/components/console/resource-list";
import { RestoreModal } from "../advanced/restore-modal";
import { RunHistoryCard } from "../advanced/run-history-card";
import {
  useDestinations,
  useVolumeBackupMutations,
  useVolumeBackupRuns,
  useVolumeBackups,
} from "../advanced/use-advanced";
import {
  volumeBackupsSpec,
  weightsVolumeOf,
} from "../advanced/volume-backups-spec";
import { useApplication } from "../use-application";

/**
 * Volumes copied off the Server, and the way back.
 *
 * The list is a `ResourceList` configuration like the other three
 * (`volume-backups-spec.tsx`). What this file owns is the pair of actions that
 * are not create-read-update-delete: **Run now** on a row, and **Restore**,
 * which is deliberately its own card rather than a row control.
 *
 * That separation is the design decision here. `POST /volume-backups/restore`
 * takes a service, a volume, a destination and an object key — it is **not** the
 * inverse of a backup row, and any tarball can go into any volume. Hanging it off
 * a row would say otherwise, and the mistake that invites is restoring last
 * week's uploads volume over this week's database. Opening it from a row still
 * seeds what it knows, because the common case really is "put this one back".
 *
 * As with schedules, **a run's outcome reads back**
 * (the runs are listed, and their logs readable) — and it matters more here
 * than it does there. A tar failing quietly for a fortnight used to be
 * discovered *during a restore*, which is the worst possible moment to find
 * out. `RunHistoryCard` is the card that ends that, so it sits above Restore
 * rather than below it: checking that the backups exist is the step before
 * needing one.
 */
export default function Panel({ id, label, icon }: PanelProps) {
  const application = useApplication(id);
  const backups = useVolumeBackups(id);
  const destinations = useDestinations();
  const mutations = useVolumeBackupMutations(id);

  const [restoring, setRestoring] = useState(false);
  const [seed, setSeed] = useState<VolumeBackup | null>(null);
  const [opening, setOpening] = useState(0);
  const [historyOf, setHistoryOf] = useState<string | null>(null);
  const runs = useVolumeBackupRuns(historyOf);

  const row = application.data;
  if (!row) return <TabPending />;

  function openRestore(from: VolumeBackup | null) {
    setSeed(from);
    // Keyed like every other dialog on these screens: the restore flow holds
    // three fields and a step, and reopening it should not resume somebody
    // else's half-finished restore.
    setOpening((n) => n + 1);
    setRestoring(true);
  }

  const spec = volumeBackupsSpec({
    serviceId: id,
    destinations: destinations.data ?? [],
    destinationsPending: destinations.isPending,
    weightsVolume: weightsVolumeOf(row),
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
        lede="Copies of this Application's volumes, written off the Server on a cron."
      />

      <ResourceList
        spec={{
          ...spec,
          rowExtras: (item) => (
            <>
              <Button
                size="xs"
                disabled={mutations.run.isPending}
                onClick={async () => {
                  try {
                    await mutations.run.mutateAsync(item.volumeBackupId);
                    // Point the history at what was just started, so the run is
                    // one glance away rather than one more choice.
                    setHistoryOf(item.volumeBackupId);
                    toast.done(`Running ${item.name} now.`, {
                      description: item.turnOff
                        ? "The service is stopped for the tar and started again afterwards. The outcome lands in the run history below."
                        : "The volume is tarred while the service keeps running. The outcome lands in the run history below.",
                    });
                  } catch (error) {
                    toast.error(error);
                  }
                }}
              >
                Run now
              </Button>
              <Button size="xs" onClick={() => openRestore(item)}>
                Restore
              </Button>
            </>
          ),
        }}
        query={backups}
        note={
          <MetaStrip>
            A Deployment replaces the container and leaves the volume where it is,
            so <strong>nothing else here copies a volume off its Server</strong>.
            Losing the host loses the volume unless one of these has run.
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
          sub="Unpack a tarball over a volume on this Application's Server."
          headingLevel={2}
          actions={
            <Button size="sm" onClick={() => openRestore(null)}>
              <Icon name="back" size={14} />
              Restore a volume
            </Button>
          }
        />
        <Card.Body>
          <p className="max-w-lede text-body text-tx-2">
            A restore is not the inverse of a backup row — any tarball in a
            destination can be unpacked into any volume, so the flow asks for the
            object, the volume and the destination separately. It{" "}
            <strong className="font-medium text-tx">
              replaces the volume&rsquo;s current contents
            </strong>
            , with no copy of what was there, which is why it names that step
            before it does it. The tarballs it offers are the ones the bucket
            actually holds — a schedule that keeps the newest five has deleted
            the rest, and only the destination knows which those are.
          </p>
        </Card.Body>
        <Card.Footer>
          The tarball is picked from what is really in the destination, read
          straight from the bucket when the flow opens.
        </Card.Footer>
      </Card>

      <RestoreModal
        key={`restore-${opening}`}
        serviceId={id}
        serviceName={row.name}
        serverId={row.serverId}
        destinations={destinations.data ?? []}
        destinationsPending={destinations.isPending}
        suggestedVolume={seed?.volumeName ?? ""}
        // A run writes `<appName>/<prefix>/<timestamp>.tar`, so this is where
        // the flow starts looking — and the listing is recursive, so the
        // Application's own directory finds every backup it has ever written,
        // whichever schedule's prefix it went under.
        suggestedPrefix={
          seed ? `${row.appName}/${seed.prefix}/` : `${row.appName}/`
        }
        open={restoring}
        onOpenChange={setRestoring}
        restore={(input) => mutations.restore.mutateAsync(input)}
      />
    </Page>
  );
}
