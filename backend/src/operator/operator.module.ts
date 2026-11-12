import { Module } from '@nestjs/common';
import { BoughtServersModule } from '../bought-servers/bought-servers.module';
import { MailModule } from '../mail/mail.module';
import { RbacModule } from '../rbac/rbac.module';
import { OperatorAbuseController } from './operator-abuse.controller';
import { OperatorAbuse } from './operator-abuse.service';
import { OperatorBoughtServerReprices } from './operator-bought-server-reprices.service';
import { OperatorBoughtServers } from './operator-bought-servers.service';
import { OperatorOrphanMachines } from './operator-orphan-machines.service';
import { OperatorController } from './operator.controller';
import { OperatorService } from './operator.service';

/**
 * The hosted-only Operator page (ADR-0050). InstanceMode and the lapse
 * notifications come from global modules; the Bought Servers section reads
 * its settings, the day's rate and the EUR price list from Bought Servers.
 * The abuse actions (#1401) send their own email, so Mail too.
 */
@Module({
  imports: [RbacModule, BoughtServersModule, MailModule],
  controllers: [OperatorController, OperatorAbuseController],
  providers: [
    OperatorService,
    OperatorBoughtServers,
    OperatorOrphanMachines,
    OperatorAbuse,
    OperatorBoughtServerReprices,
  ],
  exports: [OperatorService],
})
export class OperatorModule {}
