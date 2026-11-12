import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { GenericContainer, Wait } from 'testcontainers';
import type { StartedTestContainer } from 'testcontainers';

import { awsBucketName } from '../../../src/buckets/bucket-name';
import {
  CLOUDFRONT_CERTIFICATE_REGION,
  STATIC_OUTPUTS,
  staticDefinition,
} from '../../../src/cloud-accounts/aws/definitions/static-definition';
import type { WebDomain } from '../../../src/cloud-accounts/aws/definitions/web-definition';
import { TofuRunner } from '../../../src/cloud-accounts/tofu/tofu-runner';
import type {
  TofuApplyOutcome,
  TofuPlanOutcome,
  TofuShow,
} from '../../../src/cloud-accounts/cloud.port';
import { closeMotoGaps } from './moto-gaps';
import { normalisePlan } from './normalise-plan';

/**
 * Seam 3 of the spec: a `static` site's generated definition — its own
 * private bucket, the Origin Access Control, the bucket policy, the
 * CloudFront function and distribution — run by the real pinned OpenTofu and
 * AWS provider, through the real runner, against moto, as
 * `bucket-lane.moto-spec.ts` runs a bucket's.
 *
 * It proves the site applies, plans clean against its own state, plans a
 * `spa` change as the distribution's error responses, never shows the origin
 * path a deploy switches as a change once it is the live folder, shows a
 * hand change to the distribution, its origin's bucket and the bucket policy
 * as Drift and puts it back, takes a Domain as its
 * own certificate in `us-east-1` and then as the distribution's alternate
 * domain name, and destroys; and it re-saves the stored plan files
 * the in-memory cloud port replays for a `static` site (`static-create`,
 * `static-spa-change`, `static-drift`, `static-domain-certificate`,
 * `static-domain-attach`).
 *
 * moto never validates a certificate: it stays pending, and moto puts it on
 * the distribution all the same. That a Domain's certificate is issued, and
 * the site answers on it, is the walk by hand's (5d).
 *
 * Needs what the bucket lane needs: `OPENTOFU_BINARY`,
 * `OPENTOFU_PROVIDER_MIRROR`, Docker, and `123456789012.localhost` resolving
 * to this host. Run with `pnpm test:moto`.
 */

const MOTO_IMAGE = 'motoserver/moto:5.2.3';
const POSTGRES_IMAGE = 'postgres:17-alpine';

const REPO = resolve(__dirname, '..', '..', '..', '..');
const PLANS = resolve(__dirname, '..', 'fixtures', 'plans');

const ACCOUNT = '123456789012';
const REGION = 'eu-central-1';
const ENVIRONMENT = 'env_1';
const CLOUD_ACCOUNT = 'cloud_1';
const CONFIG_NAME = 'docs';
const SERVICE = 'app_static_1';
const STATE = 'state_static_1';
const BUCKET = awsBucketName(CONFIG_NAME, 'p4x8m2rt', ACCOUNT, REGION);
const APP_SECRET = 'moto-lane-app-encryption-secret';
const STATE_PASSWORD = 'moto-lane-state-login';
const CREDENTIAL = { accessKeyId: 'moto', secretAccessKey: 'moto' };
const CLOUDFRONT_API = '2020-05-31';
const HOST = 'docs.example.com';

const ACCOUNT_ACCESS = {
  awsAccountId: ACCOUNT,
  deployRoleArn: `arn:aws:iam::${ACCOUNT}:role/cloudgate/cloudgate-deploy`,
  externalId: 'moto-lane-external-id',
  cloudAccountId: CLOUD_ACCOUNT,
};

let postgres: StartedPostgreSqlContainer;
let moto: StartedTestContainer;
let motoUrl: string;
let runner: TofuRunner;
let distributionId: string;
/** The folder a deploy last switched the origin to, as the site records it. */
let liveFolder: string | null = null;
const log: string[] = [];

/**
 * moto 5.2.3 has no CloudFront Functions API (`CreateFunction` answers 404),
 * so every run that applies leaves the function and its association out: the
 * create is planned whole and saved as is, the rest of the site is applied
 * and read back without it. That the function is made, and runs, is checked
 * by hand on AWS (`docs/aws-walk-by-hand.md`).
 */
function withoutFunction(definition: Record<string, unknown>) {
  const copy = structuredClone(definition) as {
    resource: Record<string, Record<string, Record<string, unknown>>>;
  };
  delete copy.resource.aws_cloudfront_function;
  const site = copy.resource.aws_cloudfront_distribution.site;
  const [behaviour] = site.default_cache_behavior as Record<string, unknown>[];
  delete behaviour.function_association;
  return copy;
}

/** The site's one Domain: its certificate, then `attach` once issued. */
const domain = (attach: boolean): WebDomain => ({
  domainId: 'dom_1',
  host: HOST,
  path: '/',
  attempt: 1,
  attach,
});
const CERTIFICATE = 'aws_acm_certificate.domain["dom_1-1"]';

function siteRun(
  spa: boolean,
  whole = false,
  domains: readonly WebDomain[] = [],
) {
  const definition = staticDefinition({
    configName: CONFIG_NAME,
    serviceId: SERVICE,
    bucketName: BUCKET,
    spa,
    account: ACCOUNT_ACCESS,
    region: REGION,
    environmentId: ENVIRONMENT,
    stateId: STATE,
    liveFolder,
    domains,
  });
  return {
    stateId: STATE,
    credential: CREDENTIAL,
    definition: whole ? definition : withoutFunction(definition),
    onLine: (line: string) => log.push(line),
  };
}

function shown(outcome: TofuPlanOutcome | TofuApplyOutcome): TofuShow {
  if (!outcome.ok) {
    const printed = log.splice(0).slice(-60).join('\n');
    throw new Error(`${outcome.reason}: ${outcome.message}\n${printed}`);
  }
  log.length = 0;
  return closeMotoGaps(outcome.show);
}

async function applied(outcome: Promise<TofuApplyOutcome>) {
  const done = await outcome;
  shown(done);
  return done.ok ? done.outputs : {};
}

interface Change {
  address: string;
  change: { actions: string[] };
}

/** Each resource's actions, `no-op`s left out. */
function actions(show: TofuShow): Record<string, string> {
  const changes = (show.resource_changes ?? []) as Change[];
  return Object.fromEntries(
    changes
      .filter((c) => c.change.actions.join() !== 'no-op')
      .map((c) => [c.address, c.change.actions.join()]),
  );
}

function drifted(show: TofuShow): string[] {
  return ((show.resource_drift ?? []) as Change[]).map((c) => c.address);
}

function save(name: string, show: TofuShow) {
  writeFileSync(
    join(PLANS, `${name}.json`),
    `${JSON.stringify(normalisePlan(show, { motoUrl, known: [] }), null, 2)}\n`,
  );
}

const SIGNED = (service: string) => ({
  Authorization: `AWS4-HMAC-SHA256 Credential=moto/20260101/${REGION}/${service}/aws4_request, SignedHeaders=host, Signature=0`,
});

/** The distribution's config changed by hand, as the CloudFront console would. */
async function editDistribution(edit: (xml: string) => string) {
  const url = `${motoUrl}/${CLOUDFRONT_API}/distribution/${distributionId}/config`;
  const got = await fetch(url, { headers: SIGNED('cloudfront') });
  if (!got.ok) throw new Error(`GetDistributionConfig: ${await got.text()}`);
  const etag = got.headers.get('etag') ?? '';
  const put = await fetch(url, {
    method: 'PUT',
    headers: {
      ...SIGNED('cloudfront'),
      'If-Match': etag,
      'Content-Type': 'application/xml',
    },
    body: edit(await got.text()),
  });
  if (!put.ok) throw new Error(`UpdateDistribution: ${await put.text()}`);
}

/** One S3 REST call to moto, unsigned: moto checks no signature. */
async function s3(method: string, query: string) {
  const response = await fetch(`${motoUrl}/${BUCKET}?${query}`, {
    method,
    headers: SIGNED('s3'),
  });
  if (!response.ok) {
    throw new Error(`${method} ?${query}: ${await response.text()}`);
  }
}

beforeAll(async () => {
  const binary = process.env.OPENTOFU_BINARY;
  const providerMirror = process.env.OPENTOFU_PROVIDER_MIRROR;
  if (!binary || !providerMirror) {
    throw new Error(
      'Set OPENTOFU_BINARY and OPENTOFU_PROVIDER_MIRROR: backend/test/cloud-accounts/moto/install-opentofu.sh <dir> fills them',
    );
  }

  [postgres, moto] = await Promise.all([
    new PostgreSqlContainer(POSTGRES_IMAGE).withDatabase('cloudgate').start(),
    new GenericContainer(MOTO_IMAGE)
      .withExposedPorts(5000)
      .withWaitStrategy(Wait.forHttp('/moto-api/', 5000))
      .start(),
  ]);
  motoUrl = `http://${moto.getHost()}:${moto.getMappedPort(5000)}`;

  const pool = new Pool({ connectionString: postgres.getConnectionUri() });
  try {
    await migrate(drizzle(pool), {
      migrationsFolder: join(REPO, 'backend/drizzle'),
    });
    await pool.query(
      `CREATE ROLE cloudgate_state LOGIN PASSWORD '${STATE_PASSWORD}'`,
    );
    await pool.query(
      readFileSync(join(REPO, 'deploy/opentofu/state-login.sql'), 'utf8'),
    );
  } finally {
    await pool.end();
  }
  const stateUrl = new URL(postgres.getConnectionUri());
  stateUrl.username = 'cloudgate_state';
  stateUrl.password = STATE_PASSWORD;
  stateUrl.searchParams.set('sslmode', 'disable');

  runner = new TofuRunner({
    binary,
    providerMirror,
    stateDatabaseUrl: stateUrl.toString(),
    appEncryptionSecret: APP_SECRET,
    pinsDirectory: join(REPO, 'deploy/opentofu'),
    providerOverride: {
      provider: {
        aws: {
          endpoints: Object.fromEntries(
            ['s3', 's3control', 'sts', 'iam', 'cloudfront', 'acm'].map((s) => [
              s,
              motoUrl,
            ]),
          ),
          s3_use_path_style: true,
        },
      },
    },
  });
}, 300_000);

afterAll(async () => {
  await Promise.all([postgres?.stop(), moto?.stop()]);
});

describe("a static site's generated definition, against moto", () => {
  it('plans its private bucket, OAC, bucket policy, function and distribution', async () => {
    const show = shown(await runner.plan(siteRun(false, true)));

    expect(actions(show)).toEqual({
      'aws_cloudfront_distribution.site': 'create',
      'aws_cloudfront_function.site': 'create',
      'aws_cloudfront_origin_access_control.site': 'create',
      'aws_s3_bucket.site': 'create',
      'aws_s3_bucket_ownership_controls.site': 'create',
      'aws_s3_bucket_policy.site': 'create',
      'aws_s3_bucket_public_access_block.site': 'create',
      'aws_s3_bucket_server_side_encryption_configuration.site': 'create',
    });
    save('static-create', show);
  });

  it('applies it, then plans no changes against its own state', async () => {
    const outputs = await applied(runner.apply(siteRun(false)));
    distributionId = String(outputs[STATIC_OUTPUTS.distributionId]);

    expect(actions(shown(await runner.plan(siteRun(false))))).toEqual({});
  });

  it('plans spa: true as the distribution answering a missing path with /index.html', async () => {
    const show = shown(await runner.plan(siteRun(true)));

    expect(actions(show)).toEqual({
      'aws_cloudfront_distribution.site': 'update',
    });
    save('static-spa-change', show);

    await applied(runner.apply(siteRun(true)));
    expect(actions(shown(await runner.plan(siteRun(true))))).toEqual({});
  });

  it('never plans the origin path a deploy switches, once it is the live folder', async () => {
    // As a deploy does it: the origin path switched through the
    // CloudFront API, then the folder recorded as live.
    await editDistribution((xml) =>
      xml.replace(
        /<OriginPath>[^<]*<\/OriginPath>|<OriginPath\/>/,
        '<OriginPath>/deployments/dep_1</OriginPath>',
      ),
    );
    liveFolder = 'dep_1';

    expect(actions(shown(await runner.plan(siteRun(true))))).toEqual({});
  });

  it("shows a hand change to the origin's bucket as Drift, and puts it back", async () => {
    // Its Origin Access Control is the other half, which moto keeps none of
    // (MOTO_GAPS): that one is the walk by hand's.
    await editDistribution((xml) =>
      xml.replace(
        /<DomainName>[^<]*\.s3\.[^<]*<\/DomainName>/,
        `<DomainName>someone-elses-site.s3.${REGION}.amazonaws.com</DomainName>`,
      ),
    );
    const show = shown(await runner.plan(siteRun(true)));

    expect(actions(show)).toEqual({
      'aws_cloudfront_distribution.site': 'update',
    });
    expect(drifted(show)).toEqual(['aws_cloudfront_distribution.site']);

    await applied(runner.apply(siteRun(true)));
    expect(actions(shown(await runner.plan(siteRun(true))))).toEqual({});
  });

  it('shows a hand change to the distribution and the bucket policy as Drift, and puts it back', async () => {
    await editDistribution((xml) =>
      xml.replace(
        '<DefaultRootObject>index.html</DefaultRootObject>',
        '<DefaultRootObject>home.html</DefaultRootObject>',
      ),
    );
    await s3('DELETE', 'policy');
    const show = shown(await runner.plan(siteRun(true)));

    expect(actions(show)).toEqual({
      'aws_cloudfront_distribution.site': 'update',
      'aws_s3_bucket_policy.site': 'create',
    });
    expect(drifted(show)).toEqual(
      expect.arrayContaining([
        'aws_cloudfront_distribution.site',
        'aws_s3_bucket_policy.site',
      ]),
    );
    save('static-drift', show);

    await applied(runner.apply(siteRun(true)));
    expect(actions(shown(await runner.plan(siteRun(true))))).toEqual({});
  });

  it('plans a Domain as its own certificate in us-east-1, whatever the region', async () => {
    const run = () => siteRun(true, false, [domain(false)]);
    const show = shown(await runner.plan(run()));

    expect(actions(show)).toEqual({ [CERTIFICATE]: 'create' });
    const changes = (show.resource_changes ?? []) as {
      address: string;
      change: { after: Record<string, unknown> };
    }[];
    expect(
      changes.find((c) => c.address === CERTIFICATE)?.change.after,
    ).toMatchObject({
      domain_name: HOST,
      region: CLOUDFRONT_CERTIFICATE_REGION,
      validation_method: 'DNS',
    });
    save('static-domain-certificate', show);

    await applied(runner.apply(run()));
    expect(actions(shown(await runner.plan(run())))).toEqual({});
  });

  it('plans the issued certificate onto the distribution as its alternate domain name, and nothing else', async () => {
    const run = () => siteRun(true, false, [domain(true)]);
    const show = shown(await runner.plan(run()));

    expect(actions(show)).toEqual({
      'aws_cloudfront_distribution.site': 'update',
    });
    save('static-domain-attach', show);

    await applied(runner.apply(run()));
    expect(actions(shown(await runner.plan(run())))).toEqual({});
  });

  it('shows the alternate domain name taken off by hand as Drift, and puts it back', async () => {
    await editDistribution((xml) =>
      xml.replace(
        /<Aliases>[\s\S]*?<\/Aliases>/,
        '<Aliases><Quantity>0</Quantity></Aliases>',
      ),
    );
    const run = () => siteRun(true, false, [domain(true)]);
    const show = shown(await runner.plan(run()));

    expect(actions(show)).toEqual({
      'aws_cloudfront_distribution.site': 'update',
    });
    expect(drifted(show)).toEqual(['aws_cloudfront_distribution.site']);

    await applied(runner.apply(run()));
    expect(actions(shown(await runner.plan(run())))).toEqual({});
  });

  it('destroys the site, its certificate with it and its bucket empty', async () => {
    await applied(runner.destroy(siteRun(true, false, [domain(true)])));
  });
});
