import { Module } from '@nestjs/common';
import { TraceStoreTransport } from './trace-store-proxy';
import { TracesController } from './traces.controller';
import { TracesService } from './traces.service';

/**
 * Traces (ADR-0028): a Service's traces setting and its Trace
 * store.
 *
 * The setting's API is here. The store on its machine is
 * `trace-store.ts`' plain functions — named, started, restarted and
 * reclaimed — which the deployment engine, a Rollback and both Deletes call
 * with the `db` and `remoteExec` they already hold, so no Service module
 * imports this one and nothing here imports a Service module.
 */
@Module({
  controllers: [TracesController],
  providers: [TracesService, TraceStoreTransport],
})
export class TracesModule {}
