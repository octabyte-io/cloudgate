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
import { bucketDefinition } from '../../../src/cloud-accounts/aws/definitions/bucket-definition';
import { existingBucketLookup } from '../../../src/cloud-accounts/aws/definitions/existing-bucket-lookup';
import {
  foundBucket,
  judgeBucketLookup,
} from '../../../src/cloud-accounts/aws/plan-reader/existing-bucket';
import { TofuRunner } from '../../../src/cloud-accounts/tofu/tofu-runner';
import type {
  TofuApplyOutcome,
  TofuPlanOutcome,
  TofuShow,
} from '../../../src/cloud-accounts/cloud.port';
import { closeMotoGaps } from './moto-gaps';
import { normalisePlan } from './normalise-plan';

/**
 * Seam 3 of the spec: a `bucket`'s generated definition run by the real
 * pinned OpenTofu and AWS provider, through the real runner, against moto,
 * as `moto-lane.moto-spec.ts` runs a `web`'s.
 *
 * It proves the S3 bucket and its settings apply, plan clean against their
 * own state, plan its origins as a CORS change, show a change made by hand
 * in the console and put it back, and destroy; and it re-saves the stored
 * plan files the in-memory cloud port replays for a bucket
 * (`bucket-create`, `bucket-cors-change`, `bucket-drift`). An existing
 * bucket's lookup is run for a name AWS has no bucket of: it plans,
 * finding nothing, and the reader refuses it by name. The found look is
 * `MOTO_MISSING` (`moto-gaps.ts`).
 *
 * moto keeps no account regional namespace: it accepts the name and the
 * request, which is all a plan file holds. That AWS refuses a namespaced
 * name outside its account and region is AWS's, checked by hand.
 *
 * Needs `OPENTOFU_BINARY` and `OPENTOFU_PROVIDER_MIRROR` (filled by
 * `install-opentofu.sh`) and Docker, and `123456789012.localhost` to
 * resolve to this host: the provider reads a bucket's tags through S3
 * Control, which puts the account id in front of its endpoint's host (the
 * workflow adds the line to `/etc/hosts`). Run with `pnpm test:moto`.
 */

const MOTO_IMAGE = 'motoserver/moto:5.2.3';
const POSTGRES_IMAGE = 'postgres:17-alpine';

const REPO = resolve(__dirname, '..', '..', '..', '..');
const PLANS = resolve(__dirname, '..', 'fixtures', 'plans');

const ACCOUNT = '123456789012';
const REGION = 'eu-central-1';
const ENVIRONMENT = 'env_1';
const CLOUD_ACCOUNT = 'cloud_1';
const CONFIG_NAME = 'uploads';
const BUCKET_STATE = 'state_bucket_1';
const LOOKUP_STATE = 'state_bucket_2';
const BUCKET = awsBucketName(CONFIG_NAME, 'k3f9a2qd', ACCOUNT, REGION);
const APP_SECRET = 'moto-lane-app-encryption-secret';
const STATE_PASSWORD = 'moto-lane-state-login';
const CREDENTIAL = { accessKeyId: 'moto', secretAccessKey: 'moto' };
const ORIGIN = 'https://app.example.com';

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
const log: string[] = [];

function bucketRun(origins: readonly string[]) {
  return {
    stateId: BUCKET_STATE,
    credential: CREDENTIAL,
    definition: bucketDefinition({
      configName: CONFIG_NAME,
      bucketName: BUCKET,
      account: ACCOUNT_ACCESS,
      region: REGION,
      environmentId: ENVIRONMENT,
      stateId: BUCKET_STATE,
      origins,
    }),
    onLine: (line: string) => log.push(line),
  };
}

function lookupRun(bucketName: string) {
  return {
    stateId: LOOKUP_STATE,
    credential: CREDENTIAL,
    definition: existingBucketLookup({
      account: ACCOUNT_ACCESS,
      region: REGION,
      environmentId: ENVIRONMENT,
      stateId: LOOKUP_STATE,
      bucketName,
    }),
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
  shown(await outcome);
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

/** One S3 REST call to moto, unsigned: moto checks no signature. */
async function s3(method: string, query: string, body?: string) {
  const response = await fetch(`${motoUrl}/${BUCKET}?${query}`, {
    method,
    headers: {
      Authorization: `AWS4-HMAC-SHA256 Credential=moto/20260101/${REGION}/s3/aws4_request, SignedHeaders=host, Signature=0`,
      ...(body ? { 'Content-Type': 'application/xml' } : {}),
    },
    ...(body ? { body } : {}),
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
            ['s3', 's3control', 'sts', 'iam'].map((s) => [s, motoUrl]),
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

describe("a bucket's generated definition, against moto", () => {
  it('plans a new bucket with its settings and no CORS', async () => {
    const show = shown(await runner.plan(bucketRun([])));

    expect(actions(show)).toEqual({
      'aws_s3_bucket.bucket': 'create',
      'aws_s3_bucket_ownership_controls.bucket': 'create',
      'aws_s3_bucket_public_access_block.bucket': 'create',
      'aws_s3_bucket_server_side_encryption_configuration.bucket': 'create',
    });
    save('bucket-create', show);
  });

  it('applies it, then plans no changes against its own state', async () => {
    await applied(runner.apply(bucketRun([])));

    expect(actions(shown(await runner.plan(bucketRun([]))))).toEqual({});
  });

  it('plans origins edited on its page as its CORS, and applies them', async () => {
    const show = shown(await runner.plan(bucketRun([ORIGIN])));

    expect(actions(show)).toEqual({
      'aws_s3_bucket_cors_configuration.bucket': 'create',
    });
    save('bucket-cors-change', show);

    await applied(runner.apply(bucketRun([ORIGIN])));
    expect(actions(shown(await runner.plan(bucketRun([ORIGIN]))))).toEqual({});
  });

  it('shows a change made by hand in the console as Drift, and puts it back', async () => {
    await s3(
      'PUT',
      'cors',
      '<CORSConfiguration><CORSRule><AllowedOrigin>*</AllowedOrigin><AllowedMethod>GET</AllowedMethod></CORSRule></CORSConfiguration>',
    );
    await s3('DELETE', 'publicAccessBlock');
    const show = shown(await runner.plan(bucketRun([ORIGIN])));

    expect(actions(show)).toMatchObject({
      'aws_s3_bucket_cors_configuration.bucket': 'update',
    });
    expect(drifted(show)).toEqual(
      expect.arrayContaining(['aws_s3_bucket_cors_configuration.bucket']),
    );
    save('bucket-drift', show);

    await applied(runner.apply(bucketRun([ORIGIN])));
    expect(actions(shown(await runner.plan(bucketRun([ORIGIN]))))).toEqual({});
  });

  it('destroys the bucket, empty', async () => {
    await applied(runner.destroy(bucketRun([ORIGIN])));
  });
});

describe("an existing bucket's lookup, against moto", () => {
  it('plans, finding nothing, for a name AWS has no bucket of, and the reader refuses it by that name', async () => {
    const show = shown(await runner.plan(lookupRun('acme-missing-uploads')));

    expect(actions(show)).toEqual({});
    const found = foundBucket(show, 'acme-missing-uploads');
    expect(found).toBeNull();
    expect(
      judgeBucketLookup(found, {
        serviceName: CONFIG_NAME,
        bucketName: 'acme-missing-uploads',
        cloudAccount: `Production AWS (${ACCOUNT})`,
        region: REGION,
      }),
    ).toMatchObject({
      ok: false,
      reason: expect.stringContaining(
        'AWS has no S3 bucket acme-missing-uploads',
      ) as unknown,
    });
  });
});
