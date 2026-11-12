import { Module } from '@nestjs/common';

import { CloudAccountsModule } from '../cloud-accounts/cloud-accounts.module';
import { StackVmDeletes } from './stack-vm-deletes';

/**
 * A Compose stack on a Stack VM's Delete (#1367): imported by the compose
 * module, whose Delete — the console's and a Plan's destroy — it runs. It
 * imports only `CloudAccountsModule` (the cloud ports, the sessions,
 * Infrastructure states), which imports no Service module, so it closes no
 * cycle, as `CloudDatabaseDeletesModule` does not.
 */
@Module({
  imports: [CloudAccountsModule],
  providers: [StackVmDeletes],
  exports: [StackVmDeletes],
})
export class StackVmDeletesModule {}
