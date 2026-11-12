import type { DeployableApplication } from '../deployment-engine.types';

/**
 * Port for rollback snapshots (Phase 24). The engine records one after a
 * successful build when the application has rollback capture enabled; it only
 * needs the version tag to preserve the released image under.
 */
export const ROLLBACK_RECORDER = Symbol('ROLLBACK_RECORDER');

export interface RollbackSnapshot {
  /** The version tag the released image is preserved as: `{appName}:v{n}`. */
  image: string;
}

export interface RollbackRecorder {
  capture(
    deploymentId: string,
    application: DeployableApplication,
  ): Promise<RollbackSnapshot>;
}
