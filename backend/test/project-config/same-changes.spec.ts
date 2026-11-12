import type {
  PlanReading,
  RawLine,
} from '../../src/cloud-accounts/aws/plan-reader/read-plan';
import {
  changesDiffer,
  unlisted,
  withoutAddresses,
} from '../../src/project-config/applier/same-changes';

function line(
  action: RawLine['action'],
  address: string,
  fields: string[] = [],
): RawLine {
  return {
    address,
    resourceType: address.split('.')[0],
    action,
    fields,
    briefDowntime: false,
    drift: false,
  };
}

function reading(raw: RawLine[], summary: string[] = []): PlanReading {
  return {
    summary,
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
    imageOnly: false,
  };
}

const shown = reading(
  [
    line('create', 'aws_ecs_service.web'),
    line('create', 'aws_lb_target_group.web'),
    line('create', 'aws_security_group.web'),
  ],
  [
    'ECS service: create',
    'Environment network ids (`vpc_id`): made by this plan (Environment network)',
  ],
);

describe('changesDiffer', () => {
  it('finds no difference when the same resources are made, whatever the summary now reads', () => {
    // Made again with the network's real ids: the stand-in line is gone from
    // the summary, and every resource is the same create.
    const now = reading(
      [
        line('create', 'aws_security_group.web'),
        line('create', 'aws_ecs_service.web'),
        line('create', 'aws_lb_target_group.web'),
      ],
      ['ECS service: create'],
    );
    expect(changesDiffer(shown, now)).toBeNull();
  });

  it('names a resource the plan made again would make that the shown one did not', () => {
    const now = reading([
      ...shown.raw,
      line('create', 'aws_lb_listener_rule.web'),
    ]);
    expect(changesDiffer(shown, now)).toBe(
      'it now would create aws_lb_listener_rule.web',
    );
  });

  it('names a resource the shown plan made that the plan made again does not', () => {
    const now = reading(shown.raw.slice(0, 2));
    expect(changesDiffer(shown, now)).toBe(
      'it no longer would create aws_security_group.web',
    );
  });

  it('tells an adopt from a create of the same resource', () => {
    const now = reading([
      line('adopt', 'aws_ecs_service.web'),
      ...shown.raw.slice(1),
    ]);
    expect(changesDiffer(shown, now)).toBe(
      'it now would adopt aws_ecs_service.web, and it no longer would create aws_ecs_service.web',
    );
  });

  it('tells a change of other fields from the change shown', () => {
    const before = reading([line('change', 'aws_ecs_service.web', ['cpu'])]);
    const now = reading([
      line('change', 'aws_ecs_service.web', ['cpu', 'memory']),
    ]);
    expect(changesDiffer(before, now)).toBe(
      'it now would change aws_ecs_service.web (cpu, memory), and it no longer would change aws_ecs_service.web (cpu)',
    );
  });
});

describe('unlisted', () => {
  const approved = reading([
    line('create', 'aws_ecr_repository.service'),
    line('create', 'aws_ecs_service.service'),
    line('create', 'aws_ecs_task_definition.service'),
  ]);

  it('is null when every change is one the approved plan listed, fewer included', () => {
    expect(
      unlisted(approved, reading([line('create', 'aws_ecs_service.service')])),
    ).toBeNull();
    expect(unlisted(approved, reading([]))).toBeNull();
  });

  it('names each change the approved plan did not list', () => {
    expect(
      unlisted(
        approved,
        reading([
          line('create', 'aws_ecs_service.service'),
          line('change', 'aws_lb_target_group.service', ['port']),
        ]),
      ),
    ).toBe('it would change aws_lb_target_group.service (port)');
  });
});

describe('withoutAddresses', () => {
  it('drops the lines of what a targeted apply already made', () => {
    const made = withoutAddresses(
      reading([
        line('create', 'aws_ecr_repository.service'),
        line('create', 'aws_ecs_service.service'),
      ]),
      new Set(['aws_ecr_repository.service']),
    );
    expect(made.raw.map((one) => one.address)).toEqual([
      'aws_ecs_service.service',
    ]);
  });
});
