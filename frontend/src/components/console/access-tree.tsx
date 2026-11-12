// No `"use client"`: a leaf, imported only by dialogs and rows whose own
// importers already carry it. Promoted out of `features/members/`
// when the Agents section became its second importer.

import type { Dispatch, SetStateAction } from "react";

import { serviceKindLabel } from "@/components/console/rows/service-row";
import { Skeleton } from "@/components/console/skeleton";
import type {
  Environment,
  EnvironmentService,
} from "@/lib/api/endpoints/environments";
import { errorMessage } from "@/lib/api/error-message";
import {
  useEnvironmentsOfProjects,
  useServicesOfEnvironments,
  type GrantScope,
} from "@/lib/api/use-member-grants";
import { useProjects } from "@/lib/api/use-projects";
import {
  toggleEnvironment,
  toggleProject,
  toggleService,
  type AccessGrants,
  type AccessInventory,
} from "@/lib/auth/access-grants";

import {
  AccessCheck,
  AccessSection,
  NothingAbove,
  ScopeGroup,
} from "./access-sections";

/**
 * The Project → Environment → Service tree, read for one set of grants.
 *
 * Lifted out of `ManageAccessModal` when an Agent's create dialog needed the
 * same tree ("granting an Agent works like granting a person"), and an
 * Agent's row needed the same reads to put names to its grant. Three callers
 * of one fan-out is the point of the split: a second copy of it is how one of
 * them ends up stripping a grant the other would have kept.
 *
 * **Every read is the caller's own** — `GET /projects`, `GET
 * /environments?projectId=`, `GET /environments/:id` — so the tree can only
 * ever offer what the signed-in person can see themselves.
 * `PermissionService` filters those routes by the caller's grants, so a
 * Service outside their view is not in any answer this reads, and there is
 * nothing here to filter.
 *
 * The fan-out stays bounded by the grant, as the dialog's header explains:
 * Environments for the ticked Projects, Services for the ticked Environments.
 */
export type AccessTreeReads = {
  projects: ReturnType<typeof useProjects>;
  /** Ticked Projects that exist, in tick order — the ones fanned out over. */
  openProjects: string[];
  environmentScopes: GrantScope<Environment>[];
  /** Ticked Environments whose Project answered with them. */
  openEnvironments: string[];
  serviceScopes: GrantScope<EnvironmentService>[];
  projectName: ReadonlyMap<string, string>;
  environmentRows: ReadonlyMap<string, Environment>;
  serviceRows: ReadonlyMap<string, EnvironmentService>;
  inventory: AccessInventory;
};

export function useAccessTree(grants: AccessGrants): AccessTreeReads {
  const projects = useProjects();

  const known = projects.data?.map((row) => row.projectId) ?? null;
  const projectName = new Map(
    (projects.data ?? []).map((row) => [row.projectId, row.name]),
  );

  // Only Projects that exist are fanned out over: a ticked id with no row
  // behind it is a stranded grant, and asking for its Environments would spend
  // a request to be told so.
  const openProjects =
    known === null ? [] : grants.projects.filter((id) => known.includes(id));
  const environmentScopes = useEnvironmentsOfProjects(openProjects);

  const environmentRows = new Map<string, Environment>();
  const environmentParent = new Map<string, string>();
  const projectsLoaded = new Set<string>();
  for (const scope of environmentScopes) {
    if (scope.rows === undefined) continue;
    projectsLoaded.add(scope.id);
    for (const row of scope.rows) {
      environmentRows.set(row.environmentId, row);
      environmentParent.set(row.environmentId, scope.id);
    }
  }

  const openEnvironments = grants.environments.filter((id) =>
    environmentParent.has(id),
  );
  const serviceScopes = useServicesOfEnvironments(openEnvironments);

  const serviceRows = new Map<string, EnvironmentService>();
  const serviceParent = new Map<string, string>();
  const environmentsLoaded = new Set<string>();
  for (const scope of serviceScopes) {
    if (scope.rows === undefined) continue;
    environmentsLoaded.add(scope.id);
    for (const row of scope.rows) {
      serviceRows.set(row.serviceId, row);
      serviceParent.set(row.serviceId, scope.id);
    }
  }

  return {
    projects,
    openProjects,
    environmentScopes,
    openEnvironments,
    serviceScopes,
    projectName,
    environmentRows,
    serviceRows,
    inventory: {
      projects: known,
      environmentParent,
      serviceParent,
      projectsLoaded,
      environmentsLoaded,
    },
  };
}

/**
 * The three tickable columns. What is ticked is the caller's state — a
 * Member's grants seeded from their row, or an Agent's starting empty — and
 * every tick goes through the cascade in `access-grants.ts`.
 *
 * `subject` is who the grant is for, as the empty-column sentences name it:
 * "this person", "this Agent".
 */
export function AccessTree({
  tree,
  grants,
  onChange,
  subject,
}: {
  tree: AccessTreeReads;
  grants: AccessGrants;
  onChange: Dispatch<SetStateAction<AccessGrants>>;
  subject: string;
}) {
  const { projects, inventory, projectName } = tree;

  return (
    <>
      <AccessSection title="Projects" lede="Every Project in this Organization.">
        {projects.error ? (
          <p className="px-3 py-2.75 text-meta text-bad">
            {errorMessage(projects.error)} Nothing is listed until the Project
            list can be read — an empty list would be a claim about what this
            Organization holds.
          </p>
        ) : projects.isPending ? (
          <div className="grid gap-2 px-3 py-3" aria-busy="true">
            <Skeleton className="h-ctl" />
            <Skeleton className="h-ctl" />
          </div>
        ) : (projects.data ?? []).length === 0 ? (
          <NothingAbove>
            This Organization has no Projects yet, so there is nothing to
            grant.
          </NothingAbove>
        ) : (
          <ul>
            {(projects.data ?? []).map((project) => (
              <AccessCheck
                key={project.projectId}
                id={`grant-project-${project.projectId}`}
                name={project.name}
                sub={project.description ?? undefined}
                checked={grants.projects.includes(project.projectId)}
                onCheckedChange={(on) =>
                  onChange((held) =>
                    toggleProject(held, project.projectId, on, inventory),
                  )
                }
              />
            ))}
          </ul>
        )}
      </AccessSection>

      <AccessSection
        title="Environments"
        lede="The Environments of the Projects ticked above."
      >
        {tree.openProjects.length === 0 ? (
          <NothingAbove>
            Tick a Project above to choose which of its Environments {subject}{" "}
            can reach.
          </NothingAbove>
        ) : (
          tree.openProjects.map((projectId, index) => (
            <ScopeGroup
              key={projectId}
              heading={projectName.get(projectId) ?? projectId}
              scope={tree.environmentScopes[index]}
              empty="This Project has no Environments."
              row={(environment) => (
                <AccessCheck
                  key={environment.environmentId}
                  id={`grant-environment-${environment.environmentId}`}
                  name={environment.name}
                  sub={environment.description ?? undefined}
                  checked={grants.environments.includes(
                    environment.environmentId,
                  )}
                  onCheckedChange={(on) =>
                    onChange((held) =>
                      toggleEnvironment(
                        held,
                        environment.environmentId,
                        on,
                        inventory,
                      ),
                    )
                  }
                />
              )}
            />
          ))
        )}
      </AccessSection>

      <AccessSection
        title="Services"
        lede="What is deployed in the Environments ticked above — Applications, databases and Compose stacks."
      >
        {tree.openEnvironments.length === 0 ? (
          <NothingAbove>
            Tick an Environment above to choose which of its Services {subject}{" "}
            can reach.
          </NothingAbove>
        ) : (
          tree.openEnvironments.map((environmentId, index) => (
            <ScopeGroup
              key={environmentId}
              heading={environmentHeading(tree, environmentId)}
              scope={tree.serviceScopes[index]}
              empty="Nothing is deployed in this Environment."
              row={(service) => (
                <AccessCheck
                  key={service.serviceId}
                  id={`grant-service-${service.serviceId}`}
                  name={service.name}
                  sub={service.appName}
                  chip={serviceKindLabel(service.serviceType)}
                  checked={grants.services.includes(service.serviceId)}
                  onCheckedChange={(on) =>
                    onChange((held) =>
                      toggleService(held, service.serviceId, on, inventory),
                    )
                  }
                />
              )}
            />
          ))
        )}
      </AccessSection>
    </>
  );
}

/**
 * "Staging — Checkout", so a Services group says which Environment of which
 * Project it belongs to. Two Projects routinely name an Environment the same
 * thing, and the Environment name alone would then head two groups identically.
 */
export function environmentHeading(
  tree: Pick<AccessTreeReads, "environmentRows" | "projectName" | "inventory">,
  environmentId: string,
): string {
  const projectId = tree.inventory.environmentParent.get(environmentId);
  const project =
    projectId === undefined ? undefined : tree.projectName.get(projectId);
  const label = tree.environmentRows.get(environmentId)?.name ?? environmentId;
  return project === undefined ? label : `${label} — ${project}`;
}
