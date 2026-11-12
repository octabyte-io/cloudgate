import { Module } from '@nestjs/common';
import { MailModule } from '../mail/mail.module';
import { RbacModule } from '../rbac/rbac.module';
import { SchedulingModule } from '../scheduling/scheduling.module';
import { SshKeysModule } from '../ssh-keys/ssh-keys.module';
import { BoughtServerClock } from './bought-server-clock.service';
import { BoughtServerNotifications } from './bought-server-notifications.service';
import { BoughtServerChanges } from './bought-server-changes.service';
import { BoughtServerChangeSteps } from './bought-server-change-steps.service';
import { BoughtServerDeletion } from './bought-server-deletion.service';
import { BoughtServerPurchases } from './bought-server-purchases.service';
import { BoughtServerReprices } from './bought-server-reprices.service';
import { BoughtServerSettings } from './bought-server-settings.service';
import { BoughtServerStages } from './bought-server-stages.service';
import { BoughtServersConfig } from './bought-servers.config';
import { BoughtServersController } from './bought-servers.controller';
import { BoughtServersHourly } from './bought-servers-hourly.service';
import { BoughtServersService } from './bought-servers.service';
import { DayRates } from './exchange-rate/day-rates.service';
import { EcbExchangeRate } from './exchange-rate/ecb-exchange-rate.adapter';
import { EXCHANGE_RATE } from './exchange-rate/exchange-rate.port';
import { HetznerCloudAdapter } from './hetzner/hetzner-cloud.adapter';
import { HETZNER_MACHINES, HETZNER_PRICES } from './hetzner/hetzner-cloud.port';
import { OrphanMachines } from './orphan-machines.service';

/**
 * **Bought Servers** (ADR-0071), Hosted instance only. The provider port is
 * provided twice, one adapter per token: every e2e replaces both with
 * in-memory fakes (`test/utils/test-app.ts`). Billing is global, so the
 * Server count and the subscription come from it without an import; its
 * webhook reaches the purchases through `PurchasePayments`. The day's
 * exchange rate, read only for the Operator page's margins, is a port of
 * its own, which every e2e replaces too.
 */
@Module({
  imports: [RbacModule, SshKeysModule, MailModule, SchedulingModule],
  controllers: [BoughtServersController],
  providers: [
    BoughtServersConfig,
    BoughtServersService,
    BoughtServerPurchases,
    BoughtServerStages,
    BoughtServerNotifications,
    BoughtServersHourly,
    BoughtServerClock,
    BoughtServerChanges,
    BoughtServerChangeSteps,
    BoughtServerSettings,
    DayRates,
    { provide: EXCHANGE_RATE, useClass: EcbExchangeRate },
    BoughtServerDeletion,
    OrphanMachines,
    BoughtServerReprices,
    {
      provide: HETZNER_MACHINES,
      inject: [BoughtServersConfig],
      useFactory: (config: BoughtServersConfig) =>
        new HetznerCloudAdapter(() => config.machinesToken, 'EUR (machines)'),
    },
    {
      provide: HETZNER_PRICES,
      inject: [BoughtServersConfig],
      useFactory: (config: BoughtServersConfig) =>
        new HetznerCloudAdapter(() => config.pricesToken, 'USD (prices)'),
    },
  ],
  exports: [
    BoughtServersConfig,
    BoughtServerStages,
    BoughtServersHourly,
    BoughtServerSettings,
    BoughtServerReprices,
    DayRates,
    OrphanMachines,
    HETZNER_MACHINES,
    HETZNER_PRICES,
  ],
})
export class BoughtServersModule {}
