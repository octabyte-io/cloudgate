import {
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  Post,
} from '@nestjs/common';
import { ApiAcceptedResponse } from '@nestjs/swagger';
import type { AuthSession } from '../auth/auth.config';
import type { ValidatedRequest } from '../auth/auth.service';
import {
  CurrentSession,
  CurrentUser,
} from '../auth/decorators/current-user.decorator';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import type { PermissionCtx } from '../rbac/permission.service';
import { RollbacksService } from './rollbacks.service';

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
export class RollbacksController {
  constructor(private readonly rollbacksService: RollbacksService) {}

  /** Rollback snapshots are listed per application, like deployments. */
  @Get('applications/:applicationId/rollbacks')
  @RequirePermission('deployment', 'read')
  findAllByApplication(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('applicationId') applicationId: string,
  ) {
    return this.rollbacksService.findAllByApplicationId(
      toCtx(user, session),
      applicationId,
    );
  }

  /**
   * Rolls the application back onto this snapshot. `202` either
   * way, since both are taken on and finish after the answer: on a Server
   * the running service is repointed at an image already stored, which
   * Swarm converges; a `static` site on AWS's Rollback is a
   * Deployment of the Service, queued with its pushes, whose log the
   * console opens. The service answers which (`deploymentId`).
   */
  @Post('rollbacks/:rollbackId/rollback')
  @HttpCode(202)
  @RequirePermission('deployment', 'create')
  // Stated by hand: the answer is the service's interface, no zod DTO.
  @ApiAcceptedResponse({
    description:
      "The Rollback is under way. `deploymentId` is the queued Deployment of a static site on AWS, whose log shows it; null on a Server, where Swarm converges the service onto the snapshot's image.",
    schema: {
      type: 'object',
      required: ['deploymentId'],
      properties: { deploymentId: { type: 'string', nullable: true } },
    },
  })
  rollback(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('rollbackId') rollbackId: string,
  ) {
    return this.rollbacksService.rollback(toCtx(user, session), rollbackId);
  }

  /** Deletes a snapshot: its preserved image, then its row. */
  @Delete('rollbacks/:rollbackId')
  @RequirePermission('deployment', 'create')
  remove(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('rollbackId') rollbackId: string,
  ) {
    return this.rollbacksService.remove(toCtx(user, session), rollbackId);
  }
}
