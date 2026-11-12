import type { StateResource } from '../cloud.port';
import { managedResources, stringsOf, text } from '../tofu/state-show';
import type { TofuStateShow } from '../tofu/state-show';
import { TAG_KEYS } from './definitions/tags';

/**
 * The resources an AWS state holds, as an operator may see them (ADR-0036 item
 * 3): each one's type, AWS id, region and tags, and whether a
 * tag search can find it — **never a setting's value**. This is the only
 * reading of an AWS state that leaves the tofu runner, so nothing else of it
 * is copied: not a task definition's environment, a parameter's value, an
 * output, an address. Google's is `gcp/state-resources.ts`.
 *
 * - **AWS id**: the resource's `id` (a `vpc-…`, an ECS service's ARN, a
 *   role's name), else its `arn`.
 * - **Region**: the resource's own `region` (AWS provider 6), else the
 *   state's; an IAM resource is `global`.
 * - **Tags**: `tags_all` (the provider's `default_tags` merged in), else
 *   `tags`. Tag values are ids and names only (`tags.ts`), so they may show.
 * - **Findable by tag**: Resource Groups Tagging finds a resource only by a
 *   tag it carries, and never an IAM one. A resource without Cloudgate's
 *   state tag (an association, a policy attachment) or an IAM role is "not
 *   findable by tag": if its state were lost, Recovery by tag could
 *   not adopt it.
 */
export function stateResources(
  show: TofuStateShow,
  region: string,
): StateResource[] {
  return managedResources(show).map(({ type, values }) =>
    projected(type, values, region),
  );
}

function projected(
  type: string,
  values: Record<string, unknown>,
  region: string,
): StateResource {
  const iam = type.startsWith('aws_iam_');
  const tags = stringsOf(values.tags_all) ?? stringsOf(values.tags) ?? {};
  return {
    type,
    awsId: text(values.id) ?? text(values.arn) ?? '',
    region: iam ? 'global' : (text(values.region) ?? region),
    tags,
    findableByTag: !iam && TAG_KEYS.state in tags,
  };
}
