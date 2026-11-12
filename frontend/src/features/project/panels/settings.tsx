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

import { useEnvironments } from "@/features/environment/use-environments";
import { VariablesCard } from "@/components/console/variables-card";

import { DeleteProjectModal } from "../delete-project-modal";
import { ProjectDetailsForm } from "../project-details-form";
import { ProjectFactsCard } from "../project-facts-card";
import {
  PROJECT_DELETE_REFUSAL,
  PROJECT_UPDATE_REFUSAL,
  useProject,
  useUpdateProject,
} from "../use-projects";

/**
 * A Project's settings: what it is called, what it makes available to reference,
 * and how to destroy it (the reference's `viewProject` settings tab,
 * e-console.html:3872-3881).
 *
 * The reference renders these as an editable key/value list. They are a real
 * form here, because two of the three are free text with server-side validation
 * behind them and `useApiForm` is what puts a refused value back beside the
 * field that caused it.
 *
 * The variables card is the same component the Environment's own Variables tab
 * uses — one blob, one editor, one masking rule — with the sentence changed to
 * say who can reach *these*, and how. Nothing below a Project receives them:
 * `prepareEnvironmentVariables` (`docker/docker.utils.ts`) never merges a
 * Project's blob into a service's, it only resolves `${{project.KEY}}` out of it
 * The card's own
 * sentence already said that; the lede said "what it hands down" and did not.
 */
export default function Panel({ id, label, icon }: PanelProps) {
  const project = useProject(id);
  const environments = useEnvironments(id);
  const update = useUpdateProject(id);
  // `PATCH /projects/:id` is `project: ['update']`, the statement the details
  // form above already reads.
  const canSave = usePermission({ project: ["update"] });
  // `DELETE /projects/:id` is `project: ['delete']`, which the base member
  // does not hold — the Projects list's row menu reads the same.
  const canDelete = usePermission({ project: ["delete"] });
  const refusalId = useId();
  const router = useRouter();
  const [deleting, setDeleting] = useState(false);

  const row = project.data;

  return (
    <Page>
      <PageHeader
        title={label}
        icon={icon}
        lede={
          row
            ? `${row.name} — what it is called, what it makes available to reference, and how to delete it.`
            : "What this Project is called, what it makes available to reference, and how to delete it."
        }
      />

      <Cols
        aside={
          <ProjectFactsCard
            projectId={id}
            environmentCount={environments.data?.length}
          />
        }
        asideLabel="About this Project"
      >
        {project.error ? (
          <Card>
            <Card.Body>
              <p className="text-body text-tx-2">
                {errorMessage(project.error)}
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
            <ProjectDetailsForm project={row} />

            <VariablesCard
              env={row.env}
              noun="Project"
              title="Project variables"
              sub="Set once here, for anything below to reference."
              meta={
                <>
                  Nothing receives these automatically. A service in any
                  Environment under this Project reaches one by naming it —{" "}
                  <code className="font-mono">{"${{project.KEY}}"}</code> — and
                  a key nobody references reaches no container.
                </>
              }
              save={(next) => update.mutateAsync({ env: next })}
              gate={{
                allowed: canSave.allowed,
                refusal: PROJECT_UPDATE_REFUSAL,
              }}
            />

            <Card>
              <Card.Header title="Delete" headingLevel={2} />
              <Card.Body>
                <QAList>
                  <QARow
                    title="Delete this Project"
                    description={`Removes ${row.name}, every Environment in it, and everything deployed in those. This cannot be undone.`}
                    action={
                      <Button
                        variant="dngr"
                        disabled={!canDelete.allowed}
                        title={
                          canDelete.allowed ? undefined : PROJECT_DELETE_REFUSAL
                        }
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
                    {PROJECT_DELETE_REFUSAL}
                  </p>
                )}
              </Card.Body>
            </Card>
          </>
        )}
      </Cols>

      {row ? (
        <DeleteProjectModal
          projectId={id}
          projectName={row.name}
          open={deleting}
          onOpenChange={setDeleting}
          // The Project this page is *of* has gone, so staying here would render
          // the not-found screen at an address that was right a second ago.
          onDeleted={() => router.push("/projects")}
        />
      ) : null}
    </Page>
  );
}
