import { BadRequestException, ConflictException } from '@nestjs/common';
import { eq } from 'drizzle-orm';

import type { StackVmSettings } from '../cloud-accounts/definitions/stack-vm';
import { cleanAppName, generateAppName } from '../db/columns';
import type { DrizzleDB } from '../db/drizzle.module';
import { cloudAccount, compose, stackVmKey } from '../db/schema';
import type { Compose } from '../db/schema';
import {
  claimServiceConfigName,
  mintServiceConfigName,
} from '../environments/config-name';
import type { DrizzleTx } from '../environments/config-name';
import { InstanceMode } from '../instance-mode/instance-mode.service';
import { KEEP_NOTHING } from '../project-config/console-saves';
import type { KeepConfig } from '../project-config/console-saves';
import {
  newConsoleStackVm,
  stackVmFacts,
} from '../project-config/planner/stack-vm';
import type { PermissionCtx } from '../rbac/permission.service';
import { isConnectionFailure } from '../remote/exec-error';
import type { RunTarget } from '../remote/run-target';
import { makeStackVmKey } from '../stack-vm/stack-vm-key';
import {
  STACK_VM_DOWN,
  StackVmPower,
  stackVmNotMadeRefusal,
} from '../stack-vm/stack-vm-power';
import type {
  StackVmRunState,
  StackVmStack,
  StackVmStatus,
} from '../stack-vm/stack-vm-power';
import { sourceTypeOnCreate } from './compose-source-type';
import { StackVmDeletes, stackVmTargetOf } from './stack-vm-deletes';
import type {
  CreateComposeDto,
  SaveComposeStackVmDto,
} from './dto/compose.dto';

/**
 * Said to a console create in a Cloud Environment that names a Server, or
 * the platform host: a stack there runs on its own Stack VM (ADR-0070), and
 * the owner settled that no new one is put on a Server (#1357 open point 1).
 */
export const STACK_VM_TAKES_NO_SERVER =
  "This Environment deploys to a Cloud account, where a Compose stack runs on its own Stack VM, made by the Environment's plan. Leave the Server out";

/** Said to a console create of a Swarm stack in a Cloud Environment. */
export const STACK_VM_RUNS_NO_SWARM =
  'A Stack VM runs docker-compose only, so a Swarm stack (type stack) cannot be created in an Environment that deploys to a Cloud account';

/** Where a plan-created stack in a Cloud account runs: its own Stack VM there. */
export interface ComposeCloudPlace {
  /** The id its plan was read with, which names its Stack VM's identity. */
  readonly composeId: string;
  readonly cloudAccountId: string;
  readonly region: string;
  readonly stackVm: StackVmSettings;
}

/** How long a started Stack VM has to answer through its tunnel. */
const STACK_VM_START_WAIT_MS = 5 * 60_000;
/** How long between tries while it does not answer yet. */
const STACK_VM_START_RETRY_MS = 5_000;

/** What a stack on its Stack VM's row is written with, beside the DTO. */
interface StackVmPlace {
  readonly composeId?: string;
  readonly cloudAccountId: string;
  readonly region: string;
  readonly stackVm: StackVmSettings;
}

/**
 * **The Stack VM half of `ComposeService`** (ADR-0070): the create of a
 * stack in a Cloud account, its Stack VM's facts and setting, its Delete's
 * hand-off to {@link StackVmDeletes}, and what Stop, Start, Restart and the
 * status read ask of its VM. Moved out of `compose.service.ts` as
 * `stack-vm-deletes.ts` was (§1.5's extracted-helper pattern), with the
 * behaviour as it was; the routes stay `ComposeService`'s, which checks the
 * caller before handing a row here.
 *
 * Not a provider: `ComposeService` makes it with the collaborators it was
 * given, so a spec that builds that service by hand still builds this.
 */
export class ComposeStackVms {
  constructor(
    private readonly db: DrizzleDB,
    private readonly instanceMode: InstanceMode,
    private readonly stackVmDeletes?: StackVmDeletes,
    private readonly stackVmPower?: StackVmPower,
  ) {}

  /**
   * A console create of a stack in a Cloud Environment (#1372): its row
   * with its place, the Cloud account and region, and Stack VM settings
   * at `medium` with nothing made, and its own SSH key. Its Stack VM is the
   * Environment's next plan's to make, priced there, once an operator
   * Applies it; until then nothing runs. The stack stays console-managed:
   * the plan makes its VM, never the stack.
   */
  async insertConsole(
    data: CreateComposeDto,
    keep: KeepConfig,
    target: { cloudAccountId: string; region: string },
  ): Promise<Compose> {
    // The platform host named on the Hosted instance is ADR-0053's to
    // answer, in its own sentence; anywhere else a named place is refused
    // here, since the stack's place is its Stack VM.
    if (data.serverId === null)
      this.instanceMode.refusePlatformHost('services');
    if (data.serverId !== undefined) {
      throw new BadRequestException(STACK_VM_TAKES_NO_SERVER);
    }
    if (data.composeType === 'stack') {
      throw new BadRequestException(STACK_VM_RUNS_NO_SWARM);
    }
    const [account] = await this.db
      .select({ cloud: cloudAccount.cloud })
      .from(cloudAccount)
      .where(eq(cloudAccount.cloudAccountId, target.cloudAccountId));
    const stackVm = account ? newConsoleStackVm(account.cloud) : null;
    if (!stackVm) {
      throw new BadRequestException(
        "This Environment's Cloud account makes no Stack VM, so a Compose stack cannot run there",
      );
    }
    const appName = data.appName
      ? cleanAppName(data.appName)
      : generateAppName('compose');
    return this.insertRow(
      data,
      { ...target, stackVm },
      async (tx) => {
        const [taken] = await tx
          .select({ composeId: compose.composeId })
          .from(compose)
          .where(eq(compose.appName, appName))
          .limit(1);
        if (taken) {
          throw new ConflictException(
            "Compose with this 'appName' already exists",
          );
        }
        return {
          appName,
          configName: await mintServiceConfigName(
            tx,
            data.environmentId,
            'compose',
            data.name,
          ),
        };
      },
      keep,
    );
  }

  /**
   * A plan's create of a stack in a Cloud account (ADR-0070): its row
   * with its cloud place and Stack VM settings, never a Server, under the
   * id its plan was read with. No Server is checked or claimed: nothing
   * runs until its Stack VM exists, and the plan was allowed already.
   */
  insertPlanned(
    data: CreateComposeDto,
    configName: string,
    cloud: ComposeCloudPlace,
  ): Promise<Compose> {
    return this.insertRow(
      data,
      cloud,
      async (tx) => ({
        appName: generateAppName('compose'),
        configName: await claimServiceConfigName(
          tx,
          data.environmentId,
          configName,
        ),
      }),
      KEEP_NOTHING,
    );
  }

  /**
   * The row of a stack on its Stack VM, never on a Server, with its own
   * SSH key, which its Stack VM's first boot installs. Both creates' one
   * write, `names` being where they differ: a console create mints its
   * Config name, a plan claims its own. The creator's row-level access is
   * `ComposeService.insertCompose`'s to grant, where the composed-create
   * census finds it.
   */
  private insertRow(
    data: CreateComposeDto,
    place: StackVmPlace,
    names: (tx: DrizzleTx) => Promise<{ appName: string; configName: string }>,
    keep: KeepConfig,
  ): Promise<Compose> {
    return this.db.transaction(async (tx) => {
      const { appName, configName } = await names(tx);
      const [row] = await tx
        .insert(compose)
        .values({
          ...data,
          serverId: null,
          composeFile: data.composeFile ?? '',
          // #1338: a pasted file with no `sourceType` is `raw`.
          sourceType: sourceTypeOnCreate(data),
          appName,
          configName,
          ...place,
        })
        .returning();
      await tx.insert(stackVmKey).values({
        composeId: row.composeId,
        privateKey: makeStackVmKey(configName),
      });
      await keep(tx, { serviceId: row.composeId });
      return row;
    });
  }

  /**
   * Its Stack VM as the stack page shows it, on a stack in a Cloud account
   * (ADR-0070, #1372); `null` on a Server and the platform host.
   */
  async factsOf(found: Pick<Compose, 'cloudAccountId' | 'region' | 'stackVm'>) {
    if (!found.cloudAccountId || !found.region || !found.stackVm) return null;
    const [account] = await this.db
      .select({ cloud: cloudAccount.cloud })
      .from(cloudAccount)
      .where(eq(cloudAccount.cloudAccountId, found.cloudAccountId));
    if (!account) return null;
    return stackVmFacts(
      { cloud: account.cloud, region: found.region },
      found.stackVm,
    );
  }

  /**
   * The stack page's Stack VM setting (#1372) on a stack its caller may
   * update: a console-managed stack's size, and the data disk grown to,
   * which never shrinks below what it has. See `ComposeService.saveStackVm`.
   */
  async save(composeId: string, data: SaveComposeStackVmDto) {
    const [row] = await this.db
      .select({
        composeId: compose.composeId,
        cloudAccountId: compose.cloudAccountId,
        region: compose.region,
        stackVm: compose.stackVm,
      })
      .from(compose)
      .where(eq(compose.composeId, composeId));
    if (!row?.stackVm) {
      throw new BadRequestException(
        'This stack does not run on a Stack VM, so it has none to size',
      );
    }
    if (
      data.dataDiskGb !== undefined &&
      data.dataDiskGb < row.stackVm.dataDiskGb
    ) {
      throw new BadRequestException(
        `A Stack VM's data disk only grows: it has ${row.stackVm.dataDiskGb} GB, so choose at least that`,
      );
    }
    const stackVm: StackVmSettings = {
      ...row.stackVm,
      console: {
        ...row.stackVm.console,
        ...(data.size === undefined ? {} : { sizeName: data.size }),
        ...(data.dataDiskGb === undefined
          ? {}
          : { dataDiskGb: data.dataDiskGb }),
      },
    };
    await this.db
      .update(compose)
      .set({ stackVm })
      .where(eq(compose.composeId, row.composeId));
    return this.factsOf({ ...row, stackVm });
  }

  /**
   * A stack on its own Stack VM's Delete (ADR-0070, #1367), for a stack its
   * caller may delete: no teardown on a machine Cloudgate reaches, since the
   * whole VM goes, but a destroy-only Cloud run in its Cloud account that
   * keeps a final snapshot of its data disk unless `deleteData`. The row
   * stays, `deleting`, until the run finishes clean (ADR-0038); a Delete of
   * one left incomplete Retries it. `null` for a stack not on a Stack VM.
   */
  async remove(
    ctx: PermissionCtx,
    composeId: string,
    deleteData: boolean,
    keep: KeepConfig,
  ): Promise<
    (Compose & { stackVmDelete: { readonly deploymentId: string } }) | null
  > {
    const [found] = await this.db
      .select()
      .from(compose)
      .where(eq(compose.composeId, composeId));
    const target = found ? stackVmTargetOf(found) : null;
    if (!target) return null;
    if (!this.stackVmDeletes) {
      throw new ConflictException(
        `${target.name} runs on a Stack VM, which this Cloudgate cannot delete`,
      );
    }
    const { row, deploymentId } = await this.stackVmDeletes.request(
      ctx,
      target,
      keep,
      { deleteData },
    );
    return { ...(row ?? found), stackVmDelete: { deploymentId } };
  }

  /**
   * Whether the stack's Stack VM runs, read from its cloud now (ADR-0070,
   * #1370). A stack that is not on a Stack VM is refused.
   */
  status(
    row: StackVmStack & Pick<Compose, 'cloudAccountId'>,
  ): Promise<StackVmStatus> {
    if (row.cloudAccountId === null) {
      throw new BadRequestException(
        `${row.configName} runs on a Server or this Cloudgate host, not on a Stack VM`,
      );
    }
    return this.power().state(row);
  }

  /**
   * Whether its Stack VM is down (stopped or stopping), as its cloud reads
   * it now, for Stop and Restart. One no Apply has made yet is refused up
   * front, since nothing can reach it (#1357 review).
   */
  async isDown(row: StackVmStack): Promise<boolean> {
    return STACK_VM_DOWN.has(await this.madeState(row));
  }

  /** Stop's call to its cloud, once the containers have stopped. */
  stop(row: StackVmStack): Promise<void> {
    return this.power().stop(row);
  }

  /**
   * Start's first half: the Stack VM its Stop stopped is started, then
   * waited for until it answers through its tunnel (`target`). The cloud's
   * Start answers once it has taken the call, before the VM has booted.
   * Bounded; any failure but a connection's is the stack's own, and thrown.
   */
  async start(row: StackVmStack, target: RunTarget): Promise<void> {
    await this.power().start(row);
    const deadline = Date.now() + STACK_VM_START_WAIT_MS;
    for (;;) {
      try {
        await target.exec(['true']);
        return;
      } catch (error) {
        if (!isConnectionFailure(error) || Date.now() >= deadline) throw error;
      }
      await new Promise((settle) =>
        setTimeout(settle, STACK_VM_START_RETRY_MS),
      );
    }
  }

  private async madeState(row: StackVmStack): Promise<StackVmRunState> {
    const { state } = await this.power().state(row);
    if (state === 'not-made') throw stackVmNotMadeRefusal(row.configName);
    return state;
  }

  private power(): StackVmPower {
    if (!this.stackVmPower) {
      throw new Error('This service was built without its Stack VMs');
    }
    return this.stackVmPower;
  }
}
