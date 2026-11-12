import { parseProjectConfig, planEnvironment } from '../../src/project-config';
import type {
  DeployTarget,
  PlanOutcome,
  SavedService,
} from '../../src/project-config';

/**
 * The reach rule on a cloud Deploy target (ADR-0031): two Services
 * reach each other in the same cloud network — one Cloud account and
 * region — and nowhere else. A Server and a cloud never reach each other in
 * this slice, either way, and the refusal names the Service and the variable.
 */

const CLOUD: DeployTarget = {
  kind: 'cloud',
  cloudAccountId: 'ca-1',
  region: 'eu-west-1',
};

function plan(
  text: string,
  saved: SavedService[] = [],
  deployTarget: DeployTarget = CLOUD,
): PlanOutcome {
  const parsed = parseProjectConfig(text);
  if (!parsed.ok) throw new Error(`refused: ${parsed.refusal.message}`);
  return planEnvironment({
    config: parsed.config,
    saved,
    deployTarget,
    context: { previous: null },
    networks: [{ cloudAccountId: 'ca-1', region: 'eu-west-1' }],
  });
}

const stack = (env: string) => `version: 1
services:
  web:
    kind: web
    port: 3000
    source: { image: "nginx:1.27" }
    env: ${env}
  pg-1:
    kind: postgres
`;

function postgresAt(
  place: { serverId: string } | { cloudAccountId: string; region: string },
): SavedService {
  return {
    serviceType: 'postgres',
    serviceId: 'pg-id',
    name: 'pg-1',
    configName: 'pg-1',
    ...('serverId' in place
      ? { serverId: place.serverId }
      : { cloud: { ...place, linkedRegistries: [] } }),
    settings: {
      description: null,
      cpuLimit: null,
      memoryLimit: null,
      dockerImage: 'serverId' in place ? 'postgres:18' : 'postgres:17',
      databaseName: 'pg_1',
      databaseUser: 'pg_1',
    },
    variables: { env: [] },
  };
}

const at = 'web.env.DATABASE_URL';

describe('planEnvironment: wired variables on a cloud Deploy target', () => {
  it('plans a web linking the url and ca of a postgres the same plan creates on RDS', () => {
    const outcome = plan(
      stack('[{ DATABASE_URL: pg-1.url }, { PGSSLROOTCERT: pg-1.ca }]'),
    );
    if (!outcome.ok) {
      throw new Error(outcome.refusals.map((r) => r.message).join('; '));
    }
    const names = outcome.steps
      .filter((step) => step.action === 'create')
      .map((step) => step.configName);
    expect(names.indexOf('pg-1')).toBeLessThan(names.indexOf('web'));
  });

  it('plans a link to a postgres already on RDS in the same Cloud account and region', () => {
    expect(
      plan(stack('[{ DATABASE_URL: pg-1.url }]'), [
        postgresAt({ cloudAccountId: 'ca-1', region: 'eu-west-1' }),
      ]).ok,
    ).toBe(true);
  });

  it('refuses a cloud web linking a postgres on a Server, naming the Service and variable', () => {
    const outcome = plan(stack('[{ DATABASE_URL: pg-1.url }]'), [
      postgresAt({ serverId: 'srv-1' }),
    ]);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    const [only] = outcome.refusals.filter((one) => one.at === at);
    expect(only.message).toContain(`${at} links to pg-1.url`);
    expect(only.message).toContain('cannot reach it');
  });

  it('refuses a web on a Server linking a postgres on RDS', () => {
    const outcome = plan(
      stack('[{ DATABASE_URL: pg-1.url }]'),
      [postgresAt({ cloudAccountId: 'ca-1', region: 'eu-west-1' })],
      { kind: 'server', serverId: 'srv-1' },
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusals.map((one) => one.at)).toContain(at);
  });

  it('refuses a postgres in another region of the same Cloud account', () => {
    const outcome = plan(stack('[{ DATABASE_URL: pg-1.url }]'), [
      postgresAt({ cloudAccountId: 'ca-1', region: 'us-east-1' }),
    ]);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusals.map((one) => one.at)).toContain(at);
  });

  it('still refuses ca from a postgres on a Server', () => {
    const outcome = plan(
      stack('[{ PGSSLROOTCERT: pg-1.ca }]'),
      [postgresAt({ serverId: 'srv-1' })],
      { kind: 'server', serverId: 'srv-1' },
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusals[0].message).toContain('hands out no ca');
  });
});

const withUploads = (env: string) => `version: 1
services:
  web:
    kind: web
    port: 3000
    source: { image: "nginx:1.27" }
    env: ${env}
  uploads:
    kind: bucket
`;

function bucketAt(
  place: { serverId: string } | { cloudAccountId: string; region: string },
): SavedService {
  return {
    serviceType: 'bucket',
    serviceId: 'bkt-id',
    name: 'uploads',
    configName: 'uploads',
    ...('serverId' in place
      ? { serverId: place.serverId }
      : { cloud: { ...place, linkedRegistries: [] } }),
    settings: {
      description: null,
      bucketName:
        'serverId' in place
          ? 'uploads-k3j9x2ab'
          : 'uploads-k3f9a2qd-123456789012-eu-west-1-an',
    },
    variables: { env: [] },
  };
}

const KEY_LINKS =
  '[{ AWS_ACCESS_KEY_ID: uploads.access_key_id }, { AWS_SECRET_ACCESS_KEY: uploads.secret_access_key }, { S3_BUCKET: uploads.name }]';

describe('planEnvironment: a cloud web linking a bucket on S3', () => {
  it('plans all six Outputs, and notes each key variable is left unset because the task role gives access', () => {
    const outcome = plan(
      withUploads(
        '[{ AWS_ACCESS_KEY_ID: uploads.access_key_id }, { AWS_SECRET_ACCESS_KEY: uploads.secret_access_key }, { S3_BUCKET: uploads.name }, { AWS_REGION: uploads.region }, { S3_ENDPOINT: uploads.endpoint }, { S3_PATH_STYLE: uploads.path_style }]',
      ),
    );
    if (!outcome.ok) {
      throw new Error(outcome.refusals.map((r) => r.message).join('; '));
    }
    const notes = outcome.notes.filter(
      (note) => note.kind === 'task-role-access',
    );
    expect(notes).toEqual([
      {
        kind: 'task-role-access',
        configName: 'web',
        variable: 'AWS_ACCESS_KEY_ID',
        message:
          "web.env.AWS_ACCESS_KEY_ID links to uploads.access_key_id: on AWS the task's role gives access, so AWS_ACCESS_KEY_ID is left unset. An app that passes keys to its S3 client by hand breaks on AWS; let its SDK find its credentials by itself.",
      },
      {
        kind: 'task-role-access',
        configName: 'web',
        variable: 'AWS_SECRET_ACCESS_KEY',
        message:
          "web.env.AWS_SECRET_ACCESS_KEY links to uploads.secret_access_key: on AWS the task's role gives access, so AWS_SECRET_ACCESS_KEY is left unset. An app that passes keys to its S3 client by hand breaks on AWS; let its SDK find its credentials by itself.",
      },
    ]);
  });

  it('notes the same for a bucket already on S3, and nothing for a link to its other Outputs', () => {
    const outcome = plan(withUploads(KEY_LINKS), [
      bucketAt({ cloudAccountId: 'ca-1', region: 'eu-west-1' }),
    ]);
    if (!outcome.ok) {
      throw new Error(outcome.refusals.map((r) => r.message).join('; '));
    }
    expect(
      outcome.notes
        .filter((note) => note.kind === 'task-role-access')
        .map((note) => 'variable' in note && note.variable),
    ).toEqual(['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY']);
  });

  it('notes nothing on a Server, where the bucket hands out its key', () => {
    const outcome = plan(withUploads(KEY_LINKS), [], {
      kind: 'server',
      serverId: 'srv-1',
    });
    if (!outcome.ok) {
      throw new Error(outcome.refusals.map((r) => r.message).join('; '));
    }
    expect(
      outcome.notes.filter((note) => note.kind === 'task-role-access'),
    ).toEqual([]);
  });

  it('refuses a web on a Server linking a bucket on S3, naming the Service and variable', () => {
    const outcome = plan(
      withUploads('[{ S3_BUCKET: uploads.name }]'),
      [bucketAt({ cloudAccountId: 'ca-1', region: 'eu-west-1' })],
      { kind: 'server', serverId: 'srv-1' },
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    const [only] = outcome.refusals.filter(
      (one) => one.at === 'web.env.S3_BUCKET',
    );
    expect(only.message).toContain(
      'web.env.S3_BUCKET links to uploads.name, but web runs on Server srv-1 and uploads in Cloud account ca-1 (eu-west-1), so web cannot reach it',
    );
  });

  it('refuses a cloud web linking a bucket on a Server, naming the Service and variable', () => {
    const outcome = plan(withUploads('[{ S3_BUCKET: uploads.name }]'), [
      bucketAt({ serverId: 'srv-1' }),
    ]);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    const [only] = outcome.refusals.filter(
      (one) => one.at === 'web.env.S3_BUCKET',
    );
    expect(only.message).toContain('web.env.S3_BUCKET links to uploads.name');
    expect(only.message).toContain('cannot reach it');
  });
});
