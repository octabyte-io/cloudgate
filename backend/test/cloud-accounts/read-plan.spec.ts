import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  networkStandIns,
  STAND_IN_MARKER,
} from '../../src/cloud-accounts/aws/definitions/stand-ins';
import { readPlan } from '../../src/cloud-accounts/aws/plan-reader/read-plan';
import type {
  FoundResource,
  PlanReadContext,
} from '../../src/cloud-accounts/aws/plan-reader/read-plan';
import type {
  TofuResourceChange,
  TofuShowJson,
} from '../../src/cloud-accounts/aws/plan-reader/tofu-show.types';

/**
 * Stored `tofu show -json` plans, as the moto lane
 * (`moto/moto-lane.moto-spec.ts`) re-saves them: the generated definitions for
 * the sample `api` and its Environment network, planned by OpenTofu 1.13.1 and
 * `hashicorp/aws` 6.69.1 against moto, each after the hand change its name
 * says (`drift-tags-noise.json`: the service and log group deleted by hand and
 * port 22 opened, with `resource_drift` marking what the refresh saw move).
 */
function plan(name: string): TofuShowJson {
  return JSON.parse(
    readFileSync(join(__dirname, 'fixtures', 'plans', `${name}.json`), 'utf8'),
  ) as TofuShowJson;
}

/** A stored plan with resource changes added — for the shapes one file can't show. */
function withChanges(
  show: TofuShowJson,
  ...extra: TofuResourceChange[]
): TofuShowJson {
  return {
    ...show,
    resource_changes: [...(show.resource_changes ?? []), ...extra],
  };
}

const ACCOUNT = '123456789012';
/** What a plan read hands the reader for a network not made yet (`cloud-plan-reads.service.ts`). */
const STAND_IN_IDS = networkStandIns('eu-central-1', ACCOUNT);
const STAND_INS = [
  STAND_IN_IDS.vpcId,
  ...STAND_IN_IDS.publicSubnetIds,
  STAND_IN_IDS.clusterArn,
  STAND_IN_IDS.httpsListenerArn,
  STAND_IN_IDS.albSecurityGroupId,
  STAND_IN_MARKER,
];
const IMAGE_DEP_2 = `${ACCOUNT}.dkr.ecr.eu-central-1.amazonaws.com/cloudgate/svc_1:dep_2`;

const WEB: PlanReadContext = {
  serviceName: 'api',
  sizeName: 'small',
  variableNames: ['API_KEY', 'BIG_CERT'],
  standIns: STAND_INS,
};
const DEPLOY: PlanReadContext = {
  serviceName: 'api',
  sizeName: 'small',
  variableNames: ['API_KEY'],
  imageRef: IMAGE_DEP_2,
};

/** Every variable value any fixture carries, in clear, as `tofu show -json` prints them. */
const SECRET_VALUES = [
  'hunter2-very-secret',
  'another-secret-value',
  'rotated-secret-value-2',
  'changed-by-hand-secret',
];

describe('readPlan', () => {
  describe('creates', () => {
    it("shows a new web Service's size beside its Fargate pair, and its task count", () => {
      const reading = readPlan({
        show: plan('web-create'),
        tagSearch: [],
        context: WEB,
      });

      expect(reading.summary).toContain(
        'ECS service `api`: create, `small` → 0.5 vCPU / 1 GB, 1 task',
      );
      expect(reading.summary).toContain(
        'ECR repository `cloudgate/svc_1`: create',
      );
    });

    it('marks each half of the Fargate pair its native.aws sets', () => {
      const show = plan('web-create');
      const reading = readPlan({
        show: {
          ...show,
          resource_changes: (show.resource_changes ?? []).map((change) =>
            change.type === 'aws_ecs_task_definition'
              ? {
                  ...change,
                  change: {
                    ...change.change,
                    after: {
                      ...(change.change.after as Record<string, unknown>),
                      cpu: '2048',
                    },
                  },
                }
              : change,
          ),
        },
        tagSearch: [],
        context: { ...WEB, nativePair: { cpu: true, memory: false } },
      });

      expect(reading.summary).toContain(
        'ECS service `api`: create, `small` → 2 vCPU (native) / 1 GB, 1 task',
      );
    });

    it('names each new variable, with the Advanced parameter its price', () => {
      const reading = readPlan({
        show: plan('web-create'),
        tagSearch: [],
        context: WEB,
      });

      expect(reading.summary).toContain('Variable `API_KEY`: added');
      expect(reading.summary).toContain(
        'Variable `BIG_CERT`: added (Advanced parameter, $0.05/month)',
      );
    });

    it("shows the Environment network's stand-in ids as made by this plan", () => {
      const reading = readPlan({
        show: plan('web-create'),
        tagSearch: [],
        context: WEB,
      });

      expect(reading.summary).toContain(
        'Environment network ids (`cluster`, `ingress`, `listener_arn`, `network_configuration`, `vpc_id`): made by this plan (Environment network)',
      );
      // The placeholder text itself never reaches a person.
      expect(JSON.stringify(reading)).not.toContain('cloudgate-stand-in');
    });

    it('counts every create and lists each as a raw line', () => {
      const reading = readPlan({
        show: plan('web-create'),
        tagSearch: [],
        context: WEB,
      });

      expect(reading.counts).toEqual({
        create: 11,
        change: 0,
        destroy: 0,
        replace: 0,
        drift: 0,
        adopt: 0,
        briefDowntime: 0,
      });
      expect(reading.raw).toHaveLength(11);
      expect(reading.raw).toContainEqual({
        address: 'aws_ecs_service.service',
        resourceType: 'aws_ecs_service',
        action: 'create',
        fields: [],
        briefDowntime: false,
        drift: false,
      });
    });

    it("shows a new network's idle cost", () => {
      const reading = readPlan({
        show: plan('network-create'),
        tagSearch: [],
        context: {},
      });

      expect(reading.summary).toEqual([
        'Environment network: create, about $24/month while idle',
      ]);
      expect(reading.counts.create).toBe(16);
      expect(reading.imageOnly).toBe(false);
    });

    it("shows a network made for a first web-private with its private DNS namespace's price beside its idle cost", () => {
      const reading = readPlan({
        show: plan('network-create-private-dns'),
        tagSearch: [],
        context: {},
      });

      expect([...reading.summary].sort()).toEqual([
        'Environment network: create, about $24/month while idle',
        "Private DNS namespace `cloudgate.internal`: create, for this Environment's Private web services, about $0.50/month; kept until the Environment network goes",
      ]);
      expect(reading.counts.create).toBe(17);
    });

    it('shows a namespace added to a made network as its one line', () => {
      const reading = readPlan({
        show: plan('network-private-dns'),
        tagSearch: [],
        context: {},
      });

      expect(reading.summary).toEqual([
        "Private DNS namespace `cloudgate.internal`: create, for this Environment's Private web services, about $0.50/month; kept until the Environment network goes",
      ]);
      expect(reading.counts.create).toBe(1);
    });

    it("names a new web-private's private DNS name, with nothing of the load balancer", () => {
      const reading = readPlan({
        show: plan('web-private-create'),
        tagSearch: [],
        context: { serviceName: 'inside', standIns: STAND_INS },
      });

      expect(reading.summary).toContain(
        'Private DNS name `inside.cloudgate.internal`: create, one record per healthy task, reached from this Environment network only',
      );
      expect(
        reading.raw.filter((line) => line.address.includes('aws_lb_')),
      ).toEqual([]);
      expect(JSON.stringify(reading)).not.toContain('cloudgate-stand-in');
    });

    it("shows a new Cron service's task definition, repository, task role, variable, log group and security group, with no ECS service or scheduler", () => {
      const reading = readPlan({
        show: plan('cron-create'),
        tagSearch: [],
        context: {
          serviceName: 'nightly',
          variableNames: ['API_KEY'],
          standIns: STAND_INS,
        },
      });

      expect(reading.raw.map((line) => line.address).sort()).toEqual(
        [
          'aws_cloudwatch_log_group.service',
          'aws_ecr_lifecycle_policy.service',
          'aws_ecr_repository.service',
          'aws_ecs_task_definition.service',
          'aws_iam_role.task',
          'aws_security_group.service',
          'aws_ssm_parameter.variable["API_KEY"]',
        ].sort(),
      );
      expect(JSON.stringify(reading.raw)).not.toMatch(
        /aws_ecs_service|aws_scheduler|aws_lb_/,
      );
    });
  });

  describe("a Cron service's deploy", () => {
    it('applies on its own a new task definition revision, with no ECS service to update', () => {
      const reading = readPlan({
        show: plan('cron-new-revision'),
        tagSearch: [],
        context: { serviceName: 'nightly' },
      });

      expect(reading.raw.map((line) => [line.address, line.action])).toEqual([
        ['aws_ecs_task_definition.service', 'replace'],
      ]);
      expect(reading.imageOnly).toBe(true);
    });

    it("still needs a web's service update before its new revision applies on its own", () => {
      const show = plan('image-only-no-variables');
      const reading = readPlan({
        show: {
          ...show,
          resource_changes: (show.resource_changes ?? []).map((change) =>
            change.type === 'aws_ecs_service'
              ? { ...change, change: { ...change.change, actions: ['no-op'] } }
              : change,
          ),
        },
        tagSearch: [],
        context: { serviceName: 'api' },
      });

      expect(reading.imageOnly).toBe(false);
    });
  });

  describe('changes and replaces', () => {
    it("rolls a web-private's ECS service in place when its discovery service is replaced, and calls no variable changed", () => {
      const reading = readPlan({
        show: plan('web-private-dns-replace'),
        tagSearch: [],
        context: { serviceName: 'inside' },
      });

      expect(
        reading.raw.map(({ address, action }) => [address, action]),
      ).toEqual([
        ['aws_ecs_service.service', 'change'],
        ['aws_service_discovery_service.service', 'replace'],
      ]);
      expect(reading.raw[0].fields).toContain('triggers');
      expect(reading.summary).toContain(
        'Private DNS name `inside.cloudgate.internal`: replace, its running tasks listed again by a new deployment',
      );
      // The discovery trigger moved, not the variables' digest.
      expect(reading.summary).not.toContain(
        'variables changed, tasks will be replaced',
      );
    });

    it('lists a new image as a task definition replace without downtime, and the service update to use it', () => {
      const reading = readPlan({
        show: plan('image-only'),
        tagSearch: [],
        context: DEPLOY,
      });

      expect(reading.summary).toEqual([
        'ECS service `api`: change, `small` → 0.5 vCPU / 1 GB, 1 task',
        'Task definition: new revision, new image, built by this deploy',
        'Variable `API_KEY`: value changed',
        'variables changed, tasks will be replaced',
      ]);
      expect(reading.raw).toEqual([
        {
          address: 'aws_ecs_service.service',
          resourceType: 'aws_ecs_service',
          action: 'change',
          fields: ['task_definition', 'triggers'],
          briefDowntime: false,
          drift: false,
        },
        {
          address: 'aws_ecs_task_definition.service',
          resourceType: 'aws_ecs_task_definition',
          action: 'replace',
          fields: ['container_definitions'],
          briefDowntime: false,
          drift: false,
        },
        {
          address: 'aws_ssm_parameter.variable["API_KEY"]',
          resourceType: 'aws_ssm_parameter',
          action: 'change',
          // `version` goes known → known after apply, which OpenTofu lists too.
          fields: ['value', 'version'],
          briefDowntime: false,
          drift: false,
        },
      ]);
      expect(reading.counts).toMatchObject({
        change: 2,
        replace: 1,
        briefDowntime: 0,
      });
    });

    it('names the image when it is not the one this deploy builds', () => {
      const reading = readPlan({
        show: plan('image-only'),
        tagSearch: [],
        context: { ...DEPLOY, imageRef: undefined },
      });

      expect(reading.summary).toContain(
        `Task definition: new revision, image \`${IMAGE_DEP_2}\``,
      );
    });

    it('marks a replace of anything but a task definition as brief downtime', () => {
      const reading = readPlan({
        show: withChanges(plan('image-only'), {
          address: 'aws_lb_target_group.web',
          type: 'aws_lb_target_group',
          name: 'web',
          change: {
            actions: ['create', 'delete'],
            before: { port: 3000 },
            after: { port: 8080 },
            replace_paths: [['port']],
          },
        }),
        tagSearch: [],
        context: DEPLOY,
      });

      expect(reading.raw).toContainEqual({
        address: 'aws_lb_target_group.web',
        resourceType: 'aws_lb_target_group',
        action: 'replace',
        fields: ['port'],
        briefDowntime: true,
        drift: false,
      });
      expect(reading.counts).toMatchObject({ replace: 2, briefDowntime: 1 });
    });

    it('lists a destroy', () => {
      const reading = readPlan({
        show: withChanges(plan('image-only'), {
          address: 'aws_ssm_parameter.variable["OLD"]',
          type: 'aws_ssm_parameter',
          name: 'variable',
          change: {
            actions: ['delete'],
            before: { name: '/cloudgate/env_1/svc_1/OLD', value: 'x' },
            after: null,
            before_sensitive: { value: true },
          },
        }),
        tagSearch: [],
        context: DEPLOY,
      });

      expect(reading.summary).toContain('Variable `OLD`: removed');
      expect(reading.counts.destroy).toBe(1);
    });
  });

  describe('drift', () => {
    it('ignores tag and computed-value noise, keeping only what the plan puts back', () => {
      const reading = readPlan({
        show: plan('drift-tags-noise'),
        tagSearch: [],
        context: {},
      });

      expect(reading.drift.map((d) => d.address)).toEqual([
        'aws_cloudwatch_log_group.service',
        'aws_ecs_service.service',
        'aws_security_group.service',
      ]);
      // Neither the certificate's status nor the target group's load_balancer_arns is drift.
      expect(JSON.stringify(reading.drift)).not.toMatch(
        /ISSUED|load_balancer_arns|tags/,
      );
    });

    it('ignores a computed value the refresh saw move on a resource the plan changes anyway', () => {
      const reading = readPlan({
        show: plan('image-only'),
        tagSearch: [],
        context: DEPLOY,
      });

      expect(reading.drift).toEqual([]);
      expect(reading.counts.drift).toBe(0);
      expect(reading.raw.some((line) => line.drift)).toBe(false);
    });

    it('marks a resource deleted by hand as will be made again', () => {
      const reading = readPlan({
        show: plan('drift-tags-noise'),
        tagSearch: [],
        context: { serviceName: 'api' },
      });

      expect(reading.drift).toContainEqual({
        address: 'aws_ecs_service.service',
        resourceType: 'aws_ecs_service',
        line: 'ECS service `api`: will be made again',
        deleted: true,
        replaceForcing: false,
        fields: [],
      });
      // A put-back create is drift, not one of the config's creates.
      expect(reading.counts).toMatchObject({ create: 0, change: 0, drift: 3 });
      expect(reading.summary).toEqual([]);
    });

    it("shows each drifted field's hand value and Cloudgate's value", () => {
      const reading = readPlan({
        show: plan('drift-field'),
        tagSearch: [],
        context: DEPLOY,
      });

      const group = reading.drift.find(
        (d) => d.address === 'aws_security_group.service',
      );
      expect(group?.line).toBe(
        '`aws_security_group.service`: changed outside Cloudgate, will be put back',
      );
      expect(group?.fields.map((f) => f.field)).toEqual(['ingress']);
      expect(group?.fields[0].hand).toContain('"from_port":22');
      expect(group?.fields[0].cloudgate).not.toContain('"from_port":22');
    });

    it('never counts a running count set by hand: Stop and Start own it', () => {
      // The ECS service ignores `desired_count`, so a count changed
      // in the console plans as nothing at all.
      const reading = readPlan({
        show: plan('drift-field'),
        tagSearch: [],
        context: DEPLOY,
      });

      expect(reading.drift.map((d) => d.address)).not.toContain(
        'aws_ecs_service.service',
      );
    });

    it('never shows a sensitive value, naming only the variable', () => {
      const reading = readPlan({
        show: plan('drift-field'),
        tagSearch: [],
        context: DEPLOY,
      });

      expect(reading.drift).toContainEqual({
        address: 'aws_ssm_parameter.variable["API_KEY"]',
        resourceType: 'aws_ssm_parameter',
        line: 'Variable `API_KEY`: changed outside Cloudgate, will be put back',
        deleted: false,
        replaceForcing: false,
        fields: [
          { field: 'value', hand: '(sensitive)', cloudgate: '(sensitive)' },
        ],
      });
    });

    it('counts a drift-only plan as drift, with no config changes', () => {
      const reading = readPlan({
        show: plan('drift-field'),
        tagSearch: [],
        context: DEPLOY,
      });

      expect(reading.counts).toEqual({
        create: 0,
        change: 0,
        destroy: 0,
        replace: 0,
        drift: 2,
        adopt: 0,
        briefDowntime: 0,
      });
      expect(reading.summary).toEqual([]);
      expect(reading.raw.every((line) => line.drift)).toBe(true);
    });

    it('flags a drift only a replace puts back, with brief downtime', () => {
      const reading = readPlan({
        show: plan('replace-drift'),
        tagSearch: [],
        context: DEPLOY,
      });

      // A parameter moved to the Advanced tier by hand: SSM never moves one
      // back down, so only a replace puts it back.
      expect(reading.drift).toEqual([
        {
          address: 'aws_ssm_parameter.variable["API_KEY"]',
          resourceType: 'aws_ssm_parameter',
          line: 'Variable `API_KEY`: changed outside Cloudgate, will be put back, brief downtime',
          deleted: false,
          replaceForcing: true,
          fields: [{ field: 'tier', hand: 'Advanced', cloudgate: 'Standard' }],
        },
      ]);
      expect(reading.counts).toMatchObject({
        replace: 0,
        drift: 1,
        briefDowntime: 1,
      });
    });
  });

  describe('adopt and in no state', () => {
    const repoArn = `arn:aws:ecr:eu-central-1:${ACCOUNT}:repository/cloudgate/svc_1`;
    const stray = `arn:aws:elasticloadbalancing:eu-central-1:${ACCOUNT}:targetgroup/cg-old/1`;
    const found: FoundResource[] = [
      {
        arn: repoArn,
        tags: { 'cloudgate:address': 'aws_ecr_repository.service' },
      },
      { arn: stray, tags: { 'cloudgate:address': 'aws_lb_target_group.old' } },
    ];

    it('adopts a tag-found resource at an address the plan would create', () => {
      const reading = readPlan({
        show: plan('web-create'),
        tagSearch: found,
        context: WEB,
      });

      expect(reading.adopt).toEqual([
        {
          address: 'aws_ecr_repository.service',
          resourceType: 'aws_ecr_repository',
          arn: repoArn,
          line: "ECR repository `cloudgate/svc_1`: found in AWS, taken back into Cloudgate's record",
        },
      ]);
      expect(reading.counts).toMatchObject({ create: 10, adopt: 1 });
      expect(reading.summary).not.toContain(
        'ECR repository `cloudgate/svc_1`: create',
      );
      expect(reading.raw).toContainEqual(
        expect.objectContaining({
          address: 'aws_ecr_repository.service',
          action: 'adopt',
        }),
      );
    });

    it('notes a tag-found resource no state wants as found in AWS, in no state', () => {
      const reading = readPlan({
        show: plan('web-create'),
        tagSearch: found,
        context: WEB,
      });

      expect(reading.noState).toEqual([
        {
          arn: stray,
          address: 'aws_lb_target_group.old',
          line: `found in AWS, in no state: ${stray}`,
        },
      ]);
    });

    it('says nothing of a tag-found resource the state already holds', () => {
      const reading = readPlan({
        show: plan('image-only'),
        tagSearch: [
          {
            arn: `arn:aws:ecr:eu-central-1:${ACCOUNT}:repository/cloudgate/svc_1`,
            tags: { 'cloudgate:address': 'aws_ecr_repository.service' },
          },
        ],
        context: DEPLOY,
      });

      expect(reading.adopt).toEqual([]);
      expect(reading.noState).toEqual([]);
    });

    it('notes a second resource at a held address, which the state does not know', () => {
      const twin = `arn:aws:ecr:eu-central-1:${ACCOUNT}:repository/cloudgate/svc_1-twin`;
      const reading = readPlan({
        show: plan('image-only'),
        tagSearch: [
          {
            arn: twin,
            tags: { 'cloudgate:address': 'aws_ecr_repository.service' },
          },
        ],
        context: DEPLOY,
      });

      expect(reading.noState.map((n) => n.arn)).toEqual([twin]);
    });

    it("says nothing of an older revision of the state's task definition", () => {
      const reading = readPlan({
        show: plan('image-only'),
        tagSearch: [
          {
            arn: `arn:aws:ecs:eu-central-1:${ACCOUNT}:task-definition/cloudgate-svc_1:1`,
            tags: { 'cloudgate:address': 'aws_ecs_task_definition.service' },
          },
        ],
        context: DEPLOY,
      });

      expect(reading.noState).toEqual([]);
      expect(reading.adopt).toEqual([]);
    });
  });

  describe('image-only', () => {
    const ssm = (
      variable: string,
      actions: TofuResourceChange['change']['actions'],
    ): TofuResourceChange => ({
      address: `aws_ssm_parameter.variable["${variable}"]`,
      type: 'aws_ssm_parameter',
      name: 'variable',
      change: {
        actions,
        before: actions.includes('delete')
          ? { name: `/cloudgate/env_1/svc_1/${variable}`, value: 'a' }
          : null,
        after: actions.includes('create')
          ? { name: `/cloudgate/env_1/svc_1/${variable}`, value: 'b' }
          : null,
        before_sensitive: { value: true },
        after_sensitive: { value: true },
      },
    });

    it("holds for a new task definition revision, the service update to use it, and this deploy's variables", () => {
      expect(
        readPlan({ show: plan('image-only'), tagSearch: [], context: DEPLOY })
          .imageOnly,
      ).toBe(true);
    });

    it("holds when this deploy's variables add and remove parameters", () => {
      const show = withChanges(
        plan('image-only'),
        ssm('NEW_VAR', ['create']),
        ssm('GONE_VAR', ['delete']),
      );

      expect(
        readPlan({
          show,
          tagSearch: [],
          context: { ...DEPLOY, variableNames: ['API_KEY', 'NEW_VAR'] },
        }).imageOnly,
      ).toBe(true);
    });

    it("fails for a parameter change that is not this deploy's variables", () => {
      expect(
        readPlan({
          show: plan('image-only'),
          tagSearch: [],
          context: { ...DEPLOY, variableNames: [] },
        }).imageOnly,
      ).toBe(false);
    });

    it('fails for any drift', () => {
      expect(
        readPlan({ show: plan('drift-field'), tagSearch: [], context: DEPLOY })
          .imageOnly,
      ).toBe(false);
      expect(
        readPlan({
          show: plan('replace-drift'),
          tagSearch: [],
          context: DEPLOY,
        }).imageOnly,
      ).toBe(false);
    });

    it('fails for a create, a destroy or any other replace', () => {
      const base = plan('image-only');
      const create: TofuResourceChange = {
        address: 'aws_lb_listener_rule.extra',
        type: 'aws_lb_listener_rule',
        name: 'extra',
        change: { actions: ['create'], before: null, after: { priority: 5 } },
      };
      const destroy: TofuResourceChange = {
        address: 'aws_cloudwatch_log_group.runtime',
        type: 'aws_cloudwatch_log_group',
        name: 'runtime',
        change: { actions: ['delete'], before: { name: 'x' }, after: null },
      };
      const replace: TofuResourceChange = {
        address: 'aws_security_group.web',
        type: 'aws_security_group',
        name: 'web',
        change: {
          actions: ['delete', 'create'],
          before: { name: 'a' },
          after: { name: 'b' },
          replace_paths: [['name']],
        },
      };

      for (const extra of [create, destroy, replace]) {
        expect(
          readPlan({
            show: withChanges(base, extra),
            tagSearch: [],
            context: DEPLOY,
          }).imageOnly,
        ).toBe(false);
      }
    });

    it('fails when the service update changes more than its task definition and variables', () => {
      const show = plan('image-only');
      const changes = (show.resource_changes ?? []).map((c) =>
        c.address === 'aws_ecs_service.service'
          ? {
              ...c,
              change: {
                ...c.change,
                after: { ...(c.change.after as object), desired_count: 2 },
              },
            }
          : c,
      );

      expect(
        readPlan({
          show: { ...show, resource_changes: changes },
          tagSearch: [],
          context: DEPLOY,
        }).imageOnly,
      ).toBe(false);
    });

    it('fails for a first create, and for an adopt', () => {
      expect(
        readPlan({ show: plan('web-create'), tagSearch: [], context: WEB })
          .imageOnly,
      ).toBe(false);
    });
  });

  describe('what is never shown', () => {
    const readings = () => [
      readPlan({ show: plan('web-create'), tagSearch: [], context: WEB }),
      readPlan({ show: plan('image-only'), tagSearch: [], context: DEPLOY }),
      readPlan({ show: plan('drift-field'), tagSearch: [], context: DEPLOY }),
      readPlan({ show: plan('replace-drift'), tagSearch: [], context: DEPLOY }),
    ];

    it('prints no variable value anywhere, only names', () => {
      for (const reading of readings()) {
        const text = JSON.stringify(reading);
        for (const value of SECRET_VALUES) expect(text).not.toContain(value);
      }
    });

    it("prints no variables digest from the service's triggers", () => {
      const digests = new Set<string>();
      for (const name of [
        'web-create',
        'image-only',
        'drift-field',
        'replace-drift',
      ]) {
        const text = JSON.stringify(plan(name));
        for (const [, digest] of text.matchAll(/"variables":"([0-9a-f]{64})"/g))
          digests.add(digest);
      }
      expect(digests.size).toBeGreaterThan(0);
      for (const reading of readings()) {
        const text = JSON.stringify(reading);
        for (const digest of digests) expect(text).not.toContain(digest);
      }
    });

    it('is plain JSON, so it stores in a plan step unchanged', () => {
      for (const reading of readings()) {
        expect(JSON.parse(JSON.stringify(reading))).toEqual(reading);
      }
    });
  });
});
