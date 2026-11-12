import type { CloudKind } from '../cloud-accounts/cloud-account.schema';
import { ownEntry } from './provider-schema';

/**
 * **Every generated address is a promise** (ADR-0044 rules 2 and 10,
 * Consequences). A `native.aws` or `native.gcp` block names what Cloudgate
 * generates by its full OpenTofu address (`"aws_ecs_service.service"`), so
 * an address's local name is public: renaming one in a builder would leave
 * every file that names it refused ("a web on AWS makes …, not …").
 *
 * - {@link GENERATED_ADDRESSES} is the committed snapshot of every address
 *   the cloud definition builders have generated, per cloud and kind.
 *   `address-snapshot.spec.ts` runs the builders and fails when one
 *   generates an address not listed here (add it), or no longer generates
 *   one listed here with no entry in {@link NATIVE_ADDRESS_RENAMES}. An
 *   address renamed **stays listed**: the snapshot is what operators may
 *   have written, not only what is generated today, so it only grows.
 * - {@link NATIVE_ADDRESS_RENAMES} maps an old address forward to the one
 *   generated now, per cloud and kind. The config reader
 *   ({@link forwardRenamedAddresses}, called by `parseProjectConfig`) reads
 *   a block naming the old address exactly as one naming the new, and the
 *   plan warns naming both, so the operator updates the file when they
 *   choose. A rename's target is always an address generated now: a second
 *   rename of the same resource moves every older entry to the new name
 *   too, so there are no chains to follow.
 *
 * Rejected: deriving the snapshot from the lock tables (`AWS_ADDRESSES`,
 * `GCP_ADDRESSES`). Those say what a native block may name, and a rename
 * would edit them in the same change as the builder, so nothing would
 * notice; the snapshot is read from the builders' output alone, and edited
 * only to add. Rejected too: one rename table per cloud, whatever the
 * kind. An address can be one kind's and stay another's (`aws_s3_bucket.bucket`
 * against `aws_s3_bucket.site`), so a rename is the kind's own.
 *
 * A parameter group is listed by its table key
 * (`aws_elasticache_parameter_group.<family>`): its local name is the
 * family its version runs, which moves with the version by design.
 */

/**
 * A cloud whose native block is keyed by OpenTofu address: every Cloud
 * account's, read from `cloud_kind` (ADR-0043), so a cloud added to the
 * enum is a type error at the snapshot and the rename table until they say
 * what it generates.
 */
export type NativeCloud = CloudKind;

type ByKind<T> = Readonly<Record<string, T>>;

/** The committed snapshot: every address each kind's builder has generated, sorted. */
export const GENERATED_ADDRESSES: Readonly<
  Record<NativeCloud, ByKind<readonly string[]>>
> = {
  aws: {
    web: [
      'aws_acm_certificate.domain',
      'aws_cloudwatch_log_group.service',
      'aws_ecr_lifecycle_policy.service',
      'aws_ecr_repository.service',
      'aws_ecs_service.service',
      'aws_ecs_task_definition.service',
      'aws_iam_role.task',
      'aws_iam_role_policy.buckets',
      'aws_lb_listener_certificate.domain',
      'aws_lb_listener_rule.domain',
      'aws_lb_listener_rule.service',
      'aws_lb_target_group.service',
      'aws_security_group.service',
      'aws_ssm_parameter.variable',
    ],
    'web-private': [
      'aws_cloudwatch_log_group.service',
      'aws_ecr_lifecycle_policy.service',
      'aws_ecr_repository.service',
      'aws_ecs_service.service',
      'aws_ecs_task_definition.service',
      'aws_iam_role.task',
      'aws_iam_role_policy.buckets',
      'aws_security_group.service',
      'aws_service_discovery_service.service',
      'aws_ssm_parameter.variable',
    ],
    worker: [
      'aws_cloudwatch_log_group.service',
      'aws_ecr_lifecycle_policy.service',
      'aws_ecr_repository.service',
      'aws_ecs_service.service',
      'aws_ecs_task_definition.service',
      'aws_iam_role.task',
      'aws_iam_role_policy.buckets',
      'aws_security_group.service',
      'aws_ssm_parameter.variable',
    ],
    cron: [
      'aws_cloudwatch_log_group.service',
      'aws_ecr_lifecycle_policy.service',
      'aws_ecr_repository.service',
      'aws_ecs_task_definition.service',
      'aws_iam_role.task',
      'aws_iam_role_policy.buckets',
      'aws_security_group.service',
      'aws_ssm_parameter.variable',
    ],
    postgres: [
      'aws_db_instance.database',
      'aws_db_subnet_group.database',
      'aws_security_group.database',
    ],
    mysql: [
      'aws_db_instance.database',
      'aws_db_subnet_group.database',
      'aws_security_group.database',
    ],
    redis: [
      'aws_elasticache_parameter_group.<family>',
      'aws_elasticache_replication_group.cache',
      'aws_elasticache_subnet_group.cache',
      'aws_security_group.cache',
    ],
    bucket: [
      'aws_s3_bucket.bucket',
      'aws_s3_bucket_cors_configuration.bucket',
      'aws_s3_bucket_ownership_controls.bucket',
      'aws_s3_bucket_public_access_block.bucket',
      'aws_s3_bucket_server_side_encryption_configuration.bucket',
    ],
    static: [
      'aws_acm_certificate.domain',
      'aws_cloudfront_distribution.site',
      'aws_cloudfront_function.site',
      'aws_cloudfront_origin_access_control.site',
      'aws_s3_bucket.site',
      'aws_s3_bucket_ownership_controls.site',
      'aws_s3_bucket_policy.site',
      'aws_s3_bucket_public_access_block.site',
      'aws_s3_bucket_server_side_encryption_configuration.site',
    ],
    compose: [
      'aws_acm_certificate.domain',
      'aws_dlm_lifecycle_policy.snapshots',
      'aws_ebs_volume.data',
      'aws_iam_instance_profile.stack_vm',
      'aws_iam_role.snapshots',
      'aws_iam_role.stack_vm',
      'aws_iam_role_policy_attachment.session_manager',
      'aws_iam_role_policy_attachment.snapshots',
      'aws_instance.stack_vm',
      'aws_lb_listener_certificate.domain',
      'aws_lb_listener_rule.domain',
      'aws_lb_target_group.stack_vm',
      'aws_lb_target_group_attachment.stack_vm',
      'aws_security_group.stack_vm',
      'aws_volume_attachment.data',
    ],
  },
  gcp: {
    web: [
      'google_artifact_registry_repository.service',
      'google_cloud_run_v2_service.service',
      'google_compute_backend_service.service',
      'google_compute_region_network_endpoint_group.service',
      'google_secret_manager_secret.variable',
      'google_secret_manager_secret_iam_member.variable',
      'google_secret_manager_secret_version.variable',
      'google_service_account.service',
    ],
    'web-private': [
      'google_artifact_registry_repository.service',
      'google_cloud_run_v2_service.service',
      'google_secret_manager_secret.variable',
      'google_secret_manager_secret_iam_member.variable',
      'google_secret_manager_secret_version.variable',
      'google_service_account.service',
    ],
    worker: [
      'google_artifact_registry_repository.service',
      'google_cloud_run_v2_worker_pool.service',
      'google_secret_manager_secret.variable',
      'google_secret_manager_secret_iam_member.variable',
      'google_secret_manager_secret_version.variable',
      'google_service_account.service',
    ],
    cron: [
      'google_artifact_registry_repository.service',
      'google_cloud_run_v2_job.service',
      'google_secret_manager_secret.variable',
      'google_secret_manager_secret_iam_member.variable',
      'google_secret_manager_secret_version.variable',
      'google_service_account.service',
    ],
    postgres: [
      'google_sql_database.database',
      'google_sql_database_instance.database',
      'google_sql_user.user',
    ],
    mysql: [
      'google_sql_database.database',
      'google_sql_database_instance.database',
      'google_sql_user.user',
    ],
    redis: ['google_memorystore_instance.cache'],
    bucket: [
      'google_service_account.bucket',
      'google_storage_bucket.bucket',
      'google_storage_bucket_iam_member.object_user',
      'google_storage_hmac_key.key',
      'google_storage_hmac_key.key_b',
    ],
    static: [
      'google_compute_backend_bucket.site',
      'google_storage_bucket.site',
      'google_storage_bucket_iam_member.load_balancer',
    ],
    compose: [
      'google_compute_backend_service.stack_vm',
      'google_compute_disk.data',
      'google_compute_disk_resource_policy_attachment.snapshots',
      'google_compute_firewall.iap',
      'google_compute_firewall.load_balancer',
      'google_compute_health_check.stack_vm',
      'google_compute_instance.stack_vm',
      'google_compute_instance_group.stack_vm',
      'google_compute_resource_policy.snapshots',
      'google_service_account.stack_vm',
    ],
  },
};

/**
 * Old address → the address generated now, per cloud and kind. Empty while
 * no generated resource has been renamed.
 */
export const NATIVE_ADDRESS_RENAMES: Readonly<
  Record<NativeCloud, ByKind<Readonly<Record<string, string>>>>
> = {
  aws: {},
  gcp: {},
};

export type NativeAddressRenames = typeof NATIVE_ADDRESS_RENAMES;

/** One address a block named by its old name, read as the new one. */
export interface NativeRename {
  /** The old address's full path in the file's spelling (`api.native.aws."…"`). */
  readonly at: string;
  readonly from: string;
  readonly to: string;
}

export type ForwardedBlock<T> =
  | {
      readonly ok: true;
      /** The block with every old address under its new name, in the file's order. */
      readonly block: T;
      readonly renamed: readonly NativeRename[];
    }
  | { readonly ok: false; readonly at: string; readonly message: string };

/**
 * One entry's `native.aws` or `native.gcp` with every old address a rename
 * moved read under its new name, and each one named so the plan
 * can warn. Refused when the block names both the old address and the new:
 * they are one resource, and which of the two wins is not the reader's to
 * pick.
 */
export function forwardRenamedAddresses<T extends Record<string, unknown>>(
  configName: string,
  kind: string,
  cloud: NativeCloud,
  block: T | undefined,
  renames: NativeAddressRenames = NATIVE_ADDRESS_RENAMES,
): ForwardedBlock<T | undefined> {
  const table = ownEntry(renames[cloud], kind);
  if (block === undefined || table === undefined) {
    return { ok: true, block, renamed: [] };
  }
  const renamed: NativeRename[] = [];
  const forwarded: Record<string, unknown> = {};
  for (const [address, value] of Object.entries(block)) {
    const to = ownEntry(table, address);
    if (to === undefined) {
      forwarded[address] = value;
      continue;
    }
    const at = `${configName}.native.${cloud}.${JSON.stringify(address)}`;
    if (Object.hasOwn(block, to)) {
      return {
        ok: false,
        at,
        message: `${at}: refused - Cloudgate now calls it ${to}, which this block also names; keep the settings under ${JSON.stringify(to)} alone`,
      };
    }
    forwarded[to] = value;
    renamed.push({ at, from: address, to });
  }
  return { ok: true, block: forwarded as T, renamed };
}
