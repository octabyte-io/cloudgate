"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";

import { Card } from "@/components/console/card";
import { Cols } from "@/components/console/cols";
import { Page } from "@/components/console/page";
import { PageHeader } from "@/components/console/page-header";
import { QAList, QARow } from "@/components/console/qa-row";
import { Skeleton } from "@/components/console/skeleton";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/api/error-message";
import { usePermission } from "@/lib/auth/use-permission";
import type { PanelProps } from "@/lib/shell/tab-registry";

import { DeleteEnvironmentModal } from "../delete-environment-modal";
import { EnvironmentConfigBranchCard } from "../environment-config-branch-card";
import { EnvironmentDeployTargetCard } from "../environment-deploy-target-card";
import { EnvironmentDetailsForm } from "../environment-details-form";
import { EnvironmentFactsCard } from "../environment-facts-card";
import {
  ENVIRONMENT_DELETE_REFUSAL,
  useEnvironment,
} from "../use-environments";

/**
 * An Environment's settings (the reference's `envSettingsTab`,
 * e-console.html:4097-4113).
 *
 * Rename, describe, delete — the three things F08 asks of this screen. The
 * description is the one that answers "what is `blue` for?", which nothing else
 * on the Environment does.
 *
 * The Deploy target is the Environment's own column and has its own
 * card here. The reference's Runtime row is still absent for the reason
 * `nav.ts` gives: it is a column on nothing.
 *
 * Deleting leaves for the parent Project rather than the Projects list — unlike
 * a deleted Project, the thing above this one certainly still exists, and it is
 * where the remaining Environments are.
 *
 * Delete is off, with the reason beside it, for a role without
 * `environment: ['delete']` — the statement `DELETE /environments/:id` is
 * decorated with, which the built-in member and a read-only role lack.
 */
export default function Panel({ id, label, icon }: PanelProps) {
  const environment = useEnvironment(id);
  const router = useRouter();
  const [deleting, setDeleting] = useState(false);
  const canDelete = usePermission({ environment: ["delete"] });
  const refusalId = useId();

  const row = environment.data;

  return (
    <Page>
      <PageHeader
        title={label}
        icon={icon}
        lede={
          row
            ? `${row.name} — what it is called, what it is for, where its new Services run, and how to delete it.`
            : "What this Environment is called, what it is for, where its new Services run, and how to delete it."
        }
      />

      <Cols
        aside={<EnvironmentFactsCard environmentId={id} />}
        asideLabel="About this Environment"
      >
        {environment.error ? (
          <Card>
            <Card.Body>
              <p className="text-body text-tx-2">
                {errorMessage(environment.error)}
              </p>
            </Card.Body>
          </Card>
        ) : !row ? (
          <Card>
            <Card.Body>
              <div className="grid gap-2.5" aria-busy="true">
                <Skeleton className="h-ctl" />
                <Skeleton className="h-ctl" />
              </div>
            </Card.Body>
          </Card>
        ) : (
          <>
            <EnvironmentDetailsForm environment={row} />

            <EnvironmentDeployTargetCard environment={row} />

            <EnvironmentConfigBranchCard environment={row} />

            <Card>
              <Card.Header title="Delete" headingLevel={2} />
              <Card.Body>
                <QAList>
                  <QARow
                    title="Delete this Environment"
                    description={`Removes ${row.name} and everything deployed in it, including volumes. The other Environments in this Project are untouched.`}
                    action={
                      <Button
                        variant="dngr"
                        disabled={!canDelete.allowed}
                        title={canDelete.allowed ? undefined : ENVIRONMENT_DELETE_REFUSAL}
                        aria-describedby={
                          canDelete.allowed ? undefined : refusalId
                        }
                        onClick={() => canDelete.allowed && setDeleting(true)}
                      >
                        Delete
                      </Button>
                    }
                  />
                </QAList>
                {canDelete.allowed ? null : (
                  <p id={refusalId} className="mt-1 text-meta text-tx-2">
                    {ENVIRONMENT_DELETE_REFUSAL}
                  </p>
                )}
              </Card.Body>
            </Card>
          </>
        )}
      </Cols>

      {row ? (
        <DeleteEnvironmentModal
          environmentId={id}
          environmentName={row.name}
          projectId={row.projectId}
          env={row.env}
          open={deleting}
          onOpenChange={setDeleting}
          onDeleted={() => router.push(`/projects/${row.projectId}`)}
          onCloudDeleting={() => router.push(`/environments/${id}`)}
        />
      ) : null}
    </Page>
  );
}
