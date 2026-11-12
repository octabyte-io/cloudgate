import type {
  PlanReading,
  RawLine,
} from '../../src/cloud-accounts/aws/plan-reader/read-plan';
import {
  AWS_DIFFERS,
  refusalMessage,
  refusalOf,
} from '../../src/project-config/applier/cloud-deploy-steps';
import type {
  CloudRead,
  PlanStep,
} from '../../src/project-config/planner/plan.types';
import { withCloudRead } from '../../src/project-config/stopped-deploy-plans.service';

function line(action: RawLine['action'], address: string): RawLine {
  return {
    address,
    resourceType: address.split('.')[0],
    action,
    fields: [],
    briefDowntime: false,
    drift: false,
  };
}

function reading(raw: RawLine[], imageOnly = false): PlanReading {
  return {
    summary: [],
    raw,
    counts: {
      create: 0,
      change: 0,
      destroy: 0,
      replace: 0,
      drift: 0,
      adopt: 0,
      briefDowntime: 0,
    },
    drift: [],
    adopt: [],
    noState: [],
    imageOnly,
  };
}

const IMAGE = [
  line('replace', 'aws_ecs_task_definition.web'),
  line('change', 'aws_ecs_service.web'),
];
const none = new Set<string>();

/** Spec "Auto-apply rule": what a deploy no Apply queued may apply. */
describe('refusalOf', () => {
  const noApply = { byApply: null, listed: null };

  it('lets an image-only plan, or an empty one, go on', () => {
    expect(refusalOf(noApply, reading(IMAGE, true), none)).toBeNull();
    expect(refusalOf(noApply, reading([]), none)).toBeNull();
  });

  it.each([
    ['a create', line('create', 'aws_security_group.extra')],
    ['a destroy', line('destroy', 'aws_security_group.web')],
    ['a replace', line('replace', 'aws_lb_target_group.web')],
    ['drift', { ...line('change', 'aws_security_group.web'), drift: true }],
  ])('stops on %s, for review, naming what it met', (_name, extra) => {
    const refusal = refusalOf(noApply, reading([...IMAGE, extra]), none);

    expect(refusal).toEqual({
      kind: 'differs',
      detail: expect.stringContaining(
        `${extra.action} ${extra.address}`,
      ) as unknown,
    });
    expect(refusalMessage(refusal!)).toMatch(new RegExp(`^${AWS_DIFFERS} \\(`));
  });

  it('stops on drift even where the last applied plan listed the same line', () => {
    const remade = {
      ...line('create', 'aws_lb_target_group.web'),
      drift: true,
    };
    const listed = reading([
      ...IMAGE,
      line('create', 'aws_lb_target_group.web'),
    ]);

    expect(
      refusalOf({ byApply: null, listed }, reading([...IMAGE, remade]), none),
    ).toMatchObject({ kind: 'differs' });
  });

  it('lets what the last applied plan listed go on', () => {
    const listed = reading([
      ...IMAGE,
      line('change', 'aws_security_group.web'),
    ]);
    const now = reading([line('change', 'aws_security_group.web')]);

    expect(refusalOf({ byApply: null, listed }, now, none)).toBeNull();
  });

  it('holds a deploy its Apply queued to what that Apply approved, never for review', () => {
    const approved = reading([line('change', 'aws_security_group.web')]);
    const now = reading([line('destroy', 'aws_security_group.web')]);

    expect(
      refusalOf({ byApply: approved, listed: null }, now, none),
    ).toMatchObject({ kind: 'stale' });
    expect(
      refusalOf({ byApply: approved, listed: null }, approved, none),
    ).toBeNull();
  });

  describe('a deploy whose Apply approved a read of the live image', () => {
    const service = (...fields: string[]): RawLine => ({
      ...line('change', 'aws_ecs_service.web'),
      fields,
    });
    const drift = {
      ...line('change', 'aws_security_group.web'),
      fields: ['ingress'],
      drift: true,
    };

    it('lets a build add only its new image, its variables and the service update to use them', () => {
      const approved = reading([drift, service('desired_count')]);
      const now = reading([
        drift,
        line('replace', 'aws_ecs_task_definition.web'),
        service('desired_count', 'task_definition', 'triggers'),
        line('create', 'aws_ssm_parameter.variable["API_KEY"]'),
      ]);

      expect(
        refusalOf(
          { byApply: approved, listed: null, newImage: true },
          now,
          none,
        ),
      ).toBeNull();
    });

    it('still holds a build to everything else the Apply approved', () => {
      const approved = reading([drift]);
      const now = reading([
        line('replace', 'aws_ecs_task_definition.web'),
        service('task_definition'),
      ]);

      expect(
        refusalOf(
          { byApply: approved, listed: null, newImage: true },
          now,
          none,
        ),
      ).toMatchObject({ kind: 'stale' });
    });

    it('holds a put-back on the live image to exactly what was approved', () => {
      const approved = reading([drift]);
      const now = reading([
        drift,
        line('replace', 'aws_ecs_task_definition.web'),
      ]);

      expect(
        refusalOf(
          { byApply: approved, listed: null, newImage: false },
          now,
          none,
        ),
      ).toMatchObject({ kind: 'stale' });
    });
  });
});

/** The plan a stopped deploy opens. */
describe('withCloudRead', () => {
  const service = {
    applicationId: 'app_1',
    environmentId: 'env_1',
    configName: 'web',
    name: 'web',
  };
  const cloudRead: CloudRead = {
    status: 'read',
    ...reading([line('destroy', 'aws_security_group.web')]),
    stateId: 'st_1',
    serviceId: 'app_1',
    readAt: '2026-10-17T00:00:00.000Z',
  };
  const change = (serviceId: string, configName: string): PlanStep => ({
    action: 'change',
    configName,
    kind: 'web',
    serviceType: 'application',
    serviceId,
    name: configName,
    fields: [{ field: 'port', from: 3000, to: 8080 }],
  });
  const destroy = (serviceId: string, configName: string): PlanStep => ({
    action: 'destroy',
    configName,
    kind: 'web',
    serviceType: 'application',
    serviceId,
    name: configName,
  });

  it("puts the deploy's AWS lines on the Service's own change", () => {
    const steps = withCloudRead(
      [change('app_2', 'api'), change('app_1', 'web')],
      service,
      cloudRead,
    );

    expect(steps).toEqual([
      change('app_2', 'api'),
      { ...change('app_1', 'web'), cloudRead },
    ]);
  });

  it('adds a change of no field, before the destroys, when the config changes nothing of it', () => {
    const steps = withCloudRead(
      [change('app_2', 'api'), destroy('app_3', 'old')],
      service,
      cloudRead,
    );

    expect(steps).toEqual([
      change('app_2', 'api'),
      {
        action: 'change',
        configName: 'web',
        kind: 'web',
        serviceType: 'application',
        serviceId: 'app_1',
        name: 'web',
        fields: [],
        cloudRead,
      },
      destroy('app_3', 'old'),
    ]);
  });

  it("turns the Service's redeploy into its change, so the plan holds one step for it", () => {
    const redeploy: PlanStep = {
      action: 'redeploy',
      configName: 'web',
      kind: 'web',
      serviceType: 'application',
      serviceId: 'app_1',
      name: 'web',
      because: ['db.url'],
    };

    expect(
      withCloudRead([change('app_2', 'api'), redeploy], service, cloudRead),
    ).toEqual([
      change('app_2', 'api'),
      {
        action: 'change',
        configName: 'web',
        kind: 'web',
        serviceType: 'application',
        serviceId: 'app_1',
        name: 'web',
        fields: [],
        cloudRead,
      },
    ]);
  });

  it('leaves a plan that destroys the Service as it is', () => {
    const steps = [destroy('app_1', 'web')];

    expect(withCloudRead(steps, service, cloudRead)).toEqual(steps);
  });
});
