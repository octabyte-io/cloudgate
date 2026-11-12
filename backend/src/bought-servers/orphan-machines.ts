import type { BoughtServerStage } from './bought-server.schema';
import {
  ORGANIZATION_LABEL,
  SERVER_LABEL,
} from './bought-server-stages.service';
import type { HetznerServer } from './hetzner/hetzner-cloud.port';

/**
 * The stages after which a Bought Server holds no machine: a machine still
 * behind one is nothing's. Every other stage is **live**, Deleting included,
 * since its own steps delete the machine.
 */
const NOT_LIVE: readonly BoughtServerStage[] = ['deleted', 'failed'];

/** What the orphan check reads of each Bought Server row. */
export interface OwnerRow {
  id: string;
  stage: BoughtServerStage;
  providerServerId: number | null;
}

/**
 * The machines nothing owns (spec #1387, #1402): each one carrying a
 * Cloudgate label (`labelsOf`) with no live Bought Server behind it, by the
 * Server label or by the machine id a row stored. A machine with neither
 * label is not Cloudgate's and is left alone: the account may hold
 * Octabyte's own. Pure; the rows are read after the machines are listed,
 * so a Bought Server whose create is under way already has its row.
 */
export function orphansAmong(
  machines: readonly HetznerServer[],
  rows: readonly OwnerRow[],
): HetznerServer[] {
  const live = rows.filter((row) => !NOT_LIVE.includes(row.stage));
  const liveIds = new Set(live.map((row) => row.id));
  const liveMachines = new Set(
    live
      .map((row) => row.providerServerId)
      .filter((id): id is number => id !== null),
  );
  return machines.filter((machine) => {
    const server = machine.labels[SERVER_LABEL];
    const organization = machine.labels[ORGANIZATION_LABEL];
    if (server === undefined && organization === undefined) return false;
    if (liveMachines.has(machine.id)) return false;
    return server === undefined || !liveIds.has(server);
  });
}
