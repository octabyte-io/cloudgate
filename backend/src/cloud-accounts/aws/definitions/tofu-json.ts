import { INFRASTRUCTURE_STATE_SCHEMA } from '../../definitions/tofu-json';
import type { TofuDefinition } from '../../definitions/tofu-json';
import { defaultTags, resourceTags } from './tags';
import type { StateMark } from './tags';

/**
 * What the generators need of a Cloud account to write a provider block that
 * can only ever act in that account: its AWS account id, the deploy role and
 * the external id the role trusts.
 */
export interface AwsAccountAccess {
  readonly awsAccountId: string;
  readonly deployRoleArn: string;
  readonly externalId: string;
}

/**
 * The session name the deploy role is assumed under, so CloudTrail names
 * Cloudgate as the caller.
 */
const SESSION_NAME = 'cloudgate';

/**
 * The parts both generators share: the `pg` backend and one `aws` provider.
 *
 * The provider assumes the deploy role with the Cloud account's external id
 * and is pinned to its account by `allowed_account_ids`, so a credential that
 * reaches a different account fails before planning anything. `default_tags`
 * carries the mark (ADR-0036 item 6).
 *
 * `required_providers` is not written here: the pinned versions live once,
 * in `deploy/opentofu/versions.tf.json`, which the run puts beside this
 * file, and a second `required_providers` for the same provider is an error.
 * `hashicorp/aws` is the only provider either generator uses: the network's
 * default certificate is made by Cloudgate, not by `hashicorp/tls`.
 */
export function frame(
  account: AwsAccountAccess,
  region: string,
  mark: StateMark,
): TofuDefinition {
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
      aws: {
        region,
        allowed_account_ids: [account.awsAccountId],
        assume_role: {
          role_arn: account.deployRoleArn,
          external_id: account.externalId,
          session_name: SESSION_NAME,
        },
        default_tags: { tags: defaultTags(mark) },
      },
    },
  };
}

/**
 * Collects `resource` blocks by type and name, giving each taggable one its
 * address tag and `Name`.
 */
export class Resources {
  private readonly blocks: Record<string, Record<string, unknown>> = {};

  /**
   * A resource AWS can tag; `name` is its readable `Name` tag, and `extra`
   * any tag of its own beside the mark.
   */
  tagged(
    type: string,
    local: string,
    name: string,
    body: object,
    extra: Readonly<Record<string, string>> = {},
  ): string {
    return this.add(type, local, {
      ...body,
      tags: { ...resourceTags(`${type}.${local}`, name), ...extra },
    });
  }

  /** A resource with no tags of its own (an association, a policy). */
  untagged(type: string, local: string, body: object): string {
    return this.add(type, local, body);
  }

  /** The `resource` object of the definition. */
  all(): Record<string, Record<string, unknown>> {
    return this.blocks;
  }

  /** Adds the block and returns its address, for references. */
  private add(type: string, local: string, body: object): string {
    (this.blocks[type] ??= {})[local] = body;
    return `${type}.${local}`;
  }
}

/**
 * One inline security group rule, every field written out. Inline rather than
 * separate rule resources so that a rule added by hand in the console is
 * Drift Cloudgate puts back rather than something it never sees; all
 * fields because OpenTofu reads an inline rule list as one value, whose
 * objects must each be complete.
 */
export function rule(spec: {
  port: number;
  protocol: string;
  cidr?: string;
  securityGroupId?: string;
  description?: string;
}): Record<string, unknown> {
  return {
    description: spec.description ?? '',
    from_port: spec.port,
    to_port: spec.port,
    protocol: spec.protocol,
    cidr_blocks: spec.cidr ? [spec.cidr] : [],
    ipv6_cidr_blocks: [],
    prefix_list_ids: [],
    security_groups: spec.securityGroupId ? [spec.securityGroupId] : [],
    self: false,
  };
}
