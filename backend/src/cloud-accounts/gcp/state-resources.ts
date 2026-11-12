import type { GoogleStateResource } from '../cloud.port';
import { managedResources, stringsOf, text } from '../tofu/state-show';
import type { TofuStateShow } from '../tofu/state-show';
import { LABEL_KEYS } from './definitions/mark';

/**
 * The kinds whose Google name is a short id of their own rather than their
 * `name`, which the provider gives as Google's full resource name.
 */
const SHORT_NAME_FIELD: Readonly<Record<string, string>> = {
  google_service_account: 'account_id',
  google_secret_manager_secret: 'secret_id',
  google_artifact_registry_repository: 'repository_id',
  google_memorystore_instance: 'instance_id',
};

/**
 * The kinds with no region of their own that live in their parent's, the
 * Cloud SQL instance's: in the state's region rather than `global`.
 */
const IN_PARENTS_REGION = new Set(['google_sql_database', 'google_sql_user']);

/**
 * The resources a Google state holds, as an operator may see them (as on AWS;
 * ADR-0036 item 3): each one's type, Google name, region
 * and labels, and whether it carries Cloudgate's — **never a setting's
 * value**. This is the only reading of a Google state that leaves the tofu
 * runner, so nothing else of it is copied: not a secret version's data, a
 * Cloud Run service's environment, an output. AWS's is
 * `aws/state-resources.ts`.
 *
 * - **Google name**: the fixed name Cloudgate gave it (S4) — a service
 *   account's, a secret's, a repository's or a Memorystore instance's own
 *   short id, else its `name` — and Google's full id for a kind with no
 *   name (a secret's access binding).
 * - **Region**: its own `region` or `location`; a kind with neither is
 *   `global`, but for a Cloud SQL database or user, in its instance's. A
 *   network endpoint group's `region` is Google's full link to the region
 *   (the live walk): only its last part is shown.
 * - **Labels**: `effective_labels` (every label Google holds on it), else
 *   `labels`. Label values are ids' keys only (`mark.ts`), so they may show.
 * - **Labelled**: whether it carries Cloudgate's state label. Networks,
 *   subnets and most compute kinds take no labels at all:
 *   they are "not findable by mark", and a plan against a lost state finds
 *   them by their fixed name instead.
 */
export function googleStateResources(
  show: TofuStateShow,
  region: string,
): GoogleStateResource[] {
  return managedResources(show).map(({ type, values }) => {
    const labels =
      stringsOf(values.effective_labels) ?? stringsOf(values.labels) ?? {};
    const short = SHORT_NAME_FIELD[type];
    return {
      type,
      googleName:
        (short ? text(values[short]) : null) ??
        text(values.name) ??
        text(values.id) ??
        '',
      region: lastSegment(
        text(values.region) ??
          text(values.location) ??
          (IN_PARENTS_REGION.has(type) ? region : 'global'),
      ),
      labels,
      labelled: LABEL_KEYS.state in labels,
    };
  });
}

/** `us-central1` from the last part of a region self-link (`…/compute/v1/projects/p/regions/us-central1`). */
function lastSegment(value: string): string {
  return value.slice(value.lastIndexOf('/') + 1);
}
