import { Card } from "@/components/console/card";
import { KVList, KVRow } from "@/components/console/kv-list";
import { StatusPill } from "@/components/console/status-pill";

import { SectionFailed, SectionPending } from "../section-states";
import { useInfrastructureHealth } from "./use-platform";
import { useArrival } from "@/components/console/use-arrival";

/**
 * The two dependencies this instance has.
 *
 * **A refusal is not a reading**, which is the whole care in this card:
 * `checkInfrastructureHealth` is owner-or-admin and throws a 403 *before* the
 * probe, so rendering that as `unhealthy` would tell somebody Traefik is down
 * because their role does not let them ask. `endpoints/settings.ts` says the
 * same thing at the route.
 */
export function HealthCard() {
  const health = useInfrastructureHealth();

  const arrival = useArrival(health.isPending);
  if (health.isPending) return <SectionPending title="Health" rows={2} />;
  if (health.error) {
    return (
      <SectionFailed title="Health" error={health.error}>
        This probe is owner-or-admin. A refusal here says nothing about whether
        Postgres or Traefik is actually up.
      </SectionFailed>
    );
  }

  const legs = [
    { name: "Postgres", leg: health.data?.postgres },
    { name: "Traefik", leg: health.data?.traefik },
  ];

  return (
    <Card className={arrival}>
      <Card.Header
        title="Health"
        sub="The two things this instance cannot run without."
        headingLevel={2}
      />
      <Card.Body>
        <KVList>
          {legs.map(({ name, leg }) => (
            <KVRow
              key={name}
              label={name}
              title={leg?.message}
              value={
                <span className="flex flex-wrap items-center justify-end gap-1.75">
                  {leg?.message ? (
                    <span className="text-meta text-tx-2">{leg.message}</span>
                  ) : null}
                  <StatusPill
                    mark={
                      leg?.status === "healthy"
                        ? { glyph: "●", tone: "ok", label: "healthy" }
                        : { glyph: "✕", tone: "bad", label: "unhealthy" }
                    }
                  />
                </span>
              }
            />
          ))}
        </KVList>
      </Card.Body>
      <Card.Footer>
        Traefik is probed as a container and then as a Swarm service of the same
        name, so &ldquo;unhealthy&rdquo; also covers &ldquo;never installed on
        this host&rdquo;. The message beside it is what tells them apart.
      </Card.Footer>
    </Card>
  );
}
