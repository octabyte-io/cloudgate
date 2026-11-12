"use client";

import { useState } from "react";
import { z } from "zod";

import { Card } from "@/components/console/card";
import { Chip } from "@/components/console/chip";
import { DataTable } from "@/components/console/data-table";
import { Dash } from "@/components/console/dash";
import { EmptyState } from "@/components/console/empty-state";
import { MetaStrip } from "@/components/console/meta-strip";
import { Page } from "@/components/console/page";
import { PageHeader } from "@/components/console/page-header";
import { RowTime } from "@/components/console/rows/cells";
import { Skeleton } from "@/components/console/skeleton";
import { TabPending } from "@/components/console/tab-pending";
import { Button } from "@/components/ui/button";
import { cloudNameOf } from "@/lib/api/endpoints/applications";
import type { Application } from "@/lib/api/endpoints/applications";
import type { Rollback, RollbackContext } from "@/lib/api/endpoints/rollbacks";
import { errorMessage } from "@/lib/api/error-message";
import { usePermission } from "@/lib/auth/use-permission";
import type { PanelProps } from "@/lib/shell/tab-registry";

import { DeleteRollbackModal } from "../advanced/delete-rollback-modal";
import { RollbackModal } from "../advanced/rollback-modal";
import { isStaticOnCloud, StaticRollbacks } from "./static-rollbacks";
import { SettingsCard } from "@/components/console/settings-card";
import { useRollbackMutations, useRollbacks } from "../advanced/use-advanced";
import { isGitProviderKind, sourceSummary } from "../source/providers";
import {
  APPLICATION_SETTINGS_REFUSAL,
  useApplication,
  useUpdateApplication,
} from "../use-application";

/**
 * The branch a snapshot was built from — whichever of the five columns holds it.
 *
 * `fullContext` is the Application row as it stood, so the branch is in `branch`
 * only for GitHub. A custom-git Application records it in `customGitBranch`, and
 * GitLab, Gitea and Bitbucket each have their own column. Reading `branch`
 * unconditionally printed "Not recorded" over a branch the row was carrying, for
 * four source types out of five.
 *
 * `sourceSummary` is the resolver the Source card and the Deployments tab
 * already answer this with, and reusing it is the point: a second copy is how a
 * sixth source type ends up handled on one screen and not the other. The cast is
 * what that reuse costs — `fullContext` is the same row with the secrets
 * stripped (`rollback.schema.ts`) and is typed loosely because it arrives as
 * JSON, while every column `sourceSummary` reads survives the stripping — and
 * deliberately so: it resolves a branch out of the source columns and never
 * touches `connectionKey`, the `githubId`-shaped field taken out of the
 * snapshot. A resolver that read the connection id would have started rendering
 * "Not recorded" the day that landed. The
 * guard is not decoration: `sourceSummary` indexes `GIT_PROVIDERS` by
 * `sourceType`, and a snapshot old enough to name something else would take the
 * table down with it.
 */
export function snapshotBranch(context: RollbackContext | null): string | null {
  const sourceType = context?.sourceType;
  if (!context || typeof sourceType !== "string") return null;
  const known =
    sourceType === "docker" ||
    sourceType === "git" ||
    sourceType === "drop" ||
    isGitProviderKind(sourceType);
  if (!known) return null;

  const branch = sourceSummary(context as unknown as Application).branch;
  return branch !== null && branch !== "" ? branch : null;
}

/**
 * Where this Application can go back to.
 *
 * A rollback point is an **image tag plus the service spec it was deployed
 * with** — the engine tags every successful build `{appName}:v{version}` and
 * records what it deployed. Going back is therefore an update of the Swarm
 * service to an image that is already on the host, not a rebuild, which is why
 * it takes seconds and cannot fail the way a build can.
 *
 * Two things this screen has to be honest about, both found by reading
 * `rollbacks.service.ts` rather than by assuming symmetry with Deployments:
 *
 * 1. **A snapshot with no image cannot be used.** `rollback()` 404s when either
 *    `image` or `fullContext` is missing, so the row renders as unusable with
 *    the reason rather than offering a button that refuses.
 * 2. **Rolling back writes no Deployment.** There is no row, no log and no
 *    status change — it is a Docker service update. The strip above the table
 *    says so, because looking for it on the Deployments tab afterwards is the
 *    obvious thing to do and it will not be there.
 */
/** The lede of a cloud `web`'s Rollbacks tab. */
/** The lede of a cloud `web`'s Rollbacks tab, naming its cloud. */
export function cloudRollbackLede(cloudName: string): string {
  return `Rollback is not available on ${cloudName} yet, whatever Keep rollback points says.`;
}

export default function Panel({ id, label, icon }: PanelProps) {
  const application = useApplication(id);
  const rollbacks = useRollbacks(id);
  const mutations = useRollbackMutations(id);

  const row = application.data;
  const update = useUpdateApplication(id, row?.environmentId);
  // `PATCH /applications/:id` runs `findOwnedForUpdate`: `service: ['update']`.
  const canSave = usePermission({ service: ["update"] });

  const [rollingBack, setRollingBack] = useState<Rollback | null>(null);
  const [removing, setRemoving] = useState<Rollback | null>(null);

  if (!row) return <TabPending />;

  // A `static` site on AWS's points are folders of its bucket, and
  // rolling back is a Deployment that restores files only.
  if (isStaticOnCloud(row)) {
    return <StaticRollbacks row={row} label={label} icon={icon} />;
  }

  // A `web` in a Cloud account has no rollback, whatever
  // `rollbackActive` says: no snapshot is captured, and none is offered.
  if (row.cloudPlace) {
    return (
      <Page className="grid gap-3">
        <PageHeader
          title={label}
          icon={icon}
          lede={cloudRollbackLede(cloudNameOf(row.cloudPlace))}
        />
        <Card>
          <Card.Body>
            <EmptyState
              icon="back"
              title={`Rollback is not available on ${cloudNameOf(row.cloudPlace)} yet`}
            >
              Deploy again to change what runs. Each deploy keeps only its live
              image in Cloud account {row.cloudPlace.cloudAccountName} (
              {row.cloudPlace.region}), so there is no earlier version to go
              back to.
            </EmptyState>
          </Card.Body>
        </Card>
      </Page>
    );
  }

  const rows = rollbacks.data ?? [];

  return (
    <Page className="grid gap-3">
      <PageHeader
        title={label}
        icon={icon}
        lede="The versions this Application can be put back on, and what each one is."
      />

      <SettingsCard
        title="Keep rollback points"
        gate={{
          allowed: canSave.allowed,
          refusal: APPLICATION_SETTINGS_REFUSAL,
        }}
        lede="Whether a successful Deployment leaves a snapshot behind."
        schema={z.object({ rollbackActive: z.boolean() })}
        fields={[
          {
            kind: "switch",
            name: "rollbackActive",
            label: "Capture a snapshot on every successful Deployment",
            hint: "Each one keeps a tagged copy of the image on the Server, so going back needs no rebuild. Turning this off does not delete the snapshots already taken.",
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
              ? `${rows.length} ${rows.length === 1 ? "snapshot" : "snapshots"}, newest first.`
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
                Rolling back updates the Swarm service to a stored image. It
                writes <strong>no Deployment</strong>, so it will not appear on
                the Deployments tab — and it restores the image and its spec,
                not this Application&rsquo;s variables.
              </MetaStrip>
            ) : null}
            <Card.Body flush>
              <DataTable
                label="Rollback points of this Application"
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
                    id: "image",
                    head: "Image",
                    tone: "wrap",
                    cell: (item) =>
                      item.image ? (
                        <span
                          title={item.image}
                          className="font-mono text-meta wrap-anywhere text-tx-2"
                        >
                          {item.image}
                        </span>
                      ) : (
                        <Dash word="No image" />
                      ),
                  },
                  {
                    id: "source",
                    head: "Built from",
                    cell: (item) => {
                      const branch = snapshotBranch(item.fullContext);
                      return branch !== null ? (
                        <Chip variant="mono">{branch}</Chip>
                      ) : (
                        <Dash word="Not recorded" />
                      );
                    },
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
                          // A snapshot with no image or no context is refused by
                          // the backend with a 404. Saying so here beats a button
                          // that fails when pressed.
                          aria-disabled={
                            !item.image || !item.fullContext ? true : undefined
                          }
                          title={
                            !item.image || !item.fullContext
                              ? "This snapshot has no stored image, so it cannot be rolled back to."
                              : undefined
                          }
                          onClick={() => {
                            if (item.image && item.fullContext) {
                              setRollingBack(item);
                            }
                          }}
                        >
                          Roll back
                        </Button>
                        <Button
                          size="xs"
                          variant="dngr"
                          onClick={() => setRemoving(item)}
                        >
                          Delete
                        </Button>
                      </span>
                    ),
                  },
                ]}
                empty={
                  <EmptyState
                    icon="back"
                    title="No snapshot has been captured yet"
                  >
                    {row.rollbackActive
                      ? "The next successful Deployment leaves one behind, and from then on this Application can be put back on a previous version without rebuilding it."
                      : "Turn snapshots on above, and the next successful Deployment leaves one. Until then, nothing is kept."}
                  </EmptyState>
                }
              />
            </Card.Body>
          </>
        )}
      </Card>

      <RollbackModal
        rollback={rollingBack}
        applicationName={row.name}
        open={rollingBack !== null}
        onOpenChange={(next) => {
          if (!next) setRollingBack(null);
        }}
        run={(rollbackId) => mutations.rollback.mutateAsync(rollbackId)}
      />
      <DeleteRollbackModal
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
