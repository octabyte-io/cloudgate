import { Module } from '@nestjs/common';
import { SchedulingModule } from '../scheduling/scheduling.module';
import { systemTokenSpendClock, TOKEN_SPEND_CLOCK } from './token-spend';
import {
  EnvironmentTokenSpendController,
  ProjectTokenSpendController,
  TokenSpendController,
} from './token-spend.controller';
import { TokenSpendRetentionService } from './token-spend-retention.service';
import { TokenSpendService } from './token-spend.service';

/**
 * **Token spend**: the nightly rollup and prune of the Gateway's usage
 * rows, the REST read of an AI model's spend, and the Environment and
 * Project totals over the AI models a reader can read.
 * `PermissionService` is `@Global()`.
 */
@Module({
  imports: [SchedulingModule],
  controllers: [
    TokenSpendController,
    EnvironmentTokenSpendController,
    ProjectTokenSpendController,
  ],
  providers: [
    TokenSpendService,
    TokenSpendRetentionService,
    { provide: TOKEN_SPEND_CLOCK, useValue: systemTokenSpendClock },
  ],
  exports: [TokenSpendService],
})
export class TokenSpendModule {}
