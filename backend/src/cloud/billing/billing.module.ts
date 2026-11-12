import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { fetchClientProvider } from '../../git-providers/fetch.provider';
import { MailModule } from '../../mail/mail.module';
import { RbacModule } from '../../rbac/rbac.module';
import { SchedulingModule } from '../../scheduling/scheduling.module';
import { BoughtServerClockSteps } from './bought-server-clock-steps';
import { BillingNotificationsService } from './billing-notifications.service';
import { BillingWebhookController } from './billing-webhook.controller';
import { BillingWebhookService } from './billing-webhook.service';
import { BillingConfig } from './billing.config';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { DailyJobSteps } from './daily-job-steps';
import { FrozenOrganizations } from './frozen-organizations.service';
import { FrozenGuard } from './frozen.guard';
import { LapseClockService } from './lapse-clock.service';
import { LapseNotifications } from './lapse-notifications.service';
import { PaymentDisputes } from './payment-disputes.service';
import { STRIPE_API } from './stripe-api';
import { StripeApiClient } from './stripe-api.client';
import { StopPaying } from './stop-paying.service';
import { StripeWebhookEndpointCheck } from './stripe-webhook-endpoint-check';
import { PurchasePayments } from './purchase-payments';

/**
 * Global for the same reason LicenseModule is: the server surface consults the
 * plan's quota before creating a server, and importing this module there would
 * pull billing into a dependency chain that has nothing to do with it. The
 * same goes for `FrozenOrganizations`, the one "is this Organization frozen"
 * every path that starts work asks (ADR-0052).
 *
 * `FrozenGuard` is an APP_GUARD here, so it runs after AuthModule's and
 * RbacModule's (AppModule imports both first): it needs the session AuthGuard
 * puts on the request.
 */
@Global()
@Module({
  imports: [RbacModule, MailModule, SchedulingModule],
  controllers: [BillingController, BillingWebhookController],
  providers: [
    fetchClientProvider,
    BillingConfig,
    BillingNotificationsService,
    BillingService,
    BillingWebhookService,
    DailyJobSteps,
    BoughtServerClockSteps,
    FrozenOrganizations,
    LapseClockService,
    LapseNotifications,
    PaymentDisputes,
    PurchasePayments,
    StopPaying,
    StripeWebhookEndpointCheck,
    { provide: APP_GUARD, useClass: FrozenGuard },
    { provide: STRIPE_API, useClass: StripeApiClient },
  ],
  exports: [
    BillingService,
    BillingConfig,
    // The daily job's steps for a Bought Server (#1400).
    DailyJobSteps,
    FrozenOrganizations,
    LapseNotifications,
    PurchasePayments,
    BoughtServerClockSteps,
    // A Bought Server is charged on the Hosted plan's subscription (ADR-0071).
    STRIPE_API,
  ],
})
export class BillingModule {}
