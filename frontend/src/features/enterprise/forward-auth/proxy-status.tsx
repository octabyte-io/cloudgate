import { Chip } from "@/components/console/chip";
import type { ForwardAuthTarget } from "@/lib/api/endpoints/forward-auth";

/**
 * The probe's four answers, each with its own word — and **none of them is
 * "running"**.
 *
 * The probe reads the service's tasks, not the service object, since
 * `inspect()` succeeds the instant `docker service create` returns and said
 * `running` for a proxy whose every task exited 1
 * So a deployed
 * proxy with no replica up is its own reading, **Not starting**, and the card
 * shows the task's error beside it. **Deployed** is a replica in state
 * `running` — which is still not proof oauth2-proxy answers, so it is not a
 * green pill either.
 *
 * `unknown` is not `stopped` either. `proxyStatus` races the probe against a
 * four-second timeout and answers `unknown` for anything that fails or times out —
 * an unreachable server, not a proxy that is down. Rendering that as "stopped"
 * would send somebody to redeploy a proxy running perfectly on a host their
 * console cannot currently reach.
 *
 * No `StatusPill` either. Its keys are the product's own vocabulary — idle /
 * running / done / error — and borrowing `running` would carry the `ok` tone
 * this reading cannot earn.
 */
export function ProxyStatus({
  status,
}: {
  status: ForwardAuthTarget["status"];
}) {
  if (status === "running") return <Chip variant="brand">Deployed</Chip>;
  if (status === "failing") return <Chip>Not starting</Chip>;
  if (status === "stopped") return <Chip>No proxy</Chip>;
  return (
    <Chip>
      Could not check
      <span className="sr-only">
        {" — the probe did not answer within four seconds, so this says nothing about whether a proxy is deployed"}
      </span>
    </Chip>
  );
}
