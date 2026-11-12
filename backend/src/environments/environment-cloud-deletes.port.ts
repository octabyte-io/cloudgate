import type { CloudBucketKept } from '../buckets/bucket-files';
import type { DnsRecord } from '../domains/domain.schema';
import type { PermissionCtx } from '../rbac/permission.service';
import type { EnvironmentNetwork } from './environment-network.schema';
import type { Environment, EnvironmentLeftover } from './environment.schema';

/**
 * How an Environment's Delete reaches what it has in a Cloud account
 * (ADR-0038): its cloud Services' Deletes, then its Environment networks'
 * removals, each a destroy-only Cloud run. The work is
 * `EnvironmentCloudDeletes` in the Project config module, which imports the
 * applications and deployments modules this one cannot (they import it), so
 * `EnvironmentsService` resolves this token when a Delete is asked
 * (`CLOUD_DOMAIN_RUNNER`'s shape). `ProjectsService` injects it.
 */
export const ENVIRONMENT_CLOUD_DELETES = Symbol('ENVIRONMENT_CLOUD_DELETES');

/**
 * The rest of an Environment's Delete once its cloud parts are gone: its
 * Services on a Server or the platform host torn down as a Delete always
 * has, then its row, with `beforeRow` run just before the row goes.
 * Answers what a Server's Delete answers beside the row.
 */
export type FinishEnvironmentDelete = (
  beforeRow: () => Promise<void>,
) => Promise<Record<string, unknown>>;

/** What a Delete in a Cloud account answers at once. */
export interface StartedEnvironmentDelete {
  /** The row, marked `deleting`. */
  readonly environment: Environment;
  /** The DNS records its Domains leave at the operator's DNS provider. */
  readonly dnsRecordsLeft: readonly DnsRecord[];
  /**
   * Its buckets on AWS kept because they hold files or could not be read:
   * gone from Cloudgate already, and named here once.
   */
  readonly bucketsLeftBehind: readonly CloudBucketKept[];
  /** Resolves once the Delete ended: `true` when the Environment is gone. */
  readonly ended: Promise<boolean>;
}

export interface EnvironmentCloudDeletesPort {
  /** Of these Environments, those with a cloud Service or an Environment network. */
  inCloud(environmentIds: readonly string[]): Promise<string[]>;
  /**
   * Refuses the Delete (or its Retry) as {@link request} would, changing
   * nothing: a Project's Delete asks each of its Environments first.
   */
  refusal(environment: Environment, retrying: boolean): Promise<void>;
  /**
   * The Delete, or its Retry: the row `deleting`, the work started.
   * `byCloudgate` is a Retry Cloudgate queues itself at Google's subnet
   * hold (S13), which keeps the tries it has left; one by hand
   * clears them.
   */
  request(
    ctx: PermissionCtx,
    environment: Environment,
    options: {
      readonly retrying: boolean;
      readonly force: boolean;
      readonly finish: FinishEnvironmentDelete;
      readonly byCloudgate?: boolean;
    },
  ): Promise<StartedEnvironmentDelete>;
  /**
   * Cloudgate's own try at Google's subnet hold (S13) for a network
   * no Environment's Delete is under, as a plan's removal of an unused one
   * is: its removal queued again.
   */
  retryHeldNetwork(network: EnvironmentNetwork): Promise<void>;
  /** Forget an incomplete Delete: every row dropped, the list in the audit entry. */
  forget(
    ctx: PermissionCtx,
    environment: Environment,
    finish: FinishEnvironmentDelete,
  ): Promise<{
    readonly environmentId: string;
    readonly forgotten: readonly EnvironmentLeftover[];
  }>;
}
