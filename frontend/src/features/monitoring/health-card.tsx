import { Card } from "@/components/console/card";
import { Dot } from "@/components/console/dot";
import { Skeleton } from "@/components/console/skeleton";
import { isApiError } from "@/lib/api/api-error";
import { errorMessage } from "@/lib/api/error-message";
import type { ServiceHealthStatus } from "@/lib/api/endpoints/settings";

import { useInfrastructureHealth } from "./use-monitoring";

/**
 * The two things this instance of Cloudgate runs on — the screen's top line.
 *
 * **Two legs, not "2 of 3 healthy".** This backend probes two: Postgres, through
 * the connection it already holds, and Traefik. There is no Redis leg, because the
 * deployment queue is in-process. So there is no
 * fraction and no roll-up figure: a summary like "1 of 2 healthy" invites the
 * question "which one", and there is room to just say.
 *
 * **A 403 is rendered as a 403.** `GET /settings/infrastructure-health` is
 * owner/admin only, and the temptation is to fold the refusal into the readout
 * and show two grey dots. That would tell a member their platform's database
 * might be down. "Your role cannot ask" and "Postgres is unreachable" are
 * opposite statements and only one of them should send anyone anywhere.
 *
 * The message under an unhealthy leg is rendered rather than summarised, because
 * `checkTraefikHealth` falls back from the container to the Swarm service of the
 * same name and then reports whatever failed — so `unhealthy` also covers
 * "Traefik was never installed on this host", which is a completely different
 * afternoon from "Traefik is crash-looping".
 */
export function HealthCard() {
  const health = useInfrastructureHealth();

  return (
    <Card>
      <Card.Header
        title="This instance"
        sub="What Cloudgate itself depends on."
        headingLevel={2}
      />
      <Card.Body>
        {health.isPending ? (
          <div className="grid gap-2.5" aria-busy="true">
            <Skeleton className="h-5 w-48" />
            <Skeleton className="h-5 w-40" />
          </div>
        ) : health.error ? (
          <p className="text-body text-tx-2">
            {/* `isUnnamedRefusal` and not `status === 403`, because a banned
                operator's refusal is a 403 too and this sentence would tell them
                their role was the problem — and then that nothing is known to be
                wrong with Postgres or Traefik, which nobody asked (H-48). Every
                403 the backend did not name still reads exactly as it did: the
                sentence below is better than `errorMessage()`'s generic role
                line for the member it was written for, so the guard narrowed
                rather than the branch going. */}
            {isApiError(health.error) && health.error.isUnnamedRefusal
              ? "Only an owner or an admin of this Organization can check the platform's own health, so this reading is not available to your role. Nothing is known to be wrong — the check has not been run."
              : errorMessage(health.error)}
          </p>
        ) : health.data ? (
          <div className="flex flex-col gap-2.5">
            <HealthRow
              label="PostgreSQL"
              detail="Cloudgate's own database, probed through the live connection."
              leg={health.data.postgres}
            />
            <HealthRow
              label="Traefik"
              detail="The ingress that serves every domain, on this host."
              leg={health.data.traefik}
            />
          </div>
        ) : null}
      </Card.Body>
    </Card>
  );
}

function HealthRow({
  label,
  detail,
  leg,
}: {
  label: string;
  detail: string;
  leg: ServiceHealthStatus;
}) {
  const healthy = leg.status === "healthy";
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <p className="flex items-center gap-1.75 text-body">
        {/* The word travels with the dot — `Dot` ships it in an `sr-only` span,
            and the sentence beside it repeats it for everyone else. */}
        <Dot status={healthy ? "running" : "error"} />
        <span className="font-medium text-tx">{label}</span>
        <span className="text-tx-2">{healthy ? "is healthy" : "is not answering"}</span>
      </p>
      <p className="pl-4.5 text-meta text-tx-3 wrap-anywhere">
        {leg.message ? leg.message : detail}
      </p>
    </div>
  );
}
