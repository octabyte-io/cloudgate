import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';

import { FrozenOrganizations } from '../../../cloud/billing/frozen-organizations.service';
import { DeploymentsService } from '../../../deployments/deployments.service';
import type { Deployment } from '../../../db/schema';
import { CONFIG_PUSH_PLANNER } from '../../config-push-planner.port';
import type { ConfigPushPlanner } from '../../config-push-planner.port';
import type { GithubPushEvent } from './github-webhook.util';

/**
 * What a verified GitHub `push` delivery does: first the
 * Project config plans of every Environment whose Config branch the push
 * moved, so a build whose own config entry the same push changed is held
 * for its plan; then the push deploys (`DeploymentsService.deployOnGithubPush`
 * decides which Applications).
 *
 * A push to a Frozen Organization's connection does neither
 * (ADR-0052): nothing is planned, read or deployed, and the delivery is
 * answered as accepted with no Deployments, as a push that builds nothing is.
 */
@Injectable()
export class GithubPushService {
  private readonly logger = new Logger(GithubPushService.name);

  constructor(
    private readonly deployments: DeploymentsService,
    private readonly moduleRef: ModuleRef,
    private readonly frozen: FrozenOrganizations,
  ) {}

  async handlePush(
    connection: { readonly githubId: string; readonly gitProviderId: string },
    push: GithubPushEvent,
  ): Promise<Deployment[]> {
    if (
      await this.frozen.isFrozenAt({ gitProviderId: connection.gitProviderId })
    ) {
      this.logger.log(
        `Push to ${push.owner}/${push.repository} not deployed: its Organization is frozen`,
      );
      return [];
    }
    const holdFor = await this.configPlans().planPush({
      gitProviderId: connection.gitProviderId,
      repository: `${push.owner}/${push.repository}`,
      branch: push.deleted || push.branch === '' ? null : push.branch,
      changedFiles: push.changedFiles,
    });
    return this.deployments.deployOnGithubPush(
      connection.githubId,
      push,
      holdFor,
    );
  }

  /**
   * The config plans' port, resolved at call time: `ProjectConfigModule`
   * imports this module (its config readers), so it cannot be injected.
   */
  private configPlans(): ConfigPushPlanner {
    return this.moduleRef.get<ConfigPushPlanner>(CONFIG_PUSH_PLANNER, {
      strict: false,
    });
  }
}
