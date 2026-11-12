import { cloudReadOf } from '../../src/project-config/planner/cloud-steps';
import type { PlanStep } from '../../src/project-config';
import { startLegacyDatabase } from '../utils/migrations-up-to';
import type { LegacyDatabase } from '../utils/migrations-up-to';

jest.setTimeout(180_000);

/** The last migration before a cloud step's read was `cloudRead`. */
const MIGRATION_BEFORE_CLOUD_READ = '0151_certificate-deletion';

const PLACE = { kind: 'cloud', cloudAccountId: 'ca-1', region: 'eu-west-1' };

const NETWORK_READ = {
  status: 'read',
  summary: ['Environment network: create, about $24/month while idle'],
  raw: [],
  counts: { create: 3, change: 0, destroy: 0, replace: 0, drift: 0 },
  drift: [],
  imageOnly: false,
  stateId: 'state-network',
  readAt: '2026-10-19T09:00:00.000Z',
};

const WEB_READ = {
  ...NETWORK_READ,
  summary: ['ECS service `web`: create, `small` → 0.5 vCPU / 1 GB, 1 task'],
  stateId: 'state-web',
  serviceId: 'app-web',
};

const SERVICE = {
  port: 8080,
  command: null,
  args: [],
  size: { name: 'small', cpu: 0.5, memoryMb: 1024 },
};

/** An open plan's steps as a plan stored before spec S17 held them. */
const BEFORE = [
  {
    action: 'network-create',
    cloudAccountId: 'ca-1',
    region: 'eu-west-1',
    aws: NETWORK_READ,
  },
  {
    action: 'create',
    configName: 'web',
    kind: 'web',
    placement: PLACE,
    fields: [],
    cloud: {
      size: { name: 'small', fargate: '0.5 vCPU / 1 GB' },
      service: SERVICE,
    },
    aws: WEB_READ,
  },
  {
    action: 'change',
    configName: 'api',
    kind: 'web',
    serviceType: 'application',
    serviceId: 'app-api',
    name: 'api',
    fields: [],
    aws: { status: 'failed', reason: 'The state is locked' },
  },
  {
    action: 'create',
    configName: 'cache',
    kind: 'redis',
    placement: { kind: 'platform-host' },
    fields: [],
  },
];

/** The same steps as a plan stored after it holds them. */
const AFTER = [
  {
    action: 'network-create',
    cloudAccountId: 'ca-1',
    region: 'eu-west-1',
    cloudRead: NETWORK_READ,
  },
  {
    action: 'create',
    configName: 'web',
    kind: 'web',
    placement: PLACE,
    fields: [],
    cloud: {
      size: {
        name: 'small',
        pair: { runsOn: 'Fargate', wording: '0.5 vCPU / 1 GB' },
      },
      service: SERVICE,
    },
    cloudRead: WEB_READ,
  },
  {
    action: 'change',
    configName: 'api',
    kind: 'web',
    serviceType: 'application',
    serviceId: 'app-api',
    name: 'api',
    fields: [],
    cloudRead: { status: 'failed', reason: 'The state is locked' },
  },
  BEFORE[3],
];

/**
 * Spec S17: a cloud plan step's `aws` read became `cloudRead`, and a
 * cloud web create's `fargate` pair the neutral `pair`. `0152` rewrites the
 * stored plans, so an open plan stored before reads as one stored after —
 * the steps the planner writes now, which its Apply reads (`cloudReadOf`).
 */
describe('Plan step cloud read migration (e2e)', () => {
  let legacy: LegacyDatabase;

  beforeAll(async () => {
    legacy = await startLegacyDatabase('s17', MIGRATION_BEFORE_CLOUD_READ);
    await legacy.pool.query(`
      insert into "user" (id, email, updated_at)
        values ('user-1', 'grace@example.com', now());
      insert into organization (id, name, created_at, owner_id)
        values ('org-1', 'Acme', now(), 'user-1');
      insert into project (project_id, name, created_at, organization_id)
        values ('p-1', 'Shop', now(), 'org-1');
      insert into environment (environment_id, name, created_at, project_id)
        values ('e-1', 'production', now(), 'p-1'),
               ('e-2', 'staging', now(), 'p-1');
    `);
    await legacy.pool.query(
      `insert into plan (plan_id, environment_id, source, text_hash, base_text_hash,
                         settings_fingerprint, steps, notes, status, created_at)
         values ('plan-open', 'e-1', 'save', 'h', 'h', 'f', $1, '[]', 'open', now()),
                ('plan-none', 'e-2', 'save', 'h', 'h', 'f', $2, '[]', 'applied', now()),
                ('plan-empty', 'e-2', 'save', 'h', 'h', 'f', '[]', '[]', 'unchanged', now())`,
      [JSON.stringify(BEFORE), JSON.stringify([BEFORE[3]])],
    );

    await legacy.migrateToHead();
  });

  afterAll(async () => {
    await legacy?.drop();
  });

  async function stepsOf(planId: string): Promise<PlanStep[]> {
    const { rows } = await legacy.pool.query<{ steps: PlanStep[] }>(
      'select steps from plan where plan_id = $1',
      [planId],
    );
    return rows[0].steps;
  }

  it("renames each step's aws read to cloudRead and its Fargate pair to the neutral pair, in order", async () => {
    expect(await stepsOf('plan-open')).toEqual(AFTER);
  });

  it('leaves a read the Apply finds where it now looks', async () => {
    const steps = await stepsOf('plan-open');

    expect(steps.map((step) => cloudReadOf(step)?.status ?? null)).toEqual([
      'read',
      'read',
      'failed',
      null,
    ]);
  });

  it('leaves a plan with no cloud step as it was', async () => {
    expect(await stepsOf('plan-none')).toEqual([BEFORE[3]]);
    expect(await stepsOf('plan-empty')).toEqual([]);
  });
});
