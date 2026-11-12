import { INFRASTRUCTURE_STATE_SCHEMA } from '../../definitions/tofu-json';
import type { TofuDefinition } from '../../definitions/tofu-json';

/**
 * The parts every Google definition shares: the `pg` backend, the same as
 * AWS's (ADR-0036 item 2), and one `google` provider for the project and
 * region.
 *
 * No credential is written here: the run puts a credential configuration
 * file in its own folder and points the provider at it through the
 * environment (the Google Cloud spec, "The token"), so the definition holds nothing
 * secret. `required_providers` is not written either; the pins live once in
 * `deploy/opentofu/versions.tf.json`.
 *
 * `add_terraform_attribution_label` is off so the provider adds no
 * `goog-terraform-provisioned` label: Cloudgate's labels are the only ones it
 * writes (S5).
 */
export function frame(projectId: string, region: string): TofuDefinition {
  return {
    terraform: {
      backend: {
        pg: {
          schema_name: INFRASTRUCTURE_STATE_SCHEMA,
          skip_schema_creation: true,
          skip_table_creation: true,
          skip_index_creation: true,
        },
      },
    },
    provider: {
      google: {
        project: projectId,
        region,
        add_terraform_attribution_label: false,
      },
    },
  };
}

/**
 * The scheme of the Environment's load balancer: a global external
 * Application Load Balancer. A Service's serverless NEG and backend service
 * must use the same one.
 */
export const LOAD_BALANCING_SCHEME = 'EXTERNAL_MANAGED';

/**
 * A backend service by its full name in the project, as a URL map names it.
 * The backend service is in its Service's state, not the network's, so the
 * network's definition names it rather than referring to it.
 */
export function backendServicePath(projectId: string, name: string): string {
  return `projects/${projectId}/global/backendServices/${name}`;
}

/**
 * A backend bucket by its full name in the project, as a URL map names it:
 * a static site's, in the site's own state, not the network's.
 */
export function backendBucketPath(projectId: string, name: string): string {
  return `projects/${projectId}/global/backendBuckets/${name}`;
}
