import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseProjectConfig } from '../../../../src/project-config';
import type { WebEntry } from '../../../../src/project-config';

/**
 * Reading a generated definition the way `tofu` would, for the definition
 * specs: by resource type and name, and with what the provider's
 * `default_tags` adds.
 */

type Blocks = Record<string, Record<string, Record<string, unknown>>>;

export interface DefinitionResource {
  readonly address: string;
  readonly type: string;
  readonly body: Record<string, unknown>;
}

export function resources(
  definition: Record<string, unknown>,
): DefinitionResource[] {
  const blocks = (definition.resource ?? {}) as Blocks;
  return Object.entries(blocks).flatMap(([type, byName]) =>
    Object.entries(byName).map(([name, body]) => ({
      address: `${type}.${name}`,
      type,
      body,
    })),
  );
}

export function addresses(definition: Record<string, unknown>): string[] {
  return resources(definition)
    .map((resource) => resource.address)
    .sort();
}

export function resource(
  definition: Record<string, unknown>,
  address: string,
): Record<string, unknown> {
  const found = resources(definition).find((r) => r.address === address);
  if (!found) throw new Error(`no ${address} in the definition`);
  return found.body;
}

export function defaultTags(
  definition: Record<string, unknown>,
): Record<string, string> {
  const provider = (definition.provider as Record<string, unknown>).aws as {
    default_tags: { tags: Record<string, string> };
  };
  return provider.default_tags.tags;
}

/**
 * AWS resource types in these definitions that take no tags, from the AWS
 * provider's documentation. Every other `aws_` type does, and `default_tags`
 * reaches it.
 */
export const UNTAGGABLE_AWS_TYPES: ReadonlySet<string> = new Set([
  'aws_route',
  'aws_route_table_association',
  'aws_ecr_lifecycle_policy',
]);

/** The tags a resource ends up with: `default_tags` merged with its own. */
export function effectiveTags(
  definition: Record<string, unknown>,
  body: Record<string, unknown>,
): Record<string, string> {
  return {
    ...defaultTags(definition),
    ...((body.tags ?? {}) as Record<string, string>),
  };
}

/** The AWS resources in a definition that take tags. */
export function taggableResources(
  definition: Record<string, unknown>,
): DefinitionResource[] {
  return resources(definition).filter(
    (r) => r.type.startsWith('aws_') && !UNTAGGABLE_AWS_TYPES.has(r.type),
  );
}

/** A `web` entry of the sample config; `api` is size small, port 4000, `node dist/main.js`. */
export function sampleWebEntry(name: string): WebEntry {
  const parsed = parseProjectConfig(
    readFileSync(
      join(__dirname, '../../../project-config/cloudgate.sample.yaml'),
      'utf8',
    ),
  );
  if (!parsed.ok) throw new Error(parsed.refusal.message);
  return parsed.config.services[name] as WebEntry;
}
