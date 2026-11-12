"use client";

import { useState } from "react";

import { Card } from "@/components/console/card";
import { Cols } from "@/components/console/cols";
import { DataTable } from "@/components/console/data-table";
import { EmptyState } from "@/components/console/empty-state";
import { Page } from "@/components/console/page";
import { PageHeader } from "@/components/console/page-header";
import { Skeleton } from "@/components/console/skeleton";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/api/error-message";
import type { Environment } from "@/lib/api/endpoints/environments";
import { usePermission } from "@/lib/auth/use-permission";
import { Icon } from "@/lib/design/icons";
import type { PanelProps } from "@/lib/shell/tab-registry";

import { DeleteEnvironmentModal } from "@/features/environment/delete-environment-modal";
import { environmentColumns } from "@/features/environment/environment-columns";
import { EnvironmentFormModal } from "@/features/environment/environment-form-modal";
import {
  ENVIRONMENT_CREATE_REFUSAL,
  useEnvironments,
} from "@/features/environment/use-environments";

import { ProjectFactsCard } from "../project-facts-card";
import { useProject } from "../use-projects";

/**
 * The Environments in this Project (the reference's `viewProject`,
 * e-console.html:3882-3911).
 *
 * The columns and their three deliberate absences are in
 * `features/environment/environment-columns.tsx`; what is here is the screen
 * around them and the three dialogs, held at this level because only one can be
 * open at a time and none of them should be mounted inside a row the table is
 * about to re-sort.
 *
 * **Each opener is off, with the reason, for a role its route would refuse**.
 * New Environment is `POST /environments`, `environment: ['create']`;
 * the row menu's Rename is `PATCH /environments/:id`, whose
 * `findOwnedForUpdate` asks `environment: ['update']`; its Delete is `DELETE
 * /environments/:id`, `environment: ['delete']`. The built-in member holds only
 * the update. The columns are a declaration and cannot call a hook, so the two
 * row statements are read here and handed down as `grants`.
 */
export default function Panel({ id, label, icon }: PanelProps) {
  const project = useProject(id);
  const environments = useEnvironments(id);
  const canCreate = usePermission({ environment: ["create"] });
  const canUpdate = usePermission({ environment: ["update"] });
  const canDelete = usePermission({ environment: ["delete"] });

  const [dialog, setDialog] = useState<"none" | "new" | "rename" | "delete">(
    "none",
  );
  const [target, setTarget] = useState<Environment | null>(null);

  function open(next: typeof dialog, environment: Environment | null = null) {
    setTarget(environment);
    setDialog(next);
  }

  return (
    <Page>
      <PageHeader
        title={label}
        icon={icon}
        lede={
          project.data?.description ||
          "Each Environment is one copy of what this Project deploys, with its own variables."
        }
        actions={
          <Button
            variant="pri"
            disabled={!canCreate.allowed}
            title={canCreate.allowed ? undefined : ENVIRONMENT_CREATE_REFUSAL}
            onClick={() => canCreate.allowed && open("new")}
          >
            <Icon name="plus" size={15} />
            New Environment
          </Button>
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
        <Card>
          {environments.isPending ? (
            <Card.Body>
              <div className="grid gap-2.5" aria-busy="true">
                <Skeleton className="h-row" />
                <Skeleton className="h-row" />
              </div>
            </Card.Body>
          ) : environments.error ? (
            <Card.Body>
              <p className="text-body text-tx-2">
                {errorMessage(environments.error)}
              </p>
            </Card.Body>
          ) : (
            <>
              {/* No meta strip. It explained that an Environment's
                  variables are not inherited, which is the Variables tab's to
                  say, beside the variables. On this list it was a permanent
                  design note above the table. */}
              {/* Mounts once, when the skeleton gives way: the rows arrive as one
                  block. A refetch keeps it mounted, so it never replays. */}
              <Card.Body flush className="animate-rise">
                <DataTable
                  label="Environments"
                  rows={environments.data ?? []}
                  getRowId={(row) => row.environmentId}
                  defaultSort={{ id: "name", dir: "asc" }}
                  columns={environmentColumns({
                    grants: {
                      update: canUpdate.allowed,
                      remove: canDelete.allowed,
                    },
                    onRename: (row) => open("rename", row),
                    onDelete: (row) => open("delete", row),
                  })}
                  empty={
                    <EmptyState
                      icon="layers"
                      title="Make your first Environment"
                      action={
                        <Button
                          size="sm"
                          variant="pri"
                          disabled={!canCreate.allowed}
                          title={
                            canCreate.allowed
                              ? undefined
                              : ENVIRONMENT_CREATE_REFUSAL
                          }
                          onClick={() => canCreate.allowed && open("new")}
                        >
                          New Environment
                        </Button>
                      }
                    >
                      Create an Environment to deploy into. Most Projects start
                      with one called production.
                    </EmptyState>
                  }
                />
              </Card.Body>
            </>
          )}
        </Card>
      </Cols>

      <EnvironmentFormModal
        projectId={id}
        environment={dialog === "rename" ? target : null}
        // Remounted per target, so react-hook-form's defaults are this
        // Environment's rather than whichever row opened the dialog first.
        key={`${dialog}-${target?.environmentId ?? "new"}`}
        open={dialog === "new" || dialog === "rename"}
        onOpenChange={(next) => !next && setDialog("none")}
      />
      {target ? (
        <DeleteEnvironmentModal
          environmentId={target.environmentId}
          environmentName={target.name}
          projectId={id}
          env={target.env}
          open={dialog === "delete"}
          onOpenChange={(next) => !next && setDialog("none")}
        />
      ) : null}
    </Page>
  );
}
