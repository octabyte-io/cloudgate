import type { PointTarget } from './cloud-domain';

/**
 * How a Domain write on a cloud `web` reaches AWS: each add, edit,
 * remove and Ask again is its own short Deployment of the Service, a Cloud
 * run with a log and no plan. The runner is `CloudDomainRuns` in the Project
 * config module, which imports this one, so `DomainsService` resolves this
 * token when a cloud Domain is written (`CONFIG_PUSH_PLANNER`'s shape).
 */
export const CLOUD_DOMAIN_RUNNER = Symbol('CLOUD_DOMAIN_RUNNER');

export interface CloudDomainRunner {
  /**
   * Why the Service cannot take a Domain yet, or `null`: its Domains' rules
   * forward to the target group its first deploy makes.
   */
  refusal(applicationId: string): Promise<string | null>;
  /**
   * Records the Service's Domain run and queues it in the Cloud run pool,
   * answering at once with its Deployment's id; the run applies the
   * Service's Domains as the database holds them when it starts.
   */
  queue(input: {
    applicationId: string;
    title: string;
    description: string;
  }): Promise<string>;
  /**
   * What the Service's Domains point at, for the records shown: the
   * Environment network's load balancer, or a `static` site's CloudFront
   * distribution; `null` while it is not made.
   */
  pointTarget(applicationId: string): Promise<PointTarget | null>;
  /**
   * Why a Compose stack on its Stack VM cannot take a Domain yet (#1371),
   * or `null`: its rules reach the Stack VM, which its create's run makes.
   */
  stackRefusal(composeId: string): Promise<string | null>;
  /**
   * Records the stack's Domain run (a Cloud run of the stack) and queues
   * it, answering at once with its Deployment's id; the run applies the
   * stack's Domains as the database holds them when it starts.
   */
  queueStack(input: {
    composeId: string;
    title: string;
    description: string;
  }): Promise<string>;
  /** What the stack's Domains point at: the Environment network's load balancer. */
  stackPointTarget(composeId: string): Promise<PointTarget | null>;
  /**
   * What a stack's Domains in this Environment network would point at,
   * before the stack exists (#1379); `null` while the network is not made.
   */
  networkPointTarget(place: {
    environmentId: string;
    cloudAccountId: string;
    region: string;
  }): Promise<PointTarget | null>;
}
