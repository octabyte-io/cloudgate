import { eq } from 'drizzle-orm';

import type { DrizzleDB } from '../db/drizzle.module';
import { existingDatabase } from '../db/schema';
import { outputsMovedBy, servicesLinking } from './outputs';
import type { LinkingType } from './outputs';
import type {
  CloudRead,
  ConfigKind,
  ConfigOutline,
  PlanStep,
  RedeployStep,
} from './planner/plan.types';

type Endpoint = { readonly host: string; readonly port: number };

export type AddressMoved = NonNullable<
  Extract<CloudRead, { status: 'read' }>['addressMoved']
>;

/**
 * Where a lookup found an Existing database, against where the last one did
 * (the AWS databases spec "Each plan's lookup"). Its first lookup saves the
 * address, as there is none to deploy from yet; one at the same host and
 * port changes nothing. One elsewhere is an Output change: nothing is saved
 * here, so deploys keep the old address until this plan's Apply saves the
 * new one and redeploys what links to it — a plan never deploys anything.
 */
export async function lookedUpAddress(
  db: DrizzleDB,
  lookup: {
    readonly existingDatabaseId: string;
    readonly serviceType: string;
    readonly configName: string;
    readonly identifier: string;
    readonly found: Endpoint;
    /**
     * The server CA the lookup read, where the cloud reports one of the
     * instance's own (a Cloud SQL instance on Google Cloud): read
     * every plan like the address, and a change of it is a change of
     * address too. Absent on AWS, whose `ca` is RDS's bundle.
     */
    readonly ca?: string;
  },
): Promise<{ addressMoved: AddressMoved; line: string } | null> {
  const where = eq(
    existingDatabase.existingDatabaseId,
    lookup.existingDatabaseId,
  );
  const [saved] = await db
    .select({ address: existingDatabase.address, ca: existingDatabase.ca })
    .from(existingDatabase)
    .where(where);
  const from = saved?.address ?? null;
  if (from === null) {
    await db
      .update(existingDatabase)
      .set({
        address: lookup.found,
        ...(lookup.ca === undefined ? {} : { ca: lookup.ca, foundCa: null }),
      })
      .where(where);
    return null;
  }
  const caMoved =
    lookup.ca !== undefined && saved?.ca !== null && saved?.ca !== lookup.ca;
  const outputs = [
    ...outputsMovedBy(lookup.serviceType, from, lookup.found),
    ...(caMoved ? ['ca'] : []),
  ];
  // The CA it found waits here for this plan's Apply, as the address waits
  // on the step: an Output is never written into a plan (ADR-0006).
  // One with no CA saved yet has none to deploy from, so it is saved now,
  // as a first address is.
  if (lookup.ca !== undefined) {
    await db
      .update(existingDatabase)
      .set({
        foundCa: caMoved ? lookup.ca : null,
        ...(saved?.ca === null ? { ca: lookup.ca } : {}),
      })
      .where(where);
  }
  if (outputs.length === 0) return null;
  const moved = outputs.map((output) => `${lookup.configName}.${output}`);
  const to = { host: lookup.found.host, port: lookup.found.port };
  const addressSame = from.host === to.host && from.port === to.port;
  const what = addressSame
    ? `${lookup.identifier} reports a new server CA`
    : `${lookup.identifier} now answers at ${to.host}:${to.port}, not ${from.host}:${from.port}${caMoved ? ', with a new server CA' : ''}`;
  return {
    addressMoved: { from: { host: from.host, port: from.port }, to, moved },
    line: `${lookup.configName}: ${what}; ${moved.join(', ')} changed, so Apply saves the new address, then redeploys what links to ${moved.length === 1 ? 'it' : 'them'}`,
  };
}

/**
 * Records what a lookup found of an Existing database: nothing under
 * its identifier marks it, so its page says "AWS cannot find `acme-prod`"
 * while the plan is refused as before; finding it clears the mark. Another
 * refusal (wrong engine, another VPC) says nothing about it being there.
 */
export async function noteFound(
  db: DrizzleDB,
  existingDatabaseId: string,
  verdict: { readonly ok: boolean; readonly missing?: true },
): Promise<void> {
  if (!verdict.ok && !verdict.missing) return;
  await db
    .update(existingDatabase)
    .set({ notFoundAt: verdict.ok ? null : new Date().toISOString() })
    .where(eq(existingDatabase.existingDatabaseId, existingDatabaseId));
}

/** A Service whose applied link names an Output an address move changed. */
export interface MovedLinker {
  readonly serviceType: LinkingType;
  readonly serviceId: string;
  readonly configName: string;
  readonly name: string;
  /** The changed links it holds, as `<source>.<output>`. */
  readonly because: readonly string[];
}

/** Every Service of the Environment linking one of the moved Outputs. */
export async function movedLinkers(
  db: DrizzleDB,
  environmentId: string,
  source: string,
  moved: AddressMoved,
): Promise<MovedLinker[]> {
  const found = new Map<string, MovedLinker>();
  for (const link of moved.moved) {
    const output = link.slice(source.length + 1);
    for (const one of await servicesLinking(
      db,
      { environmentId, configName: source },
      [output],
    )) {
      const before = found.get(one.configName);
      found.set(one.configName, {
        ...one,
        because: [...(before?.because ?? []), link],
      });
    }
  }
  return [...found.values()].sort((a, b) =>
    a.configName.localeCompare(b.configName),
  );
}

/**
 * What an address move adds to its plan (ADR-0031 "a changed Output redeploys
 * what links to it"), as the wired-variables planner would have, had it known:
 * a linking Service the plan already changes or redeploys gets the reason on
 * that step, which deploys it anyway; one the plan creates or destroys gets
 * nothing; any other gets a redeploy step, after every step there is, so
 * after the lookup whose Apply saves the address. Only a Service the
 * config describes is the plan's to redeploy. Pure.
 */
export function addressMovePatch(
  steps: readonly PlanStep[],
  linkers: readonly MovedLinker[],
  outline: ConfigOutline | null,
): {
  readonly because: ReadonlyMap<number, readonly string[]>;
  readonly append: readonly RedeployStep[];
} {
  const because = new Map<number, readonly string[]>();
  const append: RedeployStep[] = [];
  for (const linker of linkers) {
    const at = steps.findIndex(
      (step) => 'configName' in step && step.configName === linker.configName,
    );
    const step = at === -1 ? null : steps[at];
    // A change of no field is a cloud Service read for Drift, whose
    // Apply puts back what was read rather than deploying: it is redeployed
    // after it, as the wired-variables planner does beside a Drift read.
    if (
      step?.action === 'redeploy' ||
      (step?.action === 'change' && step.fields.length > 0)
    ) {
      const reasons = [...(step.because ?? [])];
      for (const link of linker.because) {
        if (!reasons.includes(link)) reasons.push(link);
      }
      because.set(at, reasons);
      continue;
    }
    if (step && step.action !== 'change') continue;
    const described = outline?.services[linker.configName];
    if (!described || described.managed === 'console') continue;
    append.push({
      action: 'redeploy',
      configName: linker.configName,
      kind: described.kind as ConfigKind,
      serviceType: linker.serviceType,
      serviceId: linker.serviceId,
      name: linker.name,
      because: linker.because,
    });
  }
  return { because, append };
}
