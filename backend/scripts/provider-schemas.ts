/**
 * Regenerates `deploy/opentofu/schemas/` — `pnpm opentofu:schemas`.
 *
 * What every native block is checked against, committed so a plan can check
 * it offline (ADR-0044 rule 5): each pinned provider's schema
 * from `tofu providers schema -json`, trimmed to the resource and data source
 * types the cloud definition builders write, and the `ContainerDefinition`
 * fields of the pinned `@aws-sdk/client-ecs`, since the AWS provider drops a
 * key it does not know inside `container_definitions` without a word.
 *
 * Run it after moving a provider pin or the `@aws-sdk/client-ecs` pin, or after
 * a definition builder starts writing a type it did not:
 *
 *   eval "$(backend/test/cloud-accounts/moto/install-opentofu.sh /tmp/cloudgate-opentofu aws google)"
 *   export OPENTOFU_BINARY OPENTOFU_PROVIDER_MIRROR
 *   cd backend && pnpm opentofu:schemas
 *
 * `test/cloud-accounts/opentofu-pins.spec.ts` and
 * `test/cloud-accounts/provider-schemas.spec.ts` fail until it has been run:
 * a schema's version must equal the pin, and its types must be what the
 * builders write.
 *
 * The version written is the one `tofu version -json` says `tofu init`
 * selected from the mirror, never the lock file's text read back, so a file
 * written from a stale mirror still fails the version test.
 */
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { ContainerDefinition$ } from '@aws-sdk/client-ecs';
import * as ts from 'typescript';

import {
  opentofuCliConfig,
  PINNED_PROVIDERS,
} from '../src/cloud-accounts/tofu/tofu-environment';
import type { PinnedProvider } from '../src/cloud-accounts/tofu/tofu-environment';

const BACKEND = resolve(__dirname, '..');
const PINS = resolve(BACKEND, '..', 'deploy', 'opentofu');

/** Where the committed schemas live: beside the lock file they are of. */
export const SCHEMAS_DIRECTORY = join(PINS, 'schemas');

/** The committed file holding one provider's trimmed schema. */
export function schemaFile(provider: PinnedProvider): string {
  return join(SCHEMAS_DIRECTORY, `${provider}.json`);
}

/** The committed file holding the ECS container's fields. */
export const CONTAINER_DEFINITION_FILE = join(
  SCHEMAS_DIRECTORY,
  'ecs-container-definition.json',
);

/**
 * The folders whose code writes the OpenTofu definitions, every cloud's: what
 * a run's `main.tf.json` can hold is what these name.
 */
export const DEFINITION_FOLDERS = [
  'src/cloud-accounts/definitions',
  'src/cloud-accounts/aws/definitions',
  'src/cloud-accounts/gcp/definitions',
] as const;

/** A type name, and the `data.` in front of it when it is written as one. */
const TYPE = /(data\.)?\b((?:aws|google)_[a-z0-9_]+)/g;

/** The resource and data source types the definition builders name. */
export interface GeneratedTypes {
  readonly resources: readonly string[];
  readonly dataSources: readonly string[];
}

/**
 * Every resource and data source type some TypeScript source names. A type
 * is a block key or a string (one handed to a helper, or an address like
 * `aws_lb.environment`), so each type a definition can hold is named in the
 * code that writes it. One that is a key of a `data` block, or written
 * `data.<type>`, is a data source; every other is a resource. Comments are
 * not read: they name types the definitions do not write
 * (`aws_acm_certificate_validation`, which a docblock explains the absence of).
 */
export function typesNamedIn(
  sources: readonly { readonly path: string; readonly text: string }[],
): GeneratedTypes {
  const resources = new Set<string>();
  const dataSources = new Set<string>();
  const add = (text: string, underData: boolean) => {
    for (const match of text.matchAll(TYPE)) {
      (underData || match[1] ? dataSources : resources).add(match[2]);
    }
  };
  for (const { path, text } of sources) {
    const visit = (node: ts.Node) => {
      if (
        ts.isPropertyAssignment(node) &&
        !ts.isComputedPropertyName(node.name)
      ) {
        add(node.name.text, isUnderData(node));
      } else if (
        (ts.isStringLiteral(node) ||
          ts.isNoSubstitutionTemplateLiteral(node) ||
          ts.isTemplateHead(node) ||
          ts.isTemplateMiddle(node) ||
          ts.isTemplateTail(node)) &&
        !(ts.isPropertyAssignment(node.parent) && node.parent.name === node)
      ) {
        add(node.text, false);
      }
      ts.forEachChild(node, visit);
    };
    visit(ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true));
  }
  return {
    resources: [...resources].sort(),
    dataSources: [...dataSources].sort(),
  };
}

/** `data: { <this>: … }`: a key of the object a `data` key holds. */
function isUnderData(property: ts.PropertyAssignment): boolean {
  const object = property.parent;
  const holder = object.parent;
  return (
    ts.isPropertyAssignment(holder) &&
    holder.initializer === object &&
    !ts.isComputedPropertyName(holder.name) &&
    holder.name.text === 'data'
  );
}

/**
 * Every type the cloud definition builders name, read from their source.
 *
 * Read from the source rather than from built definitions: a built definition
 * holds only the branch its input took (a `web-private`'s discovery service,
 * an Existing database's lookup), so a census of built ones would be a census
 * of the fixtures chosen, and a branch no fixture took would go unchecked.
 */
export function generatedTypes(): GeneratedTypes {
  return typesNamedIn(
    DEFINITION_FOLDERS.flatMap((folder) =>
      readdirSync(join(BACKEND, folder))
        .filter((name) => name.endsWith('.ts'))
        .map((name) => {
          const path = join(BACKEND, folder, name);
          return { path, text: readFileSync(path, 'utf8') };
        }),
    ),
  );
}

/** The cloud whose types a provider makes. */
export function cloudOf(provider: PinnedProvider): 'aws' | 'google' {
  return provider === 'aws' ? 'aws' : 'google';
}

/** The generated types of one provider's cloud. */
export function typesOf(
  provider: PinnedProvider,
  types: GeneratedTypes,
): GeneratedTypes {
  const ofCloud = (type: string) => type.startsWith(`${cloudOf(provider)}_`);
  return {
    resources: types.resources.filter(ofCloud),
    dataSources: types.dataSources.filter(ofCloud),
  };
}

/** The OpenTofu registry source of a pinned `hashicorp/` provider. */
export function providerSource(provider: PinnedProvider): string {
  return `registry.opentofu.org/hashicorp/${provider}`;
}

/** One provider's part of `tofu providers schema -json`. */
interface ProviderSchema {
  readonly resource_schemas?: Record<string, unknown>;
  readonly data_source_schemas?: Record<string, unknown>;
}

/** A committed, trimmed provider schema. */
export interface CommittedSchema {
  readonly provider: string;
  readonly version: string;
  readonly format_version: string;
  readonly resource_schemas: Record<string, unknown>;
  readonly data_source_schemas: Record<string, unknown>;
}

/**
 * One provider's schema trimmed to every generated type of its cloud, each
 * with its prose left out. A type the provider does not have is refused
 * here, so a regeneration never commits a schema that leaves a generated
 * type unchecked.
 */
export function trimmed(
  provider: PinnedProvider,
  schema: ProviderSchema,
  types: GeneratedTypes,
): Pick<CommittedSchema, 'resource_schemas' | 'data_source_schemas'> {
  const own = typesOf(provider, types);
  const pick = (
    kind: string,
    all: Record<string, unknown> = {},
    names: readonly string[],
  ) =>
    Object.fromEntries(
      names.map((name) => {
        if (!(name in all)) {
          throw new Error(
            `The definitions write ${name} as a ${kind}, and hashicorp/${provider} has no ${kind} by that name`,
          );
        }
        return [name, withoutProse(all[name])];
      }),
    );
  return {
    resource_schemas: pick('resource', schema.resource_schemas, own.resources),
    data_source_schemas: pick(
      'data source',
      schema.data_source_schemas,
      own.dataSources,
    ),
  };
}

/**
 * A provider schema with its prose left out: `description` and
 * `description_kind` on every block and attribute. A check reads names, types,
 * nesting, `required`/`optional`/`computed`, `sensitive` and `deprecated`;
 * the prose was half the Google files' bytes, and would turn every provider
 * move into a diff of documentation edits. The provider's own documentation,
 * at the pinned version, is where a reader goes for it.
 *
 * Only the prose is dropped, never an argument that happens to be called
 * `description` (`aws_elasticache_replication_group`'s, which is required):
 * the keys of `attributes` and `block_types` are argument names, kept whole,
 * and a `type` is the provider's type expression, whose object types name
 * their attributes, so it is kept as written.
 */
export function withoutProse(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutProse);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== 'description' && key !== 'description_kind')
        .map(([key, inner]) => [
          key,
          key === 'type'
            ? inner
            : key === 'attributes' || key === 'block_types'
              ? namedWithoutProse(inner)
              : withoutProse(inner),
        ]),
    );
  }
  return value;
}

/** A map of argument names: every name kept, each one's own prose dropped. */
function namedWithoutProse(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return withoutProse(value);
  }
  return Object.fromEntries(
    Object.entries(value).map(([name, inner]) => [name, withoutProse(inner)]),
  );
}

/** The committed ECS container field list. */
export interface CommittedContainerDefinition {
  readonly package: '@aws-sdk/client-ecs';
  readonly version: string;
  readonly structure: 'ContainerDefinition';
  readonly fields: readonly string[];
}

/**
 * The top-level `ContainerDefinition` fields of the installed
 * `@aws-sdk/client-ecs`, read from the SDK's own schema of the structure
 * (`ContainerDefinition$`, whose fifth entry is its member names): the keys
 * ECS takes in one container of `container_definitions`, in its camelCase.
 * Read from the runtime schema, not by parsing the `.d.ts`: the schema is
 * what the SDK serializes a container from.
 */
export function containerDefinitionFields(): string[] {
  const members = (ContainerDefinition$ as unknown as readonly unknown[])[4];
  if (
    !Array.isArray(members) ||
    members.length === 0 ||
    !members.every((m) => typeof m === 'string')
  ) {
    throw new Error(
      "@aws-sdk/client-ecs no longer exports ContainerDefinition$ as [kind, namespace, name, traits, members, …]; read the fields from its models' ContainerDefinition instead",
    );
  }
  return [...members].sort();
}

/** The installed `@aws-sdk/client-ecs`'s version: the one its fields are read from. */
export function installedEcsVersion(): string {
  // Its `exports` map has no `./package.json`, so the manifest is found from
  // the entry point, `<package>/dist-cjs/index.js`.
  const manifest = join(
    require.resolve('@aws-sdk/client-ecs'),
    '..',
    '..',
    'package.json',
  );
  return (JSON.parse(readFileSync(manifest, 'utf8')) as { version: string })
    .version;
}

/** JSON with keys sorted at every level, so a regeneration diffs cleanly. */
export function stableJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.keys(v)
          .sort()
          .map((key) => [key, sort((v as Record<string, unknown>)[key])]),
      );
    }
    return v;
  };
  return `${JSON.stringify(sort(value), null, 2)}\n`;
}

/** `tofu providers schema -json` for every pinned provider, from the mirror. */
function pinnedSchemas(
  binary: string,
  mirror: string,
): {
  format_version: string;
  provider_schemas: Record<string, ProviderSchema>;
  provider_selections: Record<string, string>;
} {
  const folder = mkdtempSync(join(tmpdir(), 'cloudgate-schemas-'));
  try {
    for (const pin of ['versions.tf.json', '.terraform.lock.hcl']) {
      writeFileSync(join(folder, pin), readFileSync(join(PINS, pin)));
    }
    writeFileSync(join(folder, 'cloudgate.tfrc'), opentofuCliConfig(mirror));
    const env = {
      PATH: process.env.PATH,
      HOME: folder,
      TF_CLI_CONFIG_FILE: join(folder, 'cloudgate.tfrc'),
      TF_IN_AUTOMATION: '1',
    };
    const run = (args: string[]) => {
      const result = spawnSync(binary, args, {
        cwd: folder,
        env,
        encoding: 'utf8',
        maxBuffer: 1 << 30,
      });
      if (result.status !== 0) {
        throw new Error(
          `tofu ${args[0]} failed:\n${result.stdout}${result.stderr}`,
        );
      }
      return result.stdout;
    };
    run([
      'init',
      '-input=false',
      '-no-color',
      '-backend=false',
      '-lockfile=readonly',
    ]);
    const { provider_selections } = JSON.parse(run(['version', '-json'])) as {
      provider_selections: Record<string, string>;
    };
    const schemas = JSON.parse(run(['providers', 'schema', '-json'])) as {
      format_version: string;
      provider_schemas: Record<string, ProviderSchema>;
    };
    return { ...schemas, provider_selections };
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

function main(): void {
  const binary = process.env.OPENTOFU_BINARY;
  const mirror = process.env.OPENTOFU_PROVIDER_MIRROR;
  if (!binary || !mirror) {
    throw new Error(
      'Set OPENTOFU_BINARY and OPENTOFU_PROVIDER_MIRROR: backend/test/cloud-accounts/moto/install-opentofu.sh <dir> aws google fills them',
    );
  }
  const full = pinnedSchemas(binary, mirror);
  const types = generatedTypes();
  for (const provider of Object.keys(PINNED_PROVIDERS) as PinnedProvider[]) {
    const source = providerSource(provider);
    const schema = full.provider_schemas[source];
    const version = full.provider_selections[source];
    if (!schema || !version) throw new Error(`tofu init selected no ${source}`);
    const file: CommittedSchema = {
      provider: source,
      version,
      format_version: full.format_version,
      ...trimmed(provider, schema, types),
    };
    writeFileSync(schemaFile(provider), stableJson(file));
    console.log(
      `${provider}.json: ${version}, ${Object.keys(file.resource_schemas).length} resource types, ${Object.keys(file.data_source_schemas).length} data sources`,
    );
  }

  const container: CommittedContainerDefinition = {
    package: '@aws-sdk/client-ecs',
    version: installedEcsVersion(),
    structure: 'ContainerDefinition',
    fields: containerDefinitionFields(),
  };
  writeFileSync(CONTAINER_DEFINITION_FILE, stableJson(container));
  console.log(
    `ecs-container-definition.json: ${container.version}, ${container.fields.length} fields`,
  );
}

if (require.main === module) main();
