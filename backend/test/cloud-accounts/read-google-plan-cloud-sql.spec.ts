import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { readGooglePlan } from '../../src/cloud-accounts/gcp/plan-reader/read-plan';
import type {
  FoundByName,
  GooglePlanReadContext,
} from '../../src/cloud-accounts/gcp/plan-reader/read-plan';
import type { TofuShowJson } from '../../src/cloud-accounts/aws/plan-reader/tofu-show.types';

/**
 * The stored Google plans of a postgres on Cloud SQL, planned offline from the
 * real generated definitions and marked "not yet from a real project" until the
 * walk re-records them (`google-plan-fixtures.spec.ts`): the sample Environment
 * `env_1`'s network made with Cloud SQL's private link, the link added to the
 * made network, and the postgres `pg_1` made, moved from `db-g1-small` to
 * `db-custom-1-3840`, and destroyed.
 */
function plan(name: string): TofuShowJson {
  return JSON.parse(
    readFileSync(
      join(__dirname, 'fixtures', 'plans', 'google', `${name}.json`),
      'utf8',
    ),
  ) as TofuShowJson;
}

const PG: GooglePlanReadContext = { serviceName: 'pg-1', sizeName: 'small' };

const LINK_LINE =
  "Private link: lets this Environment's databases get a private address; made once, kept until the Environment is deleted";

function read(
  name: string,
  context: GooglePlanReadContext = {},
  nameSearch: FoundByName[] = [],
) {
  return readGooglePlan({ show: plan(name), nameSearch, context });
}

describe('readGooglePlan', () => {
  describe("Cloud SQL's private link", () => {
    it('lists the link’s pieces beside a new network’s line, at $0/month, with the line saying what they are for', () => {
      const reading = read('network-create-private-link');

      expect(reading.summary).toEqual([
        'Environment network: create, $0/month for the network, about $18/month while idle for the load balancer',
        'Private link subnet `cloudgate-w33lemwkholw-psc` (10.64.16.0/24): create, $0/month',
        "Private link for Cloud SQL (service connection policy `cloudgate-w33lemwkholw-psc-sql`): create, $0/month; the private DNS zone Google makes for its databases' names with the first one is about $0.20/month",
        LINK_LINE,
      ]);
      expect(reading.raw.map((line) => line.address)).toEqual(
        expect.arrayContaining([
          'google_compute_subnetwork.private_link',
          'google_network_connectivity_service_connection_policy.cloud_sql',
        ]),
      );
    });

    it('is all a made network’s plan creates when a database first needs it', () => {
      const reading = read('private-link-create');

      expect(reading.summary).toEqual([
        'Private link subnet `cloudgate-w33lemwkholw-psc` (10.64.16.0/24): create, $0/month',
        "Private link for Cloud SQL (service connection policy `cloudgate-w33lemwkholw-psc-sql`): create, $0/month; the private DNS zone Google makes for its databases' names with the first one is about $0.20/month",
        LINK_LINE,
      ]);
      expect(reading.counts).toEqual(
        expect.objectContaining({ create: 2, change: 0, destroy: 0 }),
      );
      expect(reading.drift).toEqual([]);
    });

    it('is not there on a web-only network', () => {
      const reading = read('network-create');

      expect(reading.summary).not.toContain(LINK_LINE);
      expect(
        reading.raw.filter((line) =>
          line.resourceType.startsWith('google_network_connectivity'),
        ),
      ).toEqual([]);
    });
  });

  describe('a postgres on Cloud SQL', () => {
    it('shows a new instance with its machine, edition, encrypted-only TLS, its own CA and its private DNS name, and its own address under it', () => {
      const reading = read('postgres-create', PG);

      expect(reading.summary).toEqual([
        'Cloud SQL instance `pg-1`: create, db-f1-micro, POSTGRES_17, Enterprise edition, encrypted connections only, its own CA, no public IP, a private DNS name through the private link',
        '`pg-1` private address: create, made by Google with the instance on the private link subnet (10.64.16.0/24), about $7.30/month',
      ]);
      // Its user and database fold into its line, and are still raw lines.
      expect(reading.raw.map((line) => line.address).sort()).toEqual([
        'google_sql_database.database',
        'google_sql_database_instance.database',
        'google_sql_user.user',
      ]);
    });

    it('never prints the user’s password', () => {
      const reading = read('postgres-create', PG);

      expect(JSON.stringify(reading)).not.toContain(
        'placeholder-not-a-password',
      );
    });

    it('shows a machine change on the instance', () => {
      const reading = read('postgres-change', {
        serviceName: 'pg-1',
        sizeName: 'medium',
      });

      expect(reading.summary).toEqual([
        'Cloud SQL instance `pg-1`: change, db-g1-small → db-custom-1-3840',
      ]);
      expect(reading.raw).toEqual([
        expect.objectContaining({
          address: 'google_sql_database_instance.database',
          action: 'change',
          fields: ['settings'],
        }),
      ]);
    });

    it('shows a destroy as the instance with its private address, and nothing of the link', () => {
      const reading = read('postgres-destroy', { serviceName: 'pg-1' });

      expect(reading.summary).toEqual([
        'Cloud SQL instance `pg-1`: destroy, with its private address',
      ]);
      expect(reading.counts).toEqual(expect.objectContaining({ destroy: 3 }));
    });

    it('adopts an instance found by its name when its labels carry the same mark', () => {
      const show = plan('postgres-create');
      const instance = show.resource_changes?.find(
        (change) => change.type === 'google_sql_database_instance',
      );
      const after = instance?.change.after as {
        name: string;
        settings: { user_labels: Record<string, string> }[];
      };
      const found: FoundByName = {
        resourceType: 'google_sql_database_instance',
        name: after.name,
        id: `projects/example-project-123/instances/${after.name}`,
        labels: after.settings[0].user_labels,
      };

      const reading = read('postgres-create', PG, [found]);

      expect(reading.adopt).toEqual([
        expect.objectContaining({
          address: 'google_sql_database_instance.database',
          arn: found.id,
        }),
      ]);
      expect(
        read('postgres-create', PG, [
          { ...found, labels: { 'cloudgate-state': 'another' } },
        ]).adopt,
      ).toEqual([]);
    });
  });
});
