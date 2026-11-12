import type { PlanInput, PlanNote, PlanStep } from './plan.types';

/**
 * **Values left unused** (spec #1356 story 58, ADR-0065 "Matching", #1378).
 * On a repository-kept config the user pastes a Template's renamed entries
 * into the file, and a plan creates a part from a Pending setup only when
 * the file lists it under exactly the part's Config name and kind. A part
 * the plan does not create from it (renamed in the pasted YAML, not pasted
 * yet, or whose Service already exists) gets nothing. This names those
 * parts and the values they leave unused, one note per setup. The setup
 * keeps them for a later plan, until it is cancelled or swept.
 *
 * A Cloudgate-kept config's setup wrote its entries itself, so its plans
 * note nothing.
 */
export function setupValuesUnused(
  input: PlanInput,
  creates: readonly PlanStep[],
): PlanNote[] {
  if (input.configKept !== 'repository') return [];
  const created = new Set(
    creates.flatMap((step) =>
      step.action === 'create' && step.template
        ? [`${step.template.pendingSetupId}/${step.configName}`]
        : [],
    ),
  );
  const saved = new Set(input.saved.map((found) => found.configName));
  return (input.pendingSetups ?? []).flatMap((setup): PlanNote[] => {
    const left = setup.parts.filter(
      (part) => !created.has(`${setup.pendingSetupId}/${part.configName}`),
    );
    if (left.length === 0) return [];
    const names = left.map((part) => part.configName);
    const absent = left.filter((part) => !saved.has(part.configName));
    const reasons = [
      ...(absent.length > 0
        ? [
            `this config lists ${absent
              .map(
                (part) => `no ${kindLabel(part.kind)} named ${part.configName}`,
              )
              .join(' and ')}`,
          ]
        : []),
      ...left
        .filter((part) => saved.has(part.configName))
        .map((part) => `${part.configName}'s Service already exists here`),
    ];
    const values = [...new Set(left.flatMap((part) => Object.keys(part.made)))];
    const one = left.length === 1;
    const message = [
      `${listing(names)} ${one ? 'is' : 'are'} not created from the ${setup.setupName} setup of the ${setup.templateName} template: `,
      reasons.join(' and '),
      values.length > 0
        ? `, so ${one ? 'its' : 'their'} values (${values.join(', ')}) are left unused`
        : '',
      absent.length === 0
        ? ''
        : absent.length === 1
          ? '. List it under that Config name and kind, or cancel the setup'
          : '. List them under those Config names and kinds, or cancel the setup',
    ].join('');
    return [
      {
        kind: 'setup-values-unused',
        configName: names[0],
        configNames: names,
        pendingSetupId: setup.pendingSetupId,
        templateId: setup.templateId,
        setupName: setup.setupName,
        message,
      },
    ];
  });
}

/** A part's kind as its line names it: the compose part's is console-managed. */
function kindLabel(kind: string): string {
  return kind === 'compose' ? 'console-managed compose' : kind;
}

/** `a`, `a and b`, `a, b and c`. */
function listing(names: readonly string[]): string {
  return names.length === 1
    ? names[0]
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
