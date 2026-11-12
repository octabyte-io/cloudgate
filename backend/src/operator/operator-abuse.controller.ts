import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import type { AuthSession } from '../auth/auth.config';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AllowedWhenFrozen } from '../cloud/billing/allowed-when-frozen.decorator';
import { ForwardAbuseReportDto } from './dto/forward-abuse-report.dto';
import { PowerOffBoughtServerDto } from './dto/power-off-bought-server.dto';
import { OperatorAbuse } from './operator-abuse.service';

/**
 * The Operator page's abuse actions (ADR-0071, #1401): forwarding an abuse
 * report to an Organization, the open reports, and powering a Bought Server
 * off and on. Hosted only and Operators only, as every Operator route
 * (`OperatorService.assertOperator`); the writes act on another
 * Organization than the caller's active one (`own-account`) and are audited
 * on both sides through `OperatorService.recordWrite`.
 */
@Controller('operator')
export class OperatorAbuseController {
  constructor(private readonly abuse: OperatorAbuse) {}

  /** Emails the report to the owners and admins with a 24-hour deadline. */
  @Post('organizations/:id/abuse-reports')
  @AllowedWhenFrozen('own-account')
  forwardAbuseReport(
    @CurrentUser() user: AuthSession['user'],
    @Param('id') id: string,
    @Req() req: Request,
    @Body() body: ForwardAbuseReportDto,
  ) {
    return this.abuse.forward(
      { user: { id: user.id }, ip: req.ip },
      id,
      body.report,
    );
  }

  /** Every open abuse report, the nearest deadline first. */
  @Get('abuse-reports')
  listAbuseReports(@CurrentUser() user: AuthSession['user']) {
    return this.abuse.listOpen({ user: { id: user.id } });
  }

  /** Closes an open abuse report. */
  @Post('abuse-reports/:id/close')
  @HttpCode(204)
  @AllowedWhenFrozen('own-account')
  closeAbuseReport(
    @CurrentUser() user: AuthSession['user'],
    @Param('id') id: string,
    @Req() req: Request,
  ): Promise<void> {
    return this.abuse.close({ user: { id: user.id }, ip: req.ip }, id);
  }

  /** Powers the Bought Server's machine off at once, with the reason its owners see. */
  @Post('bought-servers/:id/power-off')
  @HttpCode(200)
  @AllowedWhenFrozen('own-account')
  powerOffBoughtServer(
    @CurrentUser() user: AuthSession['user'],
    @Param('id') id: string,
    @Req() req: Request,
    @Body() body: PowerOffBoughtServerDto,
  ) {
    return this.abuse.powerOff(
      { user: { id: user.id }, ip: req.ip },
      id,
      body.reason,
    );
  }

  /** Powers it back on: the only way it comes back on. */
  @Post('bought-servers/:id/power-on')
  @HttpCode(204)
  @AllowedWhenFrozen('own-account')
  powerOnBoughtServer(
    @CurrentUser() user: AuthSession['user'],
    @Param('id') id: string,
    @Req() req: Request,
  ): Promise<void> {
    return this.abuse.powerOn({ user: { id: user.id }, ip: req.ip }, id);
  }
}
