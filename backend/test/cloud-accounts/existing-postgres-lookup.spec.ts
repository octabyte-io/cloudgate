import { existingPostgresLookup } from '../../src/cloud-accounts/aws/definitions/existing-postgres-lookup';
import {
  foundPostgres,
  judgeLookup,
} from '../../src/cloud-accounts/aws/plan-reader/existing-postgres';
import type {
  FoundPostgres,
  LookupContext,
} from '../../src/cloud-accounts/aws/plan-reader/existing-postgres';
import type { TofuShowJson } from '../../src/cloud-accounts/aws/plan-reader/tofu-show.types';
import { storedPlan } from '../utils/fake-cloud-port';

const context: LookupContext = {
  engine: 'postgres',
  serviceName: 'pg-1',
  identifier: 'acme-prod',
  cloudAccount: 'Production AWS (123456789012)',
  region: 'eu-central-1',
  networkVpcId: 'vpc-00000000000000001',
  madeReachable: false,
  configVersion: 'postgres:17',
};

const found: FoundPostgres = {
  identifier: 'acme-prod',
  engine: 'postgres',
  engineVersion: '17.4',
  host: 'acme-prod.aaaaaaaaaa.eu-central-1.rds.amazonaws.com',
  port: 5432,
  vpcId: 'vpc-00000000000000001',
  tags: { Team: 'shop' },
};

/** The stored lookup with its `data` sources' search finding nothing. */
function nothingFound(): TofuShowJson {
  const show = storedPlan(
    'existing-postgres-lookup',
  ) as unknown as TofuShowJson & {
    prior_state: { values: { root_module: { resources: unknown[] } } };
  };
  return {
    ...show,
    prior_state: {
      values: {
        root_module: {
          resources: show.prior_state.values.root_module.resources.filter(
            (one) => (one as { type: string }).type === 'aws_db_instances',
          ),
        },
      },
    },
  };
}

/**
 * An Existing database is looked up with `data` sources only, and
 * what the lookup finds is judged against ADR-0033's refusals.
 */
describe('judgeLookup, with the lookup it judges', () => {
  describe('its definition', () => {
    const definition = existingPostgresLookup({
      account: {
        awsAccountId: '123456789012',
        deployRoleArn: 'arn:aws:iam::123456789012:role/cloudgate-deploy',
        externalId: 'external-id',
        cloudAccountId: 'ca_1',
      },
      region: 'eu-central-1',
      environmentId: 'env_1',
      stateId: 'ed_1',
      identifier: 'acme-prod',
    });

    it('reads AWS and can make nothing: data sources, no resource', () => {
      expect(definition.resource).toBeUndefined();
      expect(Object.keys(definition.data as object).sort()).toEqual([
        'aws_db_instance',
        'aws_db_instances',
        'aws_db_subnet_group',
      ]);
    });

    it('searches by identifier first, so a missing database fails no plan', () => {
      expect(definition.data).toMatchObject({
        aws_db_instances: {
          found: {
            filter: [{ name: 'db-instance-id', values: ['acme-prod'] }],
          },
        },
        aws_db_instance: {
          database: {
            count:
              '${length(data.aws_db_instances.found.instance_identifiers)}',
            db_instance_identifier: 'acme-prod',
          },
        },
        aws_db_subnet_group: {
          database: {
            name: '${data.aws_db_instance.database[0].db_subnet_group}',
          },
        },
      });
    });

    it('is in the Cloud account and region it was created in', () => {
      expect(definition.provider).toMatchObject({
        aws: {
          region: 'eu-central-1',
          allowed_account_ids: ['123456789012'],
        },
      });
    });
  });

  describe('what the plan read', () => {
    it('is the instance, its address and its VPC', () => {
      expect(foundPostgres(storedPlan('existing-postgres-lookup'))).toEqual(
        found,
      );
    });

    it('is nothing when the search found no instance', () => {
      expect(foundPostgres(nothingFound())).toBeNull();
    });
  });

  describe('the judgement', () => {
    it('uses one found as given, with the address it answers at', () => {
      expect(judgeLookup(found, context)).toEqual({
        ok: true,
        address: { host: found.host, port: 5432 },
        lines: [
          'pg-1: existing database acme-prod, PostgreSQL 17.4, at acme-prod.aaaaaaaaaa.eu-central-1.rds.amazonaws.com:5432; used as given, Cloudgate changes nothing in it',
        ],
      });
    });

    it('refuses a missing one, naming identifier, Cloud account and region', () => {
      expect(judgeLookup(null, context)).toEqual({
        ok: false,
        // Its page then says "AWS cannot find acme-prod".
        missing: true,
        reason:
          "pg-1 uses the existing database acme-prod, but AWS has no RDS instance acme-prod in Cloud account Production AWS (123456789012), region eu-central-1. Check the identifier on pg-1's page; it must be in this Environment's Cloud account and region",
      });
    });

    it('refuses one that is not PostgreSQL', () => {
      expect(judgeLookup({ ...found, engine: 'mysql' }, context)).toEqual({
        ok: false,
        reason:
          'pg-1 uses the existing database acme-prod, but acme-prod runs mysql, not PostgreSQL, so a postgres cannot use it',
      });
    });

    it("refuses one that carries Cloudgate's tags", () => {
      const verdict = judgeLookup(
        {
          ...found,
          tags: {
            Team: 'shop',
            'cloudgate:environment': 'env_2',
            'cloudgate:state': 'st_9',
          },
        },
        context,
      );
      expect(verdict).toEqual({
        ok: false,
        reason:
          "pg-1 uses the existing database acme-prod, but acme-prod carries Cloudgate's tags (cloudgate:environment, cloudgate:state), so Cloudgate made it for an Environment; an existing database must be one Cloudgate did not make",
      });
    });

    it('refuses one in another VPC without the tick, saying Cloudgate cannot check it', () => {
      expect(judgeLookup({ ...found, vpcId: 'vpc-0acme' }, context)).toEqual({
        ok: false,
        reason:
          'pg-1 uses the existing database acme-prod, but acme-prod is in VPC vpc-0acme, not this Environment network\'s VPC vpc-00000000000000001. Once you have made it reachable from this Environment, tick "I made it reachable from this Environment" on pg-1\'s page; Cloudgate cannot check it',
      });
    });

    it('refuses one while the Environment network is not made, without the tick', () => {
      const verdict = judgeLookup(found, { ...context, networkVpcId: null });
      expect(verdict.ok).toBe(false);
      expect(!verdict.ok && verdict.reason).toContain(
        'this Environment network is not made yet',
      );
    });

    it('uses one in another VPC with the tick, noting Cloudgate cannot check it', () => {
      const verdict = judgeLookup(
        { ...found, vpcId: 'vpc-0acme' },
        { ...context, madeReachable: true },
      );
      expect(verdict.ok && verdict.lines[1]).toBe(
        "pg-1: acme-prod is in VPC vpc-0acme, not this Environment network's VPC vpc-00000000000000001; you ticked that you made it reachable from this Environment, which Cloudgate cannot check",
      );
    });

    it('notes a major other than the config says, and refuses nothing for it', () => {
      const verdict = judgeLookup({ ...found, engineVersion: '16.4' }, context);
      expect(verdict.ok && verdict.lines.at(-1)).toBe(
        "pg-1: acme-prod runs PostgreSQL 16.4, and the config's version is 17; the version is not applied to an existing database",
      );
    });

    it('notes no version when the config states none', () => {
      const verdict = judgeLookup(
        { ...found, engineVersion: '16.4' },
        { ...context, configVersion: null },
      );
      expect(verdict.ok && verdict.lines).toHaveLength(1);
    });
  });
});
