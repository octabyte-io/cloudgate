import { ConflictException } from '@nestjs/common';
import { isCloudService } from '../common/cloud-service-host-work';
import type { PlacedService } from '../common/cloud-service-host-work';

/**
 * **An Application in a Cloud account has no Preview deployments**, from a
 * pull request or requested.
 *
 * A Preview deployment is a copy of its parent run beside it under its own
 * `appName` and host, sharing its parent's storage (CONTEXT.md "Preview
 * deployment", ADR-0021): a Swarm service on the parent's run Server, a
 * router in that Server's Traefik, and the parent's volumes. A Service in a
 * Cloud account has none of the three. Its `serverId` is `null`, which every
 * exec dispatcher reads as the platform host, so a preview of one cloned and
 * built a pull request's code there, routed nothing (`routePreview` refuses
 * it), and tore down a Swarm service on the machine Cloudgate itself runs on
 * (ADR-0053). ADR-0047's cloud build service builds a cloud Service's own
 * image for its own Cloud run; nothing runs a second copy of it in the cloud,
 * so there is no cloud path to keep and only the platform-host one to refuse.
 *
 * So a preview of one is refused wherever one could start (a Requested
 * preview's create, a pull request's webhook, a rebuild, switching either kind
 * on), and every step that would act on one for such a parent does nothing on
 * any machine: its build fails before the clone, and its teardown has no step.
 */

/** A client branches on this, never on the message (ADR-0005). */
export const CLOUD_APPLICATION_HAS_NO_PREVIEWS_CODE =
  'CLOUD_APPLICATION_HAS_NO_PREVIEWS';

/** Why, and the way out, after whatever names the Application. */
const WHY =
  "a preview runs beside its parent on the parent's own Server and shares its storage, and a Service in a Cloud account has no Server, so its preview would run on this Cloudgate's own host. To try a branch in that Cloud account, deploy it from an Environment of its own.";

/** The refusal as told where the Application is already known: a pull request, an Agent. */
export const CLOUD_PREVIEWS_REFUSAL = `This Application runs in a Cloud account, so it has no Preview deployments, from a pull request or requested: ${WHY}`;

/** The refusal naming the Application. */
export const cloudPreviewRefusal = (name: string): string =>
  `${name} runs in a Cloud account, so it has no Preview deployments, from a pull request or requested: ${WHY}`;

/**
 * Refuses a preview of an Application in a Cloud account with a 409; does
 * nothing for one on a Server or the platform host.
 */
export function refuseCloudPreview(parent: PlacedService): void {
  if (!isCloudService(parent)) return;
  throw new ConflictException({
    message: cloudPreviewRefusal(parent.name),
    code: CLOUD_APPLICATION_HAS_NO_PREVIEWS_CODE,
  });
}

/**
 * Refuses an Application settings edit that switches previews on for an
 * Application in a Cloud account: either switch, the pull-request one or the
 * requested one. A switch that is already on may be sent on again, so a form
 * that saves every field still saves the rest; switching one off is always
 * allowed.
 */
export function refuseCloudPreviewSwitches(
  current: PlacedService & {
    readonly isPreviewDeploymentsActive: boolean | null;
    readonly requestedPreviewsAllowed: boolean;
  },
  data: {
    readonly isPreviewDeploymentsActive?: boolean | null;
    readonly requestedPreviewsAllowed?: boolean | null;
  },
): void {
  const turnsOn =
    (data.isPreviewDeploymentsActive === true &&
      current.isPreviewDeploymentsActive !== true) ||
    (data.requestedPreviewsAllowed === true &&
      !current.requestedPreviewsAllowed);
  if (turnsOn) refuseCloudPreview(current);
}
