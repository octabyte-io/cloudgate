import { frame } from './tofu-json';
import type { AwsAccountAccess } from './tofu-json';
import type { TofuDefinition } from '../../definitions/tofu-json';

/** The `data` addresses the lookup writes, which the reader reads back. */
export const EXISTING_POSTGRES_DATA = {
  /** Every instance with the identifier: none when AWS has no such instance. */
  search: 'found',
  /** The instance itself, read only when the search found it. */
  instance: 'database',
  /** Its DB subnet group, whose VPC the instance sits in. */
  subnets: 'database',
} as const;

export interface ExistingPostgresLookupInput {
  readonly account: AwsAccountAccess & { readonly cloudAccountId: string };
  readonly region: string;
  readonly environmentId: string;
  /** The lookup's own workspace: the existing database's id. It holds nothing. */
  readonly stateId: string;
  /** The RDS instance's identifier, as the operator typed it. */
  readonly identifier: string;
}

/**
 * The OpenTofu definition that looks an **Existing database** up (ADR-0033):
 * `data` sources only, so a plan of it reads AWS and can never make,
 * change or delete anything. Pure: no AWS call, no `tofu`, no database.
 *
 * `aws_db_instance` fails the whole plan when the identifier names nothing,
 * so the instance is first searched for (`aws_db_instances`, filtered by its
 * identifier), and it and its DB subnet group are read only when the search
 * found it: a missing database is then a plan that found nothing, which the
 * reader names, rather than a `tofu` error to parse. The login is never in
 * it: the lookup needs only the identifier.
 */
export function existingPostgresLookup(
  input: ExistingPostgresLookupInput,
): TofuDefinition {
  const { account } = input;
  const search = `data.aws_db_instances.${EXISTING_POSTGRES_DATA.search}`;
  const found = `\${length(${search}.instance_identifiers)}`;
  const instance = `data.aws_db_instance.${EXISTING_POSTGRES_DATA.instance}`;
  return {
    ...frame(account, input.region, {
      cloudAccountId: account.cloudAccountId,
      environmentId: input.environmentId,
      stateId: input.stateId,
    }),
    data: {
      aws_db_instances: {
        [EXISTING_POSTGRES_DATA.search]: {
          filter: [{ name: 'db-instance-id', values: [input.identifier] }],
        },
      },
      aws_db_instance: {
        [EXISTING_POSTGRES_DATA.instance]: {
          count: found,
          db_instance_identifier: input.identifier,
        },
      },
      aws_db_subnet_group: {
        [EXISTING_POSTGRES_DATA.subnets]: {
          count: found,
          name: `\${${instance}[0].db_subnet_group}`,
        },
      },
    },
  };
}
