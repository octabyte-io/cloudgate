import { startLegacyDatabase } from '../utils/migrations-up-to';
import type { LegacyDatabase } from '../utils/migrations-up-to';

jest.setTimeout(180_000);

/** The last migration before `cloud_kind` gained `gcp`. */
const MIGRATION_BEFORE_GCP = '0153_state-provider';

const AWS_COLUMNS = `access_key_id, secret_access_key, deploy_role_arn, task_execution_role_arn, external_id`;
const GOOGLE_COLUMNS = `project_number, workload_identity_provider, deploy_service_account, signing_key, signing_key_id, signing_public_key, token_issuer`;
const SHARED = `cloud_account_id, organization_id, name, cloud, cloud_id, policy_version, last_checked_at, last_check_result, created_at`;

const AWS_VALUES = `'AKIAIOSFODNN7EXAMPLE', 'enc:v1:secret', 'arn:aws:iam::123456789012:role/cloudgate-deploy', 'arn:aws:iam::123456789012:role/cloudgate-task-execution', 'external-id'`;
const GOOGLE_VALUES = `'123456789012', 'projects/123456789012/locations/global/workloadIdentityPools/cloudgate/providers/cloudgate', 'cloudgate-deploy@shop-prod.iam.gserviceaccount.com', 'enc:v1:key', 'key-1', '{"kid":"key-1"}', 'https://cloudgate.example.com/ca-gcp'`;

/**
 * Slice 6, S12: a Cloud account row can hold a second cloud. `gcp` joins
 * `cloud_kind` in one migration and the per-cloud columns and checks in the
 * next; an install upgrading across both runs them in one transaction, which
 * is where an enum value used in the transaction that added it would be
 * refused. Existing AWS rows pass the new checks untouched, and each check
 * then holds a row to its own cloud's columns.
 */
describe('A Cloud account row per cloud (e2e)', () => {
  let legacy: LegacyDatabase;

  beforeAll(async () => {
    legacy = await startLegacyDatabase('s6t1', MIGRATION_BEFORE_GCP);
    await legacy.pool.query(`
      insert into "user" (id, email, updated_at)
        values ('user-1', 'grace@example.com', now());
      insert into organization (id, name, created_at, owner_id)
        values ('org-1', 'Acme', now(), 'user-1');
      insert into cloud_account (${SHARED}, ${AWS_COLUMNS})
        values ('ca-aws', 'org-1', 'Production AWS', 'aws', '123456789012', 1, now(), 'passed', now(), ${AWS_VALUES});
    `);
    await legacy.migrateToHead();
  });

  afterAll(async () => {
    await legacy?.drop();
  });

  const insert = (id: string, cloud: string, columns: string, values: string) =>
    legacy.pool.query(
      `insert into cloud_account (${SHARED}, ${columns})
         values ('${id}', 'org-1', '${id}', '${cloud}', '${id}', 1, now(), 'passed', now(), ${values})`,
    );

  it('keeps an AWS row from before as it was', async () => {
    const { rows } = await legacy.pool.query<Record<string, unknown>>(
      `select cloud, access_key_id, project_number, signing_key from cloud_account where cloud_account_id = 'ca-aws'`,
    );
    expect(rows).toEqual([
      {
        cloud: 'aws',
        access_key_id: 'AKIAIOSFODNN7EXAMPLE',
        project_number: null,
        signing_key: null,
      },
    ]);
  });

  it('takes a Google row with every Google column and no AWS one', async () => {
    await insert('ca-gcp', 'gcp', GOOGLE_COLUMNS, GOOGLE_VALUES);
    const { rows } = await legacy.pool.query<{ cloud: string }>(
      `select cloud from cloud_account where cloud_account_id = 'ca-gcp'`,
    );
    expect(rows).toEqual([{ cloud: 'gcp' }]);
  });

  it('refuses an AWS row missing an AWS column', async () => {
    await expect(
      insert(
        'ca-aws-half',
        'aws',
        'access_key_id, deploy_role_arn, task_execution_role_arn, external_id',
        `'AKIAIOSFODNN7EXAMPLE', 'arn:aws:iam::1:role/d', 'arn:aws:iam::1:role/t', 'x'`,
      ),
    ).rejects.toThrow(/cloud_account_aws_whole/);
  });

  it('refuses an AWS row holding a Google column', async () => {
    await expect(
      insert(
        'ca-aws-mixed',
        'aws',
        `${AWS_COLUMNS}, project_number`,
        `${AWS_VALUES}, '1'`,
      ),
    ).rejects.toThrow(/cloud_account_gcp_whole/);
  });

  it('refuses a Google row missing its signing key', async () => {
    await expect(
      insert(
        'ca-gcp-half',
        'gcp',
        'project_number, workload_identity_provider, deploy_service_account, signing_key_id, signing_public_key, token_issuer',
        `'1', 'projects/1/providers/p', 'sa@p.iam.gserviceaccount.com', 'key-1', '{}', 'https://cloudgate.example.com/x'`,
      ),
    ).rejects.toThrow(/cloud_account_gcp_whole/);
  });

  it('refuses a Google row holding an AWS column', async () => {
    await expect(
      insert(
        'ca-gcp-mixed',
        'gcp',
        `${GOOGLE_COLUMNS}, access_key_id`,
        `${GOOGLE_VALUES}, 'AKIAIOSFODNN7EXAMPLE'`,
      ),
    ).rejects.toThrow(/cloud_account_aws_whole/);
  });
});
