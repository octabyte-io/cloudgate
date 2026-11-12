import type { ServiceType } from '../../applications/application.schema';
import type {
  BucketLeftAsItWas,
  BucketLeftBehind,
} from '../../buckets/bucket-files';
import type {
  UnreclaimedArtifact,
  UnreclaimedImages,
} from '../../common/teardown-steps';
import type { OrphanedWorkload } from '../../common/workload-presence';
import type { DnsRecord } from '../../domains/domain.schema';
import type { DomainPortMove } from '../../applications/domain-port-move';

/**
 * What an Apply did about a Service's Deployment once a step wrote it.
 *
 * - `queued`: an Application's ordinary Deployment, recorded pending and
 *   queued; a failed build is that Deployment's, never the plan's.
 * - `started`: a database's deploy, which writes no Deployment row
 *   (`BaseDatabaseService.deployInternal`); it runs after the Apply answers
 *   and the database's own status follows it.
 * - `not-deployed`: the step wrote its settings and the deploy was refused
 *   (an Application with no source yet); `message` says why.
 */
export type PlanStepDeploy =
  | { readonly status: 'queued'; readonly deploymentId: string }
  | { readonly status: 'started' }
  | { readonly status: 'not-deployed'; readonly message: string };

/**
 * What a destroy's Delete (ADR-0018) said it left behind, as the Delete
 * answers it beside the row: each field absent rather than empty, so `null`
 * on the step means it left nothing. The step result is the only
 * place these exist once the row is gone, exactly as the Delete's response
 * is for a console Delete.
 *
 * `volumeLeftBehind` is a database's data volume, which a Delete keeps on
 * purpose; it is named when kept (`true`) or unknown (`null`).
 * `bucketLeftBehind` is a bucket the Delete kept because it holds files,
 * could not be read or was only partly emptied.
 */
export interface PlanStepLeftovers {
  readonly unreclaimedArtifacts?: readonly UnreclaimedArtifact[];
  readonly unreclaimedImages?: readonly UnreclaimedImages[];
  readonly orphanedPreviews?: readonly OrphanedWorkload[];
  readonly volumeLeftBehind?: boolean | null;
  readonly bucketLeftBehind?: BucketLeftBehind;
  /**
   * An existing bucket's destroy (ADR-0033): the bucket it left as it
   * was, files and all, and the sentence saying so.
   */
  readonly bucketLeftAsItWas?: BucketLeftAsItWas;
}

/**
 * The Environment network's run, on its step's result: the network
 * it made and the Deployment that records the run, whose log is followed
 * from the result.
 */
export interface PlanStepNetwork {
  readonly environmentNetworkId: string;
  readonly deploymentId: string;
}

/**
 * One step's result, in the order the Apply ran it, which is the plan's
 * step order: the Environment network first, a kind change's
 * create right after its destroy, a link's source before what links
 * to it. A `redeploy` wrote nothing; `deploy` is the Deployment it queued. A step succeeds or fails on its
 * own; `applied` means its settings were written, for a destroy that its
 * Delete removed the Service — or, in a Cloud account, that its Delete's
 * destroy-only Cloud run is queued, named by `deploy` — and for the
 * network that its run made it and its ids are saved.
 *
 * **`running` is the network's alone**: its run takes minutes, so
 * the Apply answers while it runs, the plan already claimed, and writes
 * every result again when the rest has run. A plan whose results still say
 * `running` is an Apply under way.
 */
export interface PlanStepResult {
  /** The Config name; for the network, `Environment network (<region>)`. */
  readonly configName: string;
  readonly action:
    | 'network-create'
    | 'network-change'
    | 'create'
    | 'change'
    | 'redeploy'
    | 'destroy'
    | 'network-remove';
  /**
   * `blocked` is a change to a postgres on RDS that is stopped: it
   * was not tried, and says to Start it first; the rest of the Apply went
   * ahead, so the plan ends `partly-applied`.
   */
  readonly status: 'running' | 'applied' | 'failed' | 'blocked';
  /** Why it failed or is blocked; `null` when it was applied. */
  readonly message: string | null;
  readonly serviceType: ServiceType | null;
  /** The Service it wrote; `null` for a create that failed before writing. */
  readonly serviceId: string | null;
  /** The generated sslip.io host of a plan-created `web`. */
  readonly domain: string | null;
  readonly deploy: PlanStepDeploy | null;
  /** A destroy's leftovers; `null` when it left nothing, or for a non-destroy. */
  readonly leftovers: PlanStepLeftovers | null;
  /** The network step's run; absent on every other step. */
  readonly network?: PlanStepNetwork;
  /**
   * A network removal's DNS records its Domains left at the operator's DNS
   * provider, which Cloudgate never writes; absent on every other step.
   */
  readonly dnsRecordsLeft?: readonly DnsRecord[];
  /**
   * A change of a `web`'s `port` on a Server or the platform host: its
   * Domains on the old port moved to the new one, and those left on
   * another (ADR-0068); absent on every other step.
   */
  readonly domainPortMove?: DomainPortMove;
}
