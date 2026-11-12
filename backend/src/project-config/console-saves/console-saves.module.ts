import { Module } from '@nestjs/common';

import { ConsoleSaves } from './console-saves.service';

/**
 * The console Saves seam as its own module, apart from
 * `ProjectConfigModule`: every Service kind's module imports this one, and
 * `ProjectConfigModule` imports those, so the seam depends on none of them —
 * only the database, the format, the planner and the generator.
 */
@Module({
  providers: [ConsoleSaves],
  exports: [ConsoleSaves],
})
export class ConsoleSavesModule {}
