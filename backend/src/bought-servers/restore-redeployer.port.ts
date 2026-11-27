/**
 * Redeploying one Service after its Bought Server was restored (#181,
 * ADR-0093), as a port: the deploy paths live in modules that import the
 * Bought Servers readiness rule, so `BoughtServerRestoreSteps` resolves this
 * token at call time instead of importing them. `RestoreRedeployerModule`
 * binds it to `RestoreRedeployerAdapter`.
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
   * ran; a refusal to start it is thrown.
   */
  redeploy(
    service: { kind: RedeployedKind; id: string },
    meta: { title: string; description: string },
  ): Promise<void>;
}
