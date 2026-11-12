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
} from '@nestjs/common';
import type { AuthSession } from '../auth/auth.config';
import type { ValidatedRequest } from '../auth/auth.service';
import {
  CurrentSession,
  CurrentUser,
} from '../auth/decorators/current-user.decorator';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import type { PermissionCtx } from '../rbac/permission.service';
import { CreateServerDto, UpdateServerDto } from './dto/server.dto';
import { ServersService } from './servers.service';
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

// Server permissions: read on queries (list/one/validate/audit), create on
// create/update/setup/forget-host-key/start-maintenance/end-maintenance,
// delete on remove.
@Controller('servers')
export class ServersController {
  constructor(private readonly serversService: ServersService) {}

  @Post()
  @RequirePermission('server', 'create')
  create(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: CreateServerDto,
  ) {
    return this.serversService.create(toCtx(user, session), body);
  }

  @Get()
  @RequirePermission('server', 'read')
  list(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
  ) {
    return this.serversService.listWithPurchase(toCtx(user, session));
  }

  @Get(':id')
  @RequirePermission('server', 'read')
  findOne(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
  ) {
    return this.serversService.findOneWithPurchase(toCtx(user, session), id);
  }

  @Get(':id/validate')
  @RequirePermission('server', 'read')
  validate(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
  ) {
    return this.serversService.validate(toCtx(user, session), id);
  }

  @Get(':id/audit')
  @RequirePermission('server', 'read')
  audit(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
  ) {
    return this.serversService.audit(toCtx(user, session), id);
  }

  /**
   * Provision the host and answer when the script ends.
   *
   * **The console does not use this** — it opens `/listen-server-setup`, whose
   * gateway calls the same `setup` with an `onData` that writes to the socket.
   * This route stays for API callers that only want the outcome, and it
   * keeps the shape it always had: no output, and a response held open for as
   * long as `curl … | sh` takes, so a proxy will often close it while the run
   * goes on succeeding on the machine. That is the reason the gateway exists.
   */
  @Post(':id/setup')
  @HttpCode(200)
  @RequirePermission('server', 'create')
  setup(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
  ) {
    return this.serversService.setup(toCtx(user, session), id);
  }

  @Patch(':id')
  @RequirePermission('server', 'create')
  update(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
    @Body() body: UpdateServerDto,
  ) {
    return this.serversService.update(toCtx(user, session), id, body);
  }

  /**
   * Forget the Server's recorded host key, after a deliberate reinstall, so
   * the next connect records the new one (ADR-0074). A change to the Server
   * row, so `server:create` as `PATCH` is.
   */
  @Post(':id/forget-host-key')
  @HttpCode(200)
  @RequirePermission('server', 'create')
  forgetHostKey(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
  ) {
    return this.serversService.forgetHostKey(toCtx(user, session), id);
  }

  /**
   * Start Maintenance on the Server (spec #1420): nothing new starts
   * containers on it until End maintenance. A change to the Server row, so
   * `server:create` as every Server change is (ADR-0074); audited as an
   * update of the Server. 409 when it is already in maintenance.
   */
  @Post(':id/start-maintenance')
  @HttpCode(200)
  @RequirePermission('server', 'create')
  startMaintenance(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
  ) {
    return this.serversService.startMaintenance(toCtx(user, session), id);
  }

  /** End the Server's Maintenance; 409 when it is not in maintenance. */
  @Post(':id/end-maintenance')
  @HttpCode(200)
  @RequirePermission('server', 'create')
  endMaintenance(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
  ) {
    return this.serversService.endMaintenance(toCtx(user, session), id);
  }

  @Delete(':id')
  @AllowedWhenFrozen('remove')
  @RequirePermission('server', 'delete')
  remove(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
  ) {
    return this.serversService.remove(toCtx(user, session), id);
  }
}
