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
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import type { AuthSession } from '../../auth/auth.config';
import type { ValidatedRequest } from '../../auth/auth.service';
import {
  CurrentSession,
  CurrentUser,
} from '../../auth/decorators/current-user.decorator';
import type { PermissionCtx } from '../../rbac/permission.service';
import { AllowedWhenFrozen } from './allowed-when-frozen.decorator';
import { BillingService } from './billing.service';
import { FrozenOrganizations } from './frozen-organizations.service';
import { StopPaying } from './stop-paying.service';
import {
  AddOnsDto,
  CheckoutDto,
  UpdateInvoiceNotificationsDto,
  UpgradeDto,
} from './dto/billing.dto';

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
 * Everything but `getCurrentPlan`, `serverRoom`, `getStanding` and
 * `getAttachedPlan` is owner/admin only, enforced in BillingService; any
 * member may read those four — the allowance check inside Server create is
 * what actually stops a member adding one. Paying, and detaching an
 * Organization this one pays for, are allowed while the Organization is
 * frozen.
 *
 * The webhook lives on its own controller, being unauthenticated.
 */
@Controller('billing')
export class BillingController {
  constructor(
    private readonly billing: BillingService,
    private readonly frozen: FrozenOrganizations,
    private readonly stopPayingFor: StopPaying,
  ) {}

  /**
   * Whether the Organization is frozen and why, and whether a payment has
   * failed while Stripe retries: what the banner every member sees reads
   * (ADR-0052). Any member; empty on a Self-hosted instance.
   */
  @Get('standing')
  getStanding(@CurrentSession() session: Session) {
    if (!session.activeOrganizationId) {
      throw new ForbiddenException('No active organization');
    }
    return this.frozen.standingOf(session.activeOrganizationId);
  }

  /** The stored billing state — see BillingService.getSubscription. */
  @Get('subscription')
  getSubscription(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
  ) {
    return this.billing.getSubscription(toCtx(user, session));
  }

  /**
   * The "Organizations on this plan" card: whether "Add an Organization to
   * this plan" is offered and why not, how much of the pool is free, and each
   * Organization this one pays for (ADR-0059). The add itself is
   * `POST /organizations` with `paidBy: 'active-organization'`.
   */
  @Get('attached-organizations')
  getAttachedOrganizations(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
  ) {
    return this.billing.attachedOrganizations(toCtx(user, session));
  }

  /**
   * An Attached Organization's Billing page as any of its members sees it:
   * who pays, the room left on that plan and its own use; nothing for an
   * Organization that pays for itself — see `BillingService.attachedPlan`.
   * Any member.
   */
  @Get('attached-plan')
  getAttachedPlan(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
  ) {
    return this.billing.attachedPlan(toCtx(user, session));
  }

  /**
   * "Stop paying for it" (ADR-0059): detaches an Organization this
   * one pays for, which lapses at once — see `StopPaying`. Owner or admin of
   * the Paying Organization. Also the "Before <Paying> can move to Starter"
   * checklist's Detach. Allowed while the Paying Organization is frozen
   * (`detach`): it only takes an Organization off a plan nobody is paying.
   */
  @Post('attached-organizations/:organizationId/stop-paying')
  @AllowedWhenFrozen('detach')
  @HttpCode(200)
  stopPaying(
    @Req() req: Request,
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Param('organizationId') organizationId: string,
  ) {
    return this.stopPayingFor.stopPaying(
      toCtx(user, session),
      organizationId,
      req.ip,
    );
  }

  /** The plan the organization holds now, and a waiting move's date; any member. */
  @Get('plan')
  async getCurrentPlan(@CurrentSession() session: Session) {
    if (!session.activeOrganizationId) {
      throw new ForbiddenException('No active organization');
    }
    return this.billing.getCurrentPlan(session.activeOrganizationId);
  }

  /** Both plans and the Add-on, as Stripe prices them. */
  @Get('products')
  getCatalogue(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
  ) {
    return this.billing.getCatalogue(toCtx(user, session));
  }

  /** The organization's Stripe invoices. */
  @Get('invoices')
  getInvoices(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
  ) {
    return this.billing.getInvoices(toCtx(user, session));
  }

  /**
   * Whether one more Server fits the allowance, with the refusal's code and
   * sentence when not; any member.
   */
  @Get('can-create-server')
  canCreateMoreServers(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
  ) {
    return this.billing.serverRoom(toCtx(user, session));
  }

  /** Starts a Stripe Checkout session for the chosen plan and its Add-ons. */
  @Post('checkout')
  @AllowedWhenFrozen('pay')
  @HttpCode(200)
  createCheckoutSession(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: CheckoutDto,
  ) {
    return this.billing.createCheckoutSession(toCtx(user, session), body);
  }

  /** Opens a Stripe customer-portal session. */
  @Post('portal')
  @AllowedWhenFrozen('pay')
  @HttpCode(200)
  createCustomerPortalSession(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
  ) {
    return this.billing.createCustomerPortalSession(toCtx(user, session));
  }

  /** Sets the existing subscription's Add-on quantity. */
  @Post('add-ons')
  @AllowedWhenFrozen('pay')
  @HttpCode(200)
  setAddOns(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: AddOnsDto,
  ) {
    return this.billing.setAddOns(toCtx(user, session), body);
  }

  /**
   * What upgrading Starter to Business charges today and every month after,
   * from Stripe's invoice preview.
   */
  @Get('upgrade-preview')
  previewUpgrade(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
  ) {
    return this.billing.previewUpgrade(toCtx(user, session));
  }

  /**
   * Upgrades Starter to Business at once, charging the previewed amount. Not
   * allowed while frozen: a Frozen Organization has no plan to upgrade.
   */
  @Post('upgrade')
  @HttpCode(200)
  upgrade(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: UpgradeDto,
  ) {
    return this.billing.upgrade(toCtx(user, session), body);
  }

  /**
   * What moving to Starter stops, against what the Organization uses: its
   * SSO providers and SSO-only people, SCIM connections, custom-role holders
   * and protected apps.
   */
  @Get('downgrade-impact')
  getDowngradeImpact(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
  ) {
    return this.billing.getDowngradeImpact(toCtx(user, session));
  }

  /**
   * Moves Business to Starter at the end of the paid month; nothing is
   * charged. Not allowed while frozen, as the upgrade.
   */
  @Post('downgrade')
  @HttpCode(200)
  downgrade(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
  ) {
    return this.billing.downgrade(toCtx(user, session));
  }

  /** "Keep Business": takes a waiting downgrade back, at no charge. */
  @Delete('downgrade')
  keepBusiness(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
  ) {
    return this.billing.keepBusiness(toCtx(user, session));
  }

  /**
   * "Cancel trial": the plan ends with the free trial, and nothing is
   * charged. Owner/admin, during a trial only.
   */
  @Post('cancel-trial')
  @HttpCode(200)
  cancelTrial(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
  ) {
    return this.billing.cancelTrial(toCtx(user, session));
  }

  /** "Keep <plan>": takes a cancelled trial's cancel back. */
  @Delete('cancel-trial')
  keepTrial(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
  ) {
    return this.billing.keepTrial(toCtx(user, session));
  }

  /** Turns invoice mail on or off. */
  @Patch('invoice-notifications')
  updateInvoiceNotifications(
    @CurrentUser() user: AuthSession['user'],
    @CurrentSession() session: Session,
    @Body() body: UpdateInvoiceNotificationsDto,
  ) {
    return this.billing.updateInvoiceNotifications(toCtx(user, session), body);
  }
}
