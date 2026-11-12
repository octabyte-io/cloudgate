import {
  Global,
  Inject,
  Injectable,
  Logger,
  Module,
  OnModuleInit,
} from '@nestjs/common';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import { InstanceMode } from './instance-mode.service';
import { recordInstanceModeAtBoot } from './recorded-mode';

/**
 * The recorded-mode boot check (ADR-0049): the first start records the
 * mode it was given, and a later start whose `HOSTED_MODE` disagrees with the
 * record refuses (`InstanceModeBootError`, naming both).
 *
 * `onModuleInit`, not a provider factory: building the module graph needs no
 * database (the OpenAPI document is reflected off `NestFactory.create` with
 * none), and this module is global, which Nest runs the hooks of before any
 * other module's — so the refusal comes before a module's own `onModuleInit`
 * settles a build or arms a timer.
 */
@Injectable()
export class RecordedInstanceModeCheck implements OnModuleInit {
  private readonly logger = new Logger(RecordedInstanceModeCheck.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly instanceMode: InstanceMode,
  ) {}

  async onModuleInit(): Promise<void> {
    const mode = this.instanceMode.mode;
    if ((await recordInstanceModeAtBoot(this.db, mode)) === 'recorded') {
      this.logger.log(`Recorded instance mode: ${mode}`);
    }
  }
}

/** Global, so every module can ask `InstanceMode` without importing this. */
@Global()
@Module({
  providers: [InstanceMode, RecordedInstanceModeCheck],
  exports: [InstanceMode],
})
export class InstanceModeModule {}
