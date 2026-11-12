"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";

import { Card } from "@/components/console/card";
import { PageHeader } from "@/components/console/page-header";
import { Button } from "@/components/ui/button";
import type { Database, DatabaseKind } from "@/lib/api/endpoints/databases";
import { elastiCacheSettingsOf } from "@/lib/api/endpoints/elasticache-redis";
import { memorystoreSettingsOf } from "@/lib/api/endpoints/memorystore-redis";
import { rdsSettingsOf } from "@/lib/api/endpoints/rds-postgres";
import { usePermission } from "@/lib/auth/use-permission";
import type { PanelProps } from "@/lib/shell/tab-registry";

import { DatabaseFactsCard } from "../database-facts-card";
import { DatabasePanel } from "../database-panel";
import { cloudDatabaseOf } from "../lifecycle/cloud-database";
import { DeleteDatabaseModal } from "../lifecycle/delete-database-modal";
import {
  DATABASE_DELETE_REFUSAL,
  useDatabaseActions,
  useUpdateDatabase,
} from "../use-database";
import { ResourcesCard } from "./advanced-resources-card";
import { RuntimeCard } from "./advanced-runtime-card";
import { ElastiCacheSettingsCard } from "./elasticache-settings-card";
import { MemorystoreSettingsCard } from "./memorystore-settings-card";
import { RdsSettingsCard } from "./rds-settings-card";
import {
  ConfigLockNote,
  lockRefusal,
  useConfigLock,
} from "@/components/console/config-lock";

/**
 * The run command, the resource limits, and deleting the thing.
 *
 * The two settings cards are their own files because each carries an argument of
 * its own: the run command's is that **this warning is not the Application's
 * warning** (for three of these six engines the entrypoint is how the credentials
 * get applied), and the resources card's is why F10's identical card is not reused
 * directly. Both share one `update` mutation, handed in, so two saves cannot
 * disagree about which write is in flight.
 *
 * **Each control is off, with the reason, for a role the route would refuse**.
 * The two cards read `service: ['update']` themselves — `PATCH
 * /<engine>/:id` runs `findOwnedForUpdate` — and Delete reads `service:
 * ['delete']`, the `@RequirePermission` on `DELETE /<engine>/:id`; the same on
 * all six engines. Delete keeps its place and says why beside it, as the
 * Application's `DeleteApplicationCard` does.
 *
 * **A postgres on RDS has its RDS settings instead**: RDS runs no
 * container, so the run command and the resources are not its; its class,
 * storage, Multi-AZ and backup retention are. A redis on ElastiCache has its
 * ElastiCache settings likewise: its node type, replica and snapshot
 * retention. A redis on Memorystore has its Memorystore setting: high
 * availability. A postgres on Cloud SQL has none of these here: its machine
 * is its size's, or its `native.gcp` tier's, in the Project config, and its
 * backup retention is its Backups tab's, so the RDS card, whose route
 * refuses a Cloud SQL row, is not shown for it.
 */
export default function Panel(props: PanelProps) {
  return (
    <DatabasePanel
      panel={props}
      aside={(row, kind) => <DatabaseFactsCard database={row} kind={kind} />}
      header={(row) => (
        <PageHeader
          title={props.label}
          icon={props.icon}
          lede={`How ${row.name} runs, and how to get rid of it.`}
        />
      )}
    >
      {(row, kind) => <Body row={row} kind={kind} />}
    </DatabasePanel>
  );
}

function Body({ row, kind }: { row: Database; kind: DatabaseKind }) {
  const router = useRouter();
  const update = useUpdateDatabase(kind, row.databaseId, row.environmentId);
  const actions = useDatabaseActions(kind, row.databaseId, row.environmentId);
  const [deleting, setDeleting] = useState(false);
  const canDelete = usePermission({ service: ["delete"] });
  // A database a repository-kept config describes is deleted by removing it
  // from the file.
  const lock = useConfigLock(row.environmentId, kind, row.databaseId);
  const refusalId = useId();
  const place = cloudDatabaseOf(row, kind);
  const rds = place === "rds" ? rdsSettingsOf(row) : null;
  const memorystore = memorystoreSettingsOf(row);
  const cache = memorystore ? null : elastiCacheSettingsOf(row);

  return (
    <>
      {place === "cloud-sql" ? (
        <CloudSqlSettingsNote />
      ) : rds ? (
        <RdsSettingsCard row={row} settings={rds} />
      ) : memorystore ? (
        <MemorystoreSettingsCard row={row} settings={memorystore} />
      ) : cache ? (
        <ElastiCacheSettingsCard row={row} settings={cache} />
      ) : (
        <>
          <RuntimeCard row={row} kind={kind} update={update} />
          <ResourcesCard row={row} update={update} />
        </>
      )}

      <Card className="border-bad-line">
        <Card.Header
          title="Delete this database"
          sub="The service and the row go. A data volume, if a deploy created one, stays on the Server."
          headingLevel={2}
        />
        <Card.Body className="flex flex-col gap-3">
          {canDelete.allowed ? null : (
            <p id={refusalId} className="text-meta text-tx-2">
              {DATABASE_DELETE_REFUSAL}
            </p>
          )}
          {canDelete.allowed && lock ? (
            <ConfigLockNote lock={lock} what="This database is" />
          ) : null}
          <div>
            <Button
              variant="dngr"
              disabled={!canDelete.allowed || lock !== null}
              title={
                !canDelete.allowed
                  ? DATABASE_DELETE_REFUSAL
                  : lock
                    ? lockRefusal(lock)
                    : undefined
              }
              aria-describedby={canDelete.allowed ? undefined : refusalId}
              onClick={() => {
                if (canDelete.allowed) setDeleting(true);
              }}
            >
              Delete {row.name}
            </Button>
          </div>
        </Card.Body>
      </Card>

      <DeleteDatabaseModal
        database={row}
        kind={kind}
        open={deleting}
        onOpenChange={setDeleting}
        remove={(deleteData, force) =>
          actions.remove.mutateAsync({ deleteData, force })
        }
        // Its row is gone, so this screen cannot stay. The Environment above it
        // is the nearest thing that still exists.
        onDeleted={() => router.push(`/environments/${row.environmentId}`)}
      />
    </>
  );
}

/** Where a postgres on Cloud SQL's own settings are, in place of a card of them. */
function CloudSqlSettingsNote() {
  return (
    <Card>
      <Card.Header
        title="Cloud SQL settings"
        sub="Cloud SQL runs no container to configure here."
        headingLevel={2}
      />
      <Card.Body>
        <p className="text-meta text-tx-2">
          Its machine is its size, or its native.gcp settings.tier, in the
          Project config. Its backup retention is on the Backups tab.
        </p>
      </Card.Body>
    </Card>
  );
}
