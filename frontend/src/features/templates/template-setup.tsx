"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Card } from "@/components/console/card";
import { Cols } from "@/components/console/cols";
import { EmptyState } from "@/components/console/empty-state";
import { Skeleton } from "@/components/console/skeleton";
import { errorMessage } from "@/lib/api/error-message";
import type { TemplateSummary } from "@/lib/api/endpoints/templates";
import { useCloudAccounts } from "@/lib/api/use-cloud-accounts";
import { useInstanceMode } from "@/lib/api/use-instance-mode";
import { useProjects } from "@/lib/api/use-projects";
import { useServers } from "@/lib/api/use-servers";
import { usePermission } from "@/lib/auth/use-permission";
import { environmentPlanHref } from "@/lib/format/plan-href";

import { newProjectTargets } from "./new-project-targets";
import { ProjectChoice } from "./project-choice";
import { SetupFormView } from "./setup-form";
import { SetupPasteView } from "./setup-paste";
import { SetupSteps } from "./setup-steps";
import { TemplateIntro } from "./template-intro";
import { NEW_PROJECT, useSetupForm, useSetUpTemplate } from "./use-templates";

/**
 * Setting one Template up (`/templates?template=<id>`): the Template itself
 * at the top, then the form, whose first question is the Project: an
 * existing one, or a new one (#1376). Submit goes to the Environment's Plan,
 * on the Project's Config tab, where it is reviewed and Applied like any
 * other; on a repository-kept config, to the entries to paste into its file,
 * whose next push makes the Plan (#1378).
 *
 * **The form is one card from the first question on.** Before a Project is
 * chosen the card holds only that question, with a line saying what follows,
 * so the screen reads as the start of a form and not as a page that failed
 * to load. The aside says where the setup leads.
 *
 * A new Project's Deploy targets are the Environment form's: the platform
 * host (never on the Hosted instance, ADR-0053), the deploy Servers, and on
 * the Hosted instance the Cloud accounts the caller may read.
 */
export function TemplateSetup({
  templateId,
  template,
  cataloguePending,
}: {
  templateId: string;
  /** The catalogue's entry, for the header; absent until it arrives. */
  template: TemplateSummary | undefined;
  cataloguePending: boolean;
}) {
  const router = useRouter();
  const projects = useProjects();
  const [picked, setPicked] = useState<string | null>(null);
  // With no Project yet there is only one choice, so it starts on it.
  const projectId =
    picked ?? (projects.data?.length === 0 ? NEW_PROJECT : null);
  const form = useSetupForm(templateId, projectId);
  const setUp = useSetUpTemplate();
  const creating = projectId === NEW_PROJECT;
  const pasted = setUp.data?.paste
    ? { ...setUp.data, paste: setUp.data.paste }
    : null;

  const servers = useServers();
  const hosted = useInstanceMode().data === "hosted";
  const canReadClouds = usePermission({ cloudAccount: ["read"] });
  const readsClouds = hosted && canReadClouds.allowed;
  const cloudAccounts = useCloudAccounts({ enabled: creating && readsClouds });
  const targetsPending =
    servers.isPending || (readsClouds && cloudAccounts.isPending);

  const name = template?.name ?? form.data?.templateName ?? templateId;
  const pick = (next: string) => {
    setPicked(next);
    setUp.reset();
  };
  const place = (
    <ProjectChoice
      projects={projects.data}
      pending={projects.isPending}
      value={projectId}
      onChange={pick}
    />
  );

  return (
    // Fades in where the catalogue stood: the same screen, its body replaced.
    <div className="animate-fade">
      <TemplateIntro
        template={template}
        fallbackName={name}
        pending={cataloguePending}
      />
      <Cols aside={<SetupSteps />} asideLabel="How setup works">
        {pasted ? (
          // The setup's answer, arriving where its form stood.
          <div className="grid animate-rise">
            <SetupPasteView result={pasted} templateName={name} />
          </div>
        ) : projectId === null ? (
          <Card>
            <Card.Header
              title={`Set up ${name}`}
              sub="Set up makes every value once and opens a Plan; nothing runs until you Apply it."
              headingLevel={2}
            />
            <Card.Body className="grid gap-4">
              {place}
              <p className="text-meta text-tx-3">
                Choose a Project to see where in it {name} can go, and the
                values it asks for.
              </p>
            </Card.Body>
          </Card>
        ) : form.isPending || (creating && targetsPending) ? (
          <Skeleton className="h-96" />
        ) : form.error ? (
          <Card>
            <Card.Body className="grid gap-4">
              {place}
              <EmptyState icon="alert" title="The setup form could not be read">
                {errorMessage(form.error)}
              </EmptyState>
            </Card.Body>
          </Card>
        ) : (
          <SetupFormView
            key={projectId}
            form={form.data}
            place={place}
            projectId={creating ? undefined : projectId}
            onNewProject={() => pick(NEW_PROJECT)}
            newProject={
              creating
                ? {
                    targets: newProjectTargets(
                      servers.data,
                      readsClouds ? cloudAccounts.data : [],
                      form.data.deployTargets,
                      { platformHost: !hosted },
                    ),
                  }
                : undefined
            }
            onSubmit={async (choice) => {
              const result = await setUp.mutateAsync(
                "newProject" in choice
                  ? { templateId, ...choice }
                  : { templateId, projectId, ...choice },
              );
              // A repository-kept config's answer stays here, as the entries
              // to paste.
              if (result.paste) return;
              router.push(
                environmentPlanHref(
                  result.setupRecord.projectId,
                  result.pendingSetup.environmentId,
                ),
              );
            }}
          />
        )}
      </Cols>
    </div>
  );
}
