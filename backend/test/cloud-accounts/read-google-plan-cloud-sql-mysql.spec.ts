import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { readGooglePlan } from '../../src/cloud-accounts/gcp/plan-reader/read-plan';
import type { TofuShowJson } from '../../src/cloud-accounts/aws/plan-reader/tofu-show.types';

/**
 * The stored Google plans of a `mysql` on Cloud SQL, planned
 * offline by the pinned OpenTofu and provider from the generated
 * definitions and marked "not yet from a real project" until the walk
 * re-records them (`google-plan-fixtures.spec.ts`): the mysql `my-1` made
 * on Cloud SQL, and an existing one's endpoint and private zone.
 */
function plan(name: string): TofuShowJson {
  return JSON.parse(
    readFileSync(
      join(__dirname, 'fixtures', 'plans', 'google', `${name}.json`),
      'utf8',
    ),
  ) as TofuShowJson;
}

describe('readGooglePlan', () => {
  describe('a mysql made on Cloud SQL', () => {
    const reading = readGooglePlan({
      show: plan('mysql-create'),
      nameSearch: [],
      context: { serviceName: 'my-1' },
    });

    it('names the instance with its MySQL version and TLS offered, not required, its user and database folded into it, then its private address', () => {
      expect(reading.summary).toEqual([
        'Cloud SQL instance `my-1`: create, db-g1-small, MYSQL_8_4, Enterprise edition, TLS offered, not required, its own CA, no public IP, a private DNS name through the private link',
        '`my-1` private address: create, made by Google with the instance on the private link subnet (10.64.16.0/24), about $7.30/month',
      ]);
    });

    it('still lists the instance, its database and its user in the raw lines, each a create', () => {
      expect(reading.raw.map((line) => [line.address, line.action])).toEqual([
        ['google_sql_database.database', 'create'],
        ['google_sql_database_instance.database', 'create'],
        ['google_sql_user.user', 'create'],
      ]);
    });

    it('turns point-in-time recovery on by its binary log, and gives root a password', () => {
      const instance = plan('mysql-create').resource_changes?.find(
        (change) => change.address === 'google_sql_database_instance.database',
      );
      const after = instance?.change.after as {
        settings: { backup_configuration: Record<string, unknown>[] }[];
      };
      expect(after.settings[0].backup_configuration[0]).toMatchObject({
        binary_log_enabled: true,
        point_in_time_recovery_enabled: null,
      });
    });
  });

  describe("an existing mysql's endpoint and private zone", () => {
    const reading = readGooglePlan({
      show: plan('existing-mysql-create'),
      nameSearch: [],
      context: { serviceName: 'my-1' },
    });

    it("is a postgres's: the endpoint and the zone for the instance's ….sql.goog. name", () => {
      expect(reading.raw.map((line) => [line.address, line.action])).toEqual([
        ['google_compute_address.endpoint', 'create'],
        ['google_compute_forwarding_rule.endpoint', 'create'],
        ['google_dns_managed_zone.instance', 'create'],
        ['google_dns_record_set.instance', 'create'],
      ]);
      expect(reading.summary[1]).toBe(
        'Private DNS zone for `4c583468c161.1idghei1xv0vf.europe-west1.sql.goog.`: create, private to the Environment network, with an A record to the endpoint, about $0.20/month',
      );
    });
  });
});
