/**
 * What a cloud `web` Service's definition needs from its Environment network:
 * the ids the network's own Apply saves, or stand-ins for them while
 * the network is not made yet.
 */
export interface NetworkIds {
  readonly vpcId: string;
  /** The two public subnets, one per zone, that tasks run in. */
  readonly publicSubnetIds: readonly [string, string];
  readonly clusterArn: string;
  readonly httpsListenerArn: string;
  readonly albSecurityGroupId: string;
  /**
   * The Cloud Map namespace a Private web service is listed in:
   * absent until a `web-private` has needed one, and only a `web-private`
   * reads it.
   */
  readonly privateDnsNamespaceId?: string;
}

/**
 * The text every stand-in carries, and the one thing the plan reader
 * looks for to show a value as "made by this plan (Environment network)".
 */
export const STAND_IN_MARKER = 'cloudgate-stand-in';

/** Whether a planned value is a stand-in rather than a real AWS id. */
export function isStandIn(value: unknown): boolean {
  return typeof value === 'string' && value.includes(STAND_IN_MARKER);
}

/**
 * The namespace's stand-in, also for a made network whose namespace
 * the same plan adds.
 */
export const PRIVATE_DNS_NAMESPACE_STAND_IN = `ns-${STAND_IN_MARKER}`;

/**
 * Stand-ins for a network the same plan makes (the AWS spec, "Plan behaviour"). A
 * Service's plan never opens the network's state (ADR-0036 item 1), so before
 * the network exists its ids are placeholders. Each has the shape of the real
 * id, ARNs included, because the AWS provider checks an ARN argument's shape
 * at plan time and would refuse a bare word. Nothing is ever applied with
 * them: the Apply makes the network first, saves its ids and plans the
 * Service again with those.
 */
export function networkStandIns(
  region: string,
  awsAccountId: string,
): NetworkIds {
  const arn = (service: string, resource: string) =>
    `arn:aws:${service}:${region}:${awsAccountId}:${resource}`;
  return {
    vpcId: `vpc-${STAND_IN_MARKER}`,
    publicSubnetIds: [
      `subnet-${STAND_IN_MARKER}-a`,
      `subnet-${STAND_IN_MARKER}-b`,
    ],
    clusterArn: arn('ecs', `cluster/${STAND_IN_MARKER}`),
    httpsListenerArn: arn(
      'elasticloadbalancing',
      `listener/app/${STAND_IN_MARKER}/0000000000000000/0000000000000000`,
    ),
    albSecurityGroupId: `sg-${STAND_IN_MARKER}`,
    privateDnsNamespaceId: PRIVATE_DNS_NAMESPACE_STAND_IN,
  };
}

/**
 * The image tag a plan made before the build uses, shown as "new image,
 * built by this deploy". A valid ECR tag, so the task definition still plans.
 */
export const STAND_IN_IMAGE_TAG = `${STAND_IN_MARKER}-new-image`;
