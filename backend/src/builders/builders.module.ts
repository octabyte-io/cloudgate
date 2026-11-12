import { Module } from '@nestjs/common';

/**
 * Build strategies are pure command builders consumed via
 * `getBuildCommand`/`getBuildStrategy` (build-strategy.ts) — nothing to
 * inject. The module marks the subsystem boundary for the deploy engine
 * (Phase 21).
 */
@Module({})
export class BuildersModule {}
