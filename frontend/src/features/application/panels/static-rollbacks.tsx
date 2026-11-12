import { useState } from "react";
import { z } from "zod";

import { Card } from "@/components/console/card";
import { DataTable } from "@/components/console/data-table";
import { EmptyState } from "@/components/console/empty-state";
import { MetaStrip } from "@/components/console/meta-strip";
import { Page } from "@/components/console/page";
import { PageHeader } from "@/components/console/page-header";
import { RowTime } from "@/components/console/rows/cells";
import { SettingsCard } from "@/components/console/settings-card";
import { Skeleton } from "@/components/console/skeleton";
import { Button } from "@/components/ui/button";
import type { ApplicationDetail } from "@/lib/api/endpoints/applications";
import type { Rollback } from "@/lib/api/endpoints/rollbacks";
import { errorMessage } from "@/lib/api/error-message";
import { roleRefusal, usePermission } from "@/lib/auth/use-permission";
import type { PanelProps } from "@/lib/shell/tab-registry";

import {
  DeleteStaticRollbackModal,
  STATIC_ROLLBACK_RESTORES,
  StaticRollbackModal,
  pointFolder,
} from "../advanced/static-rollback-modals";
import { useRollbackMutations, useRollbacks } from "../advanced/use-advanced";
import {
  APPLICATION_SETTINGS_REFUSAL,
  useUpdateApplication,
} from "../use-application";

/** Whether this Application is a `static` site on S3 + CloudFront. */
export function isStaticOnCloud(
  row: Pick<ApplicationDetail, "cloudPlace" | "buildType">,
): boolean {
  return row.cloudPlace !== null && row.buildType === "static";
}

/**
 * The Rollbacks tab of a `static` site on AWS.
 *
 * A point is a **folder of the site's bucket**, kept until the point is
 * deleted, and rolling back to one is a Deployment of the site that switches
 * CloudFront back to it: files only, never the distribution's settings.
 */
export function StaticRollbacks({
  row,
  label,
  icon,
}: {
  row: ApplicationDetail;
  label: string;
  icon: PanelProps["icon"];
}) {
  const rollbacks = useRollbacks(row.applicationId);
  const mutations = useRollbackMutations(row.applicationId);
  const update = useUpdateApplication(row.applicationId, row.environmentId);
  // `PATCH /applications/:id` runs `findOwnedForUpdate`: `service: ['update']`.
  const canSave = usePermission({ service: ["update"] });
  // `POST /rollbacks/:id/rollback` and `DELETE /rollbacks/:id` are both
  // `deployment: ['create']`.
  const canRollBack = usePermission({ deployment: ["create"] });
  const [rollingBack, setRollingBack] = useState<Rollback | null>(null);
  const [removing, setRemoving] = useState<Rollback | null>(null);
  const rows = rollbacks.data ?? [];

  return (
    <Page className="grid gap-3">
      <PageHeader
        title={label}
        icon={icon}
        lede="The versions of this site's files it can be put back on."
      />

      <SettingsCard
        title="Keep rollback points"
        gate={{
          allowed: canSave.allowed,
          refusal: APPLICATION_SETTINGS_REFUSAL,
        }}
        lede="Whether each Deployment's files stay in the site's bucket after the next one."
        schema={z.object({ rollbackActive: z.boolean() })}
        fields={[
          {
            kind: "switch",
            name: "rollbackActive",
            label: "Keep the files of every Deployment as a rollback point",
            hint: "Each point keeps its folder in the site's S3 bucket until you delete the point. Turning this off does not delete the points already kept.",
          },
        ]}
        defaultValues={{ rollbackActive: row.rollbackActive }}
        savedMessage="Rollback setting saved."
        submit={(values) =>
          update.mutateAsync({ rollbackActive: values.rollbackActive })
        }
      />

      <Card>
        <Card.Header
          title="Rollback points"
          sub={
            rows.length > 0
              ? `${rows.length} ${rows.length === 1 ? "point" : "points"}, newest first.`
              : undefined
          }
          headingLevel={2}
        />
        {rollbacks.error ? (
          <Card.Body>
            <p className="text-body text-tx-2">
              {errorMessage(rollbacks.error)}
            </p>
          </Card.Body>
        ) : rollbacks.isPending ? (
          <Card.Body>
            <div className="grid gap-2.5" aria-busy="true">
              <Skeleton className="h-row" />
              <Skeleton className="h-row" />
            </div>
          </Card.Body>
        ) : (
          <>
            {rows.length > 0 ? (
              <MetaStrip>
                {STATIC_ROLLBACK_RESTORES} It runs as a Deployment of the site,
                with its own log on the Deployments tab.
              </MetaStrip>
            ) : null}
            <Card.Body flush>
              <DataTable
                label="Rollback points of this site"
                rows={rows}
                getRowId={(item) => item.rollbackId}
                defaultSort={{ id: "version", dir: "desc" }}
                columns={[
                  {
                    id: "version",
                    head: "Version",
                    tone: "key",
                    cell: (item) => (
                      <span className="num">v{item.version}</span>
                    ),
                    compare: (a, b) => a.version - b.version,
                  },
                  {
                    id: "folder",
                    head: "Files",
                    tone: "wrap",
                    cell: (item) => (
                      <span className="font-mono text-meta wrap-anywhere text-tx-2">
                        {pointFolder(item)}
                      </span>
                    ),
                  },
                  {
                    id: "createdAt",
                    head: "Captured",
                    cell: (item) => <RowTime iso={item.createdAt} />,
                    compare: (a, b) => a.createdAt.localeCompare(b.createdAt),
                  },
                  {
                    id: "actions",
                    head: <span className="sr-only">Actions</span>,
                    className: "w-0",
                    cell: (item) => (
                      <span className="inline-flex justify-end gap-1.5 whitespace-nowrap">
                        <Button
                          size="xs"
                          variant="pri"
                          title={
                            canRollBack.allowed
                              ? "Restores this version's files"
                              : roleRefusal("roll back")
                          }
                          disabled={!canRollBack.allowed}
                          onClick={() => setRollingBack(item)}
                        >
                          Roll back
                        </Button>
                        <Button
                          size="xs"
                          variant="dngr"
                          disabled={!canRollBack.allowed}
                          title={
                            canRollBack.allowed
                              ? undefined
                              : roleRefusal("delete a rollback point")
                          }
                          onClick={() => setRemoving(item)}
                        >
                          Delete
                        </Button>
                      </span>
                    ),
                  },
                ]}
                empty={
                  <EmptyState icon="back" title="No rollback point yet">
                    {row.rollbackActive
                      ? "The next Deployment keeps its files as one, and from then on this site can be put back on them."
                      : "Turn rollback points on above. Until then, each Deployment's files go once the next one is live."}
                  </EmptyState>
                }
              />
            </Card.Body>
          </>
        )}
      </Card>

      <StaticRollbackModal
        rollback={rollingBack}
        applicationName={row.name}
        open={rollingBack !== null}
        onOpenChange={(next) => {
          if (!next) setRollingBack(null);
        }}
        run={(rollbackId) => mutations.rollback.mutateAsync(rollbackId)}
      />
      <DeleteStaticRollbackModal
        rollback={removing}
        open={removing !== null}
        onOpenChange={(next) => {
          if (!next) setRemoving(null);
        }}
        remove={(rollbackId) => mutations.remove.mutateAsync(rollbackId)}
      />
    </Page>
  );
}
