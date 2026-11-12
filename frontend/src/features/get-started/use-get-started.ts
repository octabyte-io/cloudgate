import { useQuery } from "@tanstack/react-query";

import { billingApi } from "@/lib/api/endpoints/billing";
import { boughtServersApi } from "@/lib/api/endpoints/bought-servers";
import { environmentsApi } from "@/lib/api/endpoints/environments";
import {
  pendingSetupsApi,
  type AutoApplyView,
  type PendingSetup,
} from "@/lib/api/endpoints/pending-setups";
import { projectConfigApi } from "@/lib/api/endpoints/project-config";
import { serversApi } from "@/lib/api/endpoints/servers";
import { keys } from "@/lib/api/keys";
import { useActiveOrganizationId } from "@/lib/auth/client";

import { launchPhase, serverBeingMade } from "./wizard-model";

/**
 * The get-started wizard's reads, each one the console's own read under the
 * one key factory, asked again every few seconds **only while something is
 * on its way**: a Bought Server being made, a payment the webhook has not
 * landed yet, a deploy still starting. Each stops polling on its own once
 * the thing it follows ends, so a finished wizard left open in a tab costs
 * nothing.
 */

/** How often the wizard asks again while it waits. */
export const WAIT_POLL_MS = 4_000;

/**
 * The Organization's Servers. With `follow` it is asked again while the
 * Bought Server the wizard waits for is not Ready yet: the one named, or
 * (`null`) whichever is being made. `undefined` follows nothing.
 */
export function useWizardServers(follow?: string | null) {
  const { organizationId } = useActiveOrganizationId();
  return useQuery({
    queryKey: keys.servers.list(organizationId),
    queryFn: () => serversApi.list(),
    enabled: organizationId !== null,
    refetchInterval: (query) => {
      if (follow === undefined) return false;
      const servers = query.state.data ?? [];
      const target =
        follow === null
          ? serverBeingMade(servers)
          : servers.find((server) => server.serverId === follow);
      if (follow === null) return target ? WAIT_POLL_MS : false;
      const stage = target?.boughtServer?.stage;
      return stage === "ready" || stage === "failed" ? false : WAIT_POLL_MS;
    },
  });
}

/**
 * The purchases not made yet (waiting for payment, or being created),
 * asked again while there are any, or while `following` says a return from
 * Checkout is expected to show one.
 */
export function useWizardPurchases(enabled: boolean, following: boolean) {
  const { organizationId } = useActiveOrganizationId();
  return useQuery({
    queryKey: keys.boughtServers.purchases(organizationId),
    queryFn: () => boughtServersApi.purchases(),
    enabled: enabled && organizationId !== null,
    refetchInterval: (query) =>
      following || (query.state.data?.length ?? 0) > 0 ? WAIT_POLL_MS : false,
  });
}

/**
 * Everything the launch view reads about the Environment a setup went
 * into: its plan, the wizard's Pending setup, its Deployments, its Domains
 * and its Services. The plan and the Pending setup are asked again until
 * Cloudgate has applied the plan or given up on it (ADR-0073); the
 * Deployments until the deploy has ended, one way or the other; the Domains
 * once more when it has.
 */
export function useLaunch(environmentId: string, templateId: string) {
  const { organizationId } = useActiveOrganizationId();
  const enabled = organizationId !== null && environmentId !== "";

  const pending = useQuery({
    queryKey: keys.environments.pendingSetups(organizationId, environmentId),
    queryFn: () => pendingSetupsApi.list(environmentId),
    enabled,
    refetchInterval: (query) =>
      waitingApply(query.state.data?.pendingSetups, templateId)
        ? WAIT_POLL_MS
        : false,
  });
  const autoApply = wizardSetup(pending.data?.pendingSetups, templateId);
  const refused = autoApply?.status === "refused";

  const plan = useQuery({
    queryKey: keys.environments.plan(organizationId, environmentId),
    queryFn: () => projectConfigApi.findPlan(environmentId),
    enabled,
    refetchInterval: (query) => {
      const status = query.state.data?.plan?.status;
      return !refused && (status === undefined || status === "open")
        ? WAIT_POLL_MS
        : false;
    },
  });
  const applied =
    plan.data?.plan !== undefined &&
    plan.data.plan !== null &&
    plan.data.plan.status !== "open";

  const deployments = useQuery({
    queryKey: keys.environments.deployments(organizationId, environmentId),
    queryFn: () => environmentsApi.listDeployments(environmentId),
    enabled: enabled && applied,
    refetchInterval: (query) =>
      launchPhase(plan.data?.plan, query.state.data, autoApply).phase ===
      "starting"
        ? WAIT_POLL_MS
        : false,
  });

  const phase = launchPhase(plan.data?.plan, deployments.data, autoApply);

  const domains = useQuery({
    queryKey: keys.environments.domains(organizationId, environmentId),
    queryFn: () => environmentsApi.listDomains(environmentId),
    enabled: enabled && phase.phase === "running",
  });

  const environment = useQuery({
    queryKey: keys.environments.detail(organizationId, environmentId),
    queryFn: () => environmentsApi.findOne(environmentId),
    enabled: enabled && phase.phase === "running",
  });

  return { plan, deployments, domains, environment, phase };
}

/**
 * The Apply Cloudgate makes for the wizard's setup of this template, from
 * the Environment's Pending setups; undefined once the setup is gone (its
 * Apply created every part) or before it is read.
 */
function wizardSetup(
  rows: readonly PendingSetup[] | undefined,
  templateId: string,
): AutoApplyView | undefined {
  return (
    rows?.find((row) => row.templateId === templateId && row.autoApply)
      ?.autoApply ?? undefined
  );
}

/** Whether the setup's Apply is still to come, so it is worth asking again. */
function waitingApply(
  rows: readonly PendingSetup[] | undefined,
  templateId: string,
): boolean {
  if (rows === undefined) return true;
  const status = wizardSetup(rows, templateId)?.status;
  return status === "waiting" || status === "applying";
}

/**
 * `GET /billing/can-create-server`, asked again while `following` says a
 * plan was just paid for and the backend still says there is none: Stripe's
 * webhook, not the return from Checkout, is what grants the plan, and it
 * can land a few seconds after the browser does.
 */
export function useWizardServerRoom(following: boolean) {
  const { organizationId } = useActiveOrganizationId();
  return useQuery({
    queryKey: keys.billing.canCreateServer(organizationId),
    queryFn: billingApi.canCreateServer,
    enabled: organizationId !== null,
    retry: false,
    refetchInterval: (query) =>
      following && query.state.data?.code === "PLAN_REQUIRED"
        ? WAIT_POLL_MS
        : false,
  });
}
