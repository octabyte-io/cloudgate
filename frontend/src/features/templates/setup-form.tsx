"use client";

import Link from "next/link";
import type React from "react";
import { FormProvider } from "react-hook-form";

import {
  Card,
  CardBody,
  CardFooter,
  CardHeader,
} from "@/components/console/card";
import { Field, FormError } from "@/components/console/field";
import { LinkButton } from "@/components/console/link-button";
import { SameMachineNote } from "@/components/console/same-machine";
import { SubmitButton } from "@/components/console/submit-button";
import { useApiForm } from "@/components/console/use-api-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { Server } from "@/lib/api/endpoints/servers";
import type { SetupForm } from "@/lib/api/endpoints/templates";
import { isSameMachineServer } from "@/lib/forms/create-server-picker";
import { GET_STARTED_PATH } from "@/lib/auth/routes";
import { cn } from "@/lib/utils";

import {
  CLOUDS,
  PLATFORM_HOST_VALUE,
  onSameMachine,
} from "../environment/deploy-target";
import type { NewProjectTarget } from "./new-project-targets";
import { AskedField, DomainHostFields } from "./setup-fields";
import { SetupKernelNote } from "./setup-kernel-note";
import {
  SETUP_LABELS,
  setupChoice,
  setupSchema,
  startingHosts,
  targetHosts,
  startingValues,
  type SetupChoice,
  type SetupValues,
} from "./setup-values";

export type { SetupChoice };

/**
 * Said on the new-Project form (spec story 35): the Project is made on Set
 * up, before the Plan is reviewed, and a dismissed Plan does not take it back.
 */
export const EMPTY_PROJECT_NOTE =
  "Set up makes the Project and its production Environment at once. Dismissing the Plan leaves them empty; delete the Project if you no longer want it.";

/**
 * The setup form for an existing Project (#1369): the Environment, with every
 * one that cannot take the template greyed out and its reason beside it, the
 * setup name in front of every part's Config name, and the template's asked
 * values, each checked as the setup will check it before Submit.
 *
 * With `newProject` it is the form for "New Project from a template"
 * (#1376): the Project's name and the Deploy target of its one `production`
 * Environment, each target that cannot take the template greyed out with its
 * reason, in place of the Environment, and a note that dismissing the Plan
 * leaves an empty Project.
 *
 * Each compose Domain asks for its host (#1373), starting on the generated
 * sslip.io host of the Environment picked, or for a new Project of the
 * Deploy target picked, which "Generate one for me" puts back once cleared.
 * In a Cloud Environment (#1379) each host is typed, with the DNS record it
 * needs shown under it.
 *
 * A new Project opens on the first Ready deploy Server that can take the
 * template (#147), and while the setup goes to Cloudgate's own machine
 * (This Cloudgate host, or a Server that is the box, #149), a new Project's
 * target or an Environment there, the Same-machine warning shows.
 *
 * A `useApiForm` form: a refusal whose issue names a field is shown beside
 * it, any other above the button. Presentational: the screen fetches the
 * form and sends the setup.
 */
export function SetupFormView({
  form: setup,
  projectId,
  startOn,
  newProject,
  servers,
  place,
  onNewProject,
  onSubmit,
}: {
  /** The Environment to start on, when it can take the template. */
  startOn?: string;
  /**
   * The Project choice, drawn as the form's first question so the place the
   * setup goes is read top to bottom with the rest of it.
   */
  place?: React.ReactNode;
  /** Switches the setup to a new Project, offered when this one has no Environment. */
  onNewProject?: () => void;
  form: SetupForm;
  /** The existing Project set up into, for the link to add an Environment. */
  projectId?: string;
  /** The Deploy targets a new Project may pick; absent for an existing one. */
  newProject?: { targets: NewProjectTarget[] };
  /** The Organization's Servers, to tell one that is Cloudgate's own machine. */
  servers?: readonly Server[];
  /**
   * Sends the setup, rejecting with its refusal: a 400 naming a field lands
   * beside it, anything else above the button.
   */
  onSubmit: (choice: SetupChoice) => Promise<unknown>;
}) {
  const creating = newProject !== undefined;
  const form = useApiForm<SetupValues>({
    schema: setupSchema(setup, creating),
    defaultValues: startingValues(
      setup,
      newProject
        ? {
            firstTarget: firstTargetOf(newProject.targets),
          }
        : null,
      startOn,
    ),
    labelOf: (name) => SETUP_LABELS[name],
    onSubmit: async (values) => {
      await onSubmit(setupChoice(setup, values, creating));
    },
  });
  const environmentId = form.watch("environmentId");
  const setupName = form.watch("setupName");
  const target = form.watch("newProject.target");
  const region = form.watch("newProject.region");
  const targetCloud =
    newProject?.targets.find((one) => one.value === target)?.cloud ?? null;
  const errors = form.formState.errors;
  // A Project with no Environment has nowhere to set the template up, so the
  // rest of the form waits for one rather than asking questions it cannot use.
  const nowhere = !newProject && setup.environments.length === 0;
  // Where the setup goes is Cloudgate's own machine: the Same-machine warning.
  const machine = setup.environments.find(
    (env) => env.environmentId === environmentId,
  )?.machine;
  const sameMachine = newProject
    ? onSameMachine(target, servers)
    : machine?.serverId === null ||
      isSameMachineServer(servers, machine?.serverId);

  return (
    // Arrives in place of the skeleton the screen held for it.
    <Card className="animate-fade">
      <CardHeader
        title={`Set up ${setup.templateName}`}
        sub="Set up makes every value once and opens a Plan; nothing runs until you Apply it."
        headingLevel={2}
      />
      <FormProvider {...form}>
        <form
          method="post"
          noValidate
          onSubmit={form.submit}
          aria-label={`Set up ${setup.templateName}`}
        >
          <CardBody className="grid gap-5">
            {place}
            {newProject ? (
              <>
                <Field name="newProject.name" label="Project name">
                  <Input autoComplete="off" />
                </Field>
                <fieldset className="grid gap-2">
                  <legend className="mb-1 text-body font-medium">
                    Deploy target of its production Environment
                  </legend>
                  {newProject.targets.length === 0 ? (
                    <p className="text-meta text-tx-3">
                      This Organization has no Server or Cloud account to deploy
                      to yet.{" "}
                      {/* The get-started wizard buys one or adds your own, then
                          sets this template up on it (ADR-0073). */}
                      <Link
                        href={`${GET_STARTED_PATH}?template=${encodeURIComponent(setup.templateId)}`}
                        className="font-medium text-brand-tx underline-offset-3 hover:underline focus-visible:underline"
                      >
                        Get a server for this app
                      </Link>
                    </p>
                  ) : null}
                  {newProject.targets.map((one) => (
                    <Choice
                      key={one.value}
                      name="deployTarget"
                      value={one.value}
                      label={one.label}
                      detail={one.detail}
                      reason={one.reason}
                      disabled={one.reason !== null}
                      checked={target === one.value}
                      onPick={() => {
                        form.setValue("newProject.target", one.value);
                        // Each Deploy target generates its own hosts.
                        form.setValue(
                          "hosts",
                          startingHosts(setup, targetHosts(setup, one.value)),
                        );
                        if (
                          one.cloud === null ||
                          !CLOUDS[one.cloud].regions.includes(region)
                        ) {
                          form.setValue("newProject.region", "");
                        }
                      }}
                    />
                  ))}
                  <ChoiceError message={errors.newProject?.target?.message} />
                  {sameMachine ? <SameMachineNote /> : null}
                </fieldset>
                {targetCloud ? (
                  <Field
                    name="newProject.region"
                    label={CLOUDS[targetCloud].regionLabel}
                  >
                    {/* Native, because react-hook-form registers it; given
                        the input's focus ring so it does not read as off. */}
                    <select className="h-ctl rounded-lg border border-input bg-panel px-2.75 text-body shadow-panel transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50">
                      <option value="">Choose a region</option>
                      {CLOUDS[targetCloud].regions.map((one) => (
                        <option key={one} value={one}>
                          {one}
                        </option>
                      ))}
                    </select>
                  </Field>
                ) : null}
                <p className="text-meta text-tx-3">{EMPTY_PROJECT_NOTE}</p>
              </>
            ) : (
              <fieldset className="grid gap-2">
                <legend className="mb-1 text-body font-medium">
                  Environment
                </legend>
                {nowhere ? (
                  <div className="grid justify-items-start gap-3 rounded-lg border border-dashed border-line-2 bg-panel-2 px-4 py-4">
                    <p className="text-body text-tx-2">
                      This Project has no Environment yet, so there is nowhere
                      to set {setup.templateName} up.
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {projectId ? (
                        <LinkButton
                          size="sm"
                          href={`/projects/${encodeURIComponent(projectId)}`}
                        >
                          Add an Environment to this Project
                        </LinkButton>
                      ) : null}
                      {onNewProject ? (
                        <Button type="button" size="sm" onClick={onNewProject}>
                          Use a New Project instead
                        </Button>
                      ) : null}
                    </div>
                  </div>
                ) : null}
                {setup.environments.map((env) => (
                  <Choice
                    key={env.environmentId}
                    name="environmentId"
                    value={env.environmentId}
                    label={env.name}
                    reason={env.reason}
                    disabled={!env.canTake}
                    checked={environmentId === env.environmentId}
                    onPick={() => {
                      form.setValue("environmentId", env.environmentId);
                      // Each Environment generates its own hosts.
                      form.setValue("hosts", startingHosts(setup, env.hosts));
                    }}
                  />
                ))}
                {/* With nothing to pick, the note above says what to do. */}
                {setup.environments.length > 0 ? (
                  <ChoiceError message={errors.environmentId?.message} />
                ) : null}
                {sameMachine ? <SameMachineNote /> : null}
              </fieldset>
            )}

            {nowhere ? null : (
              <>
                <Field
                  name="setupName"
                  label="Setup name"
                  hint={`Each part is named ${setupName || "<setup name>"}-<part>; a clash adds -2 to the whole name.`}
                >
                  <Input autoComplete="off" />
                </Field>

                {setup.asked.map((input, at) => (
                  <AskedField key={input.name} input={input} at={at} />
                ))}

                <DomainHostFields
                  domains={setup.domains}
                  generated={
                    newProject
                      ? targetHosts(setup, target)
                      : (setup.environments.find(
                          (env) => env.environmentId === environmentId,
                        )?.hosts ?? null)
                  }
                  platformHost={
                    newProject
                      ? target === PLATFORM_HOST_VALUE
                      : setup.environments.find(
                          (env) => env.environmentId === environmentId,
                        )?.machine?.serverId === null
                  }
                  cloud={
                    newProject
                      ? // A new Project's network is made by its first Plan.
                        targetCloud
                        ? { pointsAt: null }
                        : null
                      : (setup.environments.find(
                          (env) => env.environmentId === environmentId,
                        )?.cloudDomains ?? null)
                  }
                />

                <SetupKernelNote
                  setup={setup}
                  environmentId={environmentId}
                  newProjectTarget={newProject ? target : null}
                />
              </>
            )}

            <FormError message={form.rootError} />
          </CardBody>
          {/* Nothing to submit until the Project has an Environment. */}
          <CardFooter className={nowhere ? "hidden" : undefined}>
            <SubmitButton type="submit" pending={form.formState.isSubmitting}>
              Set up and review the Plan
            </SubmitButton>
          </CardFooter>
        </form>
      </FormProvider>
    </Card>
  );
}

/**
 * The Deploy target a new Project opens on: the first Ready deploy Server
 * that can take the template (#147), so it does not land on Cloudgate's own
 * machine by default, else the first target that can.
 */
function firstTargetOf(targets: readonly NewProjectTarget[]): string {
  const takes = targets.filter((one) => one.reason === null);
  const server = takes.find(
    (one) =>
      one.cloud === null && one.value !== PLATFORM_HOST_VALUE && !one.disabled,
  );
  return (server ?? takes[0])?.value ?? "";
}

/** A radio group's refusal, under its last choice. */
function ChoiceError({ message }: { message: string | undefined }) {
  return message ? (
    <p role="alert" className="text-meta text-bad">
      {message}
    </p>
  ) : null;
}

/** One radio of a place the setup can go, greyed out with why it cannot. */
function Choice({
  name,
  value,
  label,
  detail,
  reason,
  disabled,
  checked,
  onPick,
}: {
  name: string;
  value: string;
  label: string;
  detail?: string;
  reason: string | null;
  disabled: boolean;
  checked: boolean;
  onPick: () => void;
}) {
  return (
    <label
      className={cn(
        "flex items-start gap-2 rounded-lg border border-line px-3 py-2.5 transition-colors duration-100 has-checked:border-brand has-checked:bg-brand-tint has-focus-visible:ring-3 has-focus-visible:ring-ring/50",
        // Native `disabled` on the radio is what makes it inert; the reason
        // beside it says why, so the row is quieted rather than hidden.
        disabled
          ? "cursor-not-allowed bg-panel-2 text-tx-3"
          : "cursor-pointer hover:border-line-2",
      )}
    >
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        disabled={disabled}
        onChange={onPick}
        className="mt-1 flex-none accent-brand"
      />
      <span className="grid min-w-0 text-body wrap-anywhere">
        <span>
          {label}
          {detail ? (
            <span className="ml-2 text-meta text-tx-3">{detail}</span>
          ) : null}
        </span>
        {reason ? <span className="text-meta text-tx-3">{reason}</span> : null}
      </span>
    </label>
  );
}
