import type { DeployTarget } from './planner/plan.types';

/**
 * Whether a plan's Deploy target is Cloudgate's own machine (`CONTEXT.md`,
 * **Same-machine warning**; spec #146): the platform host, or a Server whose
 * `sameMachine` was set when its address was saved (`SameMachine`). The
 * planner then notes each create there (`PlanInput.sameMachine`).
 *
 * Never on the Hosted instance, which refuses the platform host outright
 * (ADR-0053) and never shows the warning. A Server's `sameMachine` is false
 * there already; this does not lean on it. A Server that is gone is not.
 */
export function onCloudgateMachine(
  target: DeployTarget,
  given: {
    readonly hosted: boolean;
    /** The target's Server, when it is one and still exists. */
    readonly server?: { readonly sameMachine: boolean };
  },
): boolean {
  if (given.hosted) return false;
  if (target.kind === 'platform-host') return true;
  return target.kind === 'server' && given.server?.sameMachine === true;
}
