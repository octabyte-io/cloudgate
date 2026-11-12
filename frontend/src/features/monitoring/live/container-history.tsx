import type { MetricsConfig } from "@/lib/api/endpoints/servers";
import { retentionSpan, type SamplingState } from "@/lib/format/sampling";

import { exclusionsFor, includedFrom } from "../setup/metrics-config-spec";

/**
 * Whether a history is being kept for the **container** the picker is on.
 *
 * Said in words rather than drawn, and the words are the point: the include list
 * is empty by default and there is no value meaning everything, so the honest
 * answer for almost every instance is "no, and nothing will change that until
 * somebody names this service". Matching is by substring, which is why an entry
 * that merely appears in the name counts.
 *
 * **The exclude list is checked first and it is checked here too**
 * Reading only
 * the include list made this card say "Cloudgate is also storing this
 * container's samples" about a container the operator had excluded — the same
 * mistake as one card down, and here the test is exact rather than
 * conservative: `name` is Docker's whole name, so `exclusionsFor` runs the same
 * substring test `shouldMonitorContainer` runs at collection time.
 *
 * **A stopped history is not "nothing stored"**
 * what was
 * collected for a matched container is kept until retention deletes it, and it
 * is drawn in the Containers card, which stays on the screen for a stopped host.
 */
export function ContainerHistory({
  config,
  state,
  name,
}: {
  config: MetricsConfig | null;
  state: SamplingState;
  name: string;
}) {
  if (state === "never") {
    return (
      <p className="text-body text-tx-2">
        No history is stored for anything on this host. The reading above is live
        only.
      </p>
    );
  }

  const included = includedFrom(config);
  const matched = included.filter((entry) => name.includes(entry));
  const excludedBy = exclusionsFor(config, name);

  if (state === "stopped") {
    return (
      <p className="text-body text-tx-2">
        Cloudgate has stopped keeping a history of this host, so nothing new is
        stored for this container.{" "}
        {matched.length > 0 && excludedBy.length === 0 ? (
          <>
            What it stored under{" "}
            <code className="font-mono">{matched.join(", ")}</code> before that is
            kept until it is more than {retentionSpan(config)} old and drawn under
            Containers on this host, below.
          </>
        ) : (
          <>It was not storing this one before it stopped either.</>
        )}{" "}
        The reading above is live only.
      </p>
    );
  }

  return (
    <p className="text-body text-tx-2">
      {included.length === 0 ? (
        <>
          Cloudgate stores a history of this host but{" "}
          <strong className="font-medium text-tx">of no container on it</strong> —
          the include list is empty, and there is no value that means everything.
          The reading above is live only.
        </>
      ) : excludedBy.length > 0 ? (
        <>
          No history is stored for this container:{" "}
          <code className="font-mono">{excludedBy.join(", ")}</code>{" "}
          {excludedBy.length === 1 ? "is" : "are"} in{" "}
          <strong className="font-medium text-tx">Never collect for</strong>,
          which collection checks before the include list — an exclusion beats an
          inclusion. The reading above is live only.
        </>
      ) : matched.length > 0 ? (
        <>
          Cloudgate is also storing this container&rsquo;s samples, matched by{" "}
          <code className="font-mono">{matched.join(", ")}</code>. They are read
          back per service rather than per replica, so they are not drawn beside a
          single container&rsquo;s live figures here.
        </>
      ) : (
        <>
          No history is stored for this container: the include list is{" "}
          <code className="font-mono">{included.join(", ")}</code>, and none of
          those appears in its name. The reading above is live only.
        </>
      )}
    </p>
  );
}
