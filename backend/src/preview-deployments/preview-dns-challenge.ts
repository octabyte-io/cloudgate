import { ConflictException, Logger } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import type { DrizzleDB } from '../db/drizzle.module';
import { dnsChallengeOn } from '../settings/dns-challenge.read';
import type { TraefikAppConfigService } from '../traefik/app-config.service';
import { previewDeployment } from './preview-deployment.schema';

/**
 * The Previews switch that issues the preview wildcard through DNS-01:
 * who may turn it on, what it makes a preview's router ask for, and the
 * rewrite of live previews' routers when it moves. Plain functions rather
 * than a service, because `ApplicationsService` writes the switch and
 * `PreviewDeploymentsService` injects `ApplicationsService` — the knot
 * `preview-teardown.ts` is plain functions to avoid.
 */

/**
 * The `code` each refusal of the switch carries beside its sentence, the
 * opt-in field `all-exceptions.filter.ts` publishes. Both are `409`s: each is
 * a state of the Application or its machine, not a malformed body.
 */
export const PREVIEW_DNS_CHALLENGE_REFUSAL_CODE = {
  noWildcard: 'PREVIEW_DNS_CHALLENGE_NEEDS_WILDCARD',
  noSetup: 'NO_DNS_CHALLENGE_ON_MACHINE',
} as const;

/**
 * Turning the switch on, or clearing the wildcard while it is on, with no
 * preview wildcard left. A generated host is `<name>-<ip>.sslip.io`, whose DNS
 * nobody's provider answers, so there is nothing to issue a DNS-01
 * certificate for.
 */
export const PREVIEW_DNS_CHALLENGE_NEEDS_WILDCARD =
  'Issuing preview certificates through DNS-01 needs a preview wildcard: a generated sslip.io host cannot get a DNS-01 certificate. Set a preview wildcard, or turn DNS-01 off in the same save before clearing it';

/** Turning the switch on for an Application whose machine has no DNS-01 setup. */
export const PREVIEW_DNS_CHALLENGE_NO_SETUP =
  "The machine this Application's previews run on has no DNS-01 setup. Add a DNS provider in that machine's Traefik settings first";

/** The columns the switch's rules read off the parent Application. */
export interface DnsChallengeParent {
  serverId: string | null;
  previewWildcard: string | null;
  previewDnsChallenge: boolean;
}

/**
 * The wildcard a preview's `websecure` router asks the DNS-01 resolver for:
 * the parent's `previewWildcard` while its switch is on, and `null` — `tls:
 * {}` — otherwise. The admission below keeps "on" and "no wildcard" apart, so
 * a `null` wildcard with the switch on is a row nothing could have written,
 * and it reads as off.
 */
export const dnsChallengeWildcardOf = (
  parent: Pick<DnsChallengeParent, 'previewWildcard' | 'previewDnsChallenge'>,
): string | null =>
  parent.previewDnsChallenge ? parent.previewWildcard : null;

/**
 * Refuses an Application update that would leave the switch on without what
 * it needs. `current` is the stored row, `data` the update body.
 *
 * - **No preview wildcard**, whichever half of the body causes it — turning
 *   the switch on with none stored, or clearing the wildcard while the switch
 *   stays on. Clearing it is **refused rather than turning the switch off**:
 *   a save that silently changes a second setting is one the operator did not
 *   ask for, and the console sends both fields together, so the same save can
 *   turn the switch off.
 * - **No DNS-01 setup on the machine** its previews run on (the Application's
 *   run Server, `null` the platform host), checked only when the body turns
 *   the switch on. A save of any other field is not refused over it: the
 *   setup's own delete refuses while the switch is on, so the only way to lose
 *   it is losing the Server, and the Application goes with it.
 */
export async function admitPreviewDnsChallenge(
  db: DrizzleDB,
  current: DnsChallengeParent,
  data: { previewWildcard?: string | null; previewDnsChallenge?: boolean },
): Promise<void> {
  const on = data.previewDnsChallenge ?? current.previewDnsChallenge;
  if (!on) return;
  const wildcard =
    data.previewWildcard === undefined
      ? current.previewWildcard
      : data.previewWildcard;
  if (wildcard === null) {
    throw new ConflictException({
      message: PREVIEW_DNS_CHALLENGE_NEEDS_WILDCARD,
      code: PREVIEW_DNS_CHALLENGE_REFUSAL_CODE.noWildcard,
    });
  }
  if (data.previewDnsChallenge !== true) return;
  if ((await dnsChallengeOn(db, current.serverId)) === null) {
    throw new ConflictException({
      message: PREVIEW_DNS_CHALLENGE_NO_SETUP,
      code: PREVIEW_DNS_CHALLENGE_REFUSAL_CODE.noSetup,
    });
  }
}

const logger = new Logger('PreviewDnsChallenge');

/**
 * Rewrites the router of every live preview of `parent` with the `tls` its
 * switch now asks for, so turning DNS-01 on or off reaches previews already
 * running rather than only the next one built.
 *
 * **Live** is `done` and not expired: a preview being built is routed at the
 * end of its build from the parent row it reads then, one that failed may
 * never have been routed (writing a router for it would put a host on a
 * service that does not exist), and an expired one is waiting for its
 * teardown to remove its file.
 *
 * Best effort, preview by preview: the switch is already written, and a
 * machine that cannot be reached leaves that preview's router as it was until
 * its next build — which rewrites it anyway. A failure is logged, not thrown.
 */
export async function reroutePreviews(
  db: DrizzleDB,
  traefik: Pick<TraefikAppConfigService, 'routePreview'>,
  parent: DnsChallengeParent & { applicationId: string; previewPort: number },
): Promise<void> {
  const live = await db
    .select({
      appName: previewDeployment.appName,
      domain: previewDeployment.domain,
    })
    .from(previewDeployment)
    .where(
      and(
        eq(previewDeployment.applicationId, parent.applicationId),
        eq(previewDeployment.previewStatus, 'done'),
        isNull(previewDeployment.expiredAt),
      ),
    );
  for (const preview of live) {
    try {
      await traefik.routePreview({
        appName: preview.appName,
        host: preview.domain,
        port: parent.previewPort,
        parent: {
          applicationId: parent.applicationId,
          serverId: parent.serverId,
        },
        dnsChallengeWildcard: dnsChallengeWildcardOf(parent),
      });
    } catch (error) {
      logger.warn(
        `Preview ${preview.appName} keeps its previous router until its next build: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
