// **No `"use client"`, on purpose.** The directive declares an *entry point*
// (`next/dist/docs/01-app/03-api-reference/01-directives/use-client.md`) and it
// is what subjects a file's props to the serializable rule — which `onDeployed`,
// a plain callback that never crosses the network, would fail. The only importer
// of this module is `panels/overview.tsx`, which is already a client entry
// point, so this file is inside its module graph and the hooks below run
// client-side regardless. Do not restore it, and do not rename the callback to
// `onDeployedAction`: that name would claim it is a Server Action.

import { useState } from "react";

import { Modal } from "@/components/console/modal";
import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";
import {
  cloudNameOf,
  onGoogleCloud,
  type ApplicationDetail,
} from "@/lib/api/endpoints/applications";
import type { Deployment } from "@/lib/api/endpoints/deployments";
import { usePermission } from "@/lib/auth/use-permission";

import { DeployButton, deployUnavailable } from "../deploy/deploy-button";
import {
  APPLICATION_DEPLOY_REFUSAL,
  useApplicationLifecycle,
  wasRefused,
} from "../use-application";
import { ActionIcon } from "./action-icon";

/**
 * What Stop on a Service in a Cloud account still leaves on the bill
 * (US92): Stop lowers the bill without ending it.
 */
export const CLOUD_STOP_WARNING =
  "Stopping lowers the bill without ending it. The Environment network this Service shares (about $24/month), its stored images and its stored logs still bill, and its Domains answer 503 until you start it again.";

/**
 * The same for a Worker on ECS
 * or a
 * Private web service there
 * which
 * take no Domain, so none is said to answer anything.
 */
export const CLOUD_WORKER_STOP_WARNING =
  "Stopping lowers the bill without ending it. The Environment network this Service shares (about $24/month), its stored images and its stored logs still bill.";

/**
 * The same on Cloud Run: Stop switches the service to
 * no copies, which refuses traffic; the shared load balancer, the stored image
 * and the stored logs still bill.
 */
export const GOOGLE_STOP_WARNING =
  "Stopping lowers the bill without ending it. The load balancer of the Environment network this Service shares (about $18/month while idle), its stored image and its stored logs still bill, and its Domains answer an error until you start it again.";

/** Why Reload is off on a stopped cloud Service; the backend's own refusal. */
export const CLOUD_RELOAD_WHILE_STOPPED =
  "This Service is stopped, so it has no running copy to replace. Start it first.";

/**
 * Deploy, Restart, and Stop-or-Start — the lifecycle an Application has.
 *
 * This row is the answer to an asymmetry: a Postgres in the
 * same Environment has had Deploy / Start / Stop / Rebuild on a shared base
 * class since F11, and the Application beside it had one button.
 *
 * What each one does, because the words are close enough to confuse:
 *
 * - **Deploy** clones the source, builds it and releases the result. Minutes,
 *   and it writes a Deployment you can watch.
 * - **Restart** scales the Swarm service to zero and back. Seconds, no clone, no
 *   build, no new Deployment — the one to press when the process is wedged
 *   rather than the code wrong.
 * - **Stop** / **Start** are the same scale, held. Stopping keeps the row, the
 *   domains and the volumes; it is downtime, not deletion.
 *
 * **Stop and Start are one control, not two.** On the database screens both are
 * always offered, because a database's `applicationStatus` cannot tell you
 * whether the engine is up. Here it can: `done` means the last build released
 * and the service is serving, `stopped` means it was scaled down. So the button
 * offers the one that is the *next* thing to do, and the other would be a no-op
 * dressed as a choice. `idle` sits with `stopped`: Stop used to write it, so
 * a row stopped back then still wears it, and behind a released
 * Deployment (the gate below) it cannot mean "never deployed".
 *
 * **Nothing is offered before the first Deployment that released.**
 * `docker service scale` needs a service to scale, and an Application no
 * Deployment has finished `done` has none — the buttons would exist only to
 * return "service not found". The gate used to be "any Deployment", and a
 * failed one is a row, so an Application whose only build had failed was
 * offered exactly those two buttons. If one is pressed anyway — the
 * service removed by hand, or an API call — the backend answers a 409 naming
 * the missing service, which `run` shows as the refusal it is.
 *
 * **All three read `deployment: ['create']`**, which `start`, `stop` and
 * `reload` each check first. An earlier report said Restart and Stop
 * were `service: ['update']` and refused for a role holding only the deploy
 * statement; the routes say otherwise — starting, stopping and reloading an
 * Application is deliberately not a definition write (`access-control.ts`'s
 * `service` note) — so for that role these stay live beside Deploy, and they
 * work.
 *
 * **In a Cloud account** the same three are direct ECS calls and answer in seconds:
 * Stop runs none of the Service's copies, after a confirmation that names
 * what still bills ({@link CLOUD_STOP_WARNING}); Start runs its usual
 * `replicas` again; and the restart is **Reload**, which replaces every
 * running copy with a fresh one of the same version, and is off with the
 * reason while the Service is stopped, because there is nothing to replace.
 * There is no Remove containers on a cloud Service: a copy that stops
 * leaves nothing behind.
 *
 * **On Cloud Run** Stop switches the service to
 * no copies at all, so it refuses traffic, after {@link GOOGLE_STOP_WARNING};
 * Start hands it back its copy range; and Reload starts a fresh revision of
 * the same image. The same three buttons, in Google's words.
 *
 * **A Cron service (ADR-0034)** has no Swarm service to scale: Stop
 * is its per-Environment pause — its timetable starts no run, and a run in
 * flight is stopped — and Start resumes it from the next fire time. Neither
 * touches the Project config, and a build in flight does not hold either
 * back. There is no Restart, since nothing keeps running between runs, and
 * no Remove containers, since a finished run leaves no container.
 *
 * **While a cloud Delete runs or is incomplete**
 * none of them is offered: the backend refuses Deploy and Start, and the
 * Delete card says what is going on instead.
 */
export function ApplicationActions({
  application,
  hasBuilt,
  onDeployed,
  size = "default",
}: {
  /** The Service page's read: its `cloudPlace` picks the cloud's wording. */
  application: ApplicationDetail;
  /** Whether any Deployment has finished `done` — see the note above. */
  hasBuilt: boolean;
  onDeployed?: (deployment: Deployment) => void;
  size?: "default" | "sm";
}) {
  const lifecycle = useApplicationLifecycle(
    application.applicationId,
    application.environmentId,
  );
  const cloud = Boolean(application.cloudPlace);
  const google = onGoogleCloud(application.cloudPlace);
  const cron = application.configKind === "cron";
  // A Worker and a Private web service take no Domain.
  const noDomain =
    application.configKind === "worker" ||
    application.configKind === "web-private";
  // A Worker on Google Cloud is a worker pool: Stop sets its instance count
  // to 0, which bills nothing, so there is nothing to warn of.
  const googleWorker = google && application.configKind === "worker";
  const [confirmingStop, setConfirmingStop] = useState(false);

  // Any scale in flight disables the rest: they converge one Swarm service, and
  // two at once is a race whose loser leaves the status describing the wrong
  // operation. Same rule as the database row.
  const busy =
    lifecycle.start.isPending ||
    lifecycle.stop.isPending ||
    lifecycle.reload.isPending;

  // `running` is a *build* in flight, not a running container. Scaling under a
  // build that is about to swap the service in is how you get a service the
  // console says is stopped and the Server says is serving.
  // A build never touches a Cron service's pause.
  const building = application.applicationStatus === "running" && !cron;
  const canOperate = usePermission({ deployment: ["create"] });
  const refused = !canOperate.allowed;
  // A Cron service is paused only by Stop: `idle` is one never built.
  const scaledDown =
    application.applicationStatus === "stopped" ||
    (!cron && application.applicationStatus === "idle");
  // A stopped cloud Service has no copy for Reload to replace; the backend
  // refuses it with the same sentence.
  const reloadStopped = cloud && scaledDown;
  const stop = () =>
    run(
      lifecycle.stop,
      cron
        ? `${application.name} is paused: its timetable starts no run until you start it again, and a run in flight was stopped.`
        : googleWorker
          ? `${application.name} is stopping. None of its instances runs until you start it again.`
          : google
            ? `${application.name} is stopping. Its Domains answer an error until you start it again.`
            : cloud && noDomain
              ? `${application.name} is stopping. None of its copies runs until you start it again.`
              : cloud
                ? `${application.name} is stopping. Its Domains answer 503 until you start it again.`
                : `${application.name} is stopping. Its domains and volumes are untouched.`,
    );

  /**
   * Run one, and be honest about the ambiguous failure.
   *
   * A 4xx is the backend saying no and its message is the answer. But
   * `docker service scale` **waits for the service to converge**, and a pull on
   * a cold host outlasts the time the proxy holds the response open — so a 5xx
   * or a dropped connection usually means it is still happening. `toast.error`'s
   * sentence for a 500 once said "nothing changed", which there was
   * backwards, and is still only "look before trying again". The row
   * is already being re-read (`onSettled`), so what this has to do is point at
   * it.
   */
  const run = (
    mutation: { mutateAsync: () => Promise<unknown> },
    done: string,
  ) =>
    mutation
      .mutateAsync()
      .then(() => toast.done(done))
      .catch((error: unknown) => {
        if (wasRefused(error)) {
          toast.error(error);
          return;
        }
        toast.warn("The request did not come back.", {
          description: application.cloudPlace
            ? `${cloudNameOf(application.cloudPlace)} may still have taken it. Watch the status beside the name rather than this.`
            : "Scaling waits for the Swarm service to converge, which can take longer than the connection is held open — so this may still be running. Watch the status beside the name rather than this.",
        });
      });

  // A cloud Service being deleted, or Delete incomplete, is never deployed or
  // started (ADR-0038): its Retry and Forget are on its Delete card.
  if (application.cloudDelete) return null;

  return (
    <>
      <DeployButton
        applicationId={application.applicationId}
        environmentId={application.environmentId}
        onDeployed={onDeployed}
        size={size}
        unavailable={deployUnavailable(application)}
      />

      {hasBuilt || cron ? (
        <>
          {cron ? null : (
            <Button
              size={size}
              aria-disabled={
                refused || busy || building || reloadStopped || undefined
              }
              aria-busy={lifecycle.reload.isPending || undefined}
              title={
                refused
                  ? APPLICATION_DEPLOY_REFUSAL
                  : building
                    ? "A build is in flight. Restarting now would fight the Deployment it is about to make."
                    : reloadStopped
                      ? CLOUD_RELOAD_WHILE_STOPPED
                      : undefined
              }
              onClick={
                refused || busy || building || reloadStopped
                  ? undefined
                  : () =>
                      void run(
                        lifecycle.reload,
                        google
                          ? `${application.name} is starting a fresh revision of the same image.`
                          : cloud
                            ? `${application.name} is replacing every running copy with a fresh one of the same version.`
                            : `${application.name} is restarting on the image it already has.`,
                      )
              }
            >
              <ActionIcon
                name="refresh"
                pending={lifecycle.reload.isPending}
                size={size === "sm" ? 14 : 15}
              />
              {cloud ? "Reload" : "Restart"}
            </Button>
          )}

          {scaledDown ? (
            <Button
              size={size}
              aria-disabled={refused || busy || undefined}
              aria-busy={lifecycle.start.isPending || undefined}
              title={refused ? APPLICATION_DEPLOY_REFUSAL : undefined}
              onClick={
                refused || busy
                  ? undefined
                  : () =>
                      void run(
                        lifecycle.start,
                        cron
                          ? `${application.name}'s timetable is running again from its next fire time.`
                          : google
                            ? `${application.name} is starting again on its last deployed image, between ${application.minCopies ?? 0} and ${application.maxCopies ?? 10} copies.`
                            : cloud
                              ? `${application.name} is starting ${application.replicas} ${application.replicas === 1 ? "copy" : "copies"} of its last deployed image.`
                              : `${application.name} is starting on its last deployed image.`,
                      )
              }
            >
              <ActionIcon
                name="play"
                pending={lifecycle.start.isPending}
                size={size === "sm" ? 14 : 15}
              />
              Start
            </Button>
          ) : (
            <Button
              size={size}
              aria-disabled={refused || busy || building || undefined}
              aria-busy={lifecycle.stop.isPending || undefined}
              title={
                refused
                  ? APPLICATION_DEPLOY_REFUSAL
                  : building
                    ? "A build is in flight. Wait for it, or cancel it from the Deployments tab."
                    : undefined
              }
              onClick={
                refused || busy || building
                  ? undefined
                  : // A Cron service's Stop is its pause, wherever it runs
                    // nothing of it scales, so nothing to warn of.
                    // Nor a Worker's on Google Cloud, which bills nothing
                    // stopped.
                    cloud && !cron && !googleWorker
                    ? () => setConfirmingStop(true)
                    : () => void stop()
              }
            >
              <ActionIcon
                pending={lifecycle.stop.isPending}
                size={size === "sm" ? 14 : 15}
              />
              Stop
            </Button>
          )}
        </>
      ) : null}

      {cloud ? (
        <Modal open={confirmingStop} onOpenChange={setConfirmingStop}>
          <Modal.Header
            title={`Stop ${application.name}?`}
            description="None of its copies will run until you start it again."
          />
          <Modal.Body>
            <p className="text-body text-tx-2">
              {google
                ? GOOGLE_STOP_WARNING
                : noDomain
                  ? CLOUD_WORKER_STOP_WARNING
                  : CLOUD_STOP_WARNING}
            </p>
          </Modal.Body>
          <Modal.Footer>
            <Modal.Gap />
            <Modal.Close render={<Button type="button">Keep running</Button>} />
            <Button
              type="button"
              variant="dngr"
              disabled={refused || busy}
              onClick={() => {
                setConfirmingStop(false);
                void stop();
              }}
            >
              Stop
            </Button>
          </Modal.Footer>
        </Modal>
      ) : null}
    </>
  );
}
