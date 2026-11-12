import { DangerZone } from "@/components/console/danger-zone";
import { settingsApi } from "@/lib/api/endpoints/settings";

import { useInstanceGate, useUpdateData } from "./use-platform";

/**
 * The two controls that take this instance down, and the one that empties the
 * build queue.
 *
 * **`update-server` is the most destructive control in the product** and the
 * phase brief asked the question outright. The answer is in
 * `UpdatesService.updateServer`: `docker service update --force --image
 * cloudgate/cloudgate:<latest> cloudgate`. It replaces the running task — this
 * console goes with it, mid-request, and comes back on a different version.
 *
 * It also **does nothing at all when nothing newer is published**, because it
 * re-reads `getUpdateData` and acts only `if (data.updateAvailable)`. A button
 * that means "restart onto a new version" on Tuesday and "nothing happens" on
 * Wednesday is not one control, so this one is gated on the check: it is
 * unavailable until somebody has asked Docker Hub and been told there is
 * something to move to.
 *
 * The gate distinguishes the two ways the check can come back empty. "I
 * asked, and nothing newer is published" is a reason to leave the button alone;
 * "I could not ask" is a different sentence and gets a different one, because
 * pressing through it would answer 503 rather than doing anything.
 *
 * **Restart Cloudgate does not say "This cannot be undone."** Nothing saved is
 * lost — the database and every configuration survive it. What it does cost is
 * a build in progress: the build queue is in-memory (`InMemoryQueue`), and
 * start-up queues the waiting builds again but settles a running one `error`
 * so its line under the title says that instead. Update keeps the default: there is no route back
 * to the old version.
 */
export function InstanceDangerZone({ checked }: { checked: boolean }) {
  const update = useUpdateData(checked);
  // All three routes take instance authority (ADR-0013). A caller without it
  // is told so on each row before anything else.
  const gate = useInstanceGate();
  const refused = gate.allowed ? undefined : gate.refusal;

  const available = update.data?.updateAvailable === true;
  /** The check ran but did not complete — see the module comment. */
  const checkFailed = checked && !update.isFetching && !!update.data?.error;

  return (
    <DangerZone
      sub="Two of these restart Cloudgate itself, so this console goes with them."
      actions={[
        {
          id: "update-server",
          title: "Update this instance",
          description: available
            ? `Replaces the running image with cloudgate/cloudgate:${update.data?.latestVersion}.`
            : "Replaces the running image with the newest published one.",
          button: "Update and restart",
          unavailable: refused
            ? refused
            : !checked
              ? "Check for updates on the card above first — this control does nothing when there is nothing newer."
              : update.isFetching
                ? "Still asking Docker Hub."
                : checkFailed
                  ? `The update check did not complete, so there is nothing to update to: ${update.data?.error}`
                  : available
                    ? undefined
                    : "Nothing newer than this version has been published.",
          consequences: (
            <>
              <p>
                Cloudgate&rsquo;s own Swarm service is updated to{" "}
                <strong className="font-medium">
                  cloudgate/cloudgate:
                  {update.data?.latestVersion ?? "the newest tag"}
                </strong>{" "}
                and the running task is replaced. This console stops answering
                mid-request and comes back on the new version — including any
                database migrations that version carries.
              </p>
              <p className="mt-2">
                Deployments already running on this host are not stopped, but
                anything the platform was in the middle of orchestrating is.
                There is no route that puts the old version back.
              </p>
            </>
          ),
          run: () => settingsApi.updateServer(),
          done: "The update is running. This console will restart.",
        },
        {
          id: "reload-server",
          title: "Restart this instance",
          description:
            "Forces the Cloudgate service to restart on the version it is already running.",
          button: "Restart Cloudgate",
          unavailable: refused,
          caution:
            "Nothing saved is lost, and Deployments waiting to start are queued again once Cloudgate is back. A build in progress is cut off and ends in error; deploy it again.",
          consequences: (
            <>
              <p>
                On a Swarm service this is the same{" "}
                <code className="font-mono">
                  docker service update --force
                </code>{" "}
                as an update, without the new image, and the running task is
                replaced; on a standalone container it is{" "}
                <code className="font-mono">docker restart</code>. Either way
                this console stops answering until Cloudgate is back.
              </p>
              <p className="mt-2">
                On an install that is neither — the native install, where
                Cloudgate is the systemd units{" "}
                <code className="font-mono">cloudgate-backend</code> and{" "}
                <code className="font-mono">cloudgate-console</code> and there is
                no Docker service to force — there is nothing here to restart,
                so this refuses and says so instead, and nothing stops
                answering. Restart those units on the host.
              </p>
              <p className="mt-2">
                Worth doing when the process is wedged and worth nothing
                otherwise — no configuration on these screens needs a Cloudgate
                restart to take effect.
              </p>
            </>
          ),
          run: () => settingsApi.reloadServer(),
          done: "Cloudgate is restarting.",
        },
        {
          id: "clean-queue",
          title: "Empty the build queue",
          description:
            "Drops every Deployment that is waiting to start. A build already running is not touched.",
          button: "Empty the queue",
          unavailable: refused,
          consequences: (
            <>
              <p>
                Every queued Deployment is removed from the queue and marked{" "}
                <strong className="font-medium">cancelled</strong>, with a
                last line in its log saying the queue was emptied. Nothing
                re-queues them — those builds never happen, so anything waiting
                on one has to be deployed again by hand.
              </p>
            </>
          ),
          run: () => settingsApi.cleanDeploymentQueue(),
          done: "The queue is empty.",
        },
      ]}
    />
  );
}
