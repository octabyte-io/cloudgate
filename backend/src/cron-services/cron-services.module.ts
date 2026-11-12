import { Module } from '@nestjs/common';
import { ApplicationsModule } from '../applications/applications.module';
import { BackupsModule } from '../backups/backups.module';
import { CronRunsController } from './cron-runs.controller';
import { CRON_RUN_STOPPER } from './cron-run-stopper.port';
import {
  CRON_RUN_POLL_MS,
  CronRunsService,
  DEFAULT_POLL_MS,
} from './cron-runs.service';
import {
  CRON_RUN_SETTLE_TIMER,
  systemCronRunSettleTimer,
} from './cron-service.clock';
import { CronTimetable } from './cron-timetable.service';
import { EcsCronRunPlace } from './ecs-cron-run-place';
import { GoogleCronRunPlace } from './google-cron-run-place';
import { SwarmCronRunPlace } from './swarm-cron-run-place';
import { CloudAccountsModule } from '../cloud-accounts/cloud-accounts.module';

/**
 * Cron services' runs (ADR-0034). A Cron service is stored as an
 * Application, so its row and deployable shape come from
 * `ApplicationsModule`; its Run records are written by the run recorder
 * `BackupsModule` provides. Neither imports this module.
 *
 * The timetable reads which Cron services are armed from their rows,
 * so nothing that creates, changes or destroys one needs to reach it.
 * `CRON_SERVICE_CLOCK` is a provider only so a suite can stand time still;
 * `ApplicationsModule` provides it, since a Cron service's read lists its
 * next fire times on it too.
 */
@Module({
  // An AWS Cloud account's deploy-role session and ECS calls, for a run on
  // ECS, and a Google Cloud account's run session and Cloud Run
  // calls, for a run on Google Cloud.
  imports: [ApplicationsModule, BackupsModule, CloudAccountsModule],
  controllers: [CronRunsController],
  providers: [
    CronRunsService,
    CronTimetable,
    // A run's place: the Server's, as a one-off Swarm job, an AWS
    // Cloud account's, as a one-off ECS task, and a Google Cloud
    // account's, as an execution of its Cloud Run job.
    SwarmCronRunPlace,
    EcsCronRunPlace,
    GoogleCronRunPlace,
    // A provider only so a suite can shorten a run's watch.
    { provide: CRON_RUN_POLL_MS, useValue: DEFAULT_POLL_MS },
    // And so one can move a run's settle read on without sleeping.
    { provide: CRON_RUN_SETTLE_TIMER, useValue: systemCronRunSettleTimer },
    // Cancel, Stop and Delete end runs through it.
    { provide: CRON_RUN_STOPPER, useExisting: CronRunsService },
  ],
  exports: [CronRunsService],
})
export class CronServicesModule {}
