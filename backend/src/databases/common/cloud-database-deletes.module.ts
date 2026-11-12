import { Module } from '@nestjs/common';

import { CloudAccountsModule } from '../../cloud-accounts/cloud-accounts.module';
import { CloudDatabaseDeletes } from './cloud-database-deletes';

/**
 * A postgres's or redis's Delete in a Cloud account: imported by
 * those two engine modules, whose Delete, Retry and Forget it runs, and by
 * the Project config module, whose Environment Delete runs each one. It
 * imports only `CloudAccountsModule` (the cloud port, the deploy-role
 * session, Infrastructure states), which imports no Service module, so it
 * closes no cycle.
 */
@Module({
  imports: [CloudAccountsModule],
  providers: [CloudDatabaseDeletes],
  exports: [CloudDatabaseDeletes],
})
export class CloudDatabaseDeletesModule {}
