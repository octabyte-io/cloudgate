import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import type { AuthSession } from '../auth/auth.config';
import type { ValidatedRequest } from '../auth/auth.service';
import {
  CurrentSession,
  CurrentUser,
} from '../auth/decorators/current-user.decorator';
import { AllowedWhenFrozen } from '../cloud/billing/allowed-when-frozen.decorator';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import type { PermissionCtx } from '../rbac/permission.service';
import { BoughtServerChanges } from './bought-server-changes.service';
import { BoughtServerPurchases } from './bought-server-purchases.service';
import { BoughtServersService } from './bought-servers.service';
import {
  BackupsDto,
  BuyDto,
  FinishPayingDto,
  SizeDto,
  StorageDto,
  TodayQueryDto,
} from './dto/buy.dto';

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

/**
 * *Buy a Server*'s API (ADR-0071): hosted only, a bare 404 on a Self-hosted
 * instance. Buying follows the role rule of adding a Server
 * (`server: ['create']`), and no Agent reaches it: Agents call no REST route
 * (ADR-0023) and there is no MCP tool for it, since buying spends money.
 */
@Controller('bought-servers')
export class BoughtServersController {
  constructor(
    private readonly boughtServers: BoughtServersService,
    private readonly purchases: BoughtServerPurchases,
    private readonly changes: BoughtServerChanges,
  ) {}

  /** Whether *Buy a Server* is offered here. */
  @Get('offer')
  @RequirePermission('server', 'read')
  offer() {
    return this.boughtServers.offer();
  }

  /** Every Location and every size with its tidy monthly price and availability. */
  @Get('catalogue')
  @RequirePermission('server', 'create')
  catalogue() {
    return this.boughtServers.catalogue();
  }

  /** The Today box: what Buy would charge now for this size there, and the dates it covers. */
  @Get('today')
  @RequirePermission('server', 'create')
  today(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Query() query: TodayQueryDto,
  ) {
    return this.purchases.today(toCtx(user, session), query);
  }

  /** The Organization's Bought Servers not yet made: waiting for payment, or being created. */
  @Get('purchases')
  @RequirePermission('server', 'read')
  list(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
  ) {
    return this.purchases.purchases(toCtx(user, session));
  }

  /** Buy: charged at once; the machine is asked for only once the payment succeeds. */
  @Post()
  @RequirePermission('server', 'create')
  create(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: BuyDto,
  ) {
    return this.purchases.buy(toCtx(user, session), body);
  }

  /** *Finish paying*: where the payment stands, and where to finish it (3D Secure). */
  @Post(':id/finish-paying')
  @HttpCode(200)
  @RequirePermission('server', 'create')
  finishPaying(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
    @Body() body: FinishPayingDto,
  ) {
    // Validated, so a bad `returnTo` is refused as anywhere else, but not
    // read: an open Checkout keeps the return Buy gave it (`finishPayingSchema`).
    void body;
    return this.purchases.finishPaying(toCtx(user, session), id);
  }

  /**
   * *Cancel* a purchase still waiting for payment: nothing is charged. A
   * removal, so a frozen Organization may still do it.
   */
  @Post(':id/cancel')
  @HttpCode(200)
  @AllowedWhenFrozen('remove')
  @RequirePermission('server', 'create')
  cancel(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
  ) {
    return this.purchases.cancel(toCtx(user, session), id);
  }

  /**
   * The Bought Server behind a Server: its stage, what it holds and its
   * prices. Declared after the fixed paths above, which it would otherwise
   * swallow.
   */
  @Get(':id')
  @RequirePermission('server', 'read')
  findOne(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
  ) {
    return this.changes.view(toCtx(user, session), id);
  }

  /**
   * Backups on (charged at once, for the rest of the plan's month) or off
   * (every backup deleted at once, credited on the next invoice). Off only
   * lowers what is owed, so a frozen Organization may still do it; on is
   * refused while frozen, by the service.
   */
  @Put(':id/backups')
  @AllowedWhenFrozen('remove')
  @RequirePermission('server', 'create')
  setBackups(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
    @Body() body: BackupsDto,
  ) {
    return this.changes.setBackups(toCtx(user, session), id, body.enabled);
  }

  /**
   * Extra storage grown: charged at once for the rest of the plan's month,
   * then the Volume and the filesystem are grown. It never shrinks.
   */
  @Put(':id/storage')
  @RequirePermission('server', 'create')
  growStorage(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
    @Body() body: StorageDto,
  ) {
    return this.changes.growStorage(toCtx(user, session), id, body.sizeGb);
  }

  /** The sizes the Server can move to in its Location, with their prices. */
  @Get(':id/sizes')
  @RequirePermission('server', 'read')
  sizes(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
  ) {
    return this.changes.sizes(toCtx(user, session), id);
  }

  /**
   * A new size, up (charged at once, for the rest of the plan's month) or
   * down (credited on the next invoice); the machine is powered off while it
   * changes. Down only lowers what is owed, so a frozen Organization may
   * still do it; up is refused while frozen, by the service.
   */
  @Put(':id/size')
  @AllowedWhenFrozen('remove')
  @RequirePermission('server', 'create')
  setSize(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('id') id: string,
    @Body() body: SizeDto,
  ) {
    return this.changes.setSize(toCtx(user, session), id, body.serverType);
  }
}
