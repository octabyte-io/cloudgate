import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  projectConfigApi,
  type ConfigRead,
  type Plan,
  type PlanConfirmation,
  type MoveTarget,
} from "@/lib/api/endpoints/project-config";
import { keys } from "@/lib/api/keys";
import { useInvalidate } from "@/lib/api/use-invalidate";
import { useActiveOrganizationId } from "@/lib/auth/client";
import { cloudReadOf } from "./plan-aws";

/**
 * The Project config page's reads and writes.
 *
 * A plan request and a dismiss both answer with the plan they made or closed,
 * which is what `GET /environments/:id/plan` would answer next, so the answer
 * is written into that key rather than refetched.
 */

/** `environment: ['read']`: asking for a plan is a read of the Environment. */
export const PLAN_REQUEST_REFUSAL =
  "Your role in this Organization cannot read this Environment, so it cannot check it for changes. Ask an owner or an admin for access.";

/**
 * Apply is checked step by step against the statements each Service already
 * uses, so the console cannot say up front whether it will be allowed; it
 * offers the button to whoever can see the plan and shows the refusal.
 */
export const PLAN_APPLY_HINT =
  "Applying needs service: create for each create, service: update for each change, service: delete for each destroy and deployment: create. A role without one is refused before anything is written.";

/** `environment: ['update']`, which a read-only role does not hold. */
export const PLAN_DISMISS_REFUSAL =
  "Your role in this Organization cannot dismiss a plan for this Environment. Ask an owner or an admin to do it, or to change your role.";

/** `project: ['update']`: moving the config is a write to the whole Project. */
export const MOVE_REFUSAL =
  "Your role in this Organization cannot change where this Project's config is kept. Ask an owner or an admin to move it.";

export function useProjectConfig(projectId: string) {
  const { organizationId } = useActiveOrganizationId();
  return useQuery({
    queryKey: keys.projects.config(organizationId, projectId),
    queryFn: () => projectConfigApi.findConfig(projectId),
    enabled: organizationId !== null && projectId !== "",
  });
}

export function usePlan(environmentId: string) {
  const { organizationId } = useActiveOrganizationId();
  return useQuery({
    queryKey: keys.environments.plan(organizationId, environmentId),
    queryFn: () => projectConfigApi.findPlan(environmentId),
    enabled: organizationId !== null && environmentId !== "",
    // A cloud plan's steps read AWS after it is stored, and an Apply
    // that makes the Environment network answers while its run goes on
    // asked again until nothing is reading or running.
    refetchInterval: (query) => {
      const plan = query.state.data?.plan;
      const busy =
        plan?.steps.some((step) => cloudReadOf(step)?.status === "reading") ||
        plan?.results?.some((result) => result.status === "running");
      return busy ? PLAN_READING_POLL_MS : false;
    },
  });
}

/** How often a plan still reading AWS is asked for again. */
const PLAN_READING_POLL_MS = 3000;

function usePlanWrite(
  environmentId: string,
  write: (variables: { planId?: string }) => Promise<Plan>,
) {
  const { organizationId } = useActiveOrganizationId();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: write,
    onSuccess: (plan) =>
      queryClient.setQueryData(
        keys.environments.plan(organizationId, environmentId),
        { plan },
      ),
  });
}

/** "Check for changes": a new plan, which replaces the open one. */
export function useRequestPlan(environmentId: string) {
  return usePlanWrite(environmentId, () =>
    projectConfigApi.requestPlan(environmentId),
  );
}

export function useDismissPlan(environmentId: string) {
  return usePlanWrite(environmentId, ({ planId }) =>
    projectConfigApi.dismissPlan(environmentId, planId ?? ""),
  );
}

/**
 * The whole-YAML edit: stores a plan per Environment and applies nothing.
 * Each Environment's plan is written into its key; the config itself is
 * read again, since a text that changes nothing is stored at once.
 */
export function useSaveProjectConfig(projectId: string) {
  const { organizationId } = useActiveOrganizationId();
  const queryClient = useQueryClient();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ text }: { text: string }) =>
      projectConfigApi.saveConfig(projectId, text),
    onSuccess: async ({ plans }) => {
      for (const plan of plans) {
        queryClient.setQueryData(
          keys.environments.plan(organizationId, plan.environmentId),
          { plan },
        );
      }
      await queryClient.invalidateQueries({
        queryKey: keys.projects.config(organizationId, projectId),
      });
    },
    onError: () => invalidate.projectConfigSaved(projectId),
  });
}

/**
 * Applies an Environment's open plan. What it wrote reaches the Services,
 * Deployments and Domains screens, and the stored text moves every other
 * Environment's plan, so all of those are read again.
 */
export function useApplyPlan(projectId: string, environmentId: string) {
  const { organizationId } = useActiveOrganizationId();
  const queryClient = useQueryClient();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({
      planId,
      confirm,
    }: {
      planId: string;
      confirm: PlanConfirmation;
    }) => projectConfigApi.applyPlan(environmentId, planId, confirm),
    onSuccess: async (plan) => {
      queryClient.setQueryData(
        keys.environments.plan(organizationId, environmentId),
        { plan },
      );
      await invalidate.planApplied({ projectId, environmentId });
    },
  });
}

/** A move's preview: each Environment's plan at the new place; stores nothing. */
export function usePreviewMove(projectId: string) {
  return useMutation({
    mutationFn: (to: MoveTarget) => projectConfigApi.previewMove(projectId, to),
  });
}

/**
 * A move's confirm. Each Environment's new open plan is written into its key;
 * the config and every Environment are read again, since where they are read
 * changed, and a move out clears every Config branch.
 */
export function useConfirmMove(projectId: string) {
  const { organizationId } = useActiveOrganizationId();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      to,
      reads,
    }: {
      to: MoveTarget;
      reads: readonly ConfigRead[];
    }) => projectConfigApi.confirmMove(projectId, to, reads),
    onSuccess: async ({ plans }) => {
      for (const plan of plans) {
        queryClient.setQueryData(
          keys.environments.plan(organizationId, plan.environmentId),
          { plan },
        );
        await queryClient.invalidateQueries({
          queryKey: keys.environments.detail(
            organizationId,
            plan.environmentId,
          ),
        });
      }
      await queryClient.invalidateQueries({
        queryKey: keys.environments.byProject(organizationId, projectId),
      });
      await queryClient.invalidateQueries({
        queryKey: keys.projects.config(organizationId, projectId),
      });
    },
  });
}
