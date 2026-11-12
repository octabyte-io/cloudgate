import { z } from 'zod';

import { valkeyVersion } from '../cloud-accounts/aws/definitions/redis-version';
import {
  AWS_ADDRESSES,
  AWS_CONTAINER_LOCKS,
  AWS_ENVIRONMENT_NETWORK,
  AWS_LOCKED_EVERYWHERE,
  AWS_PER_INSTANCE,
  awsAddressKey,
  AWS_CONTAINER_ADDRESS,
  CONTAINER_KEY,
  PARAMETER_GROUP,
} from './aws-locks';
import type { AwsAddressEntry, AwsMadeFacts } from './aws-locks';
import {
  checkResourceArguments,
  committedContainerFields,
  committedProvider,
  locatedPaths as located,
  ownEntry as own,
  pathText,
  pathWithin as within,
} from './provider-schema';
import type { PathPart } from './provider-schema';
import { NATIVE_META_ARGUMENTS } from './native-shared';
import type { NativeCheck } from './native-shared';

/**
 * **`native.aws`** (ADR-0044 rules 2, 4, 5, 7–9): read and checked on
 * every plan, whatever the Environment's Deploy target, so a typo shows on a
 * Docker staging plan rather than on the first deploy to AWS.
 *
 * - **Read.** {@link nativeAwsWireSchema} is `native.aws` in each described
 *   entry's strict schema: keyed by the full OpenTofu address as one key,
 *   the address the plan's cloud lines show (`"aws_ecs_service.service"`),
 *   each holding that resource's provider arguments in the provider's
 *   spelling. The ECS container is `container_definitions` under
 *   `"aws_ecs_task_definition.service"`, written as **one object** in ECS's
 *   camelCase. Nothing is renamed between the file and here.
 * - **Check.** {@link nativeAwsCheck} returns every refusal, by full path
 *   with a one-line reason, and every deprecation warning: an address the
 *   kind does not make, or does not make right now; a per-Domain or
 *   per-variable address, refused whole; a meta-argument; a Locked setting
 *   (`aws-locks.ts`, the one list the plan, console and deploy read); and,
 *   against the committed `hashicorp/aws` schema (`provider-schema.ts`), an
 *   argument the pinned provider does not have, a value of the wrong shape,
 *   and a deprecated argument as a warning. The container's keys are
 *   checked against the committed `ContainerDefinition` fields, since the
 *   provider drops one it does not know without a word.
 * - **Nothing is laid yet.** On an AWS Environment a valid block plans no
 *   change; the per-kind tickets lay it over Cloudgate's
 *   definition. On a Docker or Google Environment it is checked only, with
 *   no step and nothing stored (an open question of the native settings
 *   spec, answered so): it is not the block that Environment uses.
 *
 *     api.native.aws."aws_db_instance.database".publicly_accessible: refused - locked: <reason>
 */

// ── Read ──

/** One address's provider arguments, as the provider spells them. */
const awsResourceWire = z.record(z.string(), z.unknown()).meta({
  description:
    "This resource's provider arguments, in hashicorp/aws's spelling, laid over Cloudgate's own: a block the provider allows once field by field, a map key by key, a list whole.",
});

/**
 * `native.aws`: any address as a key, so an unknown one reaches
 * {@link nativeAwsCheck}, which names what the kind makes, where a closed
 * schema could only say "not a field Cloudgate knows".
 */
export const nativeAwsWireSchema = z.record(z.string(), awsResourceWire).meta({
  description:
    'Settings on AWS, keyed by the full OpenTofu address the plan\'s cloud lines show (e.g. "aws_ecs_service.service"). The ECS container is "aws_ecs_task_definition.service".container_definitions, one object in ECS\'s camelCase.',
});

export type NativeAwsBlock = z.infer<typeof nativeAwsWireSchema>;

// ── What a Service makes ──

/**
 * The parameter group family a `redis` entry's written version runs on
 * ElastiCache (`valkey8`), or `undefined` when it writes none (the saved
 * one stands) or one the version rule refuses (the plan says so itself).
 */
export function parameterFamilyOf(dockerImage: string | undefined) {
  if (dockerImage === undefined) return undefined;
  const read = valkeyVersion('redis', dockerImage);
  return read.ok ? read.version.parameterFamily : undefined;
}

/** The addresses a kind's definition writes on AWS, whatever it makes right now. */
function entriesOf(kind: string): [string, AwsAddressEntry][] {
  return Object.entries(AWS_ADDRESSES).filter(([, entry]) =>
    (entry.kinds as readonly string[]).includes(kind),
  );
}

/**
 * The addresses a Service of `kind` makes on AWS **right now**, as the
 * plan's cloud lines show them, in the order its definition writes them.
 * A parameter group is named by the family its version runs, or by
 * `<family>` when that is not known. An Existing database or existing
 * bucket makes none.
 */
export function awsAddressesMade(kind: string, facts: AwsMadeFacts): string[] {
  if (facts.existing) return [];
  return entriesOf(kind)
    .map(([key]) =>
      key === PARAMETER_GROUP && facts.parameterFamily !== undefined
        ? `aws_elasticache_parameter_group.${facts.parameterFamily}`
        : key,
    )
    .filter((address) => {
      const entry = AWS_ADDRESSES[awsAddressKey(address)];
      return !entry.madeNow?.(facts, address);
    });
}

// ── Check ──

const ADDRESS = /^[a-z][a-z0-9_]*\.[A-Za-z_][A-Za-z0-9_-]*$/;

/**
 * Every refusal and warning about one entry's `native.aws`, on every plan
 * and whatever the Environment's Deploy target (ADR-0044 rule 5). Every
 * refusal is returned, not the first, so one plan names everything to
 * correct. `facts` says what the Service makes right now; a fact absent
 * (any target but AWS) is never a reason to refuse.
 */
export function nativeAwsCheck(
  configName: string,
  kind: string,
  block: NativeAwsBlock | undefined,
  facts: AwsMadeFacts,
): NativeCheck {
  const check: NativeCheck = { refusals: [], warnings: [] };
  if (block === undefined) return check;
  for (const [address, value] of Object.entries(block)) {
    const prefix = `${configName}.native.aws.${JSON.stringify(address)}`;
    const refuse = (path: readonly PathPart[], reason: string) => {
      const at = `${prefix}${pathText(path)}`;
      check.refusals.push({ at, message: `${at}: refused - ${reason}` });
    };
    const warn = (path: readonly PathPart[], reason: string) => {
      const at = `${prefix}${pathText(path)}`;
      check.warnings.push({ at, message: `${at}: deprecated - ${reason}` });
    };

    const notMade = whyNotMade(kind, address, facts);
    if (notMade !== null) {
      refuse([], notMade);
      continue;
    }
    const entry = AWS_ADDRESSES[awsAddressKey(address)];
    if (entry.whole !== undefined) {
      refuse([], `locked whole: ${entry.whole}`);
      continue;
    }

    const judged = new Set<string>();
    for (const key of Object.keys(value)) {
      const lockedNow = own(entry.lockedWhile, key);
      const reason =
        own(NATIVE_META_ARGUMENTS, key) ??
        own(AWS_LOCKED_EVERYWHERE, key) ??
        own(entry.locked, key) ??
        (lockedNow?.while(facts) ? lockedNow.reason : undefined);
      if (reason === undefined) continue;
      judged.add(key);
      refuse(
        [key],
        Object.hasOwn(NATIVE_META_ARGUMENTS, key)
          ? reason
          : `locked: ${reason}`,
      );
    }
    const nestedRefused: (readonly PathPart[])[] = [];
    for (const [lockedPath, reason] of Object.entries(entry.locked ?? {})) {
      if (!lockedPath.includes('.')) continue;
      for (const path of located(value, lockedPath.split('.'))) {
        nestedRefused.push(path);
        refuse(path, `locked: ${reason}`);
      }
    }
    // Cloudgate's in every item written: never written, so never
    // required either.
    for (const [keptPath, reason] of Object.entries(entry.kept ?? {})) {
      judged.add(keptPath);
      for (const path of located(value, keptPath.split('.'))) {
        refuse(path, `locked: ${reason}; each item written gets Cloudgate's`);
      }
    }

    if (
      address === AWS_CONTAINER_ADDRESS &&
      Object.hasOwn(value, CONTAINER_KEY)
    ) {
      // The provider's schema calls it a JSON string; native writes the
      // one container as an object, checked against ECS's own fields.
      judged.add(CONTAINER_KEY);
      for (const finding of containerFindings(value[CONTAINER_KEY])) {
        refuse([CONTAINER_KEY, ...finding.path], finding.reason);
      }
    }

    const provider = committedProvider('aws');
    for (const finding of checkResourceArguments(
      provider,
      entry.type,
      value,
      judged,
    )) {
      if (nestedRefused.some((path) => within(finding.path, path))) continue;
      if (finding.severity === 'deprecated') warn(finding.path, finding.reason);
      else refuse(finding.path, finding.reason);
    }
  }
  return check;
}

/** Why `kind` does not make `address` right now, or `null` when it does. */
function whyNotMade(
  kind: string,
  address: string,
  facts: AwsMadeFacts,
): string | null {
  const perInstance =
    own(AWS_PER_INSTANCE, address) ?? own(AWS_ENVIRONMENT_NETWORK, address);
  if (perInstance !== undefined) return perInstance;
  if (!ADDRESS.test(address)) {
    return 'an address is <type>.<name>, as the plan’s cloud lines show it';
  }
  if (facts.existing) {
    return kind === 'bucket'
      ? 'an existing bucket is used as given; Cloudgate makes nothing of it on AWS'
      : 'an Existing database is used as given; Cloudgate makes nothing of it on AWS';
  }
  const key = awsAddressKey(address);
  const entry = own(AWS_ADDRESSES, key);
  if (
    entry === undefined ||
    !(entry.kinds as readonly string[]).includes(kind)
  ) {
    const made = awsAddressesMade(kind, facts);
    return made.length === 0
      ? `a ${kind} makes nothing on AWS`
      : `a ${kind} on AWS makes ${made.join(', ')}, not ${address}`;
  }
  return entry.madeNow?.(facts, address) ?? null;
}

/** What is wrong with the ECS container as `native.aws` writes it. */
function containerFindings(
  container: unknown,
): { path: PathPart[]; reason: string }[] {
  if (
    typeof container !== 'object' ||
    container === null ||
    Array.isArray(container)
  ) {
    return [
      {
        path: [],
        reason:
          "write the container as one object in ECS's camelCase; it is merged into Cloudgate's one container",
      },
    ];
  }
  const committed = committedContainerFields();
  const findings: { path: PathPart[]; reason: string }[] = [];
  for (const [key, value] of Object.entries(container)) {
    const locked = own(AWS_CONTAINER_LOCKS, key);
    if (locked !== undefined) {
      findings.push({ path: [key], reason: `locked: ${locked}` });
    } else if (!committed.fields.has(key)) {
      findings.push({
        path: [key],
        reason: `not a ContainerDefinition field of ${committed.label}, the version Cloudgate runs; ECS would drop it without a word`,
      });
    } else if (value === null) {
      findings.push({
        path: [key],
        reason: "write a value, or leave the key out for Cloudgate's own",
      });
    }
  }
  return findings;
}
