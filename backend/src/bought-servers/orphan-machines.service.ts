import {
  BadGatewayException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { asc, eq, inArray, notInArray } from 'drizzle-orm';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import { PermissionService } from '../rbac/permission.service';
import { BoughtServerNotifications } from './bought-server-notifications.service';
import { boughtServer } from './bought-server.schema';
import {
  HETZNER_MACHINES,
  HETZNER_NOT_FOUND,
} from './hetzner/hetzner-cloud.port';
import type {
  HetznerAction,
  HetznerAnswer,
  HetznerCloudPort,
  HetznerServer,
} from './hetzner/hetzner-cloud.port';
import { boughtServerOrphan } from './orphan-machine.schema';
import type { BoughtServerOrphan } from './orphan-machine.schema';
import { orphansAmong } from './orphan-machines';

/** What one orphan check found, by machine id. */
export interface OrphanCheck {
  /** Every machine nothing owns now. */
  orphans: number[];
  /** Those found for the first time, and emailed. */
  found: number[];
}

/** What an Operator's Delete removed at the provider. */
export interface OrphanDeleted {
  machine: BoughtServerOrphan;
  /** False when the machine was gone already. */
  machineDeleted: boolean;
  volumeIds: number[];
  primaryIpIds: number[];
}

/** How many times the machine's delete action is read before giving up. */
const ACTION_READS = 30;
const ACTION_READ_INTERVAL_MS = 2_000;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * **Machines nothing owns** (spec #1387, #1402), Hosted instance only: the
 * hourly check that lists the provider's machines by Cloudgate's labels and
 * keeps those with no live Bought Server behind them (`orphansAmong`), and
 * the Operator's Delete of one.
 *
 * The check never deletes a machine: a database restored from a backup
 * leaves live customers' machines with no record too. It emails the
 * Operators about each machine once, the first time it is found, and keeps
 * the list the Operator page shows (`bought_server_orphan`).
 */
@Injectable()
export class OrphanMachines {
  private readonly logger = new Logger(OrphanMachines.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    @Inject(HETZNER_MACHINES) private readonly machines: HetznerCloudPort,
    private readonly notifications: BoughtServerNotifications,
    private readonly permissions: PermissionService,
  ) {}

  /**
   * One check: the machines are listed first and the rows read after, so a
   * Bought Server whose machine is being made already has its row. Null
   * when the provider could not be read: the list stays as it was.
   */
  async check(now: Date): Promise<OrphanCheck | null> {
    const listed = await this.machines.listServers({});
    if (!listed.ok) {
      this.logger.warn(
        `The orphan check could not list the machines: ${listed.code}: ${listed.message}`,
      );
      return null;
    }
    const rows = await this.db
      .select({
        id: boughtServer.id,
        stage: boughtServer.stage,
        providerServerId: boughtServer.providerServerId,
      })
      .from(boughtServer);
    const orphans = orphansAmong(listed.value, rows);
    const ids = orphans.map((machine) => machine.id);

    // Gone, or owned again: off the list.
    await this.db
      .delete(boughtServerOrphan)
      .where(
        ids.length > 0
          ? notInArray(boughtServerOrphan.providerServerId, ids)
          : undefined,
      );
    if (ids.length === 0) return { orphans: [], found: [] };

    const known = new Set(
      (
        await this.db
          .select({ id: boughtServerOrphan.providerServerId })
          .from(boughtServerOrphan)
          .where(inArray(boughtServerOrphan.providerServerId, ids))
      ).map((row) => row.id),
    );
    const found: BoughtServerOrphan[] = [];
    for (const machine of orphans) {
      const facts = factsOf(machine);
      if (known.has(machine.id)) {
        await this.db
          .update(boughtServerOrphan)
          .set({ ...facts, seenAt: now })
          .where(eq(boughtServerOrphan.providerServerId, machine.id));
        continue;
      }
      // A second check at the same moment inserts nothing, so emails nothing.
      const [inserted] = await this.db
        .insert(boughtServerOrphan)
        .values({ ...facts, foundAt: now, seenAt: now })
        .onConflictDoNothing()
        .returning();
      if (inserted) found.push(inserted);
    }

    if (found.length > 0) {
      this.logger.warn(
        `Found ${found.length} machine(s) nothing owns: ${found
          .map((machine) => machine.providerServerId)
          .join(', ')}`,
      );
      await this.notifications.sendOrphansFound(
        await this.permissions.instanceOrganizationId(),
        found,
      );
    }
    return { orphans: ids, found: found.map((row) => row.providerServerId) };
  }

  /** The machines nothing owns as the last check found them, oldest first. */
  list(): Promise<BoughtServerOrphan[]> {
    return this.db
      .select()
      .from(boughtServerOrphan)
      .orderBy(
        asc(boughtServerOrphan.machineCreatedAt),
        asc(boughtServerOrphan.providerServerId),
      );
  }

  /**
   * Deletes a listed machine with its backups, then its Volumes and
   * Primary IPs, which the provider detaches from a deleted machine and
   * keeps billing. Refused (409) when a live Bought Server owns it now, as
   * after a restore whose rows came back; gone already counts as done. The
   * row goes once everything has. The caller audits.
   */
  async delete(providerServerId: number): Promise<OrphanDeleted> {
    const [listed] = await this.db
      .select()
      .from(boughtServerOrphan)
      .where(eq(boughtServerOrphan.providerServerId, providerServerId))
      .limit(1);
    if (!listed) {
      throw new NotFoundException(
        `Machine ${providerServerId} is not among the machines nothing owns`,
      );
    }

    const current = await this.machines.getServer(providerServerId);
    if (!current.ok && current.code !== HETZNER_NOT_FOUND) {
      throw this.refused(`reading machine ${providerServerId}`, current);
    }
    const machine = current.ok ? current.value : null;

    let machineDeleted = false;
    if (machine) {
      const rows = await this.db
        .select({
          id: boughtServer.id,
          stage: boughtServer.stage,
          providerServerId: boughtServer.providerServerId,
        })
        .from(boughtServer);
      if (orphansAmong([machine], rows).length === 0) {
        await this.forget(providerServerId);
        throw new ConflictException(
          `Machine ${providerServerId} belongs to a live Bought Server now, so it was not deleted`,
        );
      }
      const deleted = await this.machines.deleteServer(providerServerId);
      if (!deleted.ok && deleted.code !== HETZNER_NOT_FOUND) {
        throw this.refused(`deleting machine ${providerServerId}`, deleted);
      }
      if (deleted.ok) await this.settled(deleted.value);
      machineDeleted = true;
    }

    // What the check saw, and what the machine held just now: a Delete cut
    // off after the machine went still finds its Volumes and Primary IPs.
    const volumeIds = unique([
      ...listed.volumeIds,
      ...(machine?.volumeIds ?? []),
    ]);
    const primaryIpIds = unique([
      ...listed.primaryIpIds,
      ...(machine ? primaryIpsOf(machine) : []),
    ]);
    for (const volumeId of volumeIds) {
      const answer = await this.machines.deleteVolume(volumeId);
      if (!answer.ok && answer.code !== HETZNER_NOT_FOUND) {
        throw this.refused(`deleting Volume ${volumeId}`, answer);
      }
    }
    for (const ipId of primaryIpIds) {
      const answer = await this.machines.deletePrimaryIp(ipId);
      if (!answer.ok && answer.code !== HETZNER_NOT_FOUND) {
        throw this.refused(`deleting Primary IP ${ipId}`, answer);
      }
    }

    await this.forget(providerServerId);
    this.logger.log(
      `Machine ${providerServerId}, which nothing owned, deleted with its Volumes and Primary IPs`,
    );
    return { machine: listed, machineDeleted, volumeIds, primaryIpIds };
  }

  private async forget(providerServerId: number): Promise<void> {
    await this.db
      .delete(boughtServerOrphan)
      .where(eq(boughtServerOrphan.providerServerId, providerServerId));
  }

  /** Waits for the machine's delete, so its Volumes and Primary IPs are detached. */
  private async settled(action: HetznerAction): Promise<void> {
    let current = action;
    for (let read = 0; current.status === 'running'; read++) {
      if (read >= ACTION_READS) {
        throw new BadGatewayException(
          'The machine is still being deleted; press Delete again in a minute to delete its Volume and Primary IPs',
        );
      }
      await sleep(ACTION_READ_INTERVAL_MS);
      const next = await this.machines.getAction(action.id);
      if (!next.ok) throw this.refused(`reading action ${action.id}`, next);
      current = next.value;
    }
    if (current.status === 'error') {
      throw new BadGatewayException(
        `The provider could not delete the machine: ${current.error?.code}: ${current.error?.message}`,
      );
    }
  }

  private refused(
    what: string,
    answer: Extract<HetznerAnswer<unknown>, { ok: false }>,
  ): BadGatewayException {
    this.logger.warn(`${what} was refused: ${answer.code}: ${answer.message}`);
    return new BadGatewayException(
      `The provider refused ${what}: ${answer.code}: ${answer.message}`,
    );
  }
}

/** The facts the list keeps of a machine. */
function factsOf(machine: HetznerServer) {
  return {
    providerServerId: machine.id,
    name: machine.name,
    location: machine.location,
    labels: machine.labels,
    volumeIds: machine.volumeIds,
    primaryIpIds: primaryIpsOf(machine),
    machineCreatedAt: new Date(machine.created),
  };
}

function primaryIpsOf(machine: HetznerServer): number[] {
  return [machine.primaryIpv4Id, machine.primaryIpv6Id].filter(
    (id): id is number => id !== null,
  );
}

function unique(ids: number[]): number[] {
  return [...new Set(ids)];
}
