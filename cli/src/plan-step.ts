import {
  CONFIG_VERSION_STALE_CODE,
  environmentListSchema,
  planViewSchema,
  savedConfigPlansSchema,
} from 'api-schemas';
import type { PlanStepView, PlanView } from 'api-schemas';

import type { ApiClient } from './api-client.js';
import type { CommandContext } from './command.js';
import { CliError, usageError } from './errors.js';
import { EXIT } from './exit-codes.js';
import { WORKING_COPY_FILE } from './folder-link.js';
import type { Output } from './output.js';
import {
  downloadProjectConfig,
  readWorkingCopy,
  saveWorkingCopy,
} from './working-copy.js';
import type { FoundProjectFolder } from './working-copy.js';

/**
 * The plan step of a **Project folder** (ADR-0080): its working copy sent
 * back as a whole-YAML edit naming the version it was downloaded at, each
 * Environment's Plan shown, and applied on a yes. `cloudgate config plan`
 * is this step alone; a root `cloudgate deploy` runs it first.
 */

/** How the plan step ended, when it did not refuse. */
export type PlanStepOutcome =
  /** No Environment had anything to change; nothing was applied. */
  | { readonly kind: 'unchanged' }
  /** The person said no, or typed a name that was not the one asked for. */
  | { readonly kind: 'declined' }
  /** Every Environment's plan was applied; `failed` steps did not apply. */
  | { readonly kind: 'applied'; readonly failed: number };

/**
 * Sends `project`'s `cloudgate.yaml` as a plan, prints each Environment's
 * plan on stdout and applies them on a yes. `client` acts in the link's
 * Organization.
 *
 * Refuses, sending nothing, a copy downloaded at a version the Project
 * config has moved on from (exit 1, pointing to `cloudgate config pull`).
 * With steps to apply: in a terminal it asks once, then has each destroy and
 * each major upgrade confirmed by typing its Config name; `yes` asks
 * nothing, but refuses a plan with either, naming them (exit 2); with no
 * terminal and no `yes` it refuses (exit 2). Nothing is applied before all
 * of that has passed. Applying starts only the Deployments the plans
 * themselves queue.
 *
 * Once anything was stored, the copy's recorded version is moved to
 * Cloudgate's, as long as Cloudgate now keeps the text that was sent.
 */
export async function runPlanStep(
  context: Pick<CommandContext, 'out' | 'prompter'>,
  client: ApiClient,
  project: FoundProjectFolder,
  options: { readonly yes: boolean },
): Promise<PlanStepOutcome> {
  const { out, prompter } = context;
  const { folder, link } = project;
  const text = readWorkingCopy(folder);
  if (text === undefined) {
    throw usageError(
      `this Project folder has no ${WORKING_COPY_FILE}`,
      'Run cloudgate config pull to download it.',
    );
  }
  const projectRef = { id: link.projectId, name: link.names.project };
  const startedFrom = link.workingCopy.version;
  const current = await out.withSpinner('Reading the Project config…', () =>
    downloadProjectConfig(client, projectRef),
  );
  if (current.version !== startedFrom) throw staleCopy(startedFrom);

  const saved = await out
    .withSpinner('Planning…', () =>
      client.post(
        `/projects/${encodeURIComponent(link.projectId)}/config/plans`,
        { text, version: startedFrom },
        savedConfigPlansSchema,
      ),
    )
    .catch((error: unknown) => {
      throw error instanceof CliError &&
        error.code === CONFIG_VERSION_STALE_CODE
        ? staleCopy(startedFrom)
        : error;
    });
  const names = await environmentNames(client, link.projectId);
  const nameOf = (plan: PlanView) =>
    names.get(plan.environmentId) ?? plan.environmentId;
  for (const plan of saved.plans) printPlan(out, nameOf(plan), plan);

  const pending = saved.plans
    .filter((plan) => plan.steps.length > 0)
    .map((plan) => ({
      plan,
      environment: nameOf(plan),
      ...namesToConfirm(plan.steps),
    }));
  if (pending.length === 0) {
    // Nothing to change stores the text at once: a text that differs from
    // Cloudgate's (a comment) moves the version, the same text keeps it.
    if (saved.stored) await recordStored(client, project, text);
    out.note('Nothing to change.');
    return { kind: 'unchanged' };
  }

  if (options.yes) {
    refuseNamesUnderYes(pending);
  } else {
    if (!out.mode.canAsk) {
      throw usageError(
        'nothing was applied: applying the plan needs a yes',
        'Pass --yes to apply a plan that destroys nothing, or run this in a terminal.',
      );
    }
    const where = pending.map((one) => one.environment).join(' and ');
    if (!(await prompter.confirm(`Apply the plan in ${where}?`))) {
      out.note('Nothing was applied.');
      return { kind: 'declined' };
    }
    for (const one of pending) {
      const asks = [
        ...one.destroy.map((name) => ({
          name,
          question: `Type ${name} to destroy it in ${one.environment}:`,
        })),
        ...one.upgrade.map(({ name, from, to }) => ({
          name,
          question: `Type ${name} to upgrade it from ${from} to ${to} in ${one.environment}, which cannot be undone:`,
        })),
      ];
      for (const { name, question } of asks) {
        if ((await prompter.text(question)) !== name) {
          out.note(`That is not ${name}. Nothing was applied.`);
          return { kind: 'declined' };
        }
      }
    }
  }

  let failed = 0;
  try {
    for (const one of pending) {
      const applied = await out.withSpinner(
        `Applying the plan in ${one.environment}…`,
        () =>
          client.post(
            `/environments/${encodeURIComponent(one.plan.environmentId)}/plan/apply`,
            {
              planId: one.plan.planId,
              confirmDestroy: one.destroy,
              confirmUpgrade: one.upgrade.map(({ name }) => name),
            },
            planViewSchema,
          ),
      );
      failed += reportApplied(out, one.environment, applied);
    }
  } finally {
    await recordStored(client, project, text);
  }
  return { kind: 'applied', failed };
}

/** The refusal of a copy the Project config has moved on from. */
function staleCopy(version: number): CliError {
  return new CliError(
    `${WORKING_COPY_FILE} is version ${version} of the Project config, which has changed in Cloudgate since; nothing was sent`,
    EXIT.failed,
    'Run cloudgate config pull to get the current one, then make your edits again.',
  );
}

/** Each Environment's name, by id. */
async function environmentNames(
  client: ApiClient,
  projectId: string,
): Promise<Map<string, string>> {
  const environments = await client.get(
    `/environments?projectId=${encodeURIComponent(projectId)}`,
    environmentListSchema,
  );
  return new Map(environments.map((one) => [one.environmentId, one.name]));
}

const CREATES = new Set(['create', 'network-create']);
const DESTROYS = new Set(['destroy', 'network-remove']);

/** One Environment's plan: a count line, then a line per step and note. */
function printPlan(out: Output, environment: string, plan: PlanView): void {
  if (plan.steps.length === 0) {
    out.data(`${environment}: no changes\n`);
  } else {
    const creates = plan.steps.filter((s) => CREATES.has(s.action)).length;
    const destroys = plan.steps.filter((s) => DESTROYS.has(s.action)).length;
    const changes = plan.steps.length - creates - destroys;
    out.data(
      `${environment}: ${creates} to create, ${changes} to change, ${destroys} to destroy\n`,
    );
    for (const step of plan.steps) out.data(`${stepLine(step)}\n`);
  }
  for (const note of plan.notes) {
    if (note.message) out.data(`  note: ${note.message}\n`);
  }
}

/** A step as one line: `+`, `~` or `-`, what it is, and what it does. */
function stepLine(step: PlanStepView): string {
  const what =
    step.configName === undefined
      ? `Environment network (${step.region ?? 'unknown region'})`
      : `${step.configName} (${step.kind ?? 'unknown kind'})`;
  const blocked = step.blocked ? ` (will not run: ${step.blocked})` : '';
  if (CREATES.has(step.action)) return `  + ${what} create${blocked}`;
  if (DESTROYS.has(step.action)) {
    return `  - ${step.confirmName ?? what} destroy${blocked}`;
  }
  if (step.action === 'redeploy') {
    return `  ~ ${what} redeploy: ${(step.because ?? []).join(', ')} changed${blocked}`;
  }
  const fields = (step.fields ?? []).map((one) => one.field).join(', ');
  const upgrade = step.majorUpgrade
    ? ` (major upgrade ${step.majorUpgrade.from} to ${step.majorUpgrade.to})`
    : '';
  const verb = step.action === 'change' || step.action === 'network-change';
  return `  ~ ${what} ${verb ? 'change' : step.action}${fields ? ` ${fields}` : ''}${upgrade}${blocked}`;
}

/**
 * The names an Apply of `steps` must confirm: each destroy's Config name
 * (a network removal's own confirm name), and each major upgrade's.
 */
function namesToConfirm(steps: readonly PlanStepView[]): {
  destroy: string[];
  upgrade: { name: string; from: string; to: string }[];
} {
  return {
    destroy: steps.flatMap((step) => {
      if (!DESTROYS.has(step.action)) return [];
      const name = step.confirmName ?? step.configName;
      return name === undefined ? [] : [name];
    }),
    upgrade: steps.flatMap((step) =>
      step.majorUpgrade && step.configName !== undefined
        ? [{ name: step.configName, ...step.majorUpgrade }]
        : [],
    ),
  };
}

/** `--yes` alone never destroys and never makes a major upgrade (ADR-0080). */
function refuseNamesUnderYes(
  pending: readonly {
    environment: string;
    destroy: readonly string[];
    upgrade: readonly { name: string }[];
  }[],
): void {
  const destroys = pending.flatMap((one) =>
    one.destroy.map((name) => `${name} in ${one.environment}`),
  );
  const upgrades = pending.flatMap((one) =>
    one.upgrade.map(({ name }) => `${name} in ${one.environment}`),
  );
  const parts = [
    destroys.length > 0 ? `destroys ${destroys.join(', ')}` : null,
    upgrades.length > 0
      ? `upgrades ${upgrades.join(', ')} to a new major version`
      : null,
  ].filter((part): part is string => part !== null);
  if (parts.length === 0) return;
  throw usageError(
    `the plan ${parts.join(' and ')}, which --yes alone never does; nothing was applied`,
    'Run cloudgate config plan in a terminal, which asks you to type each name.',
  );
}

/** Says how one Environment's Apply went; answers how many steps failed. */
function reportApplied(
  out: Output,
  environment: string,
  applied: PlanView,
): number {
  const missed = (applied.results ?? []).filter(
    (result) => result.status !== 'applied',
  );
  if (missed.length === 0) {
    out.note(`✓ Applied the plan in ${environment}`);
    return 0;
  }
  out.note(`Applied the plan in ${environment} in part:`);
  for (const result of missed) {
    out.note(
      `  ${result.configName} ${result.action}: ${result.status}${result.message ? `, ${result.message}` : ''}`,
    );
  }
  return missed.filter((result) => result.status !== 'running').length;
}

/**
 * Records in the link the version Cloudgate keeps now, when the text it
 * keeps is the one `sent`: the copy is then that version. Otherwise the copy
 * is left as it is, and its next plan is refused as stale.
 */
async function recordStored(
  client: ApiClient,
  project: FoundProjectFolder,
  sent: string,
): Promise<void> {
  const now = await downloadProjectConfig(client, {
    id: project.link.projectId,
    name: project.link.names.project,
  });
  if (now.text === sent) saveWorkingCopy(project.folder, project.link, now);
}
