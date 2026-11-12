"use client";

import { Card } from "@/components/console/card";
import { Cols } from "@/components/console/cols";
import { Page } from "@/components/console/page";
import { PageHeader } from "@/components/console/page-header";
import { Skeleton } from "@/components/console/skeleton";
import { errorMessage } from "@/lib/api/error-message";
import { roleRefusal, usePermission } from "@/lib/auth/use-permission";
import type { PanelProps } from "@/lib/shell/tab-registry";

import { useProject } from "@/features/project/use-projects";

import { EnvironmentFactsCard } from "../environment-facts-card";
import { VariableReferenceCard } from "../variable-reference-card";
import { useEnvironment, useUpdateEnvironment } from "../use-environments";
import { countVariables } from "@/lib/format/env-blob";
import { VariablesCard } from "@/components/console/variables-card";

/**
 * This Environment's own variables — the names a service deployed here can
 * reference (the reference's `envVarsTab`, e-console.html:4029-4051).
 *
 * The reference draws this as a table with an "Add a variable" button and a
 * Scope column. Neither is available: the column is **one encrypted blob**
 * (`environments/environment.schema.ts`), `PATCH /environments/:id` takes it
 * whole, and there is no third row to attribute a scope to — everything here is
 * this Environment's by definition. So the block is the editor and the sentence
 * above it is the scope.
 *
 * **Nothing here is handed to anything.** `prepareEnvironmentVariables`
 * (`docker/docker.utils.ts`) maps over a service's **own** blob and returns
 * only that; this Environment's blob is passed in as an *interpolation source*
 * for `${{environment.KEY}}` and is never merged. A key set here and never
 * referenced reaches no container.
 *
 * That is why the header's lede no longer says these are "handed to every
 * service in this Environment". This is the screen where somebody decides to set
 * a key once and stop, so the lede is the most expensive sentence in the console
 * to get wrong — it sat a few inches above a card saying the opposite.
 *
 * The Project's variables are shown too, read-only, because there is no merge to
 * read them out of: someone looking for `DATABASE_URL` and not finding it here
 * has no way to learn it is set one level up and reachable by name. **That card
 * is gated on the Project having variables**, which is why F19 never saw it and
 * it kept claiming an inheritance and an override precedence that no code
 * computes.
 */
export default function Panel({ id, label, icon }: PanelProps) {
  const environment = useEnvironment(id);
  const update = useUpdateEnvironment(id, environment.data?.projectId);
  const project = useProject(environment.data?.projectId ?? "");
  // `PATCH /environments/:id` is `environment: ['update']`.
  const canSave = usePermission({ environment: ["update"] });

  const row = environment.data;
  const availableFromProject = countVariables(project.data?.env);

  return (
    <Page>
      <PageHeader
        title={label}
        icon={icon}
        lede="Variables any service in this Environment can reference by name."
      />

      <Cols
        aside={
          <>
            <EnvironmentFactsCard environmentId={id} />
            <VariableReferenceCard />
          </>
        }
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
                <Skeleton className="h-row" />
                <Skeleton className="h-row" />
              </div>
            </Card.Body>
          </Card>
        ) : (
          <>
            <VariablesCard
              env={row.env}
              noun="Environment"
              sub={`Available to every service in ${row.name}.`}
              meta={
                <>
                  A service reaches one as{" "}
                  <code className="font-mono">{"${{environment.KEY}}"}</code>; a
                  key nobody references reaches no container.
                </>
              }
              save={(next) => update.mutateAsync({ env: next })}
              gate={{
                allowed: canSave.allowed,
                refusal: roleRefusal("change this Environment's variables"),
              }}
            />

            {project.data && availableFromProject > 0 ? (
              <VariablesCard
                env={project.data.env}
                noun="Project"
                title="Available from the Project"
                sub={`${availableFromProject} ${availableFromProject === 1 ? "variable" : "variables"} set on ${project.data.name}.`}
                meta={
                  <>
                    A service reaches one as{" "}
                    <code className="font-mono">{"${{project.KEY}}"}</code>, and
                    the same key set above does not override it.
                  </>
                }
                canEdit={false}
                save={async () => undefined}
              />
            ) : null}
          </>
        )}
      </Cols>
    </Page>
  );
}
