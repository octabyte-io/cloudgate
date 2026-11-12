import {
  judgeExistingCloudSql,
  parseConnectionName,
} from '../../src/cloud-accounts/gcp/plan-reader/existing-cloud-sql';
import type {
  CloudSqlLookup,
  ExistingCloudSqlContext,
} from '../../src/cloud-accounts/gcp/plan-reader/existing-cloud-sql';
import type { CloudSqlInstanceRead } from '../../src/cloud-accounts/google-cloud.port';

const NAME = '4c583468c161.1idghei1xv0vf.europe-west1.sql.goog.';
const CA = '-----BEGIN CERTIFICATE-----\nMIIB…\n-----END CERTIFICATE-----';
const ATTACHMENT =
  'projects/z1a2b3c4d5e6f7-tp/regions/europe-west1/serviceAttachments/a-4c583468c161-psc-service-attachment-8a1b';

/** An instance as the walk by hand made one: PSC on, this project allowed, its own name. */
const INSTANCE: CloudSqlInstanceRead = {
  region: 'europe-west1',
  databaseVersion: 'POSTGRES_17',
  labels: { team: 'orders' },
  sslMode: 'ENCRYPTED_ONLY',
  pscEnabled: true,
  publicIp: false,
  privateNetwork: null,
  allowedConsumerProjects: ['shop-prod'],
  serviceAttachment: ATTACHMENT,
  dnsNames: [
    {
      name: NAME,
      connectionType: 'PRIVATE_SERVICE_CONNECT',
      recordManager: 'CUSTOMER',
    },
  ],
  serverCa: CA,
};

const CONTEXT: ExistingCloudSqlContext = {
  engine: 'postgres',
  serviceName: 'pg-1',
  connectionName: 'shop-prod:europe-west1:acme-prod',
  project: { projectId: 'shop-prod', projectNumber: '123456789012' },
  region: 'europe-west1',
  serviceAccount: 'cloudgate-deploy@shop-prod.iam.gserviceaccount.com',
  configVersion: null,
};

function judged(
  instance: Partial<CloudSqlInstanceRead>,
  context: Partial<ExistingCloudSqlContext> = {},
) {
  return judgeExistingCloudSql(
    { kind: 'found', instance: { ...INSTANCE, ...instance } },
    { ...CONTEXT, ...context },
  );
}

function refusal(
  lookup: CloudSqlLookup,
  context: Partial<ExistingCloudSqlContext> = {},
): string {
  const verdict = judgeExistingCloudSql(lookup, { ...CONTEXT, ...context });
  if (verdict.ok) throw new Error('it was not refused');
  return verdict.reason;
}

describe('parseConnectionName', () => {
  it('reads project, region and instance, a domain-scoped project included', () => {
    expect(parseConnectionName('shop-prod:europe-west1:acme-prod')).toEqual({
      projectId: 'shop-prod',
      region: 'europe-west1',
      instance: 'acme-prod',
    });
    expect(
      parseConnectionName('example.com:shop-prod:us-central1:orders'),
    ).toEqual({
      projectId: 'example.com:shop-prod',
      region: 'us-central1',
      instance: 'orders',
    });
  });

  it('refuses an RDS identifier or a Valkey instance path', () => {
    expect(parseConnectionName('acme-prod')).toBeNull();
    expect(parseConnectionName('shop-prod/europe-west1/acme')).toBeNull();
  });
});

describe('judgeExistingCloudSql', () => {
  it('uses an instance as given, at its own ….sql.goog. name with the trailing dot, with the CA it reports', () => {
    const verdict = judged({});

    expect(verdict).toEqual({
      ok: true,
      address: { host: NAME, port: 5432 },
      ca: CA,
      serviceAttachment: ATTACHMENT,
      lines: [
        `pg-1: existing database shop-prod:europe-west1:acme-prod, PostgreSQL 17, at ${NAME}:5432 through Cloudgate's own endpoint; used as given, Cloudgate changes nothing in it`,
      ],
    });
  });

  it("notes a major version other than the config's, refusing nothing", () => {
    const verdict = judged({}, { configVersion: 'postgres:16' });

    expect(verdict.ok).toBe(true);
    expect(verdict.ok && verdict.lines).toContain(
      "pg-1: shop-prod:europe-west1:acme-prod runs PostgreSQL 17, and the config's version is 16; the version is not applied to an existing database",
    );
  });

  it('refuses one Google Cloud cannot find, marking it missing for its page', () => {
    const verdict = judgeExistingCloudSql({ kind: 'missing' }, CONTEXT);

    expect(verdict).toEqual({
      ok: false,
      missing: true,
      reason:
        "pg-1 uses the existing database shop-prod:europe-west1:acme-prod, but Google Cloud cannot find Cloud SQL instance acme-prod in project shop-prod. Check the connection name on pg-1's page",
    });
  });

  it('names the read grant for an instance in another project that cannot be found or read', () => {
    const elsewhere = { connectionName: 'orders-123:europe-west1:acme-prod' };
    const grant =
      'gcloud projects add-iam-policy-binding orders-123 --member=serviceAccount:cloudgate-deploy@shop-prod.iam.gserviceaccount.com --role=roles/cloudsql.viewer';

    expect(refusal({ kind: 'missing' }, elsewhere)).toContain(grant);
    expect(
      refusal(
        { kind: 'unreadable', message: 'The client is not authorized' },
        elsewhere,
      ),
    ).toContain(grant);
    // Not marked missing: it may well be there.
    expect(
      judgeExistingCloudSql(
        { kind: 'unreadable', message: 'denied' },
        { ...CONTEXT, ...elsewhere },
      ),
    ).not.toHaveProperty('missing');
  });

  it('refuses one that is not PostgreSQL', () => {
    expect(
      refusal({
        kind: 'found',
        instance: { ...INSTANCE, databaseVersion: 'MYSQL_8_4' },
      }),
    ).toBe(
      'pg-1 uses the existing database shop-prod:europe-west1:acme-prod, but it runs MYSQL_8_4, not PostgreSQL, so a postgres cannot use it',
    );
  });

  it('refuses one in another region', () => {
    const verdict = judged({ region: 'us-central1' });

    expect(verdict.ok || verdict.reason).toBe(
      "pg-1 uses the existing database shop-prod:europe-west1:acme-prod, but it is in us-central1, not this Environment's region europe-west1; an existing database must be in the Environment's region",
    );
  });

  it("refuses one with Private Service Connect off, naming Google's patch command and its downtime", () => {
    const verdict = judged({
      pscEnabled: false,
      serviceAttachment: null,
      allowedConsumerProjects: [],
      privateNetwork: 'projects/shop-prod/global/networks/default',
    });

    expect(verdict.ok || verdict.reason).toBe(
      "pg-1 uses the existing database shop-prod:europe-west1:acme-prod, but it has Private Service Connect off, and that is how Cloudgate reaches it without peering any network. Turn it on, allowing this Environment's project: `gcloud sql instances patch acme-prod --project=shop-prod --enable-private-service-connect --allowed-psc-projects=shop-prod`. Google takes about 8 minutes, about 45 s of which the instance is down.",
    );
  });

  it('says a public-IP-only instance needs a private IP before Private Service Connect', () => {
    const verdict = judged({
      pscEnabled: false,
      serviceAttachment: null,
      publicIp: true,
      privateNetwork: null,
    });

    expect(verdict.ok || verdict.reason).toContain(
      'It has only a public IP, so give it a private IP first (private services access), then turn Private Service Connect on.',
    );
  });

  it("refuses while this Environment's project is not allowed, with a command that keeps the projects already listed", () => {
    const verdict = judged({
      allowedConsumerProjects: ['analytics-prod', 'orders-123'],
    });

    expect(verdict.ok || verdict.reason).toBe(
      "pg-1 uses the existing database shop-prod:europe-west1:acme-prod, but this Environment's project shop-prod is not on its allowed consumer projects, so Cloudgate's endpoint would wait PENDING and never connect. Add it, keeping the projects already listed (Google's flag replaces the list): `gcloud sql instances patch acme-prod --project=shop-prod --allowed-psc-projects=analytics-prod,orders-123,shop-prod`",
    );
  });

  it("refuses even the instance's own project while it is not on the list, as the walk saw it PENDING", () => {
    expect(judged({ allowedConsumerProjects: [] }).ok).toBe(false);
  });

  it('accepts the project by its number, as Google may list it', () => {
    expect(judged({ allowedConsumerProjects: ['123456789012'] }).ok).toBe(true);
  });

  it('refuses one that requires client certificates, naming the setting that lifts it', () => {
    const verdict = judged({ sslMode: 'TRUSTED_CLIENT_CERTIFICATE_REQUIRED' });

    expect(verdict.ok || verdict.reason).toBe(
      "pg-1 uses the existing database shop-prod:europe-west1:acme-prod, but it requires a client certificate of every connection (TRUSTED_CLIENT_CERTIFICATE_REQUIRED), and Cloudgate's Outputs carry none. Let it take encrypted connections without one: `gcloud sql instances patch acme-prod --project=shop-prod --ssl-mode=ENCRYPTED_ONLY`",
    );
  });

  it("refuses one carrying Cloudgate's labels", () => {
    const verdict = judged({
      labels: { 'cloudgate-state': 'abc', 'cloudgate-environment': 'def' },
    });

    expect(verdict.ok || verdict.reason).toBe(
      "pg-1 uses the existing database shop-prod:europe-west1:acme-prod, but it carries Cloudgate's labels (cloudgate-environment, cloudgate-state), so Cloudgate made it for an Environment; an existing database must be one Cloudgate did not make",
    );
  });

  it('refuses one reporting no ….sql.goog. name of its own, with no fallback to an IP', () => {
    const verdict = judged({
      dnsNames: [
        {
          name: '1eefffcff90f.1idghei1xv0vf.europe-west1.sql-psc.goog',
          connectionType: 'PRIVATE_SERVICE_CONNECT',
          recordManager: 'CLOUD_SQL_AUTOMATION',
        },
      ],
    });

    expect(verdict.ok || verdict.reason).toBe(
      "pg-1 uses the existing database shop-prod:europe-west1:acme-prod, but it reports no `….sql.goog.` name of its own (recordManager CUSTOMER), the name its certificate carries; Cloudgate reaches an existing instance only by that name, never by its endpoint's IP",
    );
  });
});

/**
 * An existing Cloud SQL for MySQL instance, judged by the same
 * rules with MySQL's engine: another engine's instance refuses, and one
 * found is reached at its `….sql.goog.` name as reported, dot included
 * at MySQL's port.
 */
describe('judgeExistingCloudSql of a mysql', () => {
  const MY = { engine: 'mysql' as const, serviceName: 'db-1' };
  const MYSQL_INSTANCE = {
    databaseVersion: 'MYSQL_8_4',
    sslMode: 'ALLOW_UNENCRYPTED_AND_ENCRYPTED',
  };

  it('uses a MySQL instance as given, at its own ….sql.goog. name with the trailing dot, on port 3306', () => {
    expect(judged(MYSQL_INSTANCE, MY)).toEqual({
      ok: true,
      address: { host: NAME, port: 3306 },
      ca: CA,
      serviceAttachment: ATTACHMENT,
      lines: [
        `db-1: existing database shop-prod:europe-west1:acme-prod, MySQL 8.4, at ${NAME}:3306 through Cloudgate's own endpoint; used as given, Cloudgate changes nothing in it`,
      ],
    });
  });

  it('refuses a PostgreSQL instance named as a mysql', () => {
    expect(judged({}, MY)).toEqual({
      ok: false,
      reason:
        'db-1 uses the existing database shop-prod:europe-west1:acme-prod, but it runs POSTGRES_17, not MySQL, so a mysql cannot use it',
    });
  });

  it("notes a major other than the config's, refusing nothing", () => {
    const verdict = judged(
      { databaseVersion: 'MYSQL_8_0_31' },
      { ...MY, configVersion: 'mysql:8.4' },
    );

    expect(verdict.ok && verdict.lines).toContain(
      "db-1: shop-prod:europe-west1:acme-prod runs MySQL 8, and the config's version is 8.4; the version is not applied to an existing database",
    );
  });

  it('names the TLS mode a mysql takes when it requires client certificates', () => {
    const verdict = judged(
      {
        ...MYSQL_INSTANCE,
        sslMode: 'TRUSTED_CLIENT_CERTIFICATE_REQUIRED',
      },
      MY,
    );

    expect(verdict.ok || verdict.reason).toContain(
      '--ssl-mode=ALLOW_UNENCRYPTED_AND_ENCRYPTED',
    );
  });
});
