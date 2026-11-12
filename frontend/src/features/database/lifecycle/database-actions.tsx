import { useId, useState } from "react";

import { Modal } from "@/components/console/modal";
import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";
import { stoppedListening } from "@/lib/api/api-error";
import type { Database, DatabaseKind } from "@/lib/api/endpoints/databases";
import { existingPlaceOf } from "@/lib/api/endpoints/existing-redis";

import {
  stillConverging,
  useDatabaseActions,
} from "../use-database";
import {
  CLOUD_REBUILD_REFUSED,
  CLOUD_SQL_STOP_WARNING,
  ELASTICACHE_CANNOT_STOP,
  EXISTING_NOT_MANAGED,
  MEMORYSTORE_CANNOT_STOP,
  cloudDatabaseOf,
  rdsStopWarning,
} from "./cloud-database";
// The Application row's pending glyph, so every Service kind's lifecycle row
// says "working" the same way.
import { ActionIcon } from "../../application/lifecycle/action-icon";
import { RebuildModal } from "./rebuild-modal";

/** Why Start and Stop are off on a database no Deploy has created. */
export const DATABASE_NEVER_DEPLOYED =
  "Start and Stop scale a service this database does not have yet. Deploy creates it.";

/**
 * Deploy, Start, Stop and Rebuild — the four lifecycle actions a managed
 * database has, on the shared base class, and the same four for all six engines.
 *
 * **The Application beside it is no longer the odd one out.**
 * It has start, stop,
 * restart, redeploy, cancel and webhook-secret rotation, so this row is not
 * explaining an asymmetry any more. The one control that is still only here is
 * **Rebuild**, because there is no data volume on the other side to throw away.
 *
 * What each one really does, because the words are close enough to confuse:
 *
 * - **Deploy** pulls the image and converges the swarm service onto the row.
 *   Run it after changing the image, the credentials or the variables. It is
 *   also how a database that has never been deployed comes into existence.
 *   The request waits for Swarm to decide, up to a bound: decided, it
 *   is `done`, or a 4xx whose message says why with the status `error`; not
 *   yet, it answers `running` and the status moves when Swarm decides.
 * - **Start** / **Stop** are `docker service scale` to 1 and 0, and both are
 *   always offered once there is a service — off, saying so, before the first
 *   Deploy, when the scale could only answer "service not found" — — unlike the Application's
 *   single Stop-or-Start, whose row says which one is next. A database's `applicationStatus` cannot
 *   tell you whether the engine is up. Stopping keeps the volume, the row and the published port;
 *   it is downtime, not deletion.
 * - **Rebuild** drops the service **and the data volume** and deploys from
 *   scratch. It is the only control on these screens that destroys data, so it
 *   is the only one behind a typed confirmation.
 *
 * Deploy is primary and Rebuild is `dngr`; Start and Stop are plain, because
 * which of the two is the *right* thing to press depends entirely on what the
 * database is doing now and neither deserves emphasis.
 *
 * **In a Cloud account**:
 * a postgres on RDS stops and starts by RDS's own calls, and Stop is confirmed
 * first, because AWS starts the instance again after seven days and storage
 * and backups still bill. A redis on ElastiCache has no stopped state, so its
 * Start and Stop are off, saying so; Rebuild is off on both, because their data
 * goes by a Delete only. Neither has Remove containers, Reload or Restart.
 *
 * **On Google Cloud**:
 * the same row. A postgres on Cloud SQL stops and starts by its activation
 * policy, and Stop is confirmed first with what still costs money, but no
 * date, since Google never starts it by itself. A redis on Memorystore has no
 * stopped state either, so its Start and Stop are off, saying so.
 */
export function DatabaseActions({
  database,
  kind,
  size = "default",
}: {
  database: Database;
  kind: DatabaseKind;
  size?: "default" | "sm";
}) {
  const actions = useDatabaseActions(
    kind,
    database.databaseId,
    database.environmentId,
  );
  const [rebuilding, setRebuilding] = useState(false);
  const [confirmingStop, setConfirmingStop] = useState(false);
  const reasonId = useId();
  const cloud = cloudDatabaseOf(database, kind);
  // ElastiCache and Memorystore cannot be stopped, and a cloud database is
  // never rebuilt: the backend's own refusals, shown on the buttons.
  const scaleRefusal =
    cloud === "elasticache"
      ? ELASTICACHE_CANNOT_STOP
      : cloud === "memorystore"
        ? MEMORYSTORE_CANNOT_STOP
        : undefined;
  // RDS and Cloud SQL confirm a Stop with what it leaves billing.
  const stopConfirm =
    cloud === "rds"
      ? {
          description:
            "Its RDS instance stops; its data and settings are kept.",
          warning: () => `${rdsStopWarning(new Date())}.`,
          after: (answer: Database | undefined) =>
            `${answer?.rdsStop?.warning ?? rdsStopWarning(new Date())}.`,
        }
      : cloud === "cloud-sql"
        ? {
            description:
              "Its Cloud SQL instance stops; its data and settings are kept.",
            warning: () => CLOUD_SQL_STOP_WARNING,
            after: (answer: Database | undefined) =>
              answer?.cloudSqlStop?.warning ?? CLOUD_SQL_STOP_WARNING,
          }
        : null;
  const rebuildRefusal = cloud ? CLOUD_REBUILD_REFUSED : undefined;
  // Nothing to scale before the first Deploy: `idle` is the column's
  // never-deployed default now that Stop writes `stopped`. A row
  // stopped before then still wears it, and Deploy brings that one back too.
  const neverDeployed = !scaleRefusal && database.applicationStatus === "idle";
  const startStopOff =
    scaleRefusal ?? (neverDeployed ? DATABASE_NEVER_DEPLOYED : undefined);

  // Any lifecycle call in flight disables the rest of the row: they all
  // converge the same swarm service, and two at once is a race whose loser
  // leaves the row's status describing the wrong operation.
  // An Existing database's lifecycle is its own, in AWS.
  const existing = existingPlaceOf(database);
  const busy =
    actions.deploy.isPending ||
    actions.start.isPending ||
    actions.stop.isPending ||
    actions.rebuild.isPending;

  /**
   * Run one, and be honest about the ambiguous failure.
   *
   * These calls **converge a Swarm service inside the request**, and one can
   * outlast the time the proxy holds a response open — so a dropped connection
   * or a proxy's own timeout means the operation may still be running, and the
   * row (re-read `onSettled`) is what to watch. Only that case says so
   * (`stoppedListening`). Anything the backend answered itself — a
   * refusal, a deploy Docker failed, a Server it could not reach — is shown in
   * the backend's words: it used to get the timeout sentence too, so an
   * immediate failure never showed its reason anywhere.
   */
  const run = (
    mutation: { mutateAsync: () => Promise<unknown> },
    done: string | ((answer: unknown) => string),
  ) =>
    mutation
      .mutateAsync()
      .then((answer) =>
        toast.done(typeof done === "string" ? done : done(answer)),
      )
      .catch((error: unknown) => {
        if (!stoppedListening(error)) {
          toast.error(error);
          return;
        }
        toast.warn("The request did not come back.", {
          description:
            "Converging can take longer than the connection is held open, so this may still be running. The status beside the name is read from the Server — watch that rather than this.",
        });
      });

  if (existing) {
    // Shown, disabled, with the sentence the API refuses them with.
    return (
      <>
        {(["Start", "Stop", "Rebuild"] as const).map((label) => (
          <Button
            key={label}
            size={size}
            variant={label === "Rebuild" ? "dngr" : undefined}
            aria-disabled
            title={EXISTING_NOT_MANAGED}
          >
            {label}
          </Button>
        ))}
        <span className="text-meta text-tx-3">{EXISTING_NOT_MANAGED}</span>
      </>
    );
  }

  return (
    <>
      <Button
        size={size}
        variant="pri"
        aria-disabled={busy || undefined}
        aria-busy={actions.deploy.isPending || undefined}
        onClick={
          busy
            ? undefined
            : () =>
                void run(actions.deploy, (answer) =>
                  stillConverging(answer)
                    ? `${database.name} is converging. The status moves to done when it is up.`
                    : `${database.name} is deployed.`,
                )
        }
      >
        <ActionIcon
          name="rocket"
          pending={actions.deploy.isPending}
          size={size === "sm" ? 14 : 15}
        />
        Deploy
      </Button>

      <Button
        size={size}
        aria-disabled={busy || startStopOff ? true : undefined}
        title={startStopOff}
        aria-describedby={neverDeployed ? reasonId : undefined}
        aria-busy={actions.start.isPending || undefined}
        onClick={
          busy || startStopOff
            ? undefined
            : () => void run(actions.start, `${database.name} is starting.`)
        }
      >
        <ActionIcon
          name="play"
          pending={actions.start.isPending}
          size={size === "sm" ? 14 : 15}
        />
        Start
      </Button>

      <Button
        size={size}
        aria-disabled={busy || startStopOff ? true : undefined}
        title={startStopOff}
        aria-describedby={neverDeployed ? reasonId : undefined}
        aria-busy={actions.stop.isPending || undefined}
        onClick={
          busy || startStopOff
            ? undefined
            : stopConfirm
              ? () => setConfirmingStop(true)
              : () =>
                  void run(
                    actions.stop,
                    `${database.name} is stopping. Its data volume is untouched.`,
                  )
        }
      >
        <ActionIcon
          pending={actions.stop.isPending}
          size={size === "sm" ? 14 : 15}
        />
        Stop
      </Button>

      {neverDeployed ? (
        <span id={reasonId} className="text-meta text-tx-3">
          {DATABASE_NEVER_DEPLOYED}
        </span>
      ) : null}

      <Button
        size={size}
        variant="dngr"
        aria-disabled={busy || rebuildRefusal ? true : undefined}
        title={rebuildRefusal}
        aria-busy={actions.rebuild.isPending || undefined}
        onClick={busy || rebuildRefusal ? undefined : () => setRebuilding(true)}
      >
        <ActionIcon
          pending={actions.rebuild.isPending}
          size={size === "sm" ? 14 : 15}
        />
        Rebuild
      </Button>

      {stopConfirm ? (
        <Modal open={confirmingStop} onOpenChange={setConfirmingStop}>
          <Modal.Header
            title={`Stop ${database.name}?`}
            description={stopConfirm.description}
          />
          <Modal.Body>
            <p className="text-body text-tx-2">{stopConfirm.warning()}</p>
          </Modal.Body>
          <Modal.Footer>
            <Modal.Gap />
            <Modal.Close render={<Button type="button">Keep running</Button>} />
            <Button
              type="button"
              variant="dngr"
              disabled={busy}
              onClick={() => {
                setConfirmingStop(false);
                void run(
                  actions.stop,
                  (answer) =>
                    `${database.name} is stopping. ${stopConfirm.after(
                      answer as Database | undefined,
                    )}`,
                );
              }}
            >
              Stop
            </Button>
          </Modal.Footer>
        </Modal>
      ) : null}

      <RebuildModal
        database={database}
        kind={kind}
        open={rebuilding}
        onOpenChange={setRebuilding}
        rebuild={() => actions.rebuild.mutateAsync()}
      />
    </>
  );
}
