import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import type { AuthSession } from '../auth/auth.config';
import type { ValidatedRequest } from '../auth/auth.service';
import {
  CurrentSession,
  CurrentUser,
} from '../auth/decorators/current-user.decorator';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import type { PermissionCtx } from '../rbac/permission.service';
import { DomainsService } from './domains.service';
import {
  CreateDomainDto,
  GenerateDomainDto,
  UpdateDomainDto,
} from './dto/domain.dto';

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

// No prefix: domain CRUD lives under /domains, but the by-parent listings
// nest under their services' paths (mirroring preview-deployments).
@Controller()
export class DomainsController {
  constructor(private readonly domainsService: DomainsService) {}

  @Post('domains')
  @RequirePermission('domain', 'create')
  create(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: CreateDomainDto,
  ) {
    return this.domainsService.create(toCtx(user, session), body);
  }

  @Post('domains/generate')
  @HttpCode(200)
  @RequirePermission('domain', 'create')
  generate(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: GenerateDomainDto,
  ) {
    return this.domainsService.generateDomain(
      toCtx(user, session),
      body.appName,
      body.serverId,
      body.composeId,
    );
  }

  @Get('applications/:applicationId/domains')
  @RequirePermission('domain', 'read')
  byApplicationId(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('applicationId') applicationId: string,
  ) {
    return this.domainsService.byApplicationId(
      toCtx(user, session),
      applicationId,
    );
  }

  @Get('compose/:composeId/domains')
  @RequirePermission('domain', 'read')
  byComposeId(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('composeId') composeId: string,
  ) {
    return this.domainsService.byComposeId(toCtx(user, session), composeId);
  }

  /** A Server bucket's Domains, under the same `domain: read`. */
  @Get('buckets/:bucketId/domains')
  @RequirePermission('domain', 'read')
  byBucketId(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('bucketId') bucketId: string,
  ) {
    return this.domainsService.byBucketId(toCtx(user, session), bucketId);
  }

  @Get('domains/:id')
  findOne(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
  ) {
    return this.domainsService.findOne(toCtx(user, session), id);
  }

  @Patch('domains/:id')
  @RequirePermission('domain', 'create')
  update(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
    @Body() body: UpdateDomainDto,
  ) {
    return this.domainsService.update(toCtx(user, session), id, body);
  }

  /** A failed cloud Domain's certificate, requested again. */
  @Post('domains/:id/ask-again')
  @HttpCode(200)
  @RequirePermission('domain', 'create')
  askAgain(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
  ) {
    return this.domainsService.askAgain(toCtx(user, session), id);
  }

  /**
   * `?force=true` is the escape hatch for a Server that is gone for good, as
   * on an Application Delete: without it, a Server that cannot be reached is a
   * 409 naming it and the row is kept; with it, the row goes and the response
   * names the router left in that Server's file. Compared to 'true' like the
   * Application Delete's.
   */
  @Delete('domains/:id')
  @RequirePermission('domain', 'delete')
  remove(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
    @Query('force') force?: string,
  ) {
    return this.domainsService.remove(
      toCtx(user, session),
      id,
      force === 'true',
    );
  }
}
