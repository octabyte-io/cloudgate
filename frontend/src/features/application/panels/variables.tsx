"use client";

import Link from "next/link";

import { Banner, BannerRow } from "@/components/console/banner";
import {
  useConfigLock,
  variableNameLock,
} from "@/components/console/config-lock";
import { Card } from "@/components/console/card";
import { Cols } from "@/components/console/cols";
import { Page } from "@/components/console/page";
import { PageHeader } from "@/components/console/page-header";
import { Skeleton } from "@/components/console/skeleton";
import { errorMessage } from "@/lib/api/error-message";
import { usePermission } from "@/lib/auth/use-permission";
import type { PanelProps } from "@/lib/shell/tab-registry";

import { useEnvironment } from "@/features/environment/use-environments";
import { countVariables, parseEnvBlob } from "@/lib/format/env-blob";
import { VariablesCard } from "@/components/console/variables-card";
import { useProject } from "@/features/project/use-projects";
import { WiredChangedNotice } from "@/components/console/wired-changed-notice";
import { WiredVariablesCard } from "@/components/console/wired-variables-card";
import { useWiredVariables } from "@/lib/api/use-wired-variables";

import { BuildArgumentsCard } from "../vars/build-arguments-card";
import { ResolutionCard } from "../vars/resolution-card";
import {
  APPLICATION_UPDATE_REFUSAL,
  useApplication,
  useSaveApplicationEnvironment,
} from "../use-application";

/**
 * What this Application is handed at runtime, and what its build is handed.
 *
 * **Three blobs, not one**, and that is the shape of the endpoint rather than a
 * layout choice: `PATCH /applications/:id/environment` takes `env`, `buildArgs` and
 * `buildSecrets` together, and they reach different places. `env` becomes the
 * container's environment; `buildArgs` becomes `--build-arg` on the build and is
 * baked into the image; `buildSecrets` is mounted during the build and is not. Any
 * screen that presented them as one list would be inviting someone to put a
 * credential where it gets committed to an image layer.
 *
 * The **Environment's** and the **Project's** blobs are shown read-only underneath,
 * for the reason F08 gives on the Environment's own tab: there is no merge to read
 * them out of, so someone looking for `DATABASE_URL` and not finding it here has no
 * way to learn it is set one level up and reachable by name. **The `env` block above
 * them is the whole answer to "what will this process actually see"** —
 * `prepareEnvironmentVariables` (`docker/docker.utils.ts`) returns the service's
 * own blob and nothing else, and the two cards below it are only what can be named
 * in it. Hence
 * "Available from", not "Inherited from", on both of them.
 *
 * The redeploy warning is a banner rather than a line in a hint, because it is the
 * one thing on this screen that is easy to get wrong and expensive to notice late:
 * **saving changes nothing that is running.** It is drawn only once there is
 * something running to keep its old variables, i.e. not on an `idle` row, which
 * no Deployment has started yet. On a never-run Application it was a
 * permanent amber warning about a container that did not exist.
 */
export default function Panel({ id, label, icon }: PanelProps) {
  const application = useApplication(id);
  const save = useSaveApplicationEnvironment(
    id,
    application.data?.environmentId,
  );

  // `PATCH /applications/:id/environment` runs `findOwnedForUpdate`, which is
  // `service: ['update']` — a role made to deploy but not to change (the
  // `ui-deployer`) was handed Edit and met the refusal on Save.
  const canSave = usePermission({ service: ["update"] });

  const row = application.data;
  // A repository-kept config's file sets the names it lists.
  const lock = useConfigLock(
    row?.environmentId ?? "",
    "application",
    row?.applicationId ?? "",
  );
  const environment = useEnvironment(row?.environmentId ?? "");
  const project = useProject(environment.data?.projectId ?? "");
  // The same read the links card below makes, so a `${{KEY}}` naming a
  // linked variable is not called unset.
  const wired = useWiredVariables("application", row?.applicationId ?? "");

  const availableFromEnvironment = countVariables(environment.data?.env);
  const availableFromProject = countVariables(project.data?.env);

  return (
    <Page>
      <PageHeader
        title={label}
        icon={icon}
        lede="What this Application's process sees when it starts, and what its build sees while it runs."
      />

      <Cols
        aside={
          <ResolutionCard
            application={row}
            environmentCount={availableFromEnvironment}
            projectCount={availableFromProject}
          />
        }
        asideLabel="Where these come from"
      >
        {application.error ? (
          <Card>
            <Card.Body>
              <p className="text-body text-tx-2">
                {errorMessage(application.error)}
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
            {row.applicationStatus !== "idle" ? (
              <Banner icon="info" title="A change here needs a Deployment to take effect.">
                <BannerRow
                  tone="warn"
                  title="The running container keeps the variables it started with."
                  description="Deploy when you are done, and the next container starts with them."
                  action={
                    <Link
                      href={`/applications/${id}/deployments`}
                      className="text-body font-medium text-brand-tx underline-offset-3 hover:underline focus-visible:underline"
                    >
                      Go to Deployments
                    </Link>
                  }
                />
              </Banner>
            ) : null}

            {/* A linked Output changed outside a plan. */}
            <WiredChangedNotice
              wiredChangedAt={row.wiredChangedAt}
              deploymentsHref={`/applications/${id}/deployments`}
            />

            <VariablesCard
              env={row.env ?? ""}
              noun="Application"
              title="Variables"
              sub="Handed to the container as its environment."
              meta={
                <>
                  {/* `{" "}` after the closing `</strong>` — a JSXText node
                      starting with a newline loses its leading space, which is
                      how this first read "are allits container gets". */}
                  These are <strong>all</strong>{" "}
                  its container gets; reference an Environment or Project
                  variable by name to use it.
                </>
              }
              save={(next) => save.mutateAsync({ env: next })}
              references={{
                project: project.data?.env,
                environment: environment.data?.env,
                wired: wired.data?.links.map((link) => link.name),
              }}
              names={variableNameLock(
                lock,
                "env",
                parseEnvBlob(row.env).map((variable) => variable.key),
              )}
              gate={{
                allowed: canSave.allowed,
                refusal: APPLICATION_UPDATE_REFUSAL,
              }}
            />

            {/* Linked rows, apart from the typed blob: a link has no
                value to edit, and is set in the config. */}
            <WiredVariablesCard
              serviceType="application"
              serviceId={row.applicationId}
              environmentId={row.environmentId}
              typedNames={parseEnvBlob(row.env).map((variable) => variable.key)}
              lock={lock}
              gate={{
                allowed: canSave.allowed,
                refusal: APPLICATION_UPDATE_REFUSAL,
              }}
            />

            <BuildArgumentsCard application={row} save={save.mutateAsync} />

            {environment.data && availableFromEnvironment > 0 ? (
              <VariablesCard
                env={environment.data.env}
                noun="Environment"
                title="Available from the Environment"
                sub={`${availableFromEnvironment} ${availableFromEnvironment === 1 ? "variable" : "variables"} set on ${environment.data.name}.`}
                meta={
                  <>
                    Reach one by naming it above —{" "}
                    <code className="font-mono">{"${{environment.KEY}}"}</code>.
                  </>
                }
                canEdit={false}
                save={async () => undefined}
              />
            ) : null}

            {project.data && availableFromProject > 0 ? (
              <VariablesCard
                env={project.data.env}
                noun="Project"
                title="Available from the Project"
                sub={`${availableFromProject} ${availableFromProject === 1 ? "variable" : "variables"} set on ${project.data.name}.`}
                meta={
                  <>
                    Reach one by naming it above —{" "}
                    <code className="font-mono">{"${{project.KEY}}"}</code>.
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
