import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UnauthorizedException,
} from '@nestjs/common';
import type { AuthSession } from '../../../auth/auth.config';
import type { ValidatedRequest } from '../../../auth/auth.service';
import {
  CurrentSession,
  CurrentUser,
} from '../../../auth/decorators/current-user.decorator';
import { Public } from '../../../auth/decorators/public.decorator';
import { RequirePermission } from '../../../rbac/decorators/require-permission.decorator';
import type { PermissionCtx } from '../../../rbac/permission.service';
import { ModuleRef } from '@nestjs/core';
import { PreviewDeploymentsService } from '../../../preview-deployments/preview-deployments.service';
import {
  parseGithubPullRequestEvent,
  parseGithubPushEvent,
  verifyGithubWebhookSignature,
} from './github-webhook.util';
import type {
  GithubPullRequestPayload,
  GithubPushPayload,
} from './github-webhook.util';
import {
  CreateGithubDto,
  FindGithubBranchesDto,
  UpdateGithubDto,
} from './dto/github.dto';
import { GithubPushService } from './github-push.service';
import { GithubService } from './github.service';

type Session = NonNullable<ValidatedRequest['session']>;

/** The caller's permission ctx in the session's active organization. */
function toCtx(user: AuthSession['user'], session: Session): PermissionCtx {
  if (!session.activeOrganizationId) {
    throw new ForbiddenException('No active organization');
  }
  return {
    user: { id: user.id },
    session: { activeOrganizationId: session.activeOrganizationId },
  };
}

// Permission mapping: read on queries, create on create/update (deletion
// happens via the base git-provider row).
@Controller('github')
export class GithubController {
  constructor(
    private readonly githubService: GithubService,
    private readonly pushes: GithubPushService,
    private readonly moduleRef: ModuleRef,
  ) {}

  /** Resolved lazily: PreviewDeploymentsModule imports GitProvidersModule
   * (the previews service posts PR comments), so a constructor injection
   * here would close a module cycle. */
  private get previewDeployments(): PreviewDeploymentsService {
    return this.moduleRef.get(PreviewDeploymentsService, { strict: false });
  }

  /**
   * The GitHub webhook route. Unauthenticated — trust comes from the
   * x-hub-signature-256 HMAC over the raw body, keyed with the connection's
   * webhook secret. A push prepares the Project config plans it moved and
   * deploys what it pushed (`GithubPushService.handlePush`);
   * pull_request events drive preview deployments (Phase 25).
   */
  @Public()
  @Post('webhook')
  @HttpCode(200)
  async webhook(
    @Headers('x-github-event') event: string | undefined,
    @Headers('x-hub-signature-256') signature: string | undefined,
    @Body() body: GithubPushPayload & GithubPullRequestPayload,
  ) {
    if (!signature) {
      throw new UnauthorizedException('Missing signature header');
    }
    const installationId = body?.installation?.id;
    if (!installationId) {
      throw new BadRequestException('GitHub installation not found');
    }
    const connection = await this.githubService.findByInstallationId(
      String(installationId),
    );
    if (!connection) {
      throw new BadRequestException('GitHub installation not found');
    }
    if (!connection.webhookSecret) {
      throw new BadRequestException('GitHub webhook secret not set');
    }
    const verified = verifyGithubWebhookSignature(
      connection.webhookSecret,
      JSON.stringify(body),
      signature,
    );
    if (!verified) {
      throw new UnauthorizedException('Unauthorized');
    }
    if (event === 'ping') {
      return { message: 'Ping received, webhook is active' };
    }
    if (event === 'pull_request') {
      await this.previewDeployments.handlePullRequestEvent(
        connection.githubId,
        parseGithubPullRequestEvent(body),
      );
      return { message: 'Pull request event processed' };
    }
    if (event !== 'push') {
      throw new BadRequestException(
        'We only accept push events or pull_request events',
      );
    }
    const deployments = await this.pushes.handlePush(
      connection,
      parseGithubPushEvent(body),
    );
    return {
      message: 'Push event processed',
      deploymentsQueued: deployments.length,
    };
  }

  @Post()
  @RequirePermission('gitProviders', 'create')
  create(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: CreateGithubDto,
  ) {
    return this.githubService.create(toCtx(user, session), body);
  }

  @Get()
  @RequirePermission('gitProviders', 'read')
  list(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
  ) {
    return this.githubService.list(toCtx(user, session));
  }

  // The repositories the connection can reach.
  @Get(':id/repositories')
  @RequirePermission('gitProviders', 'read')
  listRepositories(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
  ) {
    return this.githubService.listRepositoriesFor(toCtx(user, session), id);
  }

  // The branches of one of those repositories.
  @Get(':id/branches')
  @RequirePermission('gitProviders', 'read')
  listBranches(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
    @Query() query: FindGithubBranchesDto,
  ) {
    return this.githubService.listBranchesFor(toCtx(user, session), id, query);
  }

  @Get(':id')
  @RequirePermission('gitProviders', 'read')
  findOne(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
  ) {
    return this.githubService.findOne(toCtx(user, session), id);
  }

  @Patch(':id')
  @RequirePermission('gitProviders', 'create')
  update(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
    @Body() body: UpdateGithubDto,
  ) {
    return this.githubService.update(toCtx(user, session), id, body);
  }
}
