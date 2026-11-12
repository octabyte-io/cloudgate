import { Global, Logger, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';

export const DRIZZLE = Symbol('DRIZZLE');
export type DrizzleDB = NodePgDatabase<typeof schema> & { $client: Pool };

/**
 * How long a checkout waits for a connection before failing as a request.
 *
 * `pg`'s default is no timeout at all, so while Postgres is away a caller
 * hangs on the checkout for as long as the outage lasts. `socket-access.ts`
 * names the case that makes this more than a slow response: a query hung on an
 * exhausted pool is what holds an authorization lease renewal open past the
 * lease's own expiry, so a renewal that should have failed and been retried
 * instead never returns (ADR-0012).
 */
const POOL_CONNECT_TIMEOUT_MS = 10_000;

/**
 * The one `pg` `Pool` in the app, and the `'error'` listener that keeps the
 * process alive when Postgres goes away.
 *
 * **The listener is not decoration and deleting it re-introduces a crash.**
 * `pg` attaches its own handler to a *checked-out* client, so a query-level
 * failure comes back as a rejected promise — which is why revoking `select`
 * produced two minutes of logged lease-renewal failures and no restart. An
 * *idle* pooled client has no such owner, so when the server closes its
 * connection `pg` re-emits the error on the `BoundPool` itself, and a Node
 * `EventEmitter` that emits `'error'` with no listener throws out of the event
 * loop and terminates the process. Measured: `systemctl stop postgresql` took
 * the backend down 173 ms later, both times, dropping every open socket with a
 * `1006` and no close frame. `pg` already recovers on its own — the pool
 * destroys the broken client and dials a new one on the next checkout — so the
 * whole defect was that the process did not live long enough to let it.
 *
 * Two alternatives were weighed and both are worse. **An `uncaughtException`
 * handler** would cover this and every unrelated programmer error in the
 * process with it; a crash should still mean something (systemd counts it in
 * `NRestarts`), and a global catch-all removes the signal rather than the
 * crash. **Answering at the supervisor** (letting systemd restart it)
 * crash-loops at `RestartSec=5s` for the length of the outage, cuts off every
 * running build (start-up settles it `error`), and drops every
 * WebSocket — while ADR-0012 sized the 120 s lease duration specifically so a
 * socket could "ride out a pool blip or a failover", a promise that presumes
 * the process outlives the blip. Losing the database for a few seconds must
 * degrade requests, not kill the process.
 *
 * What this deliberately does *not* do: no reconnect loop of our own (ADR-0004
 * pins `pg` with a `Pool`, which already has one), no state, no `exit`, and no
 * swallowing of a genuine startup failure. `new Pool` does not dial, so a bad
 * `DATABASE_URL` still surfaces on the first query rather than at boot, and
 * env validation stays fatal in `validateEnv` (§2.8) — this listener makes an
 * outage survivable, not invisible. `GET /health` runs `SELECT 1` and is the
 * readiness probe that says which state the process is in.
 */
@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: DRIZZLE,
      inject: [ConfigService],
      useFactory: (config: ConfigService): DrizzleDB => {
        const logger = new Logger(DrizzleModule.name);
        const pool = new Pool({
          connectionString: config.get<string>('DATABASE_URL'),
          connectionTimeoutMillis: POOL_CONNECT_TIMEOUT_MS,
        });

        pool.on('error', (error) => {
          // Guarded by shape rather than `instanceof Error`: this error is
          // constructed in Node's own realm and fails `instanceof` against a
          // sandboxed `Error` global under jest, the same trap
          // `remote-exec.service.ts` documents.
          const shaped = error as (Error & { code?: string }) | undefined;
          logger.error(
            'Idle Postgres client errored; the pool will replace it on the ' +
              `next checkout: ${shaped?.message ?? String(error)}`,
            shaped?.stack,
          );
        });

        return drizzle(pool, { schema });
      },
    },
  ],
  exports: [DRIZZLE],
})
export class DrizzleModule {}
