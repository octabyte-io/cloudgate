import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OnApplicationBootstrap } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import { InstanceMode } from '../instance-mode/instance-mode.service';
import { SameMachine } from './same-machine';
import { server } from './server.schema';

/**
 * **Works out every Server's `sameMachine` again at each start**, Self-hosted
 * only (spec #146).
 *
 * The flag is worked out when an address is saved, which leaves two rows
 * wrong until their address is saved again: a Server saved before the column
 * existed (the migration can only write `false`, since the box's own
 * addresses are not knowable from SQL), and one whose answer has since
 * changed because the box's own addresses did (a new public IP, a changed
 * `CLOUDGATE_PUBLIC_HOST`, a name that now resolves elsewhere). Once per
 * start catches both without making a Server read resolve a name.
 *
 * It runs in the background and never fails the boot: a Server whose check
 * throws is logged and left as it was, and a read that fails is logged. Each
 * check is bounded by `SAME_MACHINE_TIMEOUT_MS`. Not done on the Hosted
 * instance, where the answer is always false and every row already says so.
 */
@Injectable()
export class SameMachineRecheck implements OnApplicationBootstrap {
  private readonly logger = new Logger(SameMachineRecheck.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly instanceMode: InstanceMode,
    private readonly sameMachine: SameMachine,
  ) {}

  onApplicationBootstrap(): void {
    void this.run().catch((error: unknown) => {
      this.logger.error(
        'Same-machine recheck could not read the Servers',
        error,
      );
    });
  }

  /** One pass over every Server; answers how many rows it changed. */
  async run(): Promise<number> {
    if (this.instanceMode.isHosted) return 0;
    const rows = await this.db
      .select({
        serverId: server.serverId,
        ipAddress: server.ipAddress,
        sameMachine: server.sameMachine,
      })
      .from(server);
    let changed = 0;
    for (const row of rows) {
      try {
        const now = await this.sameMachine.isSameMachine(row.ipAddress);
        if (now === row.sameMachine) continue;
        await this.db
          .update(server)
          .set({ sameMachine: now })
          .where(eq(server.serverId, row.serverId));
        changed += 1;
      } catch (error) {
        this.logger.warn(
          `Same-machine recheck skipped Server ${row.serverId}: ${String(error)}`,
        );
      }
    }
    if (changed > 0) {
      this.logger.log(`Same-machine recheck updated ${changed} Server(s)`);
    }
    return changed;
  }
}
