import { outputsChangedBy } from '../outputs/outputs';
import { linkText } from './plan-links';
import type {
  PlanInput,
  PlanStep,
  RedeployStep,
  SavedService,
  ServiceStep,
} from './plan.types';

type Create = Extract<PlanStep, { action: 'create' }>;
type Change = Extract<PlanStep, { action: 'change' }>;
type Destroy = Extract<PlanStep, { action: 'destroy' }>;

/** A plan's Service steps as the planner found them, before they are ordered. */
export interface FoundSteps {
  readonly creates: readonly Create[];
  readonly changes: readonly Change[];
  readonly destroys: readonly Destroy[];
}

/**
 * What a plan's links do to its Apply (ADR-0031): the Services it
 * redeploys, and the order its steps run in. Pure, as the planner is.
 *
 * - **A changed Output redeploys what links to it.** A source re-created
 *   (a kind change) changes every Output; a change of a setting an Output
 *   is built from (a postgres's `database` or `user`) changes those it
 *   feeds. Every Service the config links to one of them, and does not
 *   create or re-create itself, is deployed again after it: on its own
 *   change step, which deploys anyway, or on a redeploy step. A password
 *   is never the config's, so its change is the console's notice instead.
 * - **A link's source goes first.** Creates, changes, redeploys and
 *   destroys keep that order, except that a step waits for the step of
 *   every source its entry links to, a kind change's create follows its own
 *   destroy, and a destroy waits for every Service that linked to it to
 *   stop doing so (its change) or go (its destroy) — so a rename creates
 *   the new source, moves the link, then destroys the old one, and a
 *   database Delete never meets a link to it.
 */
export function orderedSteps(
  input: PlanInput,
  found: FoundSteps,
): ServiceStep[] {
  const { changes, redeploys } = withRedeploys(input, found);
  return order(input, { ...found, changes }, redeploys);
}

function withRedeploys(
  input: PlanInput,
  found: FoundSteps,
): { changes: Change[]; redeploys: RedeployStep[] } {
  const replaced = replacedNames(found);
  const changedOutputs = new Map<string, ReadonlySet<string> | 'all'>();
  for (const name of replaced) changedOutputs.set(name, 'all');
  for (const change of found.changes) {
    const outputs = outputsChangedBy(
      change.kind,
      change.fields.map((diff) => diff.field),
    );
    if (outputs.length > 0) {
      changedOutputs.set(change.configName, new Set(outputs));
    }
  }

  const created = new Set(found.creates.map((step) => step.configName));
  const changeOf = new Map(
    found.changes.map((step) => [step.configName, step]),
  );
  const because = new Map<string, string[]>();
  for (const [name, entry] of Object.entries(input.config.services)) {
    if (entry.managed === 'console' || created.has(name)) continue;
    for (const link of Object.values(entry.links ?? {})) {
      const changed = changedOutputs.get(link.source);
      if (!changed || (changed !== 'all' && !changed.has(link.output))) {
        continue;
      }
      const reasons = because.get(name) ?? [];
      if (!reasons.includes(linkText(link))) reasons.push(linkText(link));
      because.set(name, reasons);
    }
  }

  const savedByName = new Map(
    input.saved.map((saved) => [saved.configName, saved]),
  );
  const redeploys: RedeployStep[] = [];
  for (const [name, reasons] of because) {
    if (changeOf.has(name)) continue;
    const saved = savedByName.get(name);
    const entry = input.config.services[name];
    if (!saved || !entry || entry.managed === 'console') continue;
    redeploys.push({
      action: 'redeploy',
      configName: name,
      kind: entry.kind,
      serviceType: saved.serviceType,
      serviceId: saved.serviceId,
      name: saved.name,
      because: reasons,
    });
  }
  return {
    changes: found.changes.map((step) => {
      const reasons = because.get(step.configName);
      return reasons ? { ...step, because: reasons } : step;
    }),
    redeploys,
  };
}

/** The Config names a plan destroys and creates again as another kind. */
function replacedNames(found: FoundSteps): ReadonlySet<string> {
  const created = new Set(found.creates.map((step) => step.configName));
  return new Set(
    found.destroys
      .map((step) => step.configName)
      .filter((name) => created.has(name)),
  );
}

interface Group {
  readonly name: string;
  /** Creates, changes, redeploys, destroys: the order when no link says otherwise. */
  readonly rank: number;
  readonly index: number;
  /** Whether the Service is there after the group runs. */
  readonly stays: boolean;
  readonly steps: readonly ServiceStep[];
}

function order(
  input: PlanInput,
  found: FoundSteps,
  redeploys: readonly RedeployStep[],
): ServiceStep[] {
  const replaced = replacedNames(found);
  const groups: Group[] = [];
  const add = (
    name: string,
    rank: number,
    stays: boolean,
    steps: ServiceStep[],
  ) => groups.push({ name, rank, index: groups.length, stays, steps });
  for (const step of found.creates) {
    if (!replaced.has(step.configName)) add(step.configName, 0, true, [step]);
  }
  for (const step of found.changes) add(step.configName, 1, true, [step]);
  for (const step of redeploys) add(step.configName, 2, true, [step]);
  for (const step of found.destroys) {
    const create = replaced.has(step.configName)
      ? found.creates.find((one) => one.configName === step.configName)
      : undefined;
    add(step.configName, 3, Boolean(create), create ? [step, create] : [step]);
  }

  const staying = new Map(
    groups.filter((group) => group.stays).map((group) => [group.name, group]),
  );
  const leaving = new Map(
    groups.filter((group) => !group.stays).map((group) => [group.name, group]),
  );
  const after = new Map<Group, Set<Group>>(
    groups.map((group) => [group, new Set<Group>()]),
  );
  for (const group of groups) {
    const waits = after.get(group) as Set<Group>;
    if (group.stays) {
      const entry = input.config.services[group.name];
      if (!entry || entry.managed === 'console') continue;
      for (const link of Object.values(entry.links ?? {})) {
        const source = staying.get(link.source);
        if (source && source !== group) waits.add(source);
      }
      continue;
    }
    for (const linker of linkersOf(input.saved, group.name)) {
      const waitFor = staying.get(linker) ?? leaving.get(linker);
      if (waitFor && waitFor !== group) waits.add(waitFor);
    }
  }

  const done = new Set<Group>();
  const steps: ServiceStep[] = [];
  while (done.size < groups.length) {
    const left = groups.filter((group) => !done.has(group));
    const ready = left.filter((group) =>
      [...(after.get(group) ?? [])].every((wait) => done.has(wait)),
    );
    // Links never loop (`plan-links.ts`), so something is always ready;
    // should it not be, the plain order still runs everything once.
    const next = (ready.length > 0 ? ready : left).reduce((best, group) =>
      group.rank < best.rank ||
      (group.rank === best.rank && group.index < best.index)
        ? group
        : best,
    );
    done.add(next);
    steps.push(...next.steps);
  }
  return steps;
}

/** The Config names of saved Services whose applied links name `source`. */
function linkersOf(
  saved: readonly SavedService[],
  source: string,
): readonly string[] {
  return saved
    .filter((found) =>
      Object.values(found.links ?? {}).some((link) => link.source === source),
    )
    .map((found) => found.configName);
}
