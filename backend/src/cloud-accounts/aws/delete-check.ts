import type { AwsCloudPort, AwsCredential, TofuShow } from '../cloud.port';
import { TAG_KEYS } from './definitions/tags';

/**
 * Something a cloud Delete should have removed and did not (ADR-0038):
 * what an operator needs to find it in their AWS account and remove it.
 */
export interface Leftover {
  /** `<service>:<resource type>`, as AWS's ARN names it: `ecs:service`, `iam:role`, `ec2:network-interface`. */
  readonly type: string;
  /** Its ARN, or EC2's own id for a network card. */
  readonly awsId: string;
  /** Its region; `global` for an IAM role. */
  readonly region: string;
  /** Cloudgate's tag on it, `key=value`; `null` for one AWS made, which carries none. */
  readonly tag: string | null;
  /**
   * Why it is left when the Delete itself chose to stop short of it: an S3
   * bucket whose emptying stopped partway, so it still holds files.
   */
  readonly because?: 'partly-emptied';
}

/**
 * Something a rule keeps on purpose (a bucket with files; a cloud database's
 * final snapshot), named once with what it
 * costs, then forgotten.
 */
export interface KeptResource {
  readonly type: string;
  readonly awsId: string;
  readonly region: string;
  /** The AWS account it is in, where its id does not say (an S3 bucket's ARN). */
  readonly awsAccountId?: string;
  /** The Google Cloud project it is in, where its name does not say (a Cloud Storage bucket's). */
  readonly projectId?: string;
  /** How much it holds, as it is billed (`20 GB`), when that is known. */
  readonly size?: string;
  readonly cost: string;
}

/** A cloud Delete's report: *Kept* and *Left* (the AWS spec, "Delete"). */
export interface DeleteReport {
  readonly kept: readonly KeptResource[];
  readonly left: readonly Leftover[];
}

/** The report's one line when nothing was left. */
export const CLEAN_DELETE_LINE =
  'Nothing was left in your AWS account: every resource of this Service is gone.';

/** {@link CLEAN_DELETE_LINE}, for an Environment network's removal. */
export const CLEAN_NETWORK_REMOVAL_LINE =
  'Nothing was left in your AWS account: every resource of this Environment network is gone.';

/** The report as the Deployment log and the console read it, line by line. */
export function deleteReportLines(
  report: DeleteReport,
  cleanLine: string = CLEAN_DELETE_LINE,
): string[] {
  if (report.kept.length === 0 && report.left.length === 0) {
    return [cleanLine];
  }
  return [
    ...(report.kept.length > 0
      ? [
          'Kept on purpose:',
          ...report.kept.map(
            (one) =>
              `  ${one.type} ${one.awsId} (${one.awsAccountId ? `account ${one.awsAccountId}, ` : ''}${one.projectId ? `project ${one.projectId}, ` : ''}${one.region}${one.size ? `, ${one.size}` : ''}): ${one.cost}`,
          ),
        ]
      : []),
    ...(report.left.length > 0
      ? [
          'Left, although it should have gone:',
          ...report.left.map(
            (one) =>
              `  ${one.type} ${one.awsId} (${one.region}${one.tag ? `, ${one.tag}` : ''})${one.because === 'partly-emptied' ? ': partly emptied, it still holds files' : ''}`,
          ),
        ]
      : []),
  ];
}

/** What a check afterwards looks for, beyond the state's tag. */
export interface LeftoverSearch {
  readonly region: string;
  /** The Infrastructure state whose tag every resource it made carries. */
  readonly stateId: string;
  /** IAM roles the state made: a tag search cannot find a role. */
  readonly iamRoleNames: readonly string[];
  /** Security groups the state made, whose AWS-made network cards are looked for. */
  readonly securityGroupIds: readonly string[];
}

export type LeftoverCheck =
  | { readonly ok: true; readonly left: Leftover[] }
  | { readonly ok: false; readonly message: string };

/**
 * The check after a destroy (the AWS spec, "Checking afterwards"): a search
 * by the state's tag, then by id what a tag search cannot find — each IAM
 * role the state made, and the network cards AWS made on its security
 * groups (those it held, and any the tag search found still there). A
 * refusal or no answer is a check that did not happen, never a clean one.
 */
export async function findLeftovers(
  cloud: AwsCloudPort,
  session: AwsCredential,
  search: LeftoverSearch,
): Promise<LeftoverCheck> {
  const stateTag = `${TAG_KEYS.state}=${search.stateId}`;
  try {
    const tagged = await cloud.findTagged(session, {
      region: search.region,
      tags: { [TAG_KEYS.state]: search.stateId },
    });
    if (!tagged.ok) return refused('The tag search', tagged);
    const ecsGone = await settleEcs(
      cloud,
      session,
      search.region,
      tagged.value,
    );
    if (!ecsGone.ok) return ecsGone;
    const ec2Gone = await settleEc2(
      cloud,
      session,
      search.region,
      tagged.value,
    );
    if (!ec2Gone.ok) return ec2Gone;
    const left: Leftover[] = tagged.value
      .filter((found) => !ecsGone.arns.has(found.arn))
      .filter((found) => !ec2Gone.arns.has(found.arn))
      .map((found) => ({
        type: typeOfArn(found.arn),
        awsId: found.arn,
        region: search.region,
        tag: stateTag,
      }));

    for (const roleName of new Set(search.iamRoleNames)) {
      const role = await cloud.findIamRole(session, roleName);
      if (!role.ok) return refused(`The check of IAM role ${roleName}`, role);
      if (role.value) {
        left.push({
          type: 'iam:role',
          awsId: role.value.arn,
          region: 'global',
          tag: stateTag,
        });
      }
    }

    const groups = new Set(search.securityGroupIds);
    for (const found of tagged.value) {
      const id = securityGroupIdOf(found.arn);
      if (id) groups.add(id);
    }
    if (groups.size > 0) {
      const cards = await cloud.networkInterfacesOf(session, {
        region: search.region,
        securityGroupIds: [...groups].sort(),
      });
      if (!cards.ok) return refused('The check of network cards', cards);
      for (const card of cards.value) {
        left.push({
          type: 'ec2:network-interface',
          awsId: card.networkInterfaceId,
          region: search.region,
          tag: null,
        });
      }
    }
    return { ok: true, left };
  } catch (error) {
    return {
      ok: false,
      message: `AWS could not be reached to check what is left: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * The ECS resources a tag search found that ECS says are not there:
 * AWS's tag index keeps a stopped task and a deleted service or cluster for
 * minutes, and a deregistered task definition until it is deleted, so a
 * destroy that removed everything read as Delete incomplete. Each is asked
 * of ECS itself; an INACTIVE task definition is deleted here, so none stays
 * behind, and is left only if that is refused.
 */
async function settleEcs(
  cloud: AwsCloudPort,
  session: AwsCredential,
  region: string,
  found: readonly { arn: string }[],
): Promise<{ ok: true; arns: Set<string> } | { ok: false; message: string }> {
  const arns = found
    .map((one) => one.arn)
    .filter((arn) => arn.startsWith('arn:aws:ecs:'));
  if (arns.length === 0) return { ok: true, arns: new Set() };
  const standing = await cloud.ecsStanding(session, { region, arns });
  if (!standing.ok) return refused('The check of ECS resources', standing);
  const live = new Set(standing.value.live);
  const inactive = standing.value.inactiveTaskDefinitions;
  if (inactive.length > 0) {
    const deleted = await cloud.ecsDeleteTaskDefinitions(session, {
      region,
      arns: inactive,
    });
    if (!deleted.ok) for (const arn of inactive) live.add(arn);
  }
  return { ok: true, arns: new Set(arns.filter((arn) => !live.has(arn))) };
}

/**
 * The EC2 resources a tag search found that EC2 says are not there:
 * the tag index lists a deleted subnet or VPC for minutes, so an Environment
 * network's removal that destroyed everything read as Delete incomplete,
 * as ECS's did. Each is asked of EC2 by its id; a type
 * {@link AwsCloudPort.ec2Standing} has no Describe for stays left, since a
 * check that cannot confirm is never a clean one.
 */
async function settleEc2(
  cloud: AwsCloudPort,
  session: AwsCredential,
  region: string,
  found: readonly { arn: string }[],
): Promise<{ ok: true; arns: Set<string> } | { ok: false; message: string }> {
  const arns = found
    .map((one) => one.arn)
    .filter((arn) => arn.startsWith('arn:aws:ec2:'));
  if (arns.length === 0) return { ok: true, arns: new Set() };
  const standing = await cloud.ec2Standing(session, { region, arns });
  if (!standing.ok) return refused('The check of EC2 resources', standing);
  const live = new Set(standing.value.live);
  return { ok: true, arns: new Set(arns.filter((arn) => !live.has(arn))) };
}

/**
 * What a destroy's plan says the state held, read off each deleted
 * resource's `before`: the ids the check afterwards looks for by id.
 */
export function heldByState(show: TofuShow | null): {
  iamRoleNames: string[];
  securityGroupIds: string[];
} {
  const changes = (show?.resource_changes ?? []) as {
    type?: string;
    change?: { actions?: string[]; before?: Record<string, unknown> | null };
  }[];
  const iamRoleNames: string[] = [];
  const securityGroupIds: string[] = [];
  for (const one of changes) {
    if (!one.change?.actions?.includes('delete')) continue;
    const before = one.change.before ?? {};
    if (one.type === 'aws_iam_role' && typeof before.name === 'string') {
      iamRoleNames.push(before.name);
    }
    if (one.type === 'aws_security_group' && typeof before.id === 'string') {
      securityGroupIds.push(before.id);
    }
  }
  return { iamRoleNames, securityGroupIds };
}

/** `arn:aws:ecs:eu-central-1:1:service/c/web` → `ecs:service`. */
export function typeOfArn(arn: string): string {
  const [, , service = 'unknown', , , ...rest] = arn.split(':');
  const resource = rest.join(':');
  const kind = resource.split(/[/:]/)[0] ?? '';
  // A bare name (an S3 bucket, an SNS topic) has no resource type of its own.
  return kind && kind !== resource ? `${service}:${kind}` : service;
}

function securityGroupIdOf(arn: string): string | null {
  return /:security-group\/(sg-[0-9a-f]+)$/.exec(arn)?.[1] ?? null;
}

function refused(
  what: string,
  answer: { code: string; message: string },
): { readonly ok: false; readonly message: string } {
  return {
    ok: false,
    message: `${what} was refused: AWS answered ${answer.code}: ${answer.message}`,
  };
}
