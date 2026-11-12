/**
 * Releasing a plan's held builds, as a port for a caller that cannot
 * import `DeploymentsModule`: the console Saves seam lives below the
 * Service modules, which `DeploymentsModule` reaches, so it resolves this
 * token at call time instead. `DeploymentsModule` binds it to
 * `DeploymentsService`.
 */
export const HELD_BUILDS = Symbol('HELD_BUILDS');

export interface HeldBuilds {
  /** `DeploymentsService.releaseHeldOutsideOpenPlans`. */
  releaseHeldOutsideOpenPlans(environmentId: string): Promise<unknown>;
}
