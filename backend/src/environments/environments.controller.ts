import {
  BadRequestException,
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
import {
  CreateEnvironmentDto,
  ListEnvironmentsDto,
  UpdateEnvironmentDto,
} from './dto/environment.dto';
import { EnvironmentsService } from './environments.service';
import { AllowedWhenFrozen } from '../cloud/billing/allowed-when-frozen.decorator';

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

@Controller('environments')
export class EnvironmentsController {
  constructor(private readonly environmentsService: EnvironmentsService) {}

  @Post()
  @RequirePermission('environment', 'create')
  create(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: CreateEnvironmentDto,
  ) {
    return this.environmentsService.create(toCtx(user, session), body);
  }

  @Get()
  listByProject(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Query() query: ListEnvironmentsDto,
  ) {
    return this.environmentsService.listByProject(
      toCtx(user, session),
      query.projectId,
    );
  }

  /** The environment plus the services deployed in it. */
  @Get(':id')
  findOne(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
  ) {
    return this.environmentsService.findOne(toCtx(user, session), id);
  }

  /**
   * Every Deployment of every service in this Environment.
   *
   * Two routes rather than one carrying both feeds, and the reason is that
   * these are two tabs opened independently: a route answering both would make
   * opening Domains pay for the deployment history and vice versa, and the two
   * have different cache lifetimes — a Deployment feed goes stale while a build
   * runs, a domain list only when someone edits a domain.
   *
   * It lives here rather than as an `environmentId` filter on the
   * Organization-wide `GET /deployments`, which would have been less new
   * surface, because that route's scoping does not generalise: it gates on
   * `deployment:read` plus the caller's `accessedServices` and never consults
   * `checkEnvironmentAccess`. Filtering it by Environment would let somebody
   * refused `GET /environments/:id` read that Environment's history anyway.
   * Under `:id` the read goes through the same `findOwned` the Environment read
   * does, so the two answers cannot disagree about who may look. Domains would
   * have needed a new route regardless — there is no `GET /domains`.
   */
  @Get(':id/deployments')
  @RequirePermission('deployment', 'read')
  listDeployments(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
  ) {
    return this.environmentsService.listDeployments(toCtx(user, session), id);
  }

  /**
   * The Environment's networks in Cloud accounts, with status and idle cost.
   * Gated like the Environment read, inside the service.
   */
  @Get(':id/networks')
  listNetworks(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
  ) {
    return this.environmentsService.listNetworks(toCtx(user, session), id);
  }

  /** Every domain answered by a service in this Environment. */
  @Get(':id/domains')
  @RequirePermission('domain', 'read')
  listDomains(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
  ) {
    return this.environmentsService.listDomains(toCtx(user, session), id);
  }

  /**
   * Every visible Service's open-Incident flag and worst current state, for
   * the Services table's Health column in one request rather than one per row.
   * `service: ['read']`, the statement every health read takes.
   */
  @Get(':id/health')
  @RequirePermission('service', 'read')
  listHealth(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
  ) {
    return this.environmentsService.listHealth(toCtx(user, session), id);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
    @Body() body: UpdateEnvironmentDto,
  ) {
    return this.environmentsService.update(toCtx(user, session), id, body);
  }

  /**
   * `?force=true` is the escape hatch for a Server that is gone for good: it
   * deletes the Environment even though Cloudgate could not confirm every
   * Service in it is torn down, and the response names each workload left
   * behind. Same shape and default as the Project route beside it.
   *
   * It never takes `deleteData`: an Environment's Delete keeps every
   * cloud database's final snapshot, and only that database's own Delete or
   * Plan destroy may ask for its data to go, so the flag is refused rather
   * than ignored.
   */
  @Delete(':id')
  @AllowedWhenFrozen('remove')
  @RequirePermission('environment', 'delete')
  remove(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
    @Query('force') force?: string,
    @Query('deleteData') deleteData?: string,
  ) {
    if (deleteData !== undefined) {
      throw new BadRequestException(
        "An Environment's Delete keeps every database's final snapshot; delete a database on its own to delete its data",
      );
    }
    return this.environmentsService.remove(
      toCtx(user, session),
      id,
      force === 'true',
    );
  }

  /**
   * **Retry** an Environment's incomplete Delete in a Cloud account
   * (ADR-0038): its cloud Services' Deletes and its networks' removals again,
   * from the kept states. `environment: delete`, as the Delete.
   */
  @Post(':id/delete/retry')
  @HttpCode(200)
  @RequirePermission('environment', 'delete')
  retryDelete(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
  ) {
    return this.environmentsService.retryCloudDelete(toCtx(user, session), id);
  }

  /**
   * **Forget** an Environment's incomplete Delete (ADR-0038): its
   * rows dropped, what is left in AWS written into the audit entry.
   */
  @Post(':id/delete/forget')
  @HttpCode(200)
  @RequirePermission('environment', 'delete')
  forgetDelete(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
  ) {
    return this.environmentsService.forgetCloudDelete(toCtx(user, session), id);
  }
}
