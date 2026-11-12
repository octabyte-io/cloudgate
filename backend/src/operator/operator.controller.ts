import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import type { AuthSession } from '../auth/auth.config';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AllowedWhenFrozen } from '../cloud/billing/allowed-when-frozen.decorator';
import {
  ApplyRepriceDto,
  PreviewRepriceDto,
} from './dto/reprice-bought-servers.dto';
import { SetBoughtServerSettingsDto } from './dto/set-bought-server-settings.dto';
import { SetEnterpriseDto } from './dto/set-enterprise.dto';
import { SuspendOrganizationDto } from './dto/suspend-organization.dto';
import { OperatorBoughtServerReprices } from './operator-bought-server-reprices.service';
import { OperatorBoughtServers } from './operator-bought-servers.service';
import { OperatorOrphanMachines } from './operator-orphan-machines.service';
import { OperatorService } from './operator.service';

/**
 * The Operator page's API (ADR-0050): hosted only, 404 on a Self-hosted
 * instance; an owner or admin of the Instance organization, people only. An
 * Agent key never gets this far — AuthService refuses one on every REST
 * route — and `holdsInstanceAuthority` refuses an Agent again by kind. The
 * active Organization does not matter: the authority is the caller's
 * membership in the Instance organization.
 *
 * The writes act on another Organization than the caller's active one, so a
 * frozen active Organization does not refuse them (`own-account`), and they
 * write their own audit rows into the target's log and the Instance
 * organization's (`OperatorService.recordWrite`).
 */
@Controller('operator')
export class OperatorController {
  constructor(
    private readonly operator: OperatorService,
    private readonly boughtServers: OperatorBoughtServers,
    private readonly orphanMachines: OperatorOrphanMachines,
    private readonly reprices: OperatorBoughtServerReprices,
  ) {}

  /** Whether the caller is an Operator; any signed-in person may ask. */
  @Get('access')
  access(@CurrentUser() user: AuthSession['user']) {
    return this.operator.access({ user: { id: user.id } });
  }

  /** Every Organization's account facts; Operators only. */
  @Get('organizations')
  listOrganizations(@CurrentUser() user: AuthSession['user']) {
    return this.operator.listOrganizations({ user: { id: user.id } });
  }

  /** Suspends the Organization with the reason its members see. */
  @Post('organizations/:id/suspension')
  @HttpCode(200)
  @AllowedWhenFrozen('own-account')
  suspend(
    @CurrentUser() user: AuthSession['user'],
    @Param('id') id: string,
    @Req() req: Request,
    @Body() body: SuspendOrganizationDto,
  ) {
    return this.operator.suspend(
      { user: { id: user.id }, ip: req.ip },
      id,
      body.reason,
    );
  }

  /** Lifts the Organization's suspension. */
  @Delete('organizations/:id/suspension')
  @HttpCode(204)
  @AllowedWhenFrozen('own-account')
  lift(
    @CurrentUser() user: AuthSession['user'],
    @Param('id') id: string,
    @Req() req: Request,
  ): Promise<void> {
    return this.operator.lift({ user: { id: user.id }, ip: req.ip }, id);
  }

  /**
   * Switches Enterprise on with the agreement's counts, or off;
   * answers the marker and counts as they now stand.
   */
  @Put('organizations/:id/enterprise')
  @AllowedWhenFrozen('own-account')
  setEnterprise(
    @CurrentUser() user: AuthSession['user'],
    @Param('id') id: string,
    @Req() req: Request,
    @Body() body: SetEnterpriseDto,
  ) {
    return this.operator.setEnterprise(
      { user: { id: user.id }, ip: req.ip },
      id,
      body,
    );
  }

  /** Every Bought Server with its real margin at the day's rate; Operators only. */
  @Get('bought-servers')
  listBoughtServers(@CurrentUser() user: AuthSession['user']) {
    return this.boughtServers.list({ user: { id: user.id } });
  }

  /** The Server markup, the margin floor and the reverse-DNS domain. */
  @Get('bought-servers/settings')
  boughtServerSettings(@CurrentUser() user: AuthSession['user']) {
    return this.boughtServers.getSettings({ user: { id: user.id } });
  }

  /**
   * Sets the Server markup and/or the margin floor: a markup prices new
   * purchases and new lines only. Audited in the Instance organization.
   */
  @Put('bought-servers/settings')
  @AllowedWhenFrozen('own-account')
  setBoughtServerSettings(
    @CurrentUser() user: AuthSession['user'],
    @Req() req: Request,
    @Body() body: SetBoughtServerSettingsDto,
  ) {
    return this.boughtServers.setSettings(
      { user: { id: user.id }, ip: req.ip },
      body,
    );
  }

  /** The machines nothing owns, as the hourly check last found them (#1402). */
  @Get('bought-servers/orphans')
  listOrphanMachines(@CurrentUser() user: AuthSession['user']) {
    return this.orphanMachines.list({ user: { id: user.id } });
  }

  /**
   * Deletes a machine nothing owns, with its Volumes and Primary IPs.
   * Audited in the Instance organization.
   */
  @Delete('bought-servers/orphans/:providerServerId')
  @HttpCode(204)
  @AllowedWhenFrozen('own-account')
  deleteOrphanMachine(
    @CurrentUser() user: AuthSession['user'],
    @Param('providerServerId', ParseIntPipe) providerServerId: number,
    @Req() req: Request,
  ): Promise<void> {
    return this.orphanMachines.delete(
      { user: { id: user.id }, ip: req.ip },
      providerServerId,
    );
  }

  /**
   * Each chosen Bought Server's old price and its price at the current USD
   * list and Server markup: a rise starts 30 days on, a fall at once.
   */
  @Post('bought-servers/reprice/preview')
  @HttpCode(200)
  @AllowedWhenFrozen('own-account')
  previewReprice(
    @CurrentUser() user: AuthSession['user'],
    @Body() body: PreviewRepriceDto,
  ) {
    return this.reprices.preview({ user: { id: user.id } }, body.ids);
  }

  /**
   * Applies the previewed reprice, refused unless each price is still the
   * one previewed; emails each Organization's owners, audited on both sides.
   */
  @Post('bought-servers/reprice')
  @HttpCode(200)
  @AllowedWhenFrozen('own-account')
  applyReprice(
    @CurrentUser() user: AuthSession['user'],
    @Req() req: Request,
    @Body() body: ApplyRepriceDto,
  ) {
    return this.reprices.apply({ user: { id: user.id }, ip: req.ip }, body);
  }
}
