import { spawnSync } from 'node:child_process';
import { stackVmPinsOn } from '../../../src/cloud-accounts/definitions/stack-vm-pins';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { makeDefaultCertificate } from '../../../src/cloud-accounts/definitions/default-certificate';
import { DEFAULT_CERTIFICATE_VARIABLES } from '../../../src/cloud-accounts/definitions/default-certificate';
import { STAND_IN_IMAGE_TAG } from '../../../src/cloud-accounts/aws/definitions/stand-ins';
import { renderDefinition } from '../../../src/cloud-accounts/definitions/tofu-json';
import type { TofuDefinition } from '../../../src/cloud-accounts/definitions/tofu-json';
import { gcpBucketDefinition } from '../../../src/cloud-accounts/gcp/definitions/bucket-definition';
import { cloudSqlDefinition } from '../../../src/cloud-accounts/gcp/definitions/cloud-sql-definition';
import { destroyDefinition } from '../../../src/cloud-accounts/gcp/definitions/destroy-definition';
import { existingCloudSqlDefinition } from '../../../src/cloud-accounts/gcp/definitions/existing-cloud-sql-definition';
import { existingValkeyDefinition } from '../../../src/cloud-accounts/gcp/definitions/existing-valkey-definition';
import { memorystoreDefinition } from '../../../src/cloud-accounts/gcp/definitions/memorystore-definition';
import { networkDefinition } from '../../../src/cloud-accounts/gcp/definitions/network-definition';
import { gcpStaticDefinition } from '../../../src/cloud-accounts/gcp/definitions/static-definition';
import { googleStackVmDefinition } from '../../../src/cloud-accounts/gcp/definitions/stack-vm-definition';
import { gcpNetworkStandIns } from '../../../src/cloud-accounts/gcp/definitions/stand-ins';
import {
  cloudRunServiceDefinition,
  webDefinition,
} from '../../../src/cloud-accounts/gcp/definitions/cloud-run-definition';
import {
  opentofuCliConfig,
  pinsFor,
} from '../../../src/cloud-accounts/tofu/tofu-environment';
import { GOOGLE_PROVIDERS } from '../../../src/cloud-accounts/tofu/tofu-runner';
import type { NativeGcpBlock } from '../../../src/native/gcp-native';
import type { WebEntry } from '../../../src/project-config/project-config.types';

/**
 * The Google validate lane: the generated Google
 * definitions, checked by the real pinned OpenTofu and `hashicorp/google`
 * from the mirror with `tofu init` and `tofu validate`. Google has no moto,
 * so this is what proves before a release that every resource type,
 * attribute and block the definitions write is one the pinned provider
 * takes — the definition specs only read the JSON Cloudgate writes.
 *
 * No project, no credential, no request to Google: `validate` reads the
 * configuration against the provider's schema alone, and `init` runs with
 * `-backend=false` and the mirror only, so it needs no Postgres either.
 *
 * Each definition is laid out as a Google Cloud run lays out its working
 * folder: `main.tf.json` as rendered, the pin files narrowed to the Google
 * provider, and the CLI config naming the mirror alone.
 *
 * Needs `OPENTOFU_BINARY` and `OPENTOFU_PROVIDER_MIRROR`, filled by
 * `install-opentofu.sh <dir> google`. Run with
 * `pnpm test:google-validate`.
 */

const REPO = resolve(__dirname, '..', '..', '..', '..');
const PINS = join(REPO, 'deploy', 'opentofu');

const MARK = {
  cloudAccountId: 'Cloud_Acct-1',
  projectId: 'acme-prod-123',
  region: 'europe-west1',
  environmentId: 'Env_Prod',
};

const ENTRY: WebEntry = {
  kind: 'web',
  managed: false,
  env: [],
  port: 8080,
  buildArgs: [],
  buildSecrets: [],
  command: 'node server.js',
  args: ['--port', '8080'],
};

/** A network with two Domains, so the `for_each` blocks are not empty. */
function networkWithDomains(): TofuDefinition {
  return networkDefinition({
    ...MARK,
    stateId: 'State_Net-1',
    domains: [
      {
        domainId: 'Dom_A',
        host: 'acme.dev',
        path: '/',
        attempt: 1,
        serviceId: 'Svc_Web',
      },
      {
        domainId: 'Dom_B',
        host: 'www.acme.dev',
        path: '/api',
        attempt: 2,
        serviceId: 'Svc_Web',
      },
      // Two static sites' Domains: the `live/` rewrite on both, and
      // the spa error policy on one.
      {
        domainId: 'Dom_C',
        host: 'docs.acme.dev',
        path: '/',
        attempt: 1,
        serviceId: 'Svc_Docs',
        site: { spa: false },
      },
      {
        domainId: 'Dom_D',
        host: 'app.acme.dev',
        path: '/',
        attempt: 1,
        serviceId: 'Svc_App',
        site: { spa: true },
      },
    ],
    privateLinks: [],
  });
}

/**
 * A `web` with a secret and an empty variable, a command and args, on the
 * network's stand-ins and the stand-in image: the plan's own shape before
 * anything is made.
 */
function webWithVariables(native?: NativeGcpBlock): {
  definition: TofuDefinition;
  variables: Record<string, string>;
} {
  const result = webDefinition({
    native,
    ...MARK,
    configName: 'api',
    entry: ENTRY,
    service: { serviceId: 'Svc_Web', copies: { min: 0, max: 10 } },
    stateId: 'State_Svc-1',
    network: gcpNetworkStandIns(),
    pair: { cpu: 1, memoryMb: 512 },
    imageTag: STAND_IN_IMAGE_TAG,
    variables: { API_KEY: 'not-a-secret', EMPTY: '' },
  });
  if (!result.ok) throw new Error(result.refusal.message);
  return result;
}

/** A Worker's worker pool with a variable, a command and args. */
function workerWithVariables(): {
  definition: TofuDefinition;
  variables: Record<string, string>;
} {
  const result = cloudRunServiceDefinition({
    ...MARK,
    configName: 'jobs',
    entry: { command: 'node worker.js', args: ['--queue', 'mail'] },
    routing: { kind: 'none', instances: 2 },
    service: { serviceId: 'Svc_Worker', copies: { min: 0, max: 10 } },
    stateId: 'State_Svc-2',
    network: gcpNetworkStandIns(),
    pair: { cpu: 1, memoryMb: 512 },
    imageTag: STAND_IN_IMAGE_TAG,
    variables: { API_KEY: 'not-a-secret' },
  });
  if (!result.ok) throw new Error(result.refusal.message);
  return result;
}

interface Validation {
  readonly valid: boolean;
  readonly diagnostics: readonly {
    readonly severity: string;
    readonly summary: string;
    readonly detail?: string;
    readonly address?: string;
  }[];
}

describe('the generated Google definitions, against the pinned provider', () => {
  const binary = process.env.OPENTOFU_BINARY;
  const mirror = process.env.OPENTOFU_PROVIDER_MIRROR;
  const folders: string[] = [];

  beforeAll(() => {
    if (!binary || !mirror) {
      throw new Error(
        'Set OPENTOFU_BINARY and OPENTOFU_PROVIDER_MIRROR: backend/test/cloud-accounts/moto/install-opentofu.sh <dir> google fills them',
      );
    }
  });

  afterAll(() => {
    for (const folder of folders) rmSync(folder, { recursive: true });
  });

  /** `tofu init` then `tofu validate -json` in a run's working folder. */
  function validate(
    definition: TofuDefinition,
    variables: Record<string, string> = {},
  ): Validation {
    const folder = mkdtempSync(join(tmpdir(), 'cloudgate-validate-'));
    folders.push(folder);
    const pins = pinsFor(
      {
        versions: readFileSync(join(PINS, 'versions.tf.json'), 'utf8'),
        lock: readFileSync(join(PINS, '.terraform.lock.hcl'), 'utf8'),
      },
      GOOGLE_PROVIDERS,
    );
    writeFileSync(join(folder, 'versions.tf.json'), pins.versions);
    writeFileSync(join(folder, '.terraform.lock.hcl'), pins.lock);
    writeFileSync(join(folder, 'main.tf.json'), renderDefinition(definition));
    writeFileSync(
      join(folder, 'cloudgate.tfrc'),
      opentofuCliConfig(mirror as string),
    );
    const env = {
      PATH: process.env.PATH,
      HOME: folder,
      TF_CLI_CONFIG_FILE: join(folder, 'cloudgate.tfrc'),
      TF_IN_AUTOMATION: '1',
      ...Object.fromEntries(
        Object.entries(variables).map(([name, value]) => [
          `TF_VAR_${name}`,
          value,
        ]),
      ),
    };
    const run = (args: string[]) =>
      spawnSync(binary as string, args, { cwd: folder, env, encoding: 'utf8' });

    const init = run([
      'init',
      '-input=false',
      '-no-color',
      '-backend=false',
      '-lockfile=readonly',
    ]);
    if (init.status !== 0) {
      throw new Error(`tofu init failed:\n${init.stdout}${init.stderr}`);
    }
    const validation = run(['validate', '-json', '-no-color']);
    return JSON.parse(validation.stdout) as Validation;
  }

  /** What `validate` said, one line per diagnostic, for a readable failure. */
  function said(validation: Validation): string[] {
    return validation.diagnostics.map(
      (one) =>
        `${one.severity}: ${one.summary}${one.address ? ` (${one.address})` : ''}${one.detail ? ` — ${one.detail}` : ''}`,
    );
  }

  it('takes the Environment network with Domains', () => {
    const certificate = makeDefaultCertificate();
    const validation = validate(networkWithDomains(), {
      [DEFAULT_CERTIFICATE_VARIABLES.certificate]: certificate.certificatePem,
      [DEFAULT_CERTIFICATE_VARIABLES.privateKey]: certificate.privateKeyPem,
    });

    expect(said(validation)).toEqual([]);
    expect(validation.valid).toBe(true);
  });

  it('takes the Environment network with no Domain', () => {
    const validation = validate(
      networkDefinition({
        ...MARK,
        stateId: 'State_Net-1',
        domains: [],
        privateLinks: [],
      }),
    );

    expect(said(validation)).toEqual([]);
    expect(validation.valid).toBe(true);
  });

  it("takes the Environment network with Cloud SQL's private link", () => {
    const validation = validate(
      networkDefinition({
        ...MARK,
        stateId: 'State_Net-1',
        domains: [],
        privateLinks: ['cloud-sql'],
      }),
    );

    expect(said(validation)).toEqual([]);
    expect(validation.valid).toBe(true);
  });

  it("takes the Environment network with its Stack VMs' Cloud NAT", () => {
    const validation = validate(
      networkDefinition({
        ...MARK,
        stateId: 'State_Net-1',
        domains: [],
        privateLinks: ['cloud-nat'],
      }),
    );

    expect(said(validation)).toEqual([]);
    expect(validation.valid).toBe(true);
  });

  it("takes a compose stack's Stack VM, first made and made, with native.gcp's machine type", () => {
    const stackVm = (imageId: string | null) =>
      googleStackVmDefinition({
        ...MARK,
        configName: 'analytics',
        serviceId: 'Cmp_Id-1',
        stateId: 'State_Analytics',
        network: gcpNetworkStandIns(),
        machineType: 'e2-small',
        dataDiskGb: 20,
        snapshotDays: 7,
        imageId,
        zone: imageId === null ? null : 'europe-west1-c',
        sshPublicKey: null,
        pins: stackVmPinsOn('gcp'),
        native: {
          'google_compute_instance.stack_vm': { machine_type: 'n2-standard-2' },
        },
      }).definition;

    for (const validation of [
      validate(stackVm(null)),
      validate(
        stackVm(
          'projects/ubuntu-os-cloud/global/images/ubuntu-2404-noble-amd64-v20261101',
        ),
      ),
    ]) {
      expect(said(validation)).toEqual([]);
      expect(validation.valid).toBe(true);
    }
  });

  it("takes a compose stack's Stack VM with its Domains' backends, and with its last Domain removed (#1371)", () => {
    const stackVm = (ports: number[]) =>
      googleStackVmDefinition({
        ...MARK,
        configName: 'analytics',
        serviceId: 'Cmp_Id-1',
        stateId: 'State_Analytics',
        network: gcpNetworkStandIns(),
        machineType: 'e2-small',
        dataDiskGb: 20,
        snapshotDays: 7,
        imageId:
          'projects/ubuntu-os-cloud/global/images/ubuntu-2404-noble-amd64-v20261101',
        zone: 'europe-west1-b',
        sshPublicKey: null,
        pins: stackVmPinsOn('gcp'),
        ports,
      }).definition;

    for (const validation of [
      validate(stackVm([3000, 8080])),
      validate(stackVm([])),
    ]) {
      expect(said(validation)).toEqual([]);
      expect(validation.valid).toBe(true);
    }
  });

  it('takes a `postgres` on Cloud SQL', () => {
    const { definition, variables } = cloudSqlDefinition({
      ...MARK,
      serviceId: 'Svc_Pg',
      stateId: 'State_Pg-1',
      network: gcpNetworkStandIns(),
      tier: 'db-custom-1-3840',
      engine: 'postgres' as const,
      databaseVersion: 'POSTGRES_17',
      login: { user: 'pg_1', database: 'pg_1', password: 'not-a-secret' },
      backupRetentionDays: 7,
      pointInTimeRecovery: true,
    });
    const validation = validate(definition, variables);

    expect(said(validation)).toEqual([]);
    expect(validation.valid).toBe(true);
  });

  it('takes a `mysql` on Cloud SQL: its MySQL version, TLS offered not required, and root’s password', () => {
    const { definition, variables } = cloudSqlDefinition({
      ...MARK,
      serviceId: 'Svc_My',
      stateId: 'State_My-1',
      network: gcpNetworkStandIns(),
      tier: 'db-f1-micro',
      engine: 'mysql',
      databaseVersion: 'MYSQL_8_4',
      login: {
        user: 'my_1',
        database: 'my_1',
        password: 'not-a-secret',
        rootPassword: 'not-a-secret-either',
      },
      backupRetentionDays: 7,
      pointInTimeRecovery: true,
    });
    const validation = validate(definition, variables);

    expect(said(validation)).toEqual([]);
    expect(validation.valid).toBe(true);
  });

  it('takes a `postgres` on Cloud SQL with its native.gcp laid: flags, backups, maintenance and insights', () => {
    const { definition, variables } = cloudSqlDefinition({
      ...MARK,
      serviceId: 'Svc_Pg',
      stateId: 'State_Pg-1',
      network: gcpNetworkStandIns(),
      tier: 'db-custom-1-3840',
      engine: 'postgres' as const,
      databaseVersion: 'POSTGRES_17',
      login: { user: 'pg_1', database: 'pg_1', password: 'not-a-secret' },
      backupRetentionDays: 7,
      pointInTimeRecovery: true,
      native: {
        'google_sql_database_instance.database': {
          settings: {
            database_flags: [
              { name: 'log_min_duration_statement', value: '250' },
            ],
            backup_configuration: {
              point_in_time_recovery_enabled: false,
              start_time: '03:00',
              backup_retention_settings: { retained_backups: 14 },
            },
            maintenance_window: { day: 7, hour: 3 },
            insights_config: { query_insights_enabled: true },
          },
        },
      },
    });
    const validation = validate(definition, variables);

    expect(said(validation)).toEqual([]);
    expect(validation.valid).toBe(true);
  });

  it('takes a `postgres` on Cloud SQL and a `redis` on Memorystore on the exact machine native.gcp sets', () => {
    const sql = cloudSqlDefinition({
      ...MARK,
      serviceId: 'Svc_Pg',
      stateId: 'State_Pg-1',
      network: gcpNetworkStandIns(),
      tier: 'db-custom-1-3840',
      engine: 'postgres' as const,
      databaseVersion: 'POSTGRES_17',
      login: { user: 'pg_1', database: 'pg_1', password: 'not-a-secret' },
      backupRetentionDays: 7,
      pointInTimeRecovery: true,
      native: {
        'google_sql_database_instance.database': {
          settings: { tier: 'db-custom-4-16384' },
        },
      },
    });
    const cache = memorystoreDefinition({
      ...MARK,
      serviceId: 'Svc_Redis',
      stateId: 'State_Redis-1',
      network: gcpNetworkStandIns(),
      nodeType: 'CUSTOM_PICO',
      engineVersion: 'VALKEY_8_0',
      highAvailability: false,
      backupRetentionDays: 1,
      native: {
        'google_memorystore_instance.cache': { node_type: 'HIGHMEM_XLARGE' },
      },
    });

    for (const validation of [
      validate(sql.definition, sql.variables),
      validate(cache),
    ]) {
      expect(said(validation)).toEqual([]);
      expect(validation.valid).toBe(true);
    }
  });

  it("answers the PSC name Google's automation records, of the two Cloud SQL lists, as its host", () => {
    // The two names a real instance listed in the live walk: only the
    // `sql-psc.goog` one has a record in the Environment network.
    const { definition } = cloudSqlDefinition({
      ...MARK,
      serviceId: 'Svc_Pg',
      stateId: 'State_Pg-1',
      network: gcpNetworkStandIns(),
      tier: 'db-f1-micro',
      engine: 'postgres' as const,
      databaseVersion: 'POSTGRES_17',
      login: { user: 'walk', database: 'walk', password: 'not-a-secret' },
      backupRetentionDays: 7,
      pointInTimeRecovery: true,
    });
    const output = definition.output as Record<string, { value: string }>;
    const expression = output.dns_name.value
      .replace(/^\$\{/, '')
      .replace(/\}$/, '')
      .replaceAll('google_sql_database_instance.database', 'local.instance');
    const folder = mkdtempSync(join(tmpdir(), 'cloudgate-console-'));
    folders.push(folder);
    writeFileSync(
      join(folder, 'main.tf.json'),
      JSON.stringify({
        locals: {
          instance: {
            dns_names: [
              {
                connection_type: 'PRIVATE_SERVICE_CONNECT',
                dns_scope: 'INSTANCE',
                name: '24201ef35c59.1idghei1xv0vf.us-central1.sql.goog.',
              },
              {
                connection_type: 'PRIVATE_SERVICE_CONNECT',
                dns_scope: 'INSTANCE',
                name: '24201ef35c59.1idghei1xv0vf.us-central1.sql-psc.goog',
              },
            ],
          },
        },
      }),
    );
    const evaluated = spawnSync(binary as string, ['console'], {
      cwd: folder,
      env: { PATH: process.env.PATH, HOME: folder, TF_IN_AUTOMATION: '1' },
      input: expression,
      encoding: 'utf8',
    });

    expect(evaluated.stdout.trim()).toBe(
      '"24201ef35c59.1idghei1xv0vf.us-central1.sql-psc.goog"',
    );
  });

  it('keeps that name exactly as Google reports it, a trailing dot included were it to report one', () => {
    const { definition } = cloudSqlDefinition({
      ...MARK,
      serviceId: 'Svc_Pg',
      stateId: 'State_Pg-1',
      network: gcpNetworkStandIns(),
      tier: 'db-f1-micro',
      engine: 'postgres' as const,
      databaseVersion: 'POSTGRES_17',
      login: { user: 'walk', database: 'walk', password: 'not-a-secret' },
      backupRetentionDays: 7,
      pointInTimeRecovery: true,
    });
    const output = definition.output as Record<string, { value: string }>;
    const expression = output.dns_name.value
      .replace(/^\$\{/, '')
      .replace(/\}$/, '')
      .replaceAll('google_sql_database_instance.database', 'local.instance');
    const folder = mkdtempSync(join(tmpdir(), 'cloudgate-console-'));
    folders.push(folder);
    writeFileSync(
      join(folder, 'main.tf.json'),
      JSON.stringify({
        locals: {
          instance: {
            dns_names: [
              {
                connection_type: 'PRIVATE_SERVICE_CONNECT',
                dns_scope: 'INSTANCE',
                name: '24201ef35c59.1idghei1xv0vf.us-central1.sql-psc.goog.',
              },
            ],
          },
        },
      }),
    );
    const evaluated = spawnSync(binary as string, ['console'], {
      cwd: folder,
      env: { PATH: process.env.PATH, HOME: folder, TF_IN_AUTOMATION: '1' },
      input: expression,
      encoding: 'utf8',
    });

    expect(evaluated.stdout.trim()).toBe(
      '"24201ef35c59.1idghei1xv0vf.us-central1.sql-psc.goog."',
    );
  });

  it("takes an Existing database's endpoint and private DNS zone for a Cloud SQL instance", () => {
    const validation = validate(
      existingCloudSqlDefinition({
        ...MARK,
        serviceId: 'Svc_Pg',
        stateId: 'State_Pg-1',
        serviceAttachment:
          'projects/a1b2c3d4e5f6-tp/regions/europe-west1/serviceAttachments/a-1234-psc-service-attachment-abcd',
        dnsName: '4c583468c161.1idghei1xv0vf.europe-west1.sql.goog.',
      }),
    );

    expect(said(validation)).toEqual([]);
    expect(validation.valid).toBe(true);
  });

  it("takes an existing Valkey's two manual endpoints, their connection ids among the outputs", () => {
    const validation = validate(
      existingValkeyDefinition({
        ...MARK,
        serviceId: 'Svc_Cache',
        stateId: 'State_Cache-1',
        serviceAttachments: {
          primary:
            'projects/y1a2b3c4d5e6f7-tp/regions/europe-west1/serviceAttachments/gcp-memorystore-auto-a1b2-psc-sa',
          reader:
            'projects/y1a2b3c4d5e6f7-tp/regions/europe-west1/serviceAttachments/gcp-memorystore-auto-a1b2-psc-sa-2',
        },
      }),
    );

    expect(said(validation)).toEqual([]);
    expect(validation.valid).toBe(true);
  });

  it("takes the Environment network with Cloud SQL's and Memorystore's private links, the Redis firewall rule among them", () => {
    const validation = validate(
      networkDefinition({
        ...MARK,
        stateId: 'State_Net-1',
        domains: [],
        privateLinks: ['cloud-sql', 'memorystore'],
      }),
    );

    expect(said(validation)).toEqual([]);
    expect(validation.valid).toBe(true);
  });

  it.each([
    ['one node', false],
    ['high availability, a replica', true],
  ])(
    'takes a `redis` on Memorystore with %s and no password through `hashicorp/google`',
    (_shape, highAvailability) => {
      const validation = validate(
        memorystoreDefinition({
          ...MARK,
          serviceId: 'Svc_Redis',
          stateId: 'State_Redis-1',
          network: gcpNetworkStandIns(),
          nodeType: 'CUSTOM_PICO',
          engineVersion: 'VALKEY_8_0',
          highAvailability,
          backupRetentionDays: 1,
        }),
      );

      expect(said(validation)).toEqual([]);
      expect(validation.valid).toBe(true);
    },
  );

  it('takes a `redis` on Memorystore with its native.gcp laid: an eviction policy, replicas and a maintenance window', () => {
    const validation = validate(
      memorystoreDefinition({
        ...MARK,
        serviceId: 'Svc_Redis',
        stateId: 'State_Redis-1',
        network: gcpNetworkStandIns(),
        nodeType: 'CUSTOM_PICO',
        engineVersion: 'VALKEY_8_0',
        highAvailability: false,
        backupRetentionDays: 1,
        native: {
          'google_memorystore_instance.cache': {
            replica_count: 1,
            engine_configs: { 'maxmemory-policy': 'allkeys-lru' },
            automated_backup_config: { retention: '259200s' },
            maintenance_policy: {
              weekly_maintenance_window: {
                day: 'SUNDAY',
                start_time: { hours: 3 },
              },
            },
          },
        },
      }),
    );

    expect(said(validation)).toEqual([]);
    expect(validation.valid).toBe(true);
  });

  it.each([
    ['no origin trusted', []],
    [
      'browser uploads from two origins',
      ['https://app.example.com', 'http://localhost:3000'],
    ],
  ])(
    'takes a `bucket` on Cloud Storage with its own service account, binding and HMAC key, and %s',
    (_shape, origins) => {
      const validation = validate(
        gcpBucketDefinition({
          ...MARK,
          serviceId: 'Svc_Bucket',
          bucketName: 'cloudgate-abcdefghijkl-a1b2c3d4',
          stateId: 'State_Bucket-1',
          origins,
        }),
      );

      expect(said(validation)).toEqual([]);
      expect(validation.valid).toBe(true);
    },
  );

  it.each([
    ['a rotation’s new key beside the live one', { live: 'key', spare: true }],
    ['the live key moved to the second slot', { live: 'key_b', spare: false }],
    ['a stray beside the moved key', { live: 'key_b', spare: true }],
  ] as const)(
    'takes a `bucket` on Cloud Storage holding %s',
    (_shape, keys) => {
      const validation = validate(
        gcpBucketDefinition({
          ...MARK,
          serviceId: 'Svc_Bucket',
          bucketName: 'cloudgate-abcdefghijkl-a1b2c3d4',
          stateId: 'State_Bucket-1',
          origins: [],
          keys,
        }),
      );

      expect(said(validation)).toEqual([]);
      expect(validation.valid).toBe(true);
    },
  );

  it.each([
    ['its one key', { live: 'key', spare: false }],
    ['a rotation’s new key beside the live one', { live: 'key', spare: true }],
  ] as const)(
    'takes an existing bucket’s own service account and key, holding %s, with no bucket',
    (_shape, keys) => {
      const validation = validate(
        gcpBucketDefinition({
          ...MARK,
          serviceId: 'Svc_Bucket',
          bucketName: 'acme-prod-uploads',
          stateId: 'State_Bucket-1',
          origins: [],
          keys,
          existing: true,
        }),
      );

      expect(said(validation)).toEqual([]);
      expect(validation.valid).toBe(true);
    },
  );

  it('takes a `web` with variables, a command and args', () => {
    const { definition, variables } = webWithVariables();
    const validation = validate(definition, variables);

    expect(said(validation)).toEqual([]);
    expect(validation.valid).toBe(true);
  });

  it('takes a `web` with its native.gcp laid: run.app closed, the template, its container’s probes and the backend service’s settings', () => {
    const { definition, variables } = webWithVariables({
      'google_cloud_run_v2_service.service': {
        ingress: 'INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER',
        annotations: { 'example.com/team': 'payments' },
        template: {
          max_instance_request_concurrency: 20,
          timeout: '120s',
          volumes: [{ name: 'tmp', empty_dir: { medium: 'MEMORY' } }],
          containers: {
            liveness_probe: { http_get: { path: '/healthz' } },
            startup_probe: { tcp_socket: { port: 8080 } },
            resources: { cpu_idle: false, startup_cpu_boost: true },
            volume_mounts: [{ name: 'tmp', mount_path: '/tmp' }],
          },
        },
      },
      'google_compute_backend_service.service': {
        timeout_sec: 60,
        log_config: { enable: true, sample_rate: 0.5 },
        iap: { enabled: false },
      },
      'google_artifact_registry_repository.service': {
        cleanup_policies: [
          {
            id: 'keep-five',
            action: 'KEEP',
            most_recent_versions: { keep_count: 5 },
          },
        ],
      },
    });
    const validation = validate(definition, variables);

    expect(said(validation)).toEqual([]);
    expect(validation.valid).toBe(true);
  });

  it('takes a `web` whose container limits native.gcp sets, over the size', () => {
    const { definition, variables } = webWithVariables({
      'google_cloud_run_v2_service.service': {
        template: {
          containers: { resources: { limits: { cpu: '4', memory: '8Gi' } } },
        },
      },
    });
    const validation = validate(definition, variables);

    expect(said(validation)).toEqual([]);
    expect(validation.valid).toBe(true);
  });

  it("takes a Worker's Cloud Run worker pool with variables, a command and args, in the GA provider", () => {
    const { definition, variables } = workerWithVariables();
    const validation = validate(definition, variables);

    expect(said(validation)).toEqual([]);
    expect(validation.valid).toBe(true);
  });

  it("takes a Private web service's internal-only Cloud Run service with variables, its run.app URLs among its outputs", () => {
    const result = cloudRunServiceDefinition({
      ...MARK,
      configName: 'inside',
      entry: { command: 'node api.js', args: ['--port', '4000'] },
      routing: { kind: 'internal-only', port: 4000 },
      service: { serviceId: 'Svc_Inside', copies: { min: 0, max: 10 } },
      stateId: 'State_Svc-3',
      network: gcpNetworkStandIns(),
      pair: { cpu: 1, memoryMb: 512 },
      imageTag: STAND_IN_IMAGE_TAG,
      variables: { API_KEY: 'not-a-secret' },
    });
    if (!result.ok) throw new Error(result.refusal.message);
    const validation = validate(result.definition, result.variables);

    expect(said(validation)).toEqual([]);
    expect(validation.valid).toBe(true);
  });

  it("takes a Cron service's Cloud Run job with variables, a command and args: one task, no retries, a 24h task timeout, in the GA provider", () => {
    const result = cloudRunServiceDefinition({
      ...MARK,
      configName: 'report',
      entry: { command: 'node dist/report.js', args: ['--all'] },
      routing: { kind: 'job' },
      service: { serviceId: 'Svc_Cron', copies: { min: 0, max: 10 } },
      stateId: 'State_Svc-4',
      network: gcpNetworkStandIns(),
      pair: { cpu: 1, memoryMb: 512 },
      imageTag: STAND_IN_IMAGE_TAG,
      variables: { API_KEY: 'not-a-secret' },
    });
    if (!result.ok) throw new Error(result.refusal.message);
    const validation = validate(result.definition, result.variables);

    expect(said(validation)).toEqual([]);
    expect(validation.valid).toBe(true);
  });

  it("takes the Environment network with its Private web services' run.app zone and a database's private link", () => {
    const validation = validate(
      networkDefinition({
        ...MARK,
        stateId: 'State_Net-1',
        domains: [],
        privateLinks: ['run-app-zone', 'cloud-sql'],
      }),
    );

    expect(said(validation)).toEqual([]);
    expect(validation.valid).toBe(true);
  });

  it('takes a `static` site: its private bucket, Cloud CDN backend bucket and the load balancer’s grant', () => {
    const validation = validate(
      gcpStaticDefinition({
        ...MARK,
        serviceId: 'Svc_Docs',
        bucketName: 'cloudgate-abcdefghijkl-p4x8m2rt',
        projectNumber: '123456789012',
        stateId: 'State_Docs-1',
      }),
    );

    expect(said(validation)).toEqual([]);
    expect(validation.valid).toBe(true);
  });

  it('takes the destroy-only definition', () => {
    const validation = validate(destroyDefinition(MARK.projectId, MARK.region));

    expect(said(validation)).toEqual([]);
    expect(validation.valid).toBe(true);
  });

  // The lane's own control: were `validate` to stop reading the provider's
  // schema, every case above would pass on anything.
  it('refuses an attribute the pinned provider does not have', () => {
    const { definition } = webWithVariables();
    const resource = definition.resource as Record<
      string,
      Record<string, Record<string, unknown>>
    >;
    resource.google_cloud_run_v2_service.service.not_an_attribute = true;

    const validation = validate(definition);

    expect(validation.valid).toBe(false);
    expect(said(validation)).toEqual([
      expect.stringContaining(
        'No argument or block type is named "not_an_attribute"',
      ),
    ]);
  });
});
