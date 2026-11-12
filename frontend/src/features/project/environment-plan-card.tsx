import { Card } from "@/components/console/card";
import { CodeEditor } from "@/components/console/code-editor";
import { Skeleton } from "@/components/console/skeleton";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/api/error-message";
import type { CloudAccount } from "@/lib/api/endpoints/cloud-accounts";
import type { Environment } from "@/lib/api/endpoints/environments";
import { useEnvironmentConfigCopy } from "@/lib/api/use-config-copy";
import { usePermission } from "@/lib/auth/use-permission";
import { Icon } from "@/lib/design/icons";
import { useCloudAccounts } from "@/lib/api/use-cloud-accounts";

import { readLine } from "./move-preview-list";
import { PlanView } from "./plan-view";
import {
  PLAN_APPLY_HINT,
  PLAN_DISMISS_REFUSAL,
  PLAN_REQUEST_REFUSAL,
  useApplyPlan,
  useDismissPlan,
  usePlan,
  useRequestPlan,
} from "./use-project-config";
import { cloudName, CLOUD_NAMES } from "@/lib/api/endpoints/cloud-accounts";

/**
 * An Environment's copy of a repository-kept config, read now from its
 * Config branch (US55): read-only, with the commit it was read at and a link
 * to the file there, or why it cannot be read. Never a fallback copy.
 */
function EnvironmentCopy({ environmentId }: { environmentId: string }) {
  const copy = useEnvironmentConfigCopy(environmentId);
  if (copy.error) {
    return <p className="text-body text-bad">{errorMessage(copy.error)}</p>;
  }
  if (copy.isPending) return <Skeleton className="h-8 w-full rounded-lg" />;
  const found = copy.data;
  if (found.kind !== "repository") return null;
  const branch = found.configBranch ?? "the default branch";
  if (!found.copy) {
    return (
      <p className="flex items-start gap-2 text-body text-bad">
        <Icon name="info" className="mt-0.5 flex-none" />
        {found.refusal?.message ??
          `${found.path} cannot be read from ${found.repository} on ${branch}.`}
      </p>
    );
  }
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-meta text-tx-2">
          {found.path} on {readLine(found.copy.branch, found.copy.commitSha)}
          {found.configBranch === null ? " (the default branch)" : ""}
        </p>
        <a
          href={found.copy.fileUrl}
          target="_blank"
          rel="noreferrer"
          className="text-meta font-medium text-brand-tx underline-offset-3 hover:underline focus-visible:underline"
        >
          Open the file
        </a>
      </div>
      <CodeEditor
        value={found.copy.text}
        label={`Project config on ${branch}`}
      />
    </div>
  );
}

/**
 * One Environment's plan of the Project config: the copy it
 * reads when a repository keeps the config, the plan now, and Check for
 * changes, Dismiss and Apply.
 */
export function EnvironmentPlanCard({
  projectId,
  environment,
  serverNames,
  repositoryKept,
}: {
  projectId: string;
  environment: Environment;
  serverNames: Readonly<Record<string, string>>;
  repositoryKept: boolean;
}) {
  const plan = usePlan(environment.environmentId);
  const request = useRequestPlan(environment.environmentId);
  const dismiss = useDismissPlan(environment.environmentId);
  const apply = useApplyPlan(projectId, environment.environmentId);
  const canRequest = usePermission({ environment: ["read"] });
  const canDismiss = usePermission({ environment: ["update"] });
  // A cloud step names its Cloud account for a role that may read them.
  const canReadClouds = usePermission({ cloudAccount: ["read"] });
  const cloudAccounts = useCloudAccounts({ enabled: canReadClouds.allowed });
  const cloudAccountNames = Object.fromEntries(
    (cloudAccounts.data ?? []).map((account) => [
      account.cloudAccountId,
      account.name,
    ]),
  );
  const cloudName = planCloudName(
    environment.deployTarget,
    cloudAccounts.data ?? [],
  );

  const current = plan.data?.plan ?? null;
  const open = current?.status === "open" ? current : null;
  const failure = apply.error ?? request.error ?? dismiss.error ?? plan.error;
  const busy = apply.isPending || dismiss.isPending || request.isPending;
  const shown =
    current &&
    (current.status === "open" ||
      current.status === "unchanged" ||
      current.status === "applied" ||
      current.status === "partly-applied")
      ? current
      : null;

  return (
    // The anchor a stopped deploy's "Review the open plan →" lands on.
    <Card id={`plan-${environment.environmentId}`} aria-busy={plan.isPending}>
      <Card.Header
        title={environment.name}
        sub={planSubtitle(current)}
        actions={
          <>
            {open ? (
              <Button
                variant="gh"
                disabled={!canDismiss.allowed || busy}
                title={canDismiss.allowed ? undefined : PLAN_DISMISS_REFUSAL}
                onClick={() =>
                  canDismiss.allowed && dismiss.mutate({ planId: open.planId })
                }
              >
                Dismiss
              </Button>
            ) : null}
            <Button
              variant="gh"
              disabled={!canRequest.allowed || busy}
              title={canRequest.allowed ? undefined : PLAN_REQUEST_REFUSAL}
              onClick={() => canRequest.allowed && request.mutate({})}
            >
              <Icon name="refresh" size={15} />
              Check for changes
            </Button>
          </>
        }
      />
      <Card.Body className="grid gap-4">
        {repositoryKept ? (
          <EnvironmentCopy environmentId={environment.environmentId} />
        ) : null}
        {failure ? (
          <p className="text-body text-bad">{errorMessage(failure)}</p>
        ) : null}
        {plan.isPending ? (
          <Skeleton className="h-8 w-full rounded-lg" />
        ) : shown ? (
          <PlanView
            plan={shown}
            serverNames={serverNames}
            cloudAccountNames={cloudAccountNames}
            cloudName={cloudName}
            onApply={(confirm) =>
              apply.mutate({ planId: shown.planId, confirm })
            }
            applying={busy}
            applyHint={PLAN_APPLY_HINT}
          />
        ) : (
          <p className="text-body text-tx-3">
            No open plan. Check for changes to see what applying the config
            would do here.
          </p>
        )}
      </Card.Body>
    </Card>
  );
}

/**
 * The cloud the plan reads, as its lines name it: its Deploy
 * target's Cloud account's, or "the cloud" for a role that cannot read
 * Cloud accounts.
 */
export function planCloudName(
  target: Environment["deployTarget"],
  accounts: readonly Pick<CloudAccount, "cloudAccountId" | "cloud">[],
): string {
  if (target.kind !== "cloud") return CLOUD_NAMES.aws;
  const account = accounts.find(
    (one) => one.cloudAccountId === target.cloudAccountId,
  );
  if (!account) return "the cloud";
  return cloudName(account.cloud);
}

function planSubtitle(
  plan: {
    status: string;
    createdAt: string;
    appliedAt: string | null;
    commitSha?: string | null;
  } | null,
): string | undefined {
  if (!plan) return "Never checked";
  const read = plan.commitSha ? ` (read at ${plan.commitSha.slice(0, 7)})` : "";
  const when = `${new Date(plan.createdAt).toLocaleString()}${read}`;
  switch (plan.status) {
    case "open":
      return `Open plan, checked ${when}`;
    case "unchanged":
      return `Checked ${when}`;
    case "applied":
    case "partly-applied":
      return `Last plan ${plan.status === "applied" ? "applied" : "partly applied"}, ${new Date(plan.appliedAt ?? plan.createdAt).toLocaleString()}`;
    default:
      return `Last plan ${plan.status}, ${when}`;
  }
}
