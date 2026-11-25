import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { FormProvider } from "react-hook-form";

import { Card } from "@/components/console/card";
import { FormError } from "@/components/console/field";
import { LinkButton } from "@/components/console/link-button";
import { SameMachineNote } from "@/components/console/same-machine";
import { SubmitButton } from "@/components/console/submit-button";
import { useApiForm } from "@/components/console/use-api-form";
import type { Project } from "@/lib/api/endpoints/projects";
import type { SetupForm, TemplateSummary } from "@/lib/api/endpoints/templates";
import { useInvalidate } from "@/lib/api/use-invalidate";
import { usePermission } from "@/lib/auth/use-permission";

import { PLATFORM_HOST_VALUE } from "../environment/deploy-target";
import { AskedField, DomainHostFields } from "../templates/setup-fields";
import {
  SETUP_LABELS,
  setupChoice,
  setupSchema,
  startingValues,
  targetHosts,
  type SetupValues,
} from "../templates/setup-values";
import { NEW_PROJECT, useSetupForm } from "../templates/use-templates";
import { deployTemplate, type WizardPlace } from "./deploy-template";
import { DetailsPlace } from "./details-place";
import { AskAdmin } from "./wizard-parts";
import { freeEnvironmentName, freeProjectName } from "./wizard-model";
import { wizardHref } from "./wizard-state";

/**
 * Step 2's form, at parity with Template setup (#112): the template's
 * asked values, each compose Domain's host (`DomainHostFields`: the
 * Server's generated host to start with, or the person's own domain with
 * its A record and Check DNS), and under More options the Project and the
 * setup name. It holds Template setup's own values and checks
 * (`setup-values.ts`), as a new Project on this Server, and Deploy sends
 * what was chosen; the setup checks it all again, and its word is final.
 *
 * An existing Project is read for its Environments: the setup goes into
 * its Environment on this Server, or a new one made there.
 *
 * On This Cloudgate host it shows the Same-machine warning (#147); step 1
 * opens on the first Ready Server, so the wizard reaches here on a Server.
 */
export function DetailsForm({
  template,
  setup,
  projects,
  serverId,
  serverName,
  canDeploy,
}: {
  template: TemplateSummary;
  /** The new-Project setup form, carrying the hosts generated on the Server. */
  setup: SetupForm;
  projects: readonly Project[];
  serverId: string;
  serverName: string;
  /** False while a Bought Server has no Server row yet (before Setting up). */
  canDeploy: boolean;
}) {
  const router = useRouter();
  const invalidate = useInvalidate();
  const [projectId, setProjectId] = useState(NEW_PROJECT);
  const existing = useSetupForm(
    template.id,
    projectId === NEW_PROJECT ? null : projectId,
  );
  // What the chosen place asks of the role, as the setup asks it: its own
  // route `service: create` wherever it goes (Template setup's form leaves
  // that to the route), a new Project `project: create` and
  // `environment: create`, and a new Environment in an existing Project
  // `environment: create`, which `POST /environments` asks first.
  const canSetUp = usePermission({ service: ["create"] });
  const canMakeProject = usePermission({
    project: ["create"],
    environment: ["create"],
  });
  const canMakeEnvironment = usePermission({ environment: ["create"] });

  const place = placeIn(projectId, existing.data, serverId);
  const missing = !canSetUp.allowed
    ? "service"
    : place === null || "environmentId" in place
      ? null
      : "newProject" in place
        ? canMakeProject.allowed
          ? null
          : "project"
        : canMakeEnvironment.allowed
          ? null
          : "environment";
  const allowed = missing === null;
  const projectName = projects.find((one) => one.projectId === projectId)?.name;
  const onEnvironment =
    place && "environmentId" in place
      ? (existing.data?.environments.find(
          (env) => env.environmentId === place.environmentId,
        )?.name ?? null)
      : null;
  const generated = targetHosts(setup, serverId);

  const form = useApiForm<SetupValues>({
    schema: setupSchema(setup, true),
    defaultValues: {
      ...startingValues(setup, { firstTarget: serverId }),
      newProject: {
        name: freeProjectName(
          template.name,
          projects.map((project) => project.name),
        ),
        target: serverId,
        region: "",
      },
    },
    labelOf: (name) => SETUP_LABELS[name],
    onSubmit: async (values) => {
      if (place === null) return;
      const choice = setupChoice(setup, values, true);
      const result = await deployTemplate({
        templateId: template.id,
        serverId,
        place:
          "newProject" in place
            ? { newProject: { name: values.newProject.name.trim() } }
            : place,
        setupName: choice.setupName,
        values: choice.values,
        hosts: choice.hosts,
      });
      void invalidate.project();
      router.push(
        wizardHref({
          templateId: template.id,
          serverId,
          environmentId: result.pendingSetup.environmentId,
        }),
      );
    },
  });

  // A Bought Server's hosts are generated once its Server row exists, so a
  // form opened before then gets them late: each empty host takes its own.
  const { getValues, setValue } = form;
  useEffect(() => {
    if (generated === null) return;
    setup.domains.forEach((domain, at) => {
      const host = generated[domain.name];
      if (host && (getValues(`hosts.${at}`) ?? "") === "") {
        setValue(`hosts.${at}`, host);
      }
    });
  }, [generated, setup.domains, getValues, setValue]);

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
          <Card.Body className="grid gap-5">
            {setup.asked.length > 0 ? (
              <div className="grid gap-4">
                {setup.asked.map((input, at) => (
                  <AskedField
                    key={input.name}
                    input={input}
                    at={at}
                    hint={signInHint(template, input.name)}
                  />
                ))}
              </div>
            ) : null}
            {setup.domains.length > 0 ? (
              <section
                aria-labelledby="details-web"
                className="grid gap-3 border-t border-line pt-4 first:border-t-0 first:pt-0"
              >
                <h3 id="details-web" className="text-body font-medium text-tx">
                  Web address
                </h3>
                <DomainHostFields
                  domains={setup.domains}
                  generated={generated}
                  cloud={null}
                  platformHost={serverId === PLATFORM_HOST_VALUE}
                />
              </section>
            ) : null}
            {serverId === PLATFORM_HOST_VALUE ? <SameMachineNote /> : null}
            <DetailsPlace
              projects={projects}
              projectId={projectId}
              onProject={setProjectId}
              place={place}
              environmentName={onEnvironment}
              serverName={serverName}
            />
            {canDeploy ? null : (
              <p className="text-ui text-tx-2">
                You can deploy once the server is created.
              </p>
            )}
            {missing === "service" ? (
              <AskAdmin>
                {`Your role can’t add Services, so an owner or an admin can deploy ${template.name}.`}
              </AskAdmin>
            ) : missing === "project" ? (
              <AskAdmin>
                {projects.length > 0
                  ? `Your role can’t create a Project, so pick an existing one under More options, or an owner or an admin can deploy ${template.name}.`
                  : `Your role can’t create a Project, so an owner or an admin can deploy ${template.name}.`}
              </AskAdmin>
            ) : missing === "environment" ? (
              <AskAdmin>
                {`Your role can’t create an Environment, which the ${projectName ?? "chosen"} Project needs on ${serverName}, so an owner or an admin can deploy ${template.name}.`}
              </AskAdmin>
            ) : null}
            <FormError message={form.rootError} />
          </Card.Body>
          <Card.Footer className="flex flex-wrap items-center gap-3">
            <SubmitButton
              pending={form.formState.isSubmitting}
              disabled={place === null || !allowed || !canDeploy}
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

/**
 * Where Deploy sets up: a new Project (named from the form on Deploy), or
 * in an existing one its Environment on this Server that can take the
 * template, or else a new Environment there. Null while the existing
 * Project's form is read.
 */
function placeIn(
  projectId: string,
  existing: SetupForm | undefined,
  serverId: string,
): WizardPlace | null {
  if (projectId === NEW_PROJECT) return { newProject: { name: "" } };
  if (!existing) return null;
  const on = existing.environments.find(
    (env) => env.canTake && env.machine?.serverId === serverId,
  );
  return on
    ? { projectId, environmentId: on.environmentId }
    : {
        projectId,
        newEnvironment: freeEnvironmentName(
          existing.environments.map((env) => env.name),
        ),
      };
}

/**
 * Step 2's hint under the sign-in username (#131): its password, made at
 * setup, is shown on the done card, so the person needn't hunt for it later.
 */
function signInHint(
  template: TemplateSummary,
  name: string,
): string | undefined {
  const signIn = template.signIn;
  if (!signIn || "firstVisit" in signIn || signIn.username !== name) {
    return undefined;
  }
  return `The password is shown on the next screen once ${template.name} is running.`;
}
