"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { EmptyState } from "@/components/console/empty-state";
import { Field } from "@/components/console/field";
import { LinkButton } from "@/components/console/link-button";
import { Picker } from "@/components/console/picker";
import { Skeleton } from "@/components/console/skeleton";
import { errorMessage } from "@/lib/api/error-message";
import { useCloudAccounts } from "@/lib/api/use-cloud-accounts";
import { useInstanceMode } from "@/lib/api/use-instance-mode";
import { useProjects } from "@/lib/api/use-projects";
import { useServers } from "@/lib/api/use-servers";
import { usePermission } from "@/lib/auth/use-permission";
import { environmentPlanHref } from "@/lib/format/plan-href";

import { newProjectTargets } from "./new-project-targets";
import { SetupFormView } from "./setup-form";
import { SetupPasteView } from "./setup-paste";
import { NEW_PROJECT, useSetupForm, useSetUpTemplate } from "./use-templates";

/**
 * Setting one Template up (`/templates?template=<id>`): pick an existing
 * Project, or a new one (#1376), then the form for it. Submit goes to the
 * Environment's Plan, on the Project's Config tab, where it is reviewed and
 * Applied like any other; on a repository-kept config, to the entries to
 * paste into its file, whose next push makes the Plan (#1378).
 *
 * A new Project's Deploy targets are the Environment form's: the platform
 * host (never on the Hosted instance, ADR-0053), the deploy Servers, and on
 * the Hosted instance the Cloud accounts the caller may read.
 */
export function TemplateSetup({ templateId }: { templateId: string }) {
  const router = useRouter();
  const projects = useProjects();
  const [projectId, setProjectId] = useState<string | null>(null);
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

  return (
    // Fades in where the catalogue stood: the same screen, its body replaced.
    <div className="grid animate-fade gap-4">
      <div>
        <LinkButton href="/templates" size="sm">
          All templates
        </LinkButton>
      </div>
      {/* The console's `Picker`, not a native select, so it is the height,
          focus ring and popup of every other choice in the app. */}
      <Field name="projectId" label="Project" manual className="max-w-md">
        <Picker
          value={projectId ?? ""}
          onValueChange={(next) => {
            setProjectId(next || null);
            setUp.reset();
          }}
          placeholder="Choose a Project"
          pending={projects.isPending}
          options={[
            { value: NEW_PROJECT, label: "New Project" },
            ...(projects.data ?? []).map((project) => ({
              value: project.projectId,
              label: project.name,
            })),
          ]}
        />
      </Field>
      {pasted ? (
        // The setup's answer, arriving where its form stood.
        <div className="grid animate-rise">
          <SetupPasteView
            result={pasted}
            templateName={form.data?.templateName ?? templateId}
          />
        </div>
      ) : projectId === null ? null : form.isPending ||
        (creating && targetsPending) ? (
        <Skeleton className="h-64" />
      ) : form.error ? (
        <EmptyState icon="alert" title="The setup form could not be read">
          {errorMessage(form.error)}
        </EmptyState>
      ) : (
        <SetupFormView
          key={projectId}
          form={form.data}
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
    </div>
  );
}
