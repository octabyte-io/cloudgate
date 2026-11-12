import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, eq } from 'drizzle-orm';

import { destroyDefinition } from '../../cloud-accounts/aws/definitions/destroy-definition';
import type { CloudKind } from '../../cloud-accounts/cloud-account.schema';
import type {
  AwsCloudAccount,
  GcpCloudAccount,
} from '../../cloud-accounts/cloud-provider';
import { CloudAccountsService } from '../../cloud-accounts/cloud-accounts.service';
import {
  cloudOrLegacy,
  credentialOf,
} from '../../cloud-accounts/cloud-provider';
import { AWS_CLOUD_PORT } from '../../cloud-accounts/cloud.port';
import type {
  AwsCloudPort,
  GoogleStateResource,
  StateResource,
} from '../../cloud-accounts/cloud.port';
import { destroyDefinition as googleDestroyDefinition } from '../../cloud-accounts/gcp/definitions/destroy-definition';
import type { InfrastructureState } from '../../cloud-accounts/infrastructure-state/infrastructure-state.schema';
import { InfrastructureStatesService } from '../../cloud-accounts/infrastructure-state/infrastructure-states.service';
import { onCloud } from '../../cloud-accounts/cloud-provider';
import { PROVIDER_CLOUDS } from '../../cloud-accounts/infrastructure-state/state-versions';
import { DRIZZLE } from '../../db/drizzle.module';
import type { DrizzleDB } from '../../db/drizzle.module';
import {
  application,
  environment,
  environmentNetwork,
  project,
} from '../../db/schema';
import { PermissionService } from '../../rbac/permission.service';
import type { PermissionCtx } from '../../rbac/permission.service';
import { describeError } from '../../common/describe-error';
import type { PlanView } from '../project-config.views';
import { ProjectConfigService } from '../project-config.service';

/**
 * What Cloudgate made for a cloud Service or an Environment network (ADR-0036
 * item 3; on Google): read from its Infrastructure state,
 * never the state itself.
 */
export interface CloudResourceList {
  /** The cloud of the owner's Cloud account: which projection {@link resources} holds. */
  readonly cloud: CloudKind;
  /** The state the list is of; `null` before its owner's first apply. */
  readonly stateId: string | null;
  /**
   * False when Cloudgate cannot read the state (corrupt, or
   * `APP_ENCRYPTION_SECRET` changed): every run on it fails, and Rebuild
   * from the cloud is offered.
   */
  readonly readable: boolean;
  /** Why the state could not be listed, naming it; `null` when it was. */
  readonly failure: string | null;
  /**
   * On AWS, each resource's type, AWS id, region and tags, and whether a
   * tag search finds it; with the network cards AWS made on the state's
   * security groups (`aws_network_interface`, never findable by tag). On
   * Google, each one's type, Google name, region and labels, and whether
   * it carries Cloudgate's: networks and subnets take none.
   */
  readonly resources: StateResource[] | GoogleStateResource[];
  /** Why the network cards AWS made could not be looked up, when they could not; always `null` on Google. */
  readonly networkCardsUnread: string | null;
}

/** Where a state is: its owner's place, and what reaches it. */
interface StatePlace {
  readonly state: InfrastructureState | null;
  readonly cloudAccountId: string;
  readonly environmentId: string;
  readonly region: string;
}

/**
 * **The resource list, and Rebuild from the cloud** (the AWS spec,
 * "Infrastructure state"). An operator finds everything Cloudgate made
 * without anyone reading a raw state: a cloud Service's list needs
 * `service: read`, a network's `environment: read`, and either answers the
 * projection of its own cloud — `aws/state-resources.ts` or
 * `gcp/state-resources.ts` — and nothing else. No route, view or MCP tool
 * hands out a state.
 *
 * **A list is not a Cloud run.** `tofu show` of a state takes no lock and
 * writes nothing, so it does not wait in the Cloud run pool behind a deploy;
 * during an apply it shows the state as last saved.
 *
 * **Rebuild from the cloud** (`service: update`, or `environment: update`
 * for a network; confirmed by name) is only for a state Cloudgate cannot
 * read. It discards the state under the same id and asks for a plan, whose
 * read of the owner — now against an empty state — adopts by tag
 * what every resource's `cloudgate:state` tag still ties to that id; on
 * Google, by the fixed name each resource of the state was given and the
 * mark in its description, and the Apply imports it.
 */
@Injectable()
export class CloudResources {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    @Inject(AWS_CLOUD_PORT) private readonly cloud: AwsCloudPort,
    private readonly permissions: PermissionService,
    private readonly cloudAccounts: CloudAccountsService,
    private readonly states: InfrastructureStatesService,
    private readonly projectConfig: ProjectConfigService,
  ) {}

  async ofService(
    ctx: PermissionCtx,
    applicationId: string,
  ): Promise<CloudResourceList> {
    await this.permissions.checkServiceAccess(ctx, applicationId, 'read');
    const found = await this.cloudService(ctx, applicationId);
    return this.list({
      state: await this.states.findForApplication(applicationId),
      ...found,
    });
  }

  async ofNetwork(
    ctx: PermissionCtx,
    environmentId: string,
    environmentNetworkId: string,
  ): Promise<CloudResourceList> {
    await this.permissions.checkEnvironmentAccess(ctx, environmentId, 'read');
    const found = await this.network(ctx, environmentId, environmentNetworkId);
    return this.list({
      state: await this.states.findForNetwork(environmentNetworkId),
      ...found,
    });
  }

  /** Rebuild a cloud Service's state from the cloud, confirmed by its name. */
  async rebuildService(
    ctx: PermissionCtx,
    applicationId: string,
    confirmName: string,
  ): Promise<PlanView> {
    await this.permissions.checkServiceAccess(ctx, applicationId, 'update');
    const found = await this.cloudService(ctx, applicationId);
    confirm(confirmName, found.name, "the Service's name");
    // The plan that follows is the Environment's: one the caller cannot ask
    // for refuses before anything is discarded.
    await this.permissions.checkEnvironmentAccess(
      ctx,
      found.environmentId,
      'read',
    );
    const state = await this.states.findForApplication(applicationId);
    if (!state) {
      throw new BadRequestException(
        `${found.name} has no Infrastructure state to rebuild`,
      );
    }
    await this.states.discard(state.infrastructureStateId);
    return this.projectConfig.requestPlan(ctx, found.environmentId);
  }

  /** Rebuild an Environment network's state, confirmed by its Environment's name. */
  async rebuildNetwork(
    ctx: PermissionCtx,
    environmentId: string,
    environmentNetworkId: string,
    confirmName: string,
  ): Promise<PlanView> {
    await this.permissions.checkEnvironmentAccess(ctx, environmentId, 'update');
    const found = await this.network(ctx, environmentId, environmentNetworkId);
    confirm(confirmName, found.environmentName, "the Environment's name");
    const state = await this.states.findForNetwork(environmentNetworkId);
    if (!state) {
      throw new BadRequestException(
        `The Environment network (${found.region}) has no Infrastructure state to rebuild`,
      );
    }
    await this.states.discard(state.infrastructureStateId);
    return this.projectConfig.requestPlan(ctx, environmentId);
  }

  private async list(place: StatePlace): Promise<CloudResourceList> {
    const { state } = place;
    const cloudAccountRow = await this.cloudAccounts.findForUse(
      place.cloudAccountId,
    );
    const empty = {
      cloud:
        cloudAccountRow?.cloud ??
        cloudOrLegacy(state ? PROVIDER_CLOUDS[state.provider] : null),
      stateId: state?.infrastructureStateId ?? null,
      readable: state?.readable ?? true,
      resources: [],
      networkCardsUnread: null,
    } satisfies Omit<CloudResourceList, 'failure'>;
    if (!state) return { ...empty, failure: null };
    if (!cloudAccountRow) {
      return {
        ...empty,
        failure: `The Cloud account Infrastructure state ${state.infrastructureStateId} is in is gone`,
      };
    }
    // Each cloud's own list (ADR-0043).
    return onCloud(cloudAccountRow, {
      aws: (account) => this.listOnAws(account, place, state, empty),
      gcp: (account) => this.listOnGoogle(account, place, state, empty),
    });
  }

  /**
   * An AWS state's list: read with the Cloud account's key, as a destroy-only
   * run is, with the network cards AWS made on its security groups added.
   */
  private async listOnAws(
    account: AwsCloudAccount,
    place: StatePlace,
    state: InfrastructureState,
    empty: Omit<CloudResourceList, 'failure'>,
  ): Promise<CloudResourceList> {
    const credential = credentialOf(account);
    const outcome = await this.states.resources({
      stateId: state.infrastructureStateId,
      credential,
      definition: destroyDefinition(accessOf(account), place.region, {
        cloudAccountId: account.cloudAccountId,
        environmentId: place.environmentId,
        stateId: state.infrastructureStateId,
      }),
      region: place.region,
    });
    if (!outcome.ok) {
      return {
        ...empty,
        readable: outcome.reason !== 'unreadable-state',
        failure: outcome.message,
      };
    }
    const cards = await this.networkCards(
      account,
      place.region,
      outcome.resources,
    );
    return {
      ...empty,
      readable: true,
      failure: null,
      resources: [...outcome.resources, ...cards.resources],
      networkCardsUnread: cards.unread,
    };
  }

  /**
   * A Google state's list: read with a run's own credential, as a
   * Delete's destroy-only run is (`gcp/definitions/destroy-definition.ts`).
   * Google makes nothing beside a state's resources that only a lookup
   * finds, so there are no network cards to add.
   */
  private async listOnGoogle(
    account: GcpCloudAccount,
    place: StatePlace,
    state: InfrastructureState,
    empty: Omit<CloudResourceList, 'failure'>,
  ): Promise<CloudResourceList> {
    const session = await this.cloudAccounts.googleRunSession(account);
    if (!session.ok) return { ...empty, failure: session.refusal };
    const outcome = await this.states.resources({
      stateId: state.infrastructureStateId,
      credential: session.credential,
      definition: googleDestroyDefinition(account.cloudId, place.region),
      region: place.region,
    });
    if (!outcome.ok) {
      return {
        ...empty,
        readable: outcome.reason !== 'unreadable-state',
        failure: outcome.message,
      };
    }
    return {
      ...empty,
      readable: true,
      failure: null,
      resources: outcome.resources,
    };
  }

  /**
   * The network cards AWS made for tasks and the load balancer on the
   * state's security groups: no tag of Cloudgate's is on them, so only this
   * lookup finds them.
   */
  private async networkCards(
    account: AwsCloudAccount,
    region: string,
    resources: readonly StateResource[],
  ): Promise<{ resources: StateResource[]; unread: string | null }> {
    const groups = resources
      .filter((one) => one.type === 'aws_security_group' && one.awsId)
      .map((one) => one.awsId);
    if (groups.length === 0) return { resources: [], unread: null };
    const session = await this.cloudAccounts.deployRoleSession(account);
    if (!session.ok) return { resources: [], unread: session.refusal };
    try {
      const answer = await this.cloud.networkInterfacesOf(session.session, {
        region,
        securityGroupIds: groups,
      });
      if (!answer.ok) {
        return {
          resources: [],
          unread: `AWS refused the lookup of the network cards it made: ${answer.code}: ${answer.message}`,
        };
      }
      return {
        resources: answer.value.map((card) => ({
          type: 'aws_network_interface',
          awsId: card.networkInterfaceId,
          region,
          tags: {},
          findableByTag: false,
        })),
        unread: null,
      };
    } catch (error) {
      return {
        resources: [],
        unread: `AWS could not be reached for the network cards it made: ${describeError(error)}`,
      };
    }
  }

  /** A cloud Service in the caller's Organization, and where it runs. */
  private async cloudService(ctx: PermissionCtx, applicationId: string) {
    const [found] = await this.db
      .select({
        name: application.name,
        environmentId: application.environmentId,
        cloudAccountId: application.cloudAccountId,
        region: application.region,
      })
      .from(application)
      .innerJoin(
        environment,
        eq(environment.environmentId, application.environmentId),
      )
      .innerJoin(project, eq(project.projectId, environment.projectId))
      .where(
        and(
          eq(application.applicationId, applicationId),
          eq(project.organizationId, ctx.session.activeOrganizationId),
        ),
      );
    if (!found) throw new NotFoundException('Application not found');
    if (!found.cloudAccountId || !found.region) {
      throw new BadRequestException(
        `${found.name} runs on a Server; Cloudgate made nothing for it in a Cloud account`,
      );
    }
    return {
      name: found.name,
      environmentId: found.environmentId,
      cloudAccountId: found.cloudAccountId,
      region: found.region,
    };
  }

  /** An Environment network of an Environment in the caller's Organization. */
  private async network(
    ctx: PermissionCtx,
    environmentId: string,
    environmentNetworkId: string,
  ) {
    const [found] = await this.db
      .select({
        environmentName: environment.name,
        cloudAccountId: environmentNetwork.cloudAccountId,
        region: environmentNetwork.region,
      })
      .from(environmentNetwork)
      .innerJoin(
        environment,
        eq(environment.environmentId, environmentNetwork.environmentId),
      )
      .innerJoin(project, eq(project.projectId, environment.projectId))
      .where(
        and(
          eq(environmentNetwork.environmentNetworkId, environmentNetworkId),
          eq(environmentNetwork.environmentId, environmentId),
          eq(project.organizationId, ctx.session.activeOrganizationId),
        ),
      );
    if (!found) throw new NotFoundException('Environment network not found');
    return { ...found, environmentId };
  }
}

function confirm(given: string, name: string, what: string): void {
  if (given.trim() !== name) {
    throw new BadRequestException(
      `Rebuild from the cloud is confirmed by ${what}, ${name}; that does not match`,
    );
  }
}

function accessOf(account: AwsCloudAccount) {
  return {
    awsAccountId: account.cloudId,
    deployRoleArn: account.deployRoleArn,
    externalId: account.externalId,
  };
}
