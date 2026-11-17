import { useRouter } from "next/navigation";
import { useState } from "react";
import { FormProvider } from "react-hook-form";
import { z } from "zod";

import { Card } from "@/components/console/card";
import { FormError } from "@/components/console/field";
import { LinkButton } from "@/components/console/link-button";
import { Skeleton } from "@/components/console/skeleton";
import { SubmitButton } from "@/components/console/submit-button";
import { useApiForm } from "@/components/console/use-api-form";
import type { BoughtServerStage } from "@/lib/api/endpoints/bought-servers";
import type { SetupForm, TemplateSummary } from "@/lib/api/endpoints/templates";
import { errorMessage } from "@/lib/api/error-message";
import { useInvalidate } from "@/lib/api/use-invalidate";
import { useProjects } from "@/lib/api/use-projects";
import { usePermission } from "@/lib/auth/use-permission";

import { askedValueProblem } from "../templates/asked-value";
import { AskedField } from "../templates/setup-fields";
import { NEW_PROJECT, useSetupForm } from "../templates/use-templates";
import { DeployRefusal, deployTemplate } from "./deploy-template";
import { ServerGone, ServerProgress } from "./server-progress";
import { useWizardPurchases, useWizardServers } from "./use-get-started";
import { AskAdmin } from "./wizard-parts";
import { canSetUpOn, freeProjectName } from "./wizard-model";
import { wizardHref } from "./wizard-state";

type DetailsValues = { values: string[] };

/**
 * Step two: only what the app truly needs to be told — the template's
 * asked values, each starting on its default — and Deploy.
 *
 * Everything else is decided for the person: a new Project named after the
 * app, its `production` Environment on the chosen Server, the setup name
 * (the template's id), and each web address (the Server's generated one).
 * The setup checks every value again, and its word is final.
 *
 * Right after Buy the wizard is already here, with the Bought Server's
 * progress in a strip above the form: the details are filled in while it
 * is made, Deploy opens once it has a Server row (Setting up), and
 * Cloudgate applies the setup once it is Ready (ADR-0073).
 */
export function DetailsStep({
  template,
  serverId,
  bought,
}: {
  template: TemplateSummary;
  serverId: string;
  /**
   * Whether the Server was just bought here (the buy path): its progress
   * then sits above the form, and the form is open while it is still made.
   */
  bought: boolean;
}) {
  // On the buy path both are followed until the Server is Ready: the
  // purchase until its Server row exists (Setting up), the row after.
  const servers = useWizardServers(bought ? serverId : undefined);
  const purchases = useWizardPurchases(bought, false);
  const form = useSetupForm(template.id, NEW_PROJECT);
  const server = servers.data?.find((entry) => entry.serverId === serverId);
  const purchase = purchases.data?.find((entry) => entry.id === serverId);
  const stage = useLastStage(
    bought ? (server?.boughtServer?.stage ?? purchase?.stage ?? null) : null,
  );
  const error = servers.error ?? form.error;
  if (error) {
    return (
      <Card>
        <Card.Body>
          <p className="text-body text-tx-2">{errorMessage(error)}</p>
        </Card.Body>
      </Card>
    );
  }
  if (!servers.data || !form.data || (bought && purchases.isPending)) {
    return (
      <Card aria-busy="true">
        <Card.Body className="grid gap-3">
          <Skeleton className="h-6 w-64" />
          <Skeleton className="h-40" />
        </Card.Body>
      </Card>
    );
  }

  if (stage && GONE.includes(stage)) {
    return <ServerGone template={template} stage={stage} />;
  }

  // Before Setting up there is no Server row to set the app up on yet, but
  // the details can be filled in already; Deploy waits for the row.
  const beingMade = stage === "waiting_for_payment" || stage === "creating";
  if (!beingMade && (!server || !canSetUpOn(server))) {
    return (
      <Card>
        <Card.Body className="grid justify-items-start gap-3">
          <p className="text-body text-tx">
            That server isn&rsquo;t ready for an app yet.
          </p>
          <LinkButton href={wizardHref({ templateId: template.id })}>
            Choose a server
          </LinkButton>
        </Card.Body>
      </Card>
    );
  }

  const refusal = form.data.deployTargets.server;
  if (refusal) {
    return (
      <Card>
        <Card.Body className="grid gap-2">
          <p className="text-body text-tx">
            {`${template.name} can’t run on a server like this one.`}
          </p>
          <p className="text-ui text-tx-2">{refusal}</p>
        </Card.Body>
      </Card>
    );
  }

  const name = server?.name ?? purchase?.name ?? "Your server";
  return (
    <div className="grid gap-4.5">
      {stage ? (
        <ServerProgress
          template={template}
          id={serverId}
          name={name}
          stage={stage}
        />
      ) : null}
      {/* In the same place whether or not the strip shows, so what was typed
          stays as the Server moves through its stages. */}
      <DetailsForm
        template={template}
        setup={form.data}
        serverId={serverId}
        serverName={name}
        canDeploy={server !== undefined && canSetUpOn(server)}
      />
    </div>
  );
}

/** A Bought Server that will never take the app. */
const GONE: readonly BoughtServerStage[] = ["failed", "deleting", "deleted"];

/**
 * The stage last seen, held while neither read has the Server: the
 * purchase leaves the purchases list at Setting up, and the Server row is
 * read a poll later, which must not unmount the form in between.
 */
function useLastStage(
  stage: BoughtServerStage | null,
): BoughtServerStage | null {
  const [last, setLast] = useState(stage);
  if (stage !== null && stage !== last) setLast(stage);
  return stage ?? last;
}

function DetailsForm({
  template,
  setup,
  serverId,
  serverName,
  canDeploy,
}: {
  template: TemplateSummary;
  setup: SetupForm;
  serverId: string;
  serverName: string;
  /** False while a Bought Server has no Server row yet (before Setting up). */
  canDeploy: boolean;
}) {
  const router = useRouter();
  const projects = useProjects();
  const invalidate = useInvalidate();
  // The setup's own route asks `service: create`; a new Project asks
  // `project: create` and `environment: create` of the same person.
  const canSetUp = usePermission({ service: ["create"] });
  const canMakeProject = usePermission({
    project: ["create"],
    environment: ["create"],
  });
  const allowed = canSetUp.allowed && canMakeProject.allowed;
  const projectName = freeProjectName(
    template.name,
    (projects.data ?? []).map((project) => project.name),
  );
  const form = useApiForm<DetailsValues>({
    schema: z.object({ values: z.array(z.string()) }).superRefine(
      (values, issues) => {
        setup.asked.forEach((input, at) => {
          const problem = askedValueProblem(input, values.values[at] ?? "");
          if (problem) {
            issues.addIssue({
              code: "custom",
              path: ["values", at],
              message: problem,
            });
          }
        });
      },
    ),
    defaultValues: { values: setup.asked.map((input) => input.default ?? "") },
    onSubmit: async ({ values }) => {
      const asked = Object.fromEntries(
        setup.asked
          .map((input, at) => [input.name, values[at] ?? ""] as const)
          .filter(([, value]) => value !== ""),
      );
      try {
        const result = await deployTemplate({
          templateId: template.id,
          form: setup,
          projectName,
          serverId,
          values: asked,
        });
        void invalidate.project();
        router.push(
          wizardHref({
            templateId: template.id,
            serverId,
            environmentId: result.pendingSetup.environmentId,
          }),
        );
      } catch (error) {
        if (error instanceof DeployRefusal) {
          form.setError("root", { type: "server", message: error.message });
          return;
        }
        throw error;
      }
    },
  });

  return (
    <Card className="animate-fade">
      <Card.Header
        title={
          setup.asked.length > 0
            ? `A few details for ${template.name}`
            : `Ready to deploy ${template.name}`
        }
        sub="Passwords and keys it needs are made for you."
        headingLevel={2}
      />
      <FormProvider {...form}>
        <form
          method="post"
          noValidate
          onSubmit={form.submit}
          aria-label={`Deploy ${template.name}`}
        >
          <Card.Body className="grid gap-4">
            {setup.asked.map((input, at) => (
              <AskedField key={input.name} input={input} at={at} />
            ))}
            {/* What Deploy makes, said before it is pressed: it stands in
                for the Plan review nobody here is asked to do (ADR-0073). */}
            <dl
              aria-label="What Deploy makes"
              className="grid gap-1.5 rounded-lg border border-line bg-panel-2 p-3 text-ui"
            >
              <div className="flex flex-wrap justify-between gap-x-3">
                <dt className="text-tx-2">App</dt>
                <dd className="min-w-0 wrap-anywhere text-tx">{template.name}</dd>
              </div>
              <div className="flex flex-wrap justify-between gap-x-3">
                <dt className="text-tx-2">Server</dt>
                <dd className="min-w-0 wrap-anywhere text-tx">{serverName}</dd>
              </div>
              <div className="flex flex-wrap justify-between gap-x-3">
                <dt className="text-tx-2">New Project</dt>
                <dd className="min-w-0 wrap-anywhere text-tx">{projects.isPending ? "…" : projectName}</dd>
              </div>
              <div className="flex flex-wrap justify-between gap-x-3">
                <dt className="text-tx-2">Web address</dt>
                <dd className="min-w-0 wrap-anywhere text-tx">Made for you</dd>
              </div>
            </dl>
            {canDeploy ? null : (
              <p className="text-ui text-tx-2">
                You can deploy once the server is created.
              </p>
            )}
            {allowed ? null : (
              <AskAdmin>
                Deploying an app makes a new Project, which your role
                can&rsquo;t do. An owner or an admin can deploy{" "}
                {template.name} from this page.
              </AskAdmin>
            )}
            <FormError message={form.rootError} />
          </Card.Body>
          <Card.Footer className="flex flex-wrap items-center gap-3">
            <SubmitButton
              pending={form.formState.isSubmitting}
              disabled={projects.isPending || !allowed || !canDeploy}
            >
              Deploy {template.name}
            </SubmitButton>
            <LinkButton
              variant="qt"
              href={wizardHref({ templateId: template.id })}
            >
              Use a different server
            </LinkButton>
          </Card.Footer>
        </form>
      </FormProvider>
    </Card>
  );
}
