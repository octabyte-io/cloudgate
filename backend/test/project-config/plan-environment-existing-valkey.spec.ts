import {
  addEndpointsCommand,
  judgeExistingValkey,
  parseValkeyName,
  valkeyRegistered,
} from '../../src/cloud-accounts/gcp/plan-reader/existing-valkey';
import type {
  ExistingValkeyContext,
  ValkeyLookup,
} from '../../src/cloud-accounts/gcp/plan-reader/existing-valkey';
import type { MemorystoreInstanceRead } from '../../src/cloud-accounts/google-cloud.port';
import { parseProjectConfig, planEnvironment } from '../../src/project-config';
import type { DeployTarget, SavedService } from '../../src/project-config';

const CA = '-----BEGIN CERTIFICATE-----\nMIIBvalkey\n-----END CERTIFICATE-----';
const PRIMARY =
  'projects/y1a2b3c4d5e6f7-tp/regions/europe-west1/serviceAttachments/gcp-memorystore-auto-a1b2-psc-sa';
const READER =
  'projects/y1a2b3c4d5e6f7-tp/regions/europe-west1/serviceAttachments/gcp-memorystore-auto-a1b2-psc-sa-2';

/** An instance as the walk by hand made one: cluster mode off, no login, TLS on, a new enough version. */
const INSTANCE: MemorystoreInstanceRead = {
  product: 'valkey',
  engineVersion: 'VALKEY_8_0',
  mode: 'CLUSTER_DISABLED',
  authorizationMode: 'AUTH_DISABLED',
  transitEncryptionMode: 'SERVER_AUTHENTICATION',
  maintenanceVersion: 'MEMORYSTORE_20261008_00_00',
  labels: { team: 'orders' },
  serviceAttachments: [
    { serviceAttachment: PRIMARY, connectionType: 'CONNECTION_TYPE_PRIMARY' },
    { serviceAttachment: READER, connectionType: 'CONNECTION_TYPE_READER' },
  ],
  registeredForwardingRules: [],
  ca: CA,
};

const CONTEXT: ExistingValkeyContext = {
  serviceName: 'cache',
  identifier: 'shop-prod/europe-west1/orders-cache',
  projectId: 'shop-prod',
  region: 'europe-west1',
  serviceAccount: 'cloudgate-deploy@shop-prod.iam.gserviceaccount.com',
};

const USES =
  'cache uses the existing cache shop-prod/europe-west1/orders-cache';

function judged(
  instance: Partial<MemorystoreInstanceRead>,
  context: Partial<ExistingValkeyContext> = {},
) {
  return judgeExistingValkey(
    { kind: 'found', instance: { ...INSTANCE, ...instance } },
    { ...CONTEXT, ...context },
  );
}

function refusal(
  lookup: ValkeyLookup,
  context: Partial<ExistingValkeyContext> = {},
): string {
  const verdict = judgeExistingValkey(lookup, { ...CONTEXT, ...context });
  if (verdict.ok) throw new Error('it was not refused');
  return verdict.reason;
}

function refused(instance: Partial<MemorystoreInstanceRead>): string {
  return refusal({ kind: 'found', instance: { ...INSTANCE, ...instance } });
}

describe('parseValkeyName', () => {
  it('reads project, region and instance', () => {
    expect(parseValkeyName('shop-prod/europe-west1/orders-cache')).toEqual({
      projectId: 'shop-prod',
      region: 'europe-west1',
      instance: 'orders-cache',
    });
  });

  it('refuses a Cloud SQL connection name or an ElastiCache id', () => {
    expect(parseValkeyName('shop-prod:europe-west1:acme')).toBeNull();
    expect(parseValkeyName('acme-cache')).toBeNull();
  });
});

describe('judgeExistingValkey', () => {
  it("uses an instance as given, TLS read as on with the CA it reports, its primary's attachment first", () => {
    expect(judged({})).toEqual({
      ok: true,
      tls: true,
      ca: CA,
      serviceAttachments: { primary: PRIMARY, reader: READER },
      lines: [
        "cache: existing cache shop-prod/europe-west1/orders-cache, Valkey 8.0, TLS on (rediss://), through Cloudgate's own two endpoints; used as given, Cloudgate changes nothing in it",
      ],
    });
  });

  it('reads TLS off from the instance, handing out no CA', () => {
    const verdict = judged({
      transitEncryptionMode: 'TRANSIT_ENCRYPTION_DISABLED',
      ca: null,
    });

    expect(verdict).toMatchObject({ ok: true, tls: false, ca: null });
  });

  it('refuses one Google Cloud cannot find, marking it missing for its page', () => {
    expect(judgeExistingValkey({ kind: 'missing' }, CONTEXT)).toEqual({
      ok: false,
      missing: true,
      reason: `${USES}, but Google Cloud cannot find Memorystore for Valkey instance orders-cache in project shop-prod, region europe-west1. Check the instance name on cache's page`,
    });
  });

  it('names the read grant for an instance in another project, and for one it may not read', () => {
    const grant =
      'gcloud projects add-iam-policy-binding orders-123 --member=serviceAccount:cloudgate-deploy@shop-prod.iam.gserviceaccount.com --role=roles/memorystore.viewer';
    const elsewhere = { identifier: 'orders-123/europe-west1/orders-cache' };

    expect(refusal({ kind: 'missing' }, elsewhere)).toContain(grant);
    expect(
      refusal({ kind: 'unreadable', message: 'Permission denied' }, elsewhere),
    ).toContain(grant);
  });

  it.each([
    ['redis', 'a Memorystore for Redis instance'],
    ['redis-cluster', 'a Memorystore for Redis Cluster'],
  ] as const)('refuses %s with "use Valkey"', (product, said) => {
    expect(refused({ product })).toBe(
      `${USES}, but it is ${said}, which Cloudgate cannot reach without peering a network: use Valkey. Give the name of a Memorystore for Valkey instance with cluster mode off`,
    );
  });

  it('refuses one with cluster mode on', () => {
    expect(refused({ mode: 'CLUSTER' })).toBe(
      `${USES}, but it is in cluster mode (CLUSTER), so a redis cannot use it: it hands out one URL, to one primary endpoint. Give the name of a Valkey instance with cluster mode off`,
    );
  });

  it('refuses one in another region', () => {
    expect(
      refusal(
        { kind: 'found', instance: INSTANCE },
        { identifier: 'shop-prod/us-central1/orders-cache' },
      ),
    ).toBe(
      "cache uses the existing cache shop-prod/us-central1/orders-cache, but it is in us-central1, not this Environment's region europe-west1; an existing cache must be in the Environment's region",
    );
  });

  it('refuses a login mode other than AUTH_DISABLED (ADR-0042)', () => {
    expect(refused({ authorizationMode: 'IAM_AUTH' })).toBe(
      `${USES}, but it asks every client to log in (IAM_AUTH), and Cloudgate's Outputs carry no token and no IAM login. Use a Valkey instance with authorization off (AUTH_DISABLED); only this Environment's network reaches it through Cloudgate's endpoints`,
    );
  });

  it('refuses a maintenance version below MEMORYSTORE_20251210_02_00, showing the update command', () => {
    expect(refused({ maintenanceVersion: 'MEMORYSTORE_20250901_00_00' })).toBe(
      `${USES}, but it runs maintenance version MEMORYSTORE_20250901_00_00, below MEMORYSTORE_20251210_02_00, the first that takes endpoints from another network. Update it: \`gcloud memorystore instances update orders-cache --location=europe-west1 --project=shop-prod --maintenance-version=MEMORYSTORE_20251210_02_00\``,
    );
  });

  it('takes exactly the lowest maintenance version', () => {
    expect(
      judged({ maintenanceVersion: 'MEMORYSTORE_20251210_02_00' }).ok,
    ).toBe(true);
  });

  it("refuses one carrying Cloudgate's labels", () => {
    expect(
      refused({
        labels: { 'cloudgate-state': 'abc', 'cloudgate-environment': 'def' },
      }),
    ).toBe(
      `${USES}, but it carries Cloudgate's labels (cloudgate-environment, cloudgate-state), so Cloudgate made it for an Environment; an existing cache must be one Cloudgate did not make`,
    );
  });

  it('refuses one Google reports fewer than two service attachments for', () => {
    expect(
      refused({ serviceAttachments: [INSTANCE.serviceAttachments[0]] }),
    ).toContain('only one service attachment');
  });
});

describe('valkeyRegistered', () => {
  const rules = [
    'projects/shop-prod/regions/europe-west1/forwardingRules/cloudgate-abc-psc-0',
    'projects/shop-prod/regions/europe-west1/forwardingRules/cloudgate-abc-psc-1',
  ];

  it('waits until both rules are registered, by relative name or full URL', () => {
    expect(valkeyRegistered(INSTANCE, rules)).toBe(false);
    expect(
      valkeyRegistered(
        { ...INSTANCE, registeredForwardingRules: [rules[0]] },
        rules,
      ),
    ).toBe(false);
    expect(
      valkeyRegistered(
        {
          ...INSTANCE,
          registeredForwardingRules: [
            rules[0],
            `https://www.googleapis.com/compute/v1/${rules[1]}`,
          ],
        },
        rules,
      ),
    ).toBe(true);
  });
});

describe('addEndpointsCommand', () => {
  it('names both endpoints by their relative forwarding-rule names', () => {
    const command = addEndpointsCommand({
      instance: {
        projectId: 'shop-prod',
        region: 'europe-west1',
        instance: 'orders-cache',
      },
      projectId: 'shop-prod',
      network: 'projects/shop-prod/global/networks/cloudgate-abc-net',
      endpoints: [
        {
          endpoint: 'primary',
          name: 'cloudgate-abc-psc-0',
          address: '10.64.16.20',
          pscConnectionId: '111',
          serviceAttachment: PRIMARY,
        },
        {
          endpoint: 'reader',
          name: 'cloudgate-abc-psc-1',
          address: '10.64.16.21',
          pscConnectionId: '222',
          serviceAttachment: READER,
        },
      ],
    });

    expect(command).toBe(
      `gcloud memorystore instances update orders-cache --location=europe-west1 --project=shop-prod --add-endpoints='[{"connections":[{"pscConnection":{"pscConnectionId":"111","ipAddress":"10.64.16.20","network":"projects/shop-prod/global/networks/cloudgate-abc-net","forwardingRule":"projects/shop-prod/regions/europe-west1/forwardingRules/cloudgate-abc-psc-0","serviceAttachment":"${PRIMARY}"}},{"pscConnection":{"pscConnectionId":"222","ipAddress":"10.64.16.21","network":"projects/shop-prod/global/networks/cloudgate-abc-net","forwardingRule":"projects/shop-prod/regions/europe-west1/forwardingRules/cloudgate-abc-psc-1","serviceAttachment":"${READER}"}}]}]'`,
    );
  });
});

describe('planEnvironment, an existing Valkey redis on Google Cloud', () => {
  const GOOGLE: DeployTarget = {
    kind: 'cloud',
    cloudAccountId: 'gca-1',
    region: 'europe-west1',
  };
  const cache: SavedService = {
    serviceType: 'redis',
    serviceId: 'cache-id',
    name: 'cache',
    configName: 'cache',
    existing: {
      cloudAccountId: 'gca-1',
      region: 'europe-west1',
      identifier: 'shop-prod/europe-west1/orders-cache',
      madeReachable: false,
    },
    settings: {
      description: null,
      cpuLimit: null,
      memoryLimit: null,
      dockerImage: 'redis:7',
    },
    variables: { env: [] },
  };
  const CACHE_ONLY = `version: 1
services:
  cache:
    kind: redis
`;

  function googlePlan(
    networks: Parameters<typeof planEnvironment>[0]['networks'],
  ) {
    const parsed = parseProjectConfig(CACHE_ONLY);
    if (!parsed.ok) throw new Error(parsed.refusal.message);
    const outcome = planEnvironment({
      config: parsed.config,
      saved: [cache],
      deployTarget: GOOGLE,
      cloud: 'gcp',
      context: { previous: null },
      networks,
    });
    if (!outcome.ok) throw new Error(outcome.refusals[0].message);
    return outcome.steps;
  }

  it("looks it up, and adds Memorystore's private link to a made network first, whose subnet its endpoints' addresses are on", () => {
    const steps = googlePlan([
      {
        cloudAccountId: 'gca-1',
        region: 'europe-west1',
        environmentNetworkId: 'net-1',
        privateLinks: [],
      },
    ]);

    expect(steps).toEqual([
      expect.objectContaining({
        action: 'network-change',
        privateLinks: ['memorystore'],
      }),
      expect.objectContaining({
        action: 'change',
        configName: 'cache',
        existing: expect.objectContaining({
          identifier: 'shop-prod/europe-west1/orders-cache',
        }) as unknown,
        cloudRead: { status: 'reading' },
      }),
    ]);
  });

  it('touches no network that holds the link already', () => {
    const steps = googlePlan([
      {
        cloudAccountId: 'gca-1',
        region: 'europe-west1',
        environmentNetworkId: 'net-1',
        privateLinks: ['memorystore'],
      },
    ]);

    expect(steps.map((step) => step.action)).toEqual(['change']);
  });
});
