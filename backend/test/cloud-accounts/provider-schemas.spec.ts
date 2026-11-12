import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  CONTAINER_DEFINITION_FILE,
  containerDefinitionFields,
  generatedTypes,
  installedEcsVersion,
  schemaFile,
  withoutProse,
  typesNamedIn,
  typesOf,
} from '../../scripts/provider-schemas';
import type {
  CommittedContainerDefinition,
  CommittedSchema,
} from '../../scripts/provider-schemas';
import { PINNED_PROVIDERS } from '../../src/cloud-accounts/tofu/tofu-environment';
import type { PinnedProvider } from '../../src/cloud-accounts/tofu/tofu-environment';

/**
 * What a native block is checked against offline (ADR-0044 rule 5):
 * the committed provider schemas hold every resource and data source type the
 * cloud definition builders write, and nothing else, and the committed ECS
 * container fields are the pinned `@aws-sdk/client-ecs`'s. Each version
 * equals its pin in `opentofu-pins.spec.ts`. A failure here is fixed by
 * `pnpm opentofu:schemas` (`backend/scripts/provider-schemas.ts`).
 */

const PROVIDERS = Object.keys(PINNED_PROVIDERS) as PinnedProvider[];

const committed = (provider: PinnedProvider) =>
  JSON.parse(readFileSync(schemaFile(provider), 'utf8')) as CommittedSchema;

// The script is named by its path: what it binds is not `backend/src`'s.
describe('backend/scripts/provider-schemas.ts', () => {
  describe('typesNamedIn', () => {
    const named = (text: string) => typesNamedIn([{ path: 'x.ts', text }]);

    it('reads a block key, a type handed to a helper and an address as resources', () => {
      expect(
        named(`
          const d = { resource: { aws_vpc: { environment: {} } } };
          r.tagged('aws_subnet', 'public', {});
          const id = '\${aws_lb.environment.arn}';
          const t = \`\\\${google_compute_network.environment.id}-\${name}\`;
        `),
      ).toEqual({
        resources: [
          'aws_lb',
          'aws_subnet',
          'aws_vpc',
          'google_compute_network',
        ],
        dataSources: [],
      });
    });

    it('reads a key of a `data` block and a `data.` reference as data sources', () => {
      expect(
        named(`
          const d = { data: { aws_availability_zones: { zones: {} } } };
          const group = \`data.aws_elasticache_cluster.\${member}\`;
        `),
      ).toEqual({
        resources: [],
        dataSources: ['aws_availability_zones', 'aws_elasticache_cluster'],
      });
    });

    it('does not read a type a comment names', () => {
      expect(
        named(`
          // No aws_acm_certificate_validation: it would hold the apply.
          /** Like a \`google_compute_instance\`. */
          const x = 1;
        `),
      ).toEqual({ resources: [], dataSources: [] });
    });
  });

  describe('withoutProse', () => {
    it('drops the prose of a block and its attributes, and keeps an argument named description', () => {
      expect(
        withoutProse({
          version: 1,
          block: {
            description: 'A replication group.',
            description_kind: 'plain',
            attributes: {
              description: {
                type: 'string',
                required: true,
                description: 'User-created description for the group.',
                description_kind: 'plain',
              },
              tags: {
                type: ['map', 'string'],
                optional: true,
                description: 'Tags.',
              },
            },
            block_types: {
              description: {
                nesting_mode: 'list',
                block: {
                  description: 'A block of that name.',
                  attributes: { text: { type: 'string', optional: true } },
                },
              },
            },
          },
        }),
      ).toEqual({
        version: 1,
        block: {
          attributes: {
            description: { type: 'string', required: true },
            tags: { type: ['map', 'string'], optional: true },
          },
          block_types: {
            description: {
              nesting_mode: 'list',
              block: {
                attributes: { text: { type: 'string', optional: true } },
              },
            },
          },
        },
      });
    });

    it('keeps a description attribute of an object type and of a nested type', () => {
      const objectType = [
        'list',
        ['object', { description: 'string', name: 'string' }],
      ];
      expect(
        withoutProse({
          attributes: {
            rules: { type: objectType, optional: true, description: 'Rules.' },
            policy: {
              optional: true,
              description: 'A policy.',
              nested_type: {
                nesting_mode: 'single',
                attributes: {
                  description: {
                    type: 'string',
                    optional: true,
                    description: 'Its text.',
                  },
                },
              },
            },
          },
        }),
      ).toEqual({
        attributes: {
          rules: { type: objectType, optional: true },
          policy: {
            optional: true,
            nested_type: {
              nesting_mode: 'single',
              attributes: { description: { type: 'string', optional: true } },
            },
          },
        },
      });
    });
  });

  describe('generatedTypes', () => {
    // Anchors from the builders, so an empty census can never pass as a clean one.
    it('finds the types the builders write', () => {
      const types = generatedTypes();

      expect(types.resources).toEqual(
        expect.arrayContaining([
          'aws_ecs_service',
          'aws_ecs_task_definition',
          'aws_db_instance',
          'aws_service_discovery_service',
          'google_cloud_run_v2_service',
          'google_cloud_run_v2_worker_pool',
          'google_memorystore_instance',
          'google_sql_database_instance',
        ]),
      );
      expect(types.dataSources).toEqual(
        expect.arrayContaining(['aws_availability_zones', 'aws_db_instances']),
      );
      expect(types.resources).not.toContain('aws_acm_certificate_validation');
    });
  });
});

describe('deploy/opentofu/schemas/', () => {
  const types = generatedTypes();

  it.each(PROVIDERS)(
    'the %s schema holds every resource type its cloud’s definitions write, and no other',
    (provider) => {
      expect(Object.keys(committed(provider).resource_schemas).sort()).toEqual(
        typesOf(provider, types).resources,
      );
    },
  );

  it.each(PROVIDERS)(
    'the %s schema holds every data source its cloud’s definitions read, and no other',
    (provider) => {
      expect(
        Object.keys(committed(provider).data_source_schemas).sort(),
      ).toEqual(typesOf(provider, types).dataSources);
    },
  );

  it('the ECS container’s fields are the pinned @aws-sdk/client-ecs’s', () => {
    const pinned = (
      JSON.parse(
        readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'),
      ) as { dependencies: Record<string, string> }
    ).dependencies['@aws-sdk/client-ecs'];
    const container = JSON.parse(
      readFileSync(CONTAINER_DEFINITION_FILE, 'utf8'),
    ) as CommittedContainerDefinition;

    expect(installedEcsVersion()).toBe(pinned);
    expect(container.version).toBe(pinned);
    expect(container.fields).toEqual(containerDefinitionFields());
    // The two the spec's ECS example sets, in ECS spelling.
    expect(container.fields).toEqual(
      expect.arrayContaining(['healthCheck', 'stopTimeout']),
    );
  });
});
