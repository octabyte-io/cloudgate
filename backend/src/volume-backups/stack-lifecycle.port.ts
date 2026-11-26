import type { ApplicationStatus } from '../applications/application.schema';
import type { MomentRestoreLifecycle } from './volume-backup-commands';

/**
 * What a Stack backup's moment restore needs of the compose stack it
 * restores (ADR-0092), as a port: `ComposeModule` reaches
 * `DeploymentsModule`, which imports `VolumeBackupsModule`, through
 * `GitProvidersModule`, so the volume-backup service cannot import the
 * compose one and resolves this token at call time instead, as a push
 * handler resolves `CONFIG_PUSH_PLANNER`. `ComposeModule` binds it to
 * `ComposeService`.
 */
export const STACK_LIFECYCLE = Symbol('STACK_LIFECYCLE');

export interface StackLifecycle {
  /** Remove containers' and Start's commands for the restore script, or a
   * swarm stack's word that the script stops and starts it itself. */
  momentRestoreLifecycle(
    organizationId: string,
    composeId: string,
  ): Promise<MomentRestoreLifecycle>;
  /** The stack row's status once the restore has ended. */
  updateStatus(composeId: string, status: ApplicationStatus): Promise<unknown>;
}
