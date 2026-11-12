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
import { ComposeService } from './compose.service';
import {
  CreateComposeDto,
  SaveComposeEnvironmentDto,
  SaveComposeStackVmDto,
  UpdateComposeDto,
} from './dto/compose.dto';
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

@Controller('compose')
export class ComposeController {
  constructor(private readonly composeService: ComposeService) {}

  @Post()
  @RequirePermission('service', 'create')
  create(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: CreateComposeDto,
  ) {
    return this.composeService.create(toCtx(user, session), body);
  }

  @Get(':id')
  findOne(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
  ) {
    return this.composeService.findOne(toCtx(user, session), id);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
    @Body() body: UpdateComposeDto,
  ) {
    return this.composeService.update(toCtx(user, session), id, body);
  }

  @Patch(':id/environment')
  saveEnvironment(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
    @Body() body: SaveComposeEnvironmentDto,
  ) {
    return this.composeService.saveEnvironment(toCtx(user, session), id, body);
  }

  /** A stack's Stack VM setting: its size and data disk (#1372). */
  @Patch(':id/stack-vm')
  @RequirePermission('service', 'update')
  saveStackVm(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
    @Body() body: SaveComposeStackVmDto,
  ) {
    return this.composeService.saveStackVm(toCtx(user, session), id, body);
  }

  /**
   * `?force=true` is the escape hatch for a Server that is gone for good: it
   * drops the row even though Cloudgate could not confirm the stack's
   * containers are gone, and the response names what was left behind.
   * Default false, a string query parameter compared to 'true' like
   * `deleteVolumes` beside it and `applications.controller.ts`'s own `force`.
   */
  @Delete(':id')
  @AllowedWhenFrozen('remove')
  @RequirePermission('service', 'delete')
  remove(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
    @Query('deleteVolumes') deleteVolumes?: string,
    @Query('force') force?: string,
  ) {
    return this.composeService.remove(
      toCtx(user, session),
      id,
      deleteVolumes === 'true',
      force === 'true',
    );
  }

  @Post(':id/start')
  @HttpCode(200)
  @RequirePermission('deployment', 'create')
  start(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
  ) {
    return this.composeService.start(toCtx(user, session), id);
  }

  @Post(':id/stop')
  @HttpCode(200)
  @RequirePermission('deployment', 'create')
  stop(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
  ) {
    return this.composeService.stop(toCtx(user, session), id);
  }

  /**
   * Restart: `docker compose restart`, the containers only; on a Stack VM,
   * never the VM (ADR-0070). Carries Stop's and Start's statement.
   */
  @Post(':id/restart')
  @HttpCode(200)
  @RequirePermission('deployment', 'create')
  restart(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
  ) {
    return this.composeService.restart(toCtx(user, session), id);
  }

  /**
   * Whether the stack's Stack VM runs, read from its cloud now (ADR-0070).
   * A read, gated by the stack's row-level access as `GET :id` is.
   */
  @Get(':id/stack-vm')
  stackVmStatus(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
  ) {
    return this.composeService.stackVmStatus(toCtx(user, session), id);
  }

  /**
   * Remove containers. Carries `stop`'s statement rather than
   * `remove`'s, on purpose: the row-level half of this action's gate lives in
   * the service, and `service:['delete']` here would lock out the custom role
   * the rung was added for (ADR-0011). Answers the updated row, like `stop`.
   */
  @Post(':id/remove-containers')
  @HttpCode(200)
  @RequirePermission('deployment', 'create')
  removeContainers(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
  ) {
    return this.composeService.removeContainers(toCtx(user, session), id);
  }

  @Get(':id/services')
  loadServices(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
  ) {
    return this.composeService.loadServices(toCtx(user, session), id);
  }

  /**
   * The compose file as the deploy applies it. Answers the rewritten file as
   * YAML text (a bare string from a Nest handler), like the platform's other
   * file reads — `GET /patches/repo/file`, `GET /settings/traefik/file`.
   */
  @Get(':id/converted')
  getConverted(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
  ) {
    return this.composeService.getConverted(toCtx(user, session), id);
  }
}
