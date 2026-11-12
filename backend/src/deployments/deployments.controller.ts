import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { ApiOkResponse, ApiProduces } from '@nestjs/swagger';
import type { Response } from 'express';
import type { AuthSession } from '../auth/auth.config';
import type { ValidatedRequest } from '../auth/auth.service';
import {
  CurrentSession,
  CurrentUser,
} from '../auth/decorators/current-user.decorator';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import type { PermissionCtx } from '../rbac/permission.service';
import { DeploymentsService } from './deployments.service';
import {
  DeploymentStatusDto,
  ListDeploymentsDto,
  ReadDeploymentLogsDto,
  TriggerDeploymentDto,
} from './dto/deployment.dto';

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

@Controller()
export class DeploymentsController {
  constructor(private readonly deploymentsService: DeploymentsService) {}

  /** The organization's deployment feed — the read that exists
   * for no single owner, because no route enumerates an Environment's
   * services for a client to fan out over. */
  @Get('deployments')
  @RequirePermission('deployment', 'read')
  list(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Query() query: ListDeploymentsDto,
  ) {
    return this.deploymentsService.listByOrganization(
      toCtx(user, session),
      query,
    );
  }

  /**
   * Triggers a deployment of an application — deployments are triggered per
   * service.
   *
   * **Three of this controller's four `@Post`s keep `201` and carry no
   * `@HttpCode`**: `deployments`, `redeploy` and the compose sibling all
   * insert a Deployment row and answer with it, so `201 Created` is the truth
   * even where the path reads as a verb. `cancel` is the exception and is `200`:
   * it updates the Deployment named in its own path.
   */
  @Post('applications/:applicationId/deployments')
  @RequirePermission('deployment', 'create')
  deploy(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('applicationId') applicationId: string,
    @Body() body: TriggerDeploymentDto,
  ) {
    return this.deploymentsService.deploy(
      toCtx(user, session),
      applicationId,
      body,
    );
  }

  /**
   * Builds again from the source the Application already has. It
   * lives here rather than on the applications controller for the same reason
   * `deployments` does — it writes a deployment record and enqueues a job, and
   * both of those belong to one service.
   */
  @Post('applications/:applicationId/redeploy')
  @RequirePermission('deployment', 'create')
  redeploy(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('applicationId') applicationId: string,
    @Body() body: TriggerDeploymentDto,
  ) {
    return this.deploymentsService.redeploy(
      toCtx(user, session),
      applicationId,
      body,
    );
  }

  /**
   * Cancels a deployment. Gated on `deployment:cancel`,
   * which is the statement the access-control table has always had for this
   * and which nothing used until now. See `DeploymentsService.cancel` for what
   * cancellation can and cannot reach.
   */
  @Post('deployments/:deploymentId/cancel')
  @HttpCode(200)
  @RequirePermission('deployment', 'cancel')
  cancel(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('deploymentId') deploymentId: string,
  ) {
    return this.deploymentsService.cancel(toCtx(user, session), deploymentId);
  }

  /**
   * **Stop the run**: ends a running Cloud run, its apply included.
   * Gated like `cancel` — `deployment: cancel`, Agents included
   * (US111) — and `200` like it. See `DeploymentsService.stopRun`.
   */
  @Post('deployments/:deploymentId/stop-run')
  @HttpCode(200)
  @RequirePermission('deployment', 'cancel')
  stopRun(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('deploymentId') deploymentId: string,
  ) {
    return this.deploymentsService.stopRun(toCtx(user, session), deploymentId);
  }

  /**
   * "Build now with saved settings": releases a build a push held for
   * a plan into the queue at once. `200`, like `cancel`: it updates the
   * Deployment named in its path and inserts nothing.
   */
  @Post('deployments/:deploymentId/build-now')
  @HttpCode(200)
  @RequirePermission('deployment', 'create')
  buildNow(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('deploymentId') deploymentId: string,
  ) {
    return this.deploymentsService.buildNow(toCtx(user, session), deploymentId);
  }

  /** The compose sibling of the route above. */
  @Post('compose/:composeId/deployments')
  @RequirePermission('deployment', 'create')
  deployCompose(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('composeId') composeId: string,
    @Body() body: TriggerDeploymentDto,
  ) {
    return this.deploymentsService.deployCompose(
      toCtx(user, session),
      composeId,
      body,
    );
  }

  /** A compose stack's deployments. */
  @Get('compose/:composeId/deployments')
  @RequirePermission('deployment', 'read')
  findAllByCompose(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('composeId') composeId: string,
  ) {
    return this.deploymentsService.findAllByComposeId(
      toCtx(user, session),
      composeId,
    );
  }

  /** An application's deployments. */
  @Get('applications/:applicationId/deployments')
  @RequirePermission('deployment', 'read')
  findAllByApplication(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('applicationId') applicationId: string,
  ) {
    return this.deploymentsService.findAllByApplicationId(
      toCtx(user, session),
      applicationId,
    );
  }

  /** A schedule's run history — the cron sibling of the two lists above. */
  @Get('schedules/:scheduleId/deployments')
  @RequirePermission('deployment', 'read')
  findAllBySchedule(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('scheduleId') scheduleId: string,
  ) {
    return this.deploymentsService.findAllByScheduleId(
      toCtx(user, session),
      scheduleId,
    );
  }

  /** A volume backup's run history. */
  @Get('volume-backups/:volumeBackupId/deployments')
  @RequirePermission('deployment', 'read')
  findAllByVolumeBackup(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('volumeBackupId') volumeBackupId: string,
  ) {
    return this.deploymentsService.findAllByVolumeBackupId(
      toCtx(user, session),
      volumeBackupId,
    );
  }

  /**
   * One Deployment's status and times: `pending`, `running`, `done`,
   * `error` (failed), `cancelled` or `held`, and when it was recorded,
   * started and finished. The Cloudgate CLI asks it while following the
   * Deployment log, whose stream never closes by itself. Gated like the log.
   */
  @Get('deployments/:deploymentId')
  @ApiOkResponse({ type: DeploymentStatusDto })
  @RequirePermission('deployment', 'read')
  findOne(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('deploymentId') deploymentId: string,
  ) {
    return this.deploymentsService.findStatus(
      toCtx(user, session),
      deploymentId,
    );
  }

  /** The tail of a deployment's log file. */
  @Get('deployments/:deploymentId/logs')
  // The one route on this controller that does not answer in JSON: it returns
  // the log file's contents as a string. Nothing in the signature says so, and
  // an unannotated Nest route is documented as an empty JSON 200 — the exact
  // mismatch the hand-written client had to discover for itself.
  //
  // The type is set on the way out, not with `@Header`, because Express does
  // not do the obvious thing with a bare string: `res.send(string)` defaults
  // to `text/html`, so a log file was being served as a web page. Everything
  // already assumed text/plain — the issue, and the frontend client's own
  // comments — so this is the server catching up with what it is documented to
  // do. `@Header` would have been the shorter spelling and the wrong one: it
  // applies to every response from the route, which would have re-typed the
  // 404's JSON body as plain text too. Readers of the success path are
  // unaffected — the frontend takes this route through `response.text()`.
  @ApiProduces('text/plain')
  @ApiOkResponse({
    description: "The deployment's log file, most recent `tail` lines last.",
    content: { 'text/plain': { schema: { type: 'string' } } },
  })
  @RequirePermission('deployment', 'read')
  async readLogs(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('deploymentId') deploymentId: string,
    @Query() query: ReadDeploymentLogsDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const logs = await this.deploymentsService.readLogs(
      toCtx(user, session),
      deploymentId,
      query.tail,
    );
    // Only once the read has succeeded: a throw above leaves the response
    // untouched, so the exception filter still answers in JSON.
    res.type('text/plain');
    return logs;
  }
}
