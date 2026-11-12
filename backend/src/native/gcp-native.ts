import { z } from 'zod';

import { NATIVE_META_ARGUMENTS } from './native-shared';
import type { NativeCheck } from './native-shared';
import {
  GCP_ADDRESSES,
  GCP_CONTAINER_ADDRESSES,
  GCP_CONTAINER_LOCKS,
  GCP_CONTAINER_PATH,
  GCP_ENVIRONMENT_NETWORK,
  GCP_LOCKED_EVERYWHERE,
  GCP_NOT_LAID,
  GCP_PER_INSTANCE,
} from './google-locks';
import type { GcpAddressEntry, GcpMadeFacts } from './google-locks';
import {
  blockAt,
  checkMergedBlock,
  checkResourceArguments,
  committedProvider,
  locatedPaths,
  ownEntry,
  pathText,
  pathWithin,
} from './provider-schema';
import type { PathPart } from './provider-schema';
import type { ConfigKind } from '../project-config/planner/plan.types';

/**
 * **`native.gcp`** (ADR-0044 rules 2, 4, 5, 7–9): read and checked
 * on every plan, whatever the Environment's Deploy target, by the same
 * checker `native.aws` uses (`provider-schema.ts`), so a typo shows on a
 * Docker or AWS plan rather than on the first deploy to Google Cloud. The
 * twin of `aws-native.ts`.
 *
 * - **Read.** {@link nativeGcpWireSchema} is `native.gcp` in each described
 *   entry's strict schema: keyed by the full OpenTofu address as one key
 *   (`"google_sql_database_instance.database"`), each holding that
 *   resource's provider arguments in the provider's spelling. The Cloud Run
 *   container is `template.containers` under
 *   `"google_cloud_run_v2_service.service"`, written as **one object**.
 *   Nothing is renamed between the file and here.
 * - **Check.** {@link nativeGcpCheck} returns every refusal, by full path
 *   with a one-line reason, and every deprecation warning: an address the
 *   kind does not make, or does not make right now; one of a kind whose
 *   Google definition does not lay native.gcp yet (`GCP_NOT_LAID`), by
 *   name, so it is never accepted and then dropped; a per-variable or
 *   per-Domain address, refused whole; a meta-argument; a Locked setting
 *   or a value outside a limited one (`google-locks.ts`, the one list the
 *   plan, console and deploy read); another engine's argument on a kind
 *   one definition makes, pointing at the kind's own; and, against the committed schema of
 *   **the provider the address's definition names** (`hashicorp/google`
 *   for every address since the beta provider was dropped), an argument the pinned provider does
 *   not have, a value of the wrong shape, and a deprecated argument as a
 *   warning. Operators never write the provider.
 * - **Laid per kind.** On a Google Environment a `web`'s block is laid over
 *   Cloudgate's definition (`gcp-lay.ts`), and a `postgres`'s and a
 *   `redis`'s; a `web-private`'s, a `worker`'s and a `cron`'s
 *   (slice 8), a `bucket`'s and a `static` site's are refused as not
 *   laid yet. On a Docker or
 *   AWS Environment it is checked only, with no
 *   step and nothing stored, as `native.aws` is off AWS.
 *
 *     pg.native.gcp."google_sql_database_instance.database".settings.ip_configuration: refused - locked: <reason>
 */

// ── Read ──

/** One address's provider arguments, as the provider spells them. */
const gcpResourceWire = z.record(z.string(), z.unknown()).meta({
  description:
    "This resource's provider arguments, in hashicorp/google's spelling, laid over Cloudgate's own: a block the provider allows once field by field, a map key by key, a list whole.",
});

/**
 * `native.gcp`: any address as a key, so an unknown one reaches
 * {@link nativeGcpCheck}, which names what the kind makes.
 */
export const nativeGcpWireSchema = z.record(z.string(), gcpResourceWire).meta({
  description:
    'Settings on Google Cloud, keyed by the full OpenTofu address the plan\'s cloud lines show (e.g. "google_cloud_run_v2_service.service"). The Cloud Run container is "google_cloud_run_v2_service.service".template.containers, one object in the provider\'s spelling.',
});

export type NativeGcpBlock = z.infer<typeof nativeGcpWireSchema>;

// ── What a Service makes ──

/** The addresses `native.gcp` may name on a kind, whatever it makes right now. */
function entriesOf(kind: string): [string, GcpAddressEntry][] {
  return Object.entries(GCP_ADDRESSES).filter(([, entry]) =>
    (entry.kinds as readonly string[]).includes(kind),
  );
}

/**
 * The addresses a Service of `kind` makes on Google Cloud **right now**
 * that `native.gcp` may name, in the order its definition writes them. An
 * Existing database makes only its endpoint, and an existing bucket only
 * its own account and key ({@link GcpAddressEntry.existing}); with the fact
 * left out, what Cloudgate makes itself is listed. (An endpoint named then
 * is still read as made, and refused as locked whole.)
 */
export function gcpAddressesMade(kind: string, facts: GcpMadeFacts): string[] {
  return entriesOf(kind)
    .filter(
      ([, entry]) =>
        notMadeNow(kind, entry, facts) === null &&
        (facts.existing === true || entry.existing !== 'only'),
    )
    .map(([address]) => address);
}

/** Why an entry of `kind`'s is not made right now, or `null` when it is. */
function notMadeNow(
  kind: string,
  entry: GcpAddressEntry,
  facts: GcpMadeFacts,
): string | null {
  if (facts.existing === true && entry.existing === undefined) {
    return kind === 'bucket'
      ? 'an existing bucket is used as given; Cloudgate makes only its own account and key of it'
      : 'an Existing database is used as given; Cloudgate makes nothing of it native.gcp can set';
  }
  if (facts.existing === false && entry.existing === 'only') {
    return 'it is made only for an Existing database, as its endpoint';
  }
  return null;
}

/**
 * The entry `native.gcp` reads for `address` on a `kind`, or `undefined`
 * when the kind does not make it: the lock table's one lookup, for the
 * console and the deploy as for the plan.
 */
export function gcpAddressEntry(
  kind: string,
  address: string,
): GcpAddressEntry | undefined {
  const entry = ownEntry(GCP_ADDRESSES, address);
  return entry && (entry.kinds as readonly string[]).includes(kind)
    ? entry
    : undefined;
}

// ── Check ──

const ADDRESS = /^[a-z][a-z0-9_]*\.[A-Za-z_][A-Za-z0-9_-]*$/;

const CONTAINER_SHAPE =
  "write the container as one object in the provider's spelling; it is merged into Cloudgate's one container";

/**
 * Every refusal and warning about one entry's `native.gcp`, on every plan
 * and whatever the Environment's Deploy target (ADR-0044 rule 5). Every
 * refusal is returned, not the first, so one plan names everything to
 * correct. `facts` says what the Service makes right now; a fact absent
 * (any target but Google Cloud) is never a reason to refuse.
 */
export function nativeGcpCheck(
  configName: string,
  kind: string,
  block: NativeGcpBlock | undefined,
  facts: GcpMadeFacts,
): NativeCheck {
  const check: NativeCheck = { refusals: [], warnings: [] };
  if (block === undefined) return check;
  for (const [address, value] of Object.entries(block)) {
    const prefix = `${configName}.native.gcp.${JSON.stringify(address)}`;
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
    const notLaid = ownEntry(GCP_NOT_LAID, kind);
    if (notLaid !== undefined) {
      refuse([], `not laid yet: ${notLaid}`);
      continue;
    }
    const entry = GCP_ADDRESSES[address];
    if (entry.whole !== undefined) {
      refuse([], `locked whole: ${entry.whole}`);
      continue;
    }

    // What the locks judged, passed over by the schema check: top-level
    // keys by name, nested ones by the paths they were found at.
    const judged = new Set<string>();
    const judgedAt: (readonly PathPart[])[] = [];
    for (const key of Object.keys(value)) {
      const meta = ownEntry(NATIVE_META_ARGUMENTS, key);
      const reason =
        meta ??
        ownEntry(GCP_LOCKED_EVERYWHERE, key) ??
        ownEntry(entry.locked, key);
      if (reason !== undefined) {
        judged.add(key);
        refuse([key], meta !== undefined ? reason : `locked: ${reason}`);
        continue;
      }
      const limit = ownEntry(entry.limited, key);
      if (limit !== undefined && value[key] !== null) {
        if (!limit.allowed(kind as ConfigKind).includes(value[key] as string)) {
          judged.add(key);
          refuse([key], `locked: ${limit.reason(kind as ConfigKind)}`);
        }
      }
    }
    for (const [lockedPath, reason] of Object.entries(entry.locked ?? {})) {
      if (!lockedPath.includes('.')) continue;
      for (const path of locatedPaths(value, lockedPath.split('.'))) {
        judgedAt.push(path);
        refuse(path, `locked: ${reason}`);
      }
    }
    const refusedOn = entry.refusedOn?.(kind as ConfigKind) ?? {};
    for (const [refusedPath, reason] of Object.entries(refusedOn)) {
      for (const path of locatedPaths(value, refusedPath.split('.'))) {
        judgedAt.push(path);
        refuse(path, reason);
      }
    }

    const provider = committedProvider(entry.provider);
    if (GCP_CONTAINER_ADDRESSES.includes(address)) {
      // Written as one object merged into Cloudgate's container, where the
      // provider's schema has a list of them; checked here, not below.
      judged.add(GCP_CONTAINER_PATH.join('.'));
      const containers = blockAt(provider, entry.type, GCP_CONTAINER_PATH);
      for (const at of locatedPaths(value, GCP_CONTAINER_PATH)) {
        if (judgedAt.some((path) => pathWithin(at, path))) continue;
        const container = at.reduce<unknown>(
          (inner, part) => (inner as Record<string | number, unknown>)[part],
          value,
        );
        if (
          typeof container !== 'object' ||
          container === null ||
          Array.isArray(container) ||
          containers === undefined
        ) {
          refuse(at, CONTAINER_SHAPE);
          continue;
        }
        const locked = new Set<string>();
        for (const key of Object.keys(container)) {
          const reason = ownEntry(GCP_CONTAINER_LOCKS, key);
          if (reason === undefined) continue;
          locked.add(key);
          refuse([...at, key], `locked: ${reason}`);
        }
        for (const finding of checkMergedBlock(
          provider,
          entry.type,
          containers,
          container as Record<string, unknown>,
          at,
          locked,
        )) {
          if (finding.severity === 'deprecated') {
            warn(finding.path, finding.reason);
          } else refuse(finding.path, finding.reason);
        }
      }
    }

    for (const finding of checkResourceArguments(
      provider,
      entry.type,
      value,
      judged,
    )) {
      if (judgedAt.some((path) => pathWithin(finding.path, path))) continue;
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
  facts: GcpMadeFacts,
): string | null {
  const perInstance =
    ownEntry(GCP_PER_INSTANCE, address) ??
    ownEntry(GCP_ENVIRONMENT_NETWORK, address);
  if (perInstance !== undefined) return perInstance;
  if (!ADDRESS.test(address)) {
    return 'an address is <type>.<name>, as the plan’s cloud lines show it';
  }
  const entry = gcpAddressEntry(kind, address);
  if (entry !== undefined) return notMadeNow(kind, entry, facts);
  const made = gcpAddressesMade(kind, facts);
  return made.length === 0
    ? `native.gcp names nothing a ${kind} makes on Google Cloud`
    : `a ${kind} on Google Cloud makes ${made.join(', ')}, not ${address}`;
}
