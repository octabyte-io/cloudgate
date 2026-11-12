import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import type { AuthSession } from '../auth/auth.config';
import type { ValidatedRequest } from '../auth/auth.service';
import {
  CurrentSession,
  CurrentUser,
} from '../auth/decorators/current-user.decorator';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import type { PermissionCtx } from '../rbac/permission.service';
import {
  CreateRequestedPreviewDto,
  ExtendRequestedPreviewDto,
  RedeployPreviewDeploymentDto,
} from './dto/preview-deployment.dto';
import { PreviewDeploymentsService } from './preview-deployments.service';

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

// Deployment permissions: read on queries, create on asking for, extending
// and redeploying a preview, cancel on delete.
@Controller()
export class PreviewDeploymentsController {
  constructor(
    private readonly previewDeploymentsService: PreviewDeploymentsService,
  ) {}

  /** An application's preview deployments. */
  @Get('applications/:applicationId/preview-deployments')
  @RequirePermission('deployment', 'read')
  findAllByApplication(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('applicationId') applicationId: string,
  ) {
    return this.previewDeploymentsService.findAllByApplicationId(
      toCtx(user, session),
      applicationId,
    );
  }

  /**
   * Asks for a Requested preview of a branch (ADR-0026). `201` with the
   * preview, its printed link and the queued Deployment's id. The refusal
   * chain is `PreviewDeploymentsService.admitRequestedCreate`'s; the service
   * writes the audit row, which carries the branch and the expiry.
   */
  @Post('applications/:applicationId/preview-deployments')
  @RequirePermission('deployment', 'create')
  createRequested(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('applicationId') applicationId: string,
    @Req() req: Request,
    @Body() body: CreateRequestedPreviewDto,
  ) {
    return this.previewDeploymentsService.createRequested(
      toCtx(user, session),
      applicationId,
      body,
      req.ip,
    );
  }

  /**
   * Moves a Requested preview's expiry to now plus the TTL.
   * `200`: it changes a preview and creates nothing, as the status rule sorts a
   * `POST`.
   */
  @Post('preview-deployments/:previewDeploymentId/extend')
  @HttpCode(200)
  @RequirePermission('deployment', 'create')
  extend(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('previewDeploymentId') previewDeploymentId: string,
    @Req() req: Request,
    @Body() body: ExtendRequestedPreviewDto,
  ) {
    return this.previewDeploymentsService.extend(
      toCtx(user, session),
      previewDeploymentId,
      body,
      req.ip,
    );
  }

  /** One preview deployment. */
  @Get('preview-deployments/:previewDeploymentId')
  @RequirePermission('deployment', 'read')
  findOne(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('previewDeploymentId') previewDeploymentId: string,
  ) {
    return this.previewDeploymentsService.findOne(
      toCtx(user, session),
      previewDeploymentId,
    );
  }

  /**
   * Re-enqueues the preview's build, and answers the queued Deployment.
   *
   * **`201` with the Deployment, as `POST /applications/:id/redeploy`
   * answers**.
   * This was `204` while a queued preview build had no row, so
   * there was nothing to address; now it is a `pending` Deployment of
   * the parent naming the preview, created here or — when this preview's own
   * build is still waiting — the one joined. The console ignores the body.
   */
  @Post('preview-deployments/:previewDeploymentId/redeploy')
  @RequirePermission('deployment', 'create')
  redeploy(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('previewDeploymentId') previewDeploymentId: string,
    @Body() body: RedeployPreviewDeploymentDto,
  ) {
    return this.previewDeploymentsService.redeploy(
      toCtx(user, session),
      previewDeploymentId,
      body,
    );
  }

  /**
   * Tears a pull-request preview down without waiting for its PR to close, or
   * expires a Requested preview now and answers at once: the expiry sweep
   * tears it down within the minute.
   */
  @Delete('preview-deployments/:previewDeploymentId')
  @RequirePermission('deployment', 'cancel')
  remove(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('previewDeploymentId') previewDeploymentId: string,
  ) {
    return this.previewDeploymentsService.remove(
      toCtx(user, session),
      previewDeploymentId,
    );
  }
}
