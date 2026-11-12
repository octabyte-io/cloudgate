/**
 * What marks a `deployment` row as a **Run record** of a Cron service rather
 * than one of its Build deployments (ADR-0034 amending ADR-0017). Both
 * hang off the `application` parent; a run carries this, a build never does.
 *
 * Imports nothing, so the table and every writer can name it.
 */
export interface CronRunMark {
  /**
   * The one-off job the run is: the Service's `appName` plus a short run
   * id, so two runs never share a name. Kept so the run can be found again
   * by name (a timeout, a restart, a cancel). On ECS it is the task's
   * `startedBy`, and the task is found by {@link taskArn}; on
   * Google Cloud it is Cloudgate's name only, and the run is found by its
   * {@link execution}.
   */
  job: string;
  /**
   * The image the run started from, resolved when it started: the last
   * successful build's. A build that lands while it runs does not change it.
   */
  image: string;
  /** Who or what started it. */
  startedBy: CronRunStarter;
  /**
   * Set when its Cron service's Stop ended it: its status is
   * `cancelled`, and this is what reads it as stopped rather than cancelled.
   */
  stopped?: true;
  /**
   * The one-off ECS task the run is, in a Cloud account: saved once
   * `RunTask` answers, since the record is written before the run starts,
   * so the run can be watched, stopped and recovered by it.
   */
  taskArn?: string;
  /**
   * The execution of its Cron service's Cloud Run job the run is, in a
   * Google Cloud account: its short name, saved once `jobs.run`
   * answers, as an ECS task's ARN is.
   */
  execution?: string;
  /**
   * Where the copy of the run's own output into its log has reached, so a
   * run picked up again reads on from there: the task's CloudWatch stream's
   * forward token on ECS, the last copied entry's timestamp and
   * insert ids in Cloud Logging on Google Cloud.
   */
  logFrom?: string;
}

/**
 * What a Cron service's last successful build registered in an AWS Cloud
 * account: the task definition revision each run starts from, so a
 * run in flight keeps its revision, and the Cron service's own security
 * group its tasks sit in.
 */
export interface CronTask {
  taskDefinitionArn: string;
  securityGroupId: string;
}

/** A member who pressed Run now, or the Cron service's timetable. */
export type CronRunStarter =
  { kind: 'member'; userId: string; name: string } | { kind: 'timetable' };

/** How a run's starter reads in its log and its description. */
export function starterWords(starter: CronRunStarter): string {
  return starter.kind === 'member' ? starter.name : 'the timetable';
}
