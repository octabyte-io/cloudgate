import type { InstanceMode } from '../../instance-mode/instance-mode.service';
import {
  AWS_POLICY_VERSION,
  awsPolicyVersion,
  requiredActions,
  setupTemplate,
  simulationChecks,
} from './setup-template';

/**
 * The generated policy's version table, as the Cloud account checks
 * read it: the current version, each version's actions, the simulation that
 * holds a role to a version, and the setup template of a version.
 *
 * A seam, injected under {@link AWS_POLICY}, because "permissions out of
 * date" needs a Cloudgate newer than the one that checked the role, and
 * Cloudgate ships one version: a spec hands in a table with a second one
 * (CODING_STANDARDS §1.7, doubles only at a seam).
 */
export interface AwsPolicy {
  readonly version: number;
  readonly requiredActions: (version: number) => string[];
  readonly simulationChecks: typeof simulationChecks;
  readonly setupTemplate: typeof setupTemplate;
}

export const AWS_POLICY = Symbol('AWS_POLICY');

/** The version table this Cloudgate ships, at its newest version. */
export const SHIPPED_AWS_POLICY: AwsPolicy = {
  version: AWS_POLICY_VERSION,
  requiredActions,
  simulationChecks,
  setupTemplate,
};

/**
 * The shipped table at the version this instance's mode needs: the
 * Hosted instance's newest, which adds a cloud build's CodeBuild, and a
 * Self-hosted instance's version 2, which it builds without, so its Cloud
 * accounts are never told to re-run setup. The mode is read on each use,
 * through the instance-mode module, never copied.
 */
export function instanceAwsPolicy(
  mode: Pick<InstanceMode, 'isHosted'>,
): AwsPolicy {
  const current = () => awsPolicyVersion(mode.isHosted);
  return {
    get version() {
      return current();
    },
    requiredActions,
    simulationChecks: (ids, version = current()) =>
      simulationChecks(ids, version),
    setupTemplate: (input, version = current()) =>
      setupTemplate(input, version),
  };
}
