import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { stateResources } from '../../src/cloud-accounts/aws/state-resources';
import type { TofuStateShow } from '../../src/cloud-accounts/tofu/state-show';

/** A state as `tofu show -json` prints it, with values a list must never show. */
const WEB_STATE = JSON.parse(
  readFileSync(
    resolve(__dirname, 'fixtures', 'states', 'web-state.json'),
    'utf8',
  ),
) as TofuStateShow;

const SECRETS = [
  'PARAMETER-SECRET-VALUE',
  'TASK-DEFINITION-VALUE',
  'OUTPUT-SECRET-VALUE',
  '2012-10-17',
  'IMMUTABLE',
];

describe('stateResources', () => {
  it("lists each resource's type, AWS id, region and tags, and whether a tag search finds it", () => {
    const listed = stateResources(WEB_STATE, 'eu-central-1');

    expect(
      listed.map(({ type, awsId, region, findableByTag }) => ({
        type,
        awsId,
        region,
        findableByTag,
      })),
    ).toEqual([
      {
        type: 'aws_ecr_repository',
        awsId: 'cloudgate-svc_1',
        region: 'eu-central-1',
        findableByTag: true,
      },
      {
        type: 'aws_ssm_parameter',
        awsId: '/cloudgate/env_1/svc_1/API_KEY',
        region: 'eu-central-1',
        findableByTag: true,
      },
      {
        type: 'aws_ecs_task_definition',
        awsId: 'cloudgate-svc_1',
        region: 'eu-central-1',
        findableByTag: true,
      },
      {
        type: 'aws_security_group',
        awsId: 'sg-0service',
        region: 'eu-central-1',
        findableByTag: true,
      },
      // IAM is global, and Resource Groups Tagging never finds it.
      {
        type: 'aws_iam_role',
        awsId: 'cloudgate-task-svc_1',
        region: 'global',
        findableByTag: false,
      },
      {
        type: 'aws_iam_role_policy_attachment',
        awsId: 'cloudgate-task-svc_1-20261017000000000000000001',
        region: 'global',
        findableByTag: false,
      },
    ]);
    expect(listed[0].tags).toEqual({
      Name: 'web',
      'cloudgate:address': 'aws_ecr_repository.image',
      'cloudgate:cloud-account': 'cla_1',
      'cloudgate:environment': 'env_1',
      'cloudgate:state': 'state-web',
    });
  });

  it('carries only the five fields, and never a value of a setting or an output', () => {
    const listed = stateResources(WEB_STATE, 'eu-central-1');

    for (const resource of listed) {
      expect(Object.keys(resource).sort()).toEqual([
        'awsId',
        'findableByTag',
        'region',
        'tags',
        'type',
      ]);
    }
    const text = JSON.stringify(listed);
    for (const secret of SECRETS) expect(text).not.toContain(secret);
  });

  it('marks what carries no tag of Cloudgate as not findable, and takes the state region when a resource names none', () => {
    const listed = stateResources(
      {
        values: {
          root_module: {
            resources: [
              {
                mode: 'managed',
                type: 'aws_route_table_association',
                values: { id: 'rtbassoc-0a1b' },
              },
              // A data source is read, never made: not Cloudgate's.
              {
                mode: 'data',
                type: 'aws_caller_identity',
                values: { id: '123456789012' },
              },
            ],
            child_modules: [
              {
                resources: [
                  {
                    mode: 'managed',
                    type: 'aws_lb',
                    values: {
                      arn: 'arn:aws:elasticloadbalancing:eu-west-1:1:loadbalancer/app/cg/1',
                      tags_all: { 'cloudgate:state': 's' },
                    },
                  },
                ],
              },
            ],
          },
        },
      },
      'eu-west-1',
    );

    expect(listed).toEqual([
      {
        type: 'aws_route_table_association',
        awsId: 'rtbassoc-0a1b',
        region: 'eu-west-1',
        tags: {},
        findableByTag: false,
      },
      {
        type: 'aws_lb',
        awsId: 'arn:aws:elasticloadbalancing:eu-west-1:1:loadbalancer/app/cg/1',
        region: 'eu-west-1',
        tags: { 'cloudgate:state': 's' },
        findableByTag: true,
      },
    ]);
  });

  it('lists nothing for an empty state', () => {
    expect(stateResources({}, 'eu-central-1')).toEqual([]);
    expect(stateResources({ values: null }, 'eu-central-1')).toEqual([]);
  });
});
