import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { PINNED_PROVIDERS } from '../cloud-accounts/tofu/tofu-environment';
import type { PinnedProvider } from '../cloud-accounts/tofu/tofu-environment';

/**
 * **A native block checked offline against a committed provider schema**
 * (ADR-0044 rule 5): the one checker every cloud's native block
 * passes through, `native.aws` here and `native.gcp` with it, so a
 * typo, a value of the wrong shape or a setting the provider is retiring
 * reads the same on every cloud and shows on every plan, whatever the
 * Environment's Deploy target.
 *
 * It reads the schemas `backend/scripts/provider-schemas.ts` commits beside
 * the provider lock file, never a live `tofu providers schema`: a
 * plan is pure and runs with no `tofu`, and the committed file is held equal
 * to the pin by `provider-schemas.spec.ts`, so "the provider Cloudgate runs"
 * is exactly what is checked against.
 *
 * What it says, by path, about one resource's arguments:
 *
 * - **Refused**: an argument the pinned provider does not have (a typo, or
 *   one taken out by a provider release — the message names the version
 *   Cloudgate runs either way, since the committed schema cannot tell the
 *   two apart), one the provider only computes, `null`, a value of the
 *   wrong type, a block written more times than it allows, and a required
 *   argument missing from a block written whole.
 * - **Deprecated**: an argument or block the provider marks deprecated,
 *   with the provider's own sentence when it gives one. A warning, never a
 *   refusal: the provider still takes it.
 *
 * A block the provider allows once (`single`, or `max_items: 1`) is merged
 * into Cloudgate's field by field (ADR-0044 rule 3), so its required
 * arguments may come from Cloudgate's and are not asked for here; a block
 * the provider allows many of is a real list that replaces Cloudgate's
 * whole, so each item written must be complete.
 *
 * Values follow OpenTofu's own conversions (a number or `true` where a
 * string is wanted, `"5"` where a number is), so a value `tofu` would take
 * is never refused here. What is locked is not this module's: the caller
 * holds the lock table and leaves out what it refused.
 */

// ── The committed schema ──

/** An attribute's type in `tofu providers schema -json`'s spelling. */
export type SchemaType =
  | 'string'
  | 'number'
  | 'bool'
  | 'dynamic'
  | readonly ['list' | 'set' | 'map', SchemaType]
  | readonly ['object', Readonly<Record<string, SchemaType>>]
  | readonly ['tuple', readonly SchemaType[]];

export interface SchemaAttribute {
  readonly type?: SchemaType;
  readonly required?: boolean;
  readonly optional?: boolean;
  readonly computed?: boolean;
  readonly deprecated?: boolean;
  readonly deprecation_message?: string;
  readonly sensitive?: boolean;
  readonly write_only?: boolean;
}

export interface SchemaBlockType {
  readonly nesting_mode: 'single' | 'group' | 'list' | 'set' | 'map';
  readonly block: SchemaBlock;
  readonly min_items?: number;
  readonly max_items?: number;
}

export interface SchemaBlock {
  readonly attributes?: Readonly<Record<string, SchemaAttribute>>;
  readonly block_types?: Readonly<Record<string, SchemaBlockType>>;
  readonly deprecated?: boolean;
  readonly deprecation_message?: string;
}

/** One pinned provider's committed schema, as a checker reads it. */
export interface CommittedProvider {
  /** `hashicorp/aws 6.69.1`: how a message names the provider Cloudgate runs. */
  readonly label: string;
  readonly version: string;
  /** A resource type's top-level block, or `undefined` for a type not committed. */
  resource(type: string): SchemaBlock | undefined;
}

/** Where `provider-schemas.ts` commits the schemas: beside the lock file. */
export const SCHEMAS_DIRECTORY = resolve(
  __dirname,
  '..',
  '..',
  '..',
  'deploy',
  'opentofu',
  'schemas',
);

const loaded = new Map<PinnedProvider, CommittedProvider>();

/**
 * The committed schema of one pinned provider, read once per process. Read
 * from `deploy/opentofu/schemas/`, two folders above both `src/native/` and
 * `dist/native/`, so a test and the built backend read the same file.
 *
 * A schema whose version is not the pin's throws rather than checking
 * against the wrong provider; `provider-schemas.spec.ts` fails first in CI.
 */
export function committedProvider(provider: PinnedProvider): CommittedProvider {
  const known = loaded.get(provider);
  if (known) return known;
  const file = JSON.parse(
    readFileSync(join(SCHEMAS_DIRECTORY, `${provider}.json`), 'utf8'),
  ) as {
    readonly version: string;
    readonly resource_schemas: Readonly<
      Record<string, { readonly block: SchemaBlock }>
    >;
  };
  if (file.version !== PINNED_PROVIDERS[provider]) {
    throw new Error(
      `deploy/opentofu/schemas/${provider}.json is hashicorp/${provider} ${file.version}, not the pinned ${PINNED_PROVIDERS[provider]}; run pnpm opentofu:schemas`,
    );
  }
  const committed: CommittedProvider = {
    label: `hashicorp/${provider} ${file.version}`,
    version: file.version,
    resource: (type) =>
      Object.hasOwn(file.resource_schemas, type)
        ? file.resource_schemas[type].block
        : undefined,
  };
  loaded.set(provider, committed);
  return committed;
}

/** The committed `ContainerDefinition` fields of the pinned `@aws-sdk/client-ecs`. */
export interface CommittedContainerFields {
  /** `@aws-sdk/client-ecs 3.1143.0`: how a message names it. */
  readonly label: string;
  readonly fields: ReadonlySet<string>;
}

let containerFields: CommittedContainerFields | undefined;

/**
 * The ECS container's fields, read once per process: the AWS
 * provider drops a key it does not know inside `container_definitions`
 * without a word, so this list is the only check such a key gets.
 */
export function committedContainerFields(): CommittedContainerFields {
  if (containerFields) return containerFields;
  const file = JSON.parse(
    readFileSync(
      join(SCHEMAS_DIRECTORY, 'ecs-container-definition.json'),
      'utf8',
    ),
  ) as {
    readonly package: string;
    readonly version: string;
    readonly fields: readonly string[];
  };
  containerFields = {
    label: `${file.package} ${file.version}`,
    fields: new Set(file.fields),
  };
  return containerFields;
}

// ── Paths ──

/** One step into a native value: an argument or map key, or a list index. */
export type PathPart = string | number;

const BARE_KEY = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/**
 * A path in the file's spelling after its prefix: `.health_check.path`,
 * `.ingress[0].from_port`, and a key that is not a bare name quoted, as a
 * Docker label key is (`.parameter."maxmemory-policy"` stays bare; a key
 * with a dot or a space is quoted).
 */
export function pathText(path: readonly PathPart[]): string {
  return path
    .map((part) =>
      typeof part === 'number'
        ? `[${part}]`
        : BARE_KEY.test(part)
          ? `.${part}`
          : `.${JSON.stringify(part)}`,
    )
    .join('');
}

/**
 * Every concrete path below `value` along `steps`, through any list in the
 * way: where a lock on a dotted path (`settings.ip_configuration`) lands in
 * what a native block wrote, whether a block allowed once was written as an
 * object or as a list of one.
 */
export function locatedPaths(
  value: unknown,
  steps: readonly string[],
): PathPart[][] {
  if (steps.length === 0) return [[]];
  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      locatedPaths(item, steps).map((rest) => [index, ...rest]),
    );
  }
  if (typeof value !== 'object' || value === null) return [];
  const [step, ...rest] = steps;
  if (!Object.hasOwn(value, step)) return [];
  return locatedPaths((value as Record<string, unknown>)[step], rest).map(
    (path) => [step, ...path],
  );
}

/** Whether `path` is `under` or below it. */
export const pathWithin = (
  path: readonly PathPart[],
  under: readonly PathPart[],
) => under.every((part, index) => path[index] === part);

/** A table's own entry: a key such as `constructor` is not one. */
export const ownEntry = <T>(
  table: Readonly<Record<string, T>> | undefined,
  key: string,
) =>
  table !== undefined && Object.hasOwn(table, key) ? table[key] : undefined;

// ── The check ──

/** One thing the checker found, at a path below the resource. */
export interface SchemaFinding {
  readonly path: readonly PathPart[];
  readonly severity: 'refused' | 'deprecated';
  readonly reason: string;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * A block allowed once, which is merged field by field rather than replaced
 * (ADR-0044 rule 3); the lay (`lay.ts`) reads the same rule the check does.
 */
export const once = (type: SchemaBlockType) =>
  type.nesting_mode === 'single' ||
  type.nesting_mode === 'group' ||
  type.max_items === 1;

const NULL_REASON = "write a value, or leave the key out for Cloudgate's own";

/**
 * Every finding about `value` as the arguments of one `type` resource of
 * `provider`, at paths below it. `skip` names arguments the caller judges
 * itself (a locked one it refused, the ECS container it checks against its
 * own list), which are passed over whole: a top-level one by name, one
 * inside a block by its dotted path with no list index
 * (`template.containers`, the Cloud Run container `native.gcp` writes as
 * one object).
 */
export function checkResourceArguments(
  provider: CommittedProvider,
  type: string,
  value: Readonly<Record<string, unknown>>,
  skip: ReadonlySet<string> = new Set(),
): SchemaFinding[] {
  const block = provider.resource(type);
  if (!block) {
    return [
      {
        path: [],
        severity: 'refused',
        reason: `${provider.label} has no resource ${type}`,
      },
    ];
  }
  const findings: SchemaFinding[] = [];
  checkBlock(provider, type, block, value, [], false, skip, findings);
  return findings;
}

/**
 * The block of `type` at `steps` (`['template', 'containers']`), or
 * `undefined` when the committed schema has none there.
 */
export function blockAt(
  provider: CommittedProvider,
  type: string,
  steps: readonly string[],
): SchemaBlock | undefined {
  let block = provider.resource(type);
  for (const step of steps) {
    const nested =
      block?.block_types && Object.hasOwn(block.block_types, step)
        ? block.block_types[step]
        : undefined;
    block = nested?.block;
  }
  return block;
}

/**
 * Every finding about `value` written as **one object merged field by
 * field** into a block of `type` that the provider may allow many of, at
 * `at` below the resource: the Cloud Run container (`template.containers`),
 * which `native.gcp` writes as one object laid over Cloudgate's one
 * container rather than as a list replacing it, so no argument of it is
 * required here. `skip` names arguments of the block the caller judged.
 */
export function checkMergedBlock(
  provider: CommittedProvider,
  type: string,
  block: SchemaBlock,
  value: Readonly<Record<string, unknown>>,
  at: readonly PathPart[],
  skip: ReadonlySet<string> = new Set(),
): SchemaFinding[] {
  const findings: SchemaFinding[] = [];
  const skipped = new Set([...skip].map((key) => dotted([...at, key])));
  checkBlock(provider, type, block, value, at, false, skipped, findings);
  return findings;
}

/** A path as `skip` names it: its arguments, dotted, with no list index. */
const dotted = (path: readonly PathPart[]) =>
  path.filter((part) => typeof part === 'string').join('.');

/**
 * One block's arguments. `whole` is true inside an item of a list that
 * replaces Cloudgate's, where a required argument must be written.
 */
function checkBlock(
  provider: CommittedProvider,
  type: string,
  block: SchemaBlock,
  value: Readonly<Record<string, unknown>>,
  at: readonly PathPart[],
  whole: boolean,
  skip: ReadonlySet<string>,
  findings: SchemaFinding[],
): void {
  const attributes = block.attributes ?? {};
  const blocks = block.block_types ?? {};
  for (const [key, inner] of Object.entries(value)) {
    const path = [...at, key];
    if (skip.has(dotted(path))) continue;
    const attribute = Object.hasOwn(attributes, key)
      ? attributes[key]
      : undefined;
    const nested = Object.hasOwn(blocks, key) ? blocks[key] : undefined;
    if (!attribute && !nested) {
      findings.push({
        path,
        severity: 'refused',
        reason:
          at.length === 0
            ? `${type} has no argument ${key} in ${provider.label}, the version Cloudgate runs`
            : `this block of ${type} has no argument ${key} in ${provider.label}, the version Cloudgate runs`,
      });
      continue;
    }
    if (inner === null) {
      findings.push({ path, severity: 'refused', reason: NULL_REASON });
      continue;
    }
    if (attribute) {
      if (attribute.computed && !attribute.optional && !attribute.required) {
        findings.push({
          path,
          severity: 'refused',
          reason: `${key} is set by the provider once the resource exists, never written`,
        });
        continue;
      }
      deprecation(provider, attribute, key, path, findings);
      if (attribute.type) typeFindings(attribute.type, inner, path, findings);
      continue;
    }
    if (nested) {
      deprecation(provider, nested.block, key, path, findings);
      checkNested(
        provider,
        type,
        key,
        nested,
        inner,
        path,
        whole,
        skip,
        findings,
      );
    }
  }
  if (!whole) return;
  for (const [key, attribute] of Object.entries(attributes)) {
    // One the caller judged is never asked for either: a value Cloudgate
    // keeps in each item written.
    if (
      attribute.required &&
      !(key in value) &&
      !skip.has(dotted([...at, key]))
    ) {
      findings.push({
        path: [...at, key],
        severity: 'refused',
        reason: `${key} is required in each item written, since the list replaces Cloudgate's whole`,
      });
    }
  }
  for (const [key, nested] of Object.entries(blocks)) {
    if ((nested.min_items ?? 0) > 0 && !(key in value)) {
      findings.push({
        path: [...at, key],
        severity: 'refused',
        reason: `${key} is required in each item written, since the list replaces Cloudgate's whole`,
      });
    }
  }
}

function checkNested(
  provider: CommittedProvider,
  type: string,
  key: string,
  nested: SchemaBlockType,
  value: unknown,
  path: readonly PathPart[],
  whole: boolean,
  skip: ReadonlySet<string>,
  findings: SchemaFinding[],
): void {
  const one = once(nested);
  if (nested.nesting_mode === 'map') {
    if (!isObject(value)) {
      findings.push({
        path,
        severity: 'refused',
        reason: `${key} is a map of blocks, written as an object`,
      });
      return;
    }
    for (const [name, item] of Object.entries(value)) {
      if (!isObject(item)) {
        findings.push({
          path: [...path, name],
          severity: 'refused',
          reason: `each ${key} is an object`,
        });
        continue;
      }
      checkBlock(
        provider,
        type,
        nested.block,
        item,
        [...path, name],
        true,
        skip,
        findings,
      );
    }
    return;
  }

  // A block allowed once is written as one object (or a list of one, as
  // OpenTofu's JSON also takes it); any other as a list of objects.
  if (isObject(value)) {
    checkBlock(
      provider,
      type,
      nested.block,
      value,
      path,
      whole || !one,
      skip,
      findings,
    );
    return;
  }
  if (
    !Array.isArray(value) ||
    nested.nesting_mode === 'single' ||
    nested.nesting_mode === 'group'
  ) {
    findings.push({
      path,
      severity: 'refused',
      reason: one
        ? `${key} is a block written once, as an object`
        : `${key} is a list of blocks, written as a list of objects`,
    });
    return;
  }
  const max = nested.max_items;
  if (max !== undefined && value.length > max) {
    findings.push({
      path,
      severity: 'refused',
      reason: `${key} takes at most ${max} ${max === 1 ? 'block' : 'blocks'}`,
    });
  }
  const min = nested.min_items ?? 0;
  if (value.length < min) {
    findings.push({
      path,
      severity: 'refused',
      reason: `${key} takes at least ${min} ${min === 1 ? 'block' : 'blocks'}`,
    });
  }
  value.forEach((item, index) => {
    if (!isObject(item)) {
      findings.push({
        path: [...path, index],
        severity: 'refused',
        reason: `each ${key} is an object`,
      });
      return;
    }
    checkBlock(
      provider,
      type,
      nested.block,
      item,
      [...path, index],
      whole || !one,
      skip,
      findings,
    );
  });
}

function deprecation(
  provider: CommittedProvider,
  marked: { deprecated?: boolean; deprecation_message?: string },
  key: string,
  path: readonly PathPart[],
  findings: SchemaFinding[],
): void {
  if (!marked.deprecated) return;
  findings.push({
    path,
    severity: 'deprecated',
    reason: marked.deprecation_message
      ? `${provider.label} deprecates it: ${marked.deprecation_message}`
      : `${provider.label} deprecates ${key}`,
  });
}

/** A type in words, for a refusal: `a list of strings`, `a map of numbers`. */
export function typeWords(type: SchemaType, plural = false): string {
  if (typeof type === 'string') {
    const word = {
      string: 'string',
      number: 'number',
      bool: 'true or false',
      dynamic: 'value',
    }[type];
    if (type === 'bool') return word;
    return plural ? `${word}s` : `a ${word}`;
  }
  const [kind, inner] = type;
  if (kind === 'object') return plural ? 'objects' : 'an object';
  if (kind === 'tuple') return plural ? 'lists' : 'a list';
  const words = typeWords(inner, true);
  if (kind === 'map') return `${plural ? 'maps' : 'a map'} of ${words}`;
  return `${plural ? 'lists' : 'a list'} of ${words}`;
}

const NUMERIC = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;

/** Whether `value` converts to a primitive `type` as OpenTofu converts it. */
function primitiveFits(type: 'string' | 'number' | 'bool', value: unknown) {
  switch (type) {
    case 'string':
      return (
        typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean'
      );
    case 'number':
      return (
        (typeof value === 'number' && Number.isFinite(value)) ||
        (typeof value === 'string' && NUMERIC.test(value))
      );
    case 'bool':
      return (
        typeof value === 'boolean' || value === 'true' || value === 'false'
      );
  }
}

function typeFindings(
  type: SchemaType,
  value: unknown,
  path: readonly PathPart[],
  findings: SchemaFinding[],
): void {
  const wrong = () =>
    findings.push({
      path,
      severity: 'refused',
      reason: `must be ${typeWords(type)}`,
    });
  if (value === null) {
    findings.push({ path, severity: 'refused', reason: NULL_REASON });
    return;
  }
  if (type === 'dynamic') return;
  if (typeof type === 'string') {
    if (!primitiveFits(type, value)) wrong();
    return;
  }
  const [kind, inner] = type;
  switch (kind) {
    case 'list':
    case 'set':
      if (!Array.isArray(value)) return void wrong();
      value.forEach((item, index) =>
        typeFindings(inner, item, [...path, index], findings),
      );
      return;
    case 'map':
      if (!isObject(value)) return void wrong();
      for (const [name, item] of Object.entries(value)) {
        typeFindings(inner, item, [...path, name], findings);
      }
      return;
    case 'object': {
      if (!isObject(value)) return void wrong();
      const fields = inner;
      for (const [name, item] of Object.entries(value)) {
        const field = Object.hasOwn(fields, name) ? fields[name] : undefined;
        if (!field) {
          findings.push({
            path: [...path, name],
            severity: 'refused',
            reason: `not a field of this object; it takes ${Object.keys(fields).join(', ')}`,
          });
          continue;
        }
        typeFindings(field, item, [...path, name], findings);
      }
      return;
    }
    case 'tuple': {
      const items = inner;
      if (!Array.isArray(value) || value.length !== items.length) {
        return void wrong();
      }
      value.forEach((item, index) =>
        typeFindings(items[index], item, [...path, index], findings),
      );
      return;
    }
  }
}
