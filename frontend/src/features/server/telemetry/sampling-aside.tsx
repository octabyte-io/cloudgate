import { Card } from "@/components/console/card";
import { Dash } from "@/components/console/dash";
import { KVList, KVRow } from "@/components/console/kv-list";
import type { Server } from "@/lib/api/endpoints/servers";
import { retentionSpan, samplingState } from "@/lib/format/sampling";

/**
 * How the sampling is configured, out of the Server's own `metricsConfig`.
 *
 * Two of these are worth reading rather than decorative. **The interval** is what
 * makes "live" mean something: a host sampled once a minute cannot show a spike that
 * lasted twenty seconds, and knowing that stops somebody chasing a number that was
 * never going to be there. **The retention** is why the "Everything" window has an
 * end: samples past it are deleted by the cleanup cron.
 *
 * **Stopped is configured-but-off, not "not set up"**
 * Stopping clears
 * the token and keeps the rest, so the interval is the one collection resumes at
 * and the retention is still being applied — the backend keeps that cron for a
 * stopped Server. Printing dashes for both said the opposite of the config.
 */
export function SamplingAside({ server }: { server: Server }) {
  const config = server.metricsConfig.server;
  const state = samplingState(server.metricsConfig);

  return (
    <Card>
      <Card.Header title="Sampling" headingLevel={2} />
      <Card.Body>
        <KVList>
          <KVRow
            label="Collecting"
            value={
              state === "collecting"
                ? "yes"
                : state === "stopped"
                  ? "stopped — samples kept"
                  : "not set up"
            }
          />
          <KVRow
            label="Interval"
            value={
              state === "collecting" ? (
                `${config.refreshRate || 60}s`
              ) : state === "stopped" ? (
                `${config.refreshRate || 60}s, when started again`
              ) : (
                <Dash word="None" />
              )
            }
          />
          <KVRow
            label="Retention"
            value={
              state === "never" ? (
                <Dash word="None" />
              ) : (
                retentionSpan(server.metricsConfig)
              )
            }
          />
          <KVRow label="Source" value="/proc, over SSH" mono />
        </KVList>
        <p className="mt-3 text-meta text-tx-2">
          Cloudgate reads this host&rsquo;s own{" "}
          <code className="font-mono">/proc</code> over the same SSH connection
          everything else uses — there is no agent installed on the machine.
          Container-level figures are a different route and arrive with the
          Monitoring screens.
        </p>
      </Card.Body>
      <Card.Footer>
        The live stats socket in this backend takes no Server, so it can only
        ever report the host Cloudgate itself runs on. That is why this tab
        polls rather than streams.
      </Card.Footer>
    </Card>
  );
}
