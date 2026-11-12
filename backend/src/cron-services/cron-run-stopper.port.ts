/**
 * Ending a Cron service's runs in flight (ADR-0034), as a port for the
 * two callers that cannot import `CronServicesModule`: `DeploymentsService`'s
 * Cancel, and `ApplicationsService`'s Stop and Delete. `CronServicesModule`
 * imports `ApplicationsModule`, so both resolve this token at call time
 * (`HELD_BUILDS`' shape) and `CronServicesModule` binds it to
 * `CronRunsService`.
 *
 * Imports nothing, so any module can name it.
 */
export const CRON_RUN_STOPPER = Symbol('CRON_RUN_STOPPER');

/** Why a Cron service's runs in flight are being ended, and by whom. */
export interface CronRunsEnding {
  /** A Stop (the pause) or a Delete of the Cron service. */
  kind: 'stopped' | 'deleted';
  /** The member who asked. */
  userId: string;
}

export interface CronRunStopper {
  /**
   * Cancels one run in flight: its output so far kept, its job removed, and
   * only then its Run record settled `cancelled`, saying who. Answers false
   * when the run had already ended (the first settle wins), in which
   * case nothing is changed; refuses, the run still `running`, when its job
   * could not be confirmed gone. The timetable is not touched.
   */
  cancelRun(deploymentId: string, userId: string): Promise<boolean>;

  /**
   * Ends every run of one Cron service still in flight, each settled
   * `cancelled` with a last log line saying it was stopped and why, and a
   * Stop's marked stopped. Answers the jobs whose removal could not be
   * confirmed, whose runs stay `running`, so a Delete can refuse to drop the
   * row of a Service whose run still holds a container; a Stop's are ended
   * again on every tick until they are gone.
   */
  stopRunsOf(applicationId: string, why: CronRunsEnding): Promise<string[]>;
}
