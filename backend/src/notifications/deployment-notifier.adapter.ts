import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, isNotNull } from 'drizzle-orm';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import { domain } from '../db/schema';
import type {
  DeploymentNotification,
  DeploymentNotifier,
} from '../deployment-engine/ports/deployment-notifier';
import { InstanceUrlService } from '../settings/instance-url.service';
import { NotificationDispatcherService } from './dispatcher.service';
import type { DeployedDomain } from './events/notification-event';

/**
 * The console segment each deployable Service's scope lives under, and the
 * whole of what a notification link has to get right besides the origin.
 *
 * **These are route segments the console serves, not a shape assembled from
 * the ids to hand.** `buildLink` used to render
 * `/dashboard/project/:p/environment/:e/services/:type/:id?tab=deployments`,
 * which no route in `frontend/src/app/(console)/` has ever matched — so
 * correcting the port alone still landed the operator on the console's
 * not-found page. The console's routes are flat on purpose and
 * `components/shell/scope.ts`'s `RESOURCE_SEGMENT` says why: every id is
 * globally unique, the API takes one id and no parent, and a URL carrying a
 * parent id is a URL that can disagree with the row it renders. So the
 * Deployment link names the Service and the tab, and the `projectId` and
 * `environmentId` the port still carries go into no link.
 *
 * A type not named here gets **no link at all** rather than a guessed one.
 * That is the defect this map exists for: a link that resolves to nothing
 * costs an operator a sign-in and a 404 to learn what a missing link says
 * immediately.
 */
const CONSOLE_SEGMENT: Partial<Record<string, string>> = {
  application: 'applications',
  compose: 'compose',
};

/**
 * The tab slug of the Deployments panel, in both scopes that have one —
 * `lib/shell/tabs/application.ts` and `lib/shell/tabs/compose.ts`. A slug the
 * scope does not declare 404s at the route, which is what
 * `test/notifications/deployment-link.spec.ts` reads those tables to hold.
 */
const DEPLOYMENTS_TAB = 'deployments';

/**
 * The Phase 21 DeploymentNotifier port implemented over the dispatcher:
 * build outcomes become app-deploy / app-build-error events for the
 * application's organization. buildLink is the Service's Deployments tab in
 * the console, omitted while the instance URL is unconfigured rather than
 * rendered as a "http://null:3000" link.
 */
@Injectable()
export class DeploymentNotifierAdapter implements DeploymentNotifier {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly dispatcher: NotificationDispatcherService,
    private readonly instanceUrl: InstanceUrlService,
  ) {}

  private async buildLink(
    notification: DeploymentNotification,
  ): Promise<string | undefined> {
    const segment = CONSOLE_SEGMENT[notification.applicationType];
    if (!segment) return undefined;
    const url = await this.instanceUrl.getInstanceUrl();
    if (!url) return undefined;
    return `${url}/${segment}/${notification.serviceId}/${DEPLOYMENTS_TAB}`;
  }

  /**
   * The hosts the deployed Service answers on, for the one fact in a deploy
   * notification an operator acts on — *it is up, here is where*.
   *
   * **Read here rather than passed down the port.** The field was
   * declared on `AppDeployEvent` and read by two channels — the custom
   * webhook's `domains` string and telegram's domain buttons — and no producer
   * ever set it, so both were structurally empty on every install rather than
   * empty in some case. The port could have carried it instead and the engine
   * does inject `DomainsService` — but it holds domains only for a Compose
   * stack, whose deploy loads them to inject as labels; an Application's would
   * have to be fetched, and that read would then sit in the deploy path rather
   * than in the notification's. This is the seam `InstanceUrlService` already
   * occupies: a notification enriching itself from the instance's own rows, on
   * the far side of the port, where nothing a deploy does depends on it.
   *
   * **`DomainsService` is deliberately not called.** `findComposeDomains` is
   * compose-only and, by design, *throws* on a row that predates the routing
   * validations — survivable where it is called (before a deploy's `rm -rf`),
   * fatal here, where the throw would travel back up `buildSuccess` into the
   * engine's try and record a Deployment that succeeded as an error. The
   * `serviceName` filter below is that method's other half kept: a compose
   * domain with no service name is never injected as a label, so it answers on
   * nothing and promising it would be a link to a 404.
   */
  private async deployedDomains(
    notification: DeploymentNotification,
  ): Promise<readonly DeployedDomain[]> {
    const owned =
      notification.applicationType === 'application'
        ? eq(domain.applicationId, notification.serviceId)
        : notification.applicationType === 'compose'
          ? and(
              eq(domain.composeId, notification.serviceId),
              isNotNull(domain.serviceName),
            )
          : undefined;
    if (!owned) return [];

    return this.db
      .select({ host: domain.host, https: domain.https })
      .from(domain)
      .where(owned)
      .orderBy(asc(domain.host));
  }

  async buildSuccess(notification: DeploymentNotification): Promise<void> {
    await this.dispatcher.dispatch(notification.organizationId, {
      type: 'app-deploy',
      projectName: notification.projectName,
      applicationName: notification.applicationName,
      applicationType: notification.applicationType,
      environmentName: notification.environmentName,
      buildLink: await this.buildLink(notification),
      domains: await this.deployedDomains(notification),
    });
  }

  async buildError(
    notification: DeploymentNotification & { errorMessage: string },
  ): Promise<void> {
    await this.dispatcher.dispatch(notification.organizationId, {
      type: 'app-build-error',
      projectName: notification.projectName,
      applicationName: notification.applicationName,
      applicationType: notification.applicationType,
      errorMessage: notification.errorMessage,
      buildLink: await this.buildLink(notification),
    });
  }
}
