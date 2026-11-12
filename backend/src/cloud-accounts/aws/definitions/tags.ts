/**
 * Which state a resource belongs to: the three ids every resource in one
 * state shares. With the resource's own address they are Cloudgate's mark
 * (ADR-0036 item 6), which is how a plan finds what it made by tag search and
 * adopts it rather than make it twice.
 */
export interface StateMark {
  readonly cloudAccountId: string;
  readonly environmentId: string;
  readonly stateId: string;
}

/**
 * The four tag keys (ADR-0036 item 6). Values are ids only, never a name or a
 * secret: a tag is readable by anyone with the cloud's read access, and a
 * renamed Environment must not change every resource.
 */
export const TAG_KEYS = {
  cloudAccount: 'cloudgate:cloud-account',
  environment: 'cloudgate:environment',
  state: 'cloudgate:state',
  address: 'cloudgate:address',
} as const;

/**
 * The tags the AWS provider's `default_tags` sets on every taggable resource
 * in one state.
 *
 * `cloudgate:address` is not among them, although ADR-0036 lists all four as
 * `default_tags`: it is the resource's own address in the state
 * (`aws_ecs_service.service`), so it differs per resource and one provider
 * block cannot carry it. It goes in each resource's own `tags` through
 * {@link resourceTags}, which the provider merges with these into `tags_all`,
 * so every taggable resource still ends up with all four.
 */
export function defaultTags(mark: StateMark): Record<string, string> {
  return {
    [TAG_KEYS.cloudAccount]: mark.cloudAccountId,
    [TAG_KEYS.environment]: mark.environmentId,
    [TAG_KEYS.state]: mark.stateId,
  };
}

/**
 * A resource's own tags: its address in the state, and a readable `Name`.
 *
 * The `Name` is built from what never changes for the life of the resource
 * (a Config name, an Environment's id), not from an Environment's or
 * Project's display name: a rename would otherwise change a tag on every
 * resource, and a deploy whose plan carries anything but its new image stops
 * so renaming an Environment would stop every deploy in it.
 */
export function resourceTags(
  address: string,
  name: string,
): Record<string, string> {
  return { [TAG_KEYS.address]: addressTag(address), Name: name };
}

/**
 * A resource address as a tag value can hold it. AWS tag values allow only
 * letters, digits, spaces and `_.:/=+-@`, and SSM and ACM enforce it: the
 * quotes and brackets of a `for_each` instance (`aws_ssm_parameter.variable["API_KEY"]`)
 * were refused in a real account, which moto never checks. So the
 * key goes after a slash instead (`aws_ssm_parameter.variable/API_KEY`); no
 * address Cloudgate writes has a slash of its own.
 */
export function addressTag(address: string): string {
  return address.replace(/\["(.*)"\]$/, '/$1');
}

/** The address a resource's `cloudgate:address` tag names, or `null` without one. */
export function tagAddress(resource: {
  readonly tags: Readonly<Record<string, string>>;
}): string | null {
  const tag = resource.tags[TAG_KEYS.address];
  return tag === undefined ? null : addressOfTag(tag);
}

/** The resource address a `cloudgate:address` tag value names: {@link addressTag} undone. */
export function addressOfTag(tag: string): string {
  const slash = tag.indexOf('/');
  return slash === -1
    ? tag
    : `${tag.slice(0, slash)}["${tag.slice(slash + 1)}"]`;
}
