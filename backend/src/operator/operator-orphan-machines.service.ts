import { Injectable } from '@nestjs/common';
import { OrphanMachines } from '../bought-servers/orphan-machines.service';
import { PermissionService } from '../rbac/permission.service';
import { OperatorService } from './operator.service';
import type { OperatorCtx } from './operator.service';

/** One machine nothing owns, as the Operator page lists it. */
export interface OperatorOrphanMachineView {
  /** The machine's id at the provider. */
  providerServerId: number;
  name: string;
  /** The provider's Location code, `hel1`. */
  location: string;
  /** Its labels: which Organization and Server it was made for. */
  labels: Record<string, string>;
  /** When the provider made it: its age. */
  createdAt: Date;
  /** When the hourly check first found it, and emailed the Operators. */
  foundAt: Date;
  /** When the hourly check last found it. */
  seenAt: Date;
}

/**
 * The Operator page's **Machines nothing owns** (spec #1387, #1402): the
 * hourly orphan check's list, and Delete, which also deletes the machine's
 * Volumes and Primary IPs and is audited in the Instance organization's log
 * through the Operator write path. Operators only, Hosted only.
 */
@Injectable()
export class OperatorOrphanMachines {
  constructor(
    private readonly orphans: OrphanMachines,
    private readonly operator: OperatorService,
    private readonly permissions: PermissionService,
  ) {}

  /** The machines nothing owns as the last hourly check found them, oldest first. */
  async list(ctx: OperatorCtx): Promise<OperatorOrphanMachineView[]> {
    await this.operator.assertOperator(ctx);
    return (await this.orphans.list()).map((row) => ({
      providerServerId: row.providerServerId,
      name: row.name,
      location: row.location,
      labels: row.labels,
      createdAt: row.machineCreatedAt,
      foundAt: row.foundAt,
      seenAt: row.seenAt,
    }));
  }

  /**
   * Deletes a listed machine with its Volumes and Primary IPs, and records
   * it, with its labels and what went, in the Instance organization's log.
   */
  async delete(ctx: OperatorCtx, providerServerId: number): Promise<void> {
    await this.operator.assertOperator(ctx);
    const deleted = await this.orphans.delete(providerServerId);
    const instanceOrganizationId =
      await this.permissions.instanceOrganizationId();
    if (!instanceOrganizationId) return;
    const instance = await this.operator.targetOf(instanceOrganizationId);
    await this.operator.recordWrite(ctx, instance, {
      type: 'deleteOrphanMachine',
      providerServerId,
      name: deleted.machine.name,
      location: deleted.machine.location,
      labels: deleted.machine.labels,
      machineDeleted: deleted.machineDeleted,
      volumeIds: deleted.volumeIds,
      primaryIpIds: deleted.primaryIpIds,
    });
  }
}
