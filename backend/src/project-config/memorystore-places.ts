import type { GcpCloudAccount } from '../cloud-accounts/cloud-provider';
import { memorystoreDefinition } from '../cloud-accounts/gcp/definitions/memorystore-definition';
import type { TofuDefinition } from '../cloud-accounts/definitions/tofu-json';
import type { GcpNetworkNames } from '../cloud-accounts/gcp/definitions/stand-ins';
import type { Redis } from '../db/schema';
import { memorystoreNativeColumns } from '../native/gcp-console-owned';
import type { NativeGcpBlock } from '../native/gcp-native';
import { memorystoreEngineVersion } from './planner/memorystore';

/**
 * The OpenTofu definition of a redis already on Memorystore, from its saved
 * row, as `savedCloudSqlDefinition` is a Cloud SQL instance's: the
 * node type and engine version the row holds (the ones it was made on, or moved
 * to), unless the caller names the ones a change moves to, and
 * the high availability its page holds. A version naming only its
 * major so keeps the minor it was made on when Google offers a newer one.
 * A change's read writes it with the step's node type and version before
 * the Apply saves them; the Apply's Cloud run
 * writes it after, from the row alone, so both write the same definition.
 * No secret is in it: Google makes the token. Its backups are its Backups
 * tab's retention, or none on one made before backups (no retention
 * in what its last Apply wrote) until a change's read names the retention
 * its catch-up writes. Its `native.gcp` is laid last: the step's
 * on a change's read, else the row's, its high availability and backup
 * days written as native sets them, as its Apply saves them.
 */
export function savedMemorystoreDefinition(input: {
  readonly row: Redis;
  readonly account: GcpCloudAccount;
  readonly stateId: string;
  readonly network: Pick<GcpNetworkNames, 'networkName'>;
  readonly nodeType?: string;
  readonly engineVersion?: string;
  /** The retention a change moves to, before its Apply records it. */
  readonly backupRetentionDays?: number;
  /**
   * The `native.gcp` a change's read lays, before the Apply saves
   * it; absent, the one the row holds, which every Cloud run lays.
   */
  readonly native?: NativeGcpBlock | null;
}):
  | { readonly ok: true; readonly definition: TofuDefinition }
  | { readonly ok: false; readonly message: string } {
  const { row } = input;
  const name = row.configName ?? row.name;
  if (!row.cloudAccountId || !row.region) {
    return { ok: false, message: `${name} does not run in a Cloud account` };
  }
  const nodeType = input.nodeType ?? row.nodeType;
  if (!nodeType) {
    return {
      ok: false,
      message: `${name} has no Memorystore node type saved. Check for changes, then apply the new plan`,
    };
  }
  // One made before versions were saved has none saved: its written version, as then.
  let engineVersion = input.engineVersion ?? row.memorystoreEngineVersion;
  if (!engineVersion) {
    const read = memorystoreEngineVersion(name, row.dockerImage);
    if (!read.ok) return { ok: false, message: read.message };
    engineVersion = read.engineVersion;
  }
  const native = input.native !== undefined ? input.native : row.nativeGcp;
  // What native sets of the console's settings wins over them.
  const owned = memorystoreNativeColumns(native);
  return {
    ok: true,
    definition: memorystoreDefinition({
      serviceId: row.redisId,
      cloudAccountId: input.account.cloudAccountId,
      projectId: input.account.cloudId,
      region: row.region,
      environmentId: row.environmentId,
      stateId: input.stateId,
      network: input.network,
      nodeType,
      engineVersion,
      highAvailability:
        owned.memorystoreHighAvailability ?? row.memorystoreHighAvailability,
      backupRetentionDays:
        owned.memorystoreBackupRetentionDays ??
        input.backupRetentionDays ??
        (row.memorystoreApplied?.backupRetentionDays === undefined
          ? null
          : row.memorystoreBackupRetentionDays),
      native,
    }),
  };
}
