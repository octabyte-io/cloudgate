import { Card } from "@/components/console/card";
import { QAList, QARow } from "@/components/console/qa-row";
import { Skeleton } from "@/components/console/skeleton";
import { toast } from "@/components/console/toast";
import { Switch } from "@/components/ui/switch";
import type { TraefikPort } from "@/lib/api/endpoints/traefik";

import { SectionFailed } from "../section-states";
import { EnvBlock } from "./traefik-env-block";
import { PortsBlock } from "./traefik-ports-block";
import {
  usePlatformMutations,
  useTraefikDashboard,
  useTraefikEnv,
  useTraefikPorts,
} from "./use-platform";
import { useRecreation } from "./use-recreation";

/** What `toggleDashboard` adds to the published ports, and removes. */
const DASHBOARD_PORT: TraefikPort = {
  targetPort: 8080,
  publishedPort: 8080,
  protocol: "tcp",
};

/**
 * Traefik's **container** — its environment, its dashboard and its ports.
 *
 * Three routes in one card because they share one failure and one consequence.
 *
 * **The failure:** all three inspect the running `cloudgate-traefik` resource,
 * so all three throw the same thing when it is not running. Three separate cards
 * would print that same refusal three times, which reads as three broken
 * features rather than as one absent container.
 *
 * **The consequence:** every save here calls `writeTraefikSetup`, which
 * **recreates the container** — unawaited, so the request returns before it
 * happens. Every open connection on 80 and 443 goes with it. Saying that once,
 * for the card, is more honest than saying it three times in three footnotes.
 *
 * **After a save the card shows what was saved, not what the refetch reads**,
 * until a read shows the recreated container — `useRecreation`. Every
 * Save waits for it too: each route reads the *running* container's other
 * settings to carry them over, so a second save before the first recreation
 * would write the first one's old value back.
 *
 * The two blocks with a draft in them are their own modules rather than closures
 * inside this one. A component defined during render is a *new type* every render,
 * so React unmounts and remounts it — which would throw away what somebody is
 * typing.
 */
export function TraefikRuntimeCard() {
  const recreation = useRecreation();
  const env = useTraefikEnv(recreation.polling);
  const dashboard = useTraefikDashboard(recreation.polling);
  const ports = useTraefikPorts(recreation.polling);
  const mutations = usePlatformMutations();

  const { show, recreating, late } = recreation.view({
    env: env.data,
    ports: ports.data,
    dashboard: dashboard.data,
  });

  /** What the three reads say now, which is what a save is about to replace. */
  const before = () => ({
    env: env.data ?? "",
    ports: ports.data ?? [],
    dashboard: dashboard.data === true,
  });

  // Any one of the three failing means the same thing, so the first one that
  // does speaks for all three. Not while a save is waiting on its container: the
  // old one is removed before the new one exists, and a read in that gap says
  // Traefik is not running when what it is doing is restarting.
  const failure = recreating
    ? null
    : (env.error ?? dashboard.error ?? ports.error);
  if (failure) {
    return (
      <SectionFailed title="Traefik's container" error={failure}>
        These three settings are read from the running{" "}
        <code className="font-mono">cloudgate-traefik</code> resource, so there
        is nothing to show when it is not running. The files above are on disk
        and are readable either way.
      </SectionFailed>
    );
  }

  return (
    <Card
      aria-busy={
        env.isPending || dashboard.isPending || ports.isPending || undefined
      }
    >
      <Card.Header
        title="Traefik's container"
        sub="What it was started with. Changing any of it restarts it."
        headingLevel={2}
      />
      <Card.Body className="grid gap-5">
        {recreating || late ? (
          <p
            role="status"
            className="rounded-lg border border-line bg-panel-2 px-3.5 py-2.5 text-meta text-tx-2"
          >
            {recreating ? (
              <>
                Recreating… This card shows what was saved until Traefik&rsquo;s
                new container can be read.
              </>
            ) : (
              <>
                A minute after the save, Traefik&rsquo;s container still reads
                as it did before it, so this card shows what the container has,
                not what was saved. The recreation runs in the background; if it
                failed, Cloudgate&rsquo;s own log says why.
              </>
            )}
          </p>
        ) : null}
        <QAList>
          <QARow
            title="Publish the dashboard on 8080"
            description="Traefik's own dashboard has no password. Publishing it puts the full routing table — every host, every service, every middleware — on a port anyone who can reach this machine can open."
            action={
              dashboard.isPending ? (
                <Skeleton className="h-4.5 w-8 rounded-pill" />
              ) : (
                <Switch
                  checked={show("dashboard") === true}
                  disabled={mutations.toggleDashboard.isPending || recreating}
                  aria-label="Publish the Traefik dashboard on port 8080"
                  onCheckedChange={async (next) => {
                    const was = before();
                    try {
                      await mutations.toggleDashboard.mutateAsync(next);
                      recreation.start(was, {
                        dashboard: next,
                        ports: next
                          ? [...was.ports, DASHBOARD_PORT]
                          : was.ports.filter(
                              (port) =>
                                port.targetPort !== DASHBOARD_PORT.targetPort,
                            ),
                      });
                      toast.done(
                        next
                          ? "The dashboard is being published on 8080. Traefik is restarting."
                          : "The dashboard is being unpublished. Traefik is restarting.",
                      );
                    } catch (error) {
                      toast.error(error);
                    }
                  }}
                />
              )
            }
          />
        </QAList>

        <EnvBlock
          server={show("env") ?? ""}
          pending={env.isPending}
          save={mutations.writeEnv}
          recreating={recreating}
          onSaved={(saved) => recreation.start(before(), { env: saved })}
        />
        <PortsBlock
          rows={show("ports") ?? []}
          pending={ports.isPending}
          save={mutations.updatePorts}
          recreating={recreating}
          onSaved={(saved) =>
            recreation.start(before(), {
              ports: saved,
              dashboard: saved.some(
                (port) => port.targetPort === DASHBOARD_PORT.targetPort,
              ),
            })
          }
        />
      </Card.Body>
      <Card.Footer>
        Each of these saves by recreating the container in the background, so the
        request finishes before the restart does. Every connection on 80 and 443
        drops when it happens.
      </Card.Footer>
    </Card>
  );
}
