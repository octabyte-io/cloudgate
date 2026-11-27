/**
 * Redeploying one Service after its Bought Server was restored (#181,
 * ADR-0093), as a port: the deploy paths live in modules that import the
 * Bought Servers readiness rule, so `RestoreRedeploys` resolves this token
 * at call time instead of importing them. `RestoreRedeployerModule` binds it
 * to `RestoreRedeployerAdapter`.
 */
export const RESTORE_REDEPLOYER = Symbol('RESTORE_REDEPLOYER');

/** Every deploy path the readiness rule guards, by the Service's kind. */
export type RedeployedKind =
  | 'application'
  | 'compose'
  | 'postgres'
  | 'mysql'
  | 'mariadb'
  | 'mongo'
  | 'redis'
  | 'libsql'
  | 'bucket';

export interface RestoreRedeployer {
  /**
   * Starts the Service's redeploy through the call a person's deploy takes:
   * an Application's or a stack's Deployment queued, a Database's or a
   * Bucket's own deploy. Answers once it is queued or started, not once it
   * ran; a refusal before it starts is thrown, and once it started a
   * failure shows on its Service as its deploy's does.
   */
  redeploy(
    service: { kind: RedeployedKind; id: string },
    meta: { title: string; description: string },
  ): Promise<void>;

  /**
   * Puts an Application's rollback point back through the call a person's
   * Rollback takes, for one whose newest change after the backup was a
   * Rollback to it. A refusal is thrown, as {@link redeploy}'s is.
   */
  rollBack(rollbackId: string): Promise<void>;

  /**
   * Records on the Service a redeploy refused before it started, so it
   * shows failed as a failed deploy would: a Deployment ended `error` with
   * the reason, or a Database's or a Bucket's status `error`.
   */
  recordRefused(
    service: { kind: RedeployedKind; id: string },
    meta: { title: string },
    reason: string,
  ): Promise<void>;
}
