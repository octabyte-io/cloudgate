import { eq } from 'drizzle-orm';

import { boughtServer } from '../../bought-servers/bought-server.schema';
import type { BoughtServerStage } from '../../bought-servers/bought-server.schema';
import type { DrizzleDB } from '../../db/drizzle.module';
import type { DeployTarget } from '../../environments/deploy-target';
import { server } from '../../servers/server.schema';

/**
 * Whether a get-started wizard's setup may be applied now (ADR-0073), by
 * the state of the Server its Environment deploys to:
 *
 * - `ready`: apply now;
 * - `waiting`: not yet, and `waitingFor` says what for, in words the
 *   wizard shows as they are;
 * - `gone`: never, and `reason` says why. Cloudgate gives the Apply up.
 */
export type AutoApplyReadiness =
  | { readonly kind: 'ready' }
  | { readonly kind: 'waiting'; readonly waitingFor: string }
  | { readonly kind: 'gone'; readonly reason: string };

/** What {@link readinessOf} reads of the Server, so the rule is testable without a database. */
export interface ServerFacts {
  readonly name: string;
  /** The last Setup run's outcome; null before the first run ends. */
  readonly setupOk: boolean | null;
  readonly setupMessage: string | null;
  /** A Setup run going on this backend right now (`ServerSetupRuns.inFlight`). */
  readonly setupInFlight: boolean;
  /** Its Bought Server's stage; null for a Server of the customer's own. */
  readonly boughtStage: BoughtServerStage | null;
}

/**
 * The rule, pure. A Server is ready once it is set up: its last Setup run
 * finished, none is going now, and, when it is a Bought Server, it is
 * Ready (spec #1387). A failed or never-run setup keeps the setup waiting
 * rather than giving it up, since a press of *Run setup* can still make the
 * Server ready; a Bought Server that failed to be made or is being deleted
 * will never be.
 *
 * Only a Server can be waited for. The platform host and a Cloud account
 * are ready at once: the first is always there, and in the second the
 * Apply itself makes what the Services run on.
 */
export function readinessFrom(
  target: DeployTarget,
  facts: ServerFacts | null,
): AutoApplyReadiness {
  if (target.kind !== 'server') return { kind: 'ready' };
  if (facts === null) {
    return {
      kind: 'gone',
      reason: 'The Server this setup was to deploy to no longer exists',
    };
  }
  const { name, boughtStage } = facts;
  if (boughtStage === 'failed') {
    return {
      kind: 'gone',
      reason: `${name} could not be made, so there is nowhere to deploy this app`,
    };
  }
  if (boughtStage === 'deleting' || boughtStage === 'deleted') {
    return {
      kind: 'gone',
      reason: `${name} is being deleted, so there is nowhere to deploy this app`,
    };
  }
  if (boughtStage !== null && boughtStage !== 'ready') {
    return {
      kind: 'waiting',
      waitingFor:
        boughtStage === 'changing'
          ? `${name} is being changed`
          : `${name} is still being set up`,
    };
  }
  if (facts.setupInFlight) {
    return { kind: 'waiting', waitingFor: `${name} is being set up` };
  }
  if (facts.setupOk === true) return { kind: 'ready' };
  if (facts.setupOk === false) {
    return {
      kind: 'waiting',
      waitingFor: `${name}'s setup failed${
        facts.setupMessage ? `: ${facts.setupMessage}` : ''
      }. Run setup again on the Server's page`,
    };
  }
  return {
    kind: 'waiting',
    waitingFor: `${name} has not been set up yet. Run setup on the Server's page`,
  };
}

/** {@link readinessFrom}, with the Server's facts read from the database. */
export async function readinessOf(
  db: DrizzleDB,
  target: DeployTarget,
  setupInFlight: (serverId: string) => boolean,
): Promise<AutoApplyReadiness> {
  if (target.kind !== 'server') return readinessFrom(target, null);
  const [found] = await db
    .select({
      name: server.name,
      setupOk: server.setupOk,
      setupMessage: server.setupMessage,
      boughtStage: boughtServer.stage,
    })
    .from(server)
    .leftJoin(boughtServer, eq(boughtServer.serverId, server.serverId))
    .where(eq(server.serverId, target.serverId))
    .limit(1);
  return readinessFrom(
    target,
    found
      ? {
          name: found.name,
          setupOk: found.setupOk,
          setupMessage: found.setupMessage,
          setupInFlight: setupInFlight(target.serverId),
          boughtStage: found.boughtStage ?? null,
        }
      : null,
  );
}
