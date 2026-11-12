import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import type { VariableList } from 'api-schemas';
import { parse } from 'dotenv';

import { keepKeys } from '../project-config/applier/dotenv-keys';
import { VARIABLE_IS_LINKED_CODE } from '../project-config/outputs';
import type { ConfigLinks } from '../project-config/project-config.types';

/**
 * A Service's own runtime variables changed key by key, on the
 * dotenv text they are stored as. Every line the operator wrote that is not
 * one of the named keys — comments, blank lines, quoting, the order — stays
 * as it was (`keepKeys`); a key set again is moved to the end with its new
 * value, and a key set for the first time is added there.
 *
 * Written with the quote character the value does not hold, and read back
 * with `dotenv`'s own parser before it is stored: a value this text cannot
 * hold exactly is refused rather than stored as something else.
 */
export function withVariables(
  text: string | null,
  set: Readonly<Record<string, string>>,
  unset: readonly string[],
): string {
  const before = parse(text ?? '');
  const touched = new Set([...Object.keys(set), ...unset]);
  const kept = keepKeys(
    text ?? '',
    new Set(Object.keys(before).filter((name) => !touched.has(name))),
  );
  const added = Object.entries(set).map(
    ([name, value]) => `${name}=${quoted(value)}`,
  );
  const result =
    added.length === 0
      ? kept
      : `${kept === '' || kept.endsWith('\n') ? kept : `${kept}\n`}${added.join('\n')}\n`;

  const after = parse(result);
  const expected: Record<string, string> = { ...before, ...set };
  for (const name of unset) delete expected[name];
  for (const [name, value] of Object.entries(expected)) {
    if (after[name] !== value) {
      throw new BadRequestException(
        Object.hasOwn(set, name)
          ? `${name}'s value cannot be stored exactly as a variable; set it in the console`
          : 'The variables could not be changed without rewriting the others; change them in the console',
      );
    }
  }
  if (Object.keys(after).length !== Object.keys(expected).length) {
    throw new BadRequestException(
      'The variables could not be changed without rewriting the others; change them in the console',
    );
  }
  return result;
}

/**
 * Single quotes first, which dotenv reads literally; then backticks; then
 * double quotes, in which dotenv expands `\n`. The read-back above is what
 * decides whether the choice held.
 */
function quoted(value: string): string {
  const quote = ["'", '`', '"'].find((one) => !value.includes(one)) ?? '"';
  return `${quote}${value}${quote}`;
}

/** The refusal code for unsetting a name the Service does not have. */
export const VARIABLE_NOT_SET_CODE = 'VARIABLE_NOT_SET';

/**
 * Refuses an unset of a name that is not set on the Service: a wired one
 * (its value is the link's, so it is unset by changing the link in the
 * config) with `VARIABLE_IS_LINKED`, naming its Output, and any other with
 * `VARIABLE_NOT_SET`, so a mistyped name is not reported as removed.
 */
export function refuseUnsetOfMissing(
  text: string | null,
  links: ConfigLinks | null | undefined,
  unset: readonly string[],
  serviceName: string,
): void {
  const present = parse(text ?? '');
  const missing = unset.filter((name) => !Object.hasOwn(present, name));
  const linked = missing.filter((name) => links && Object.hasOwn(links, name));
  if (linked.length > 0 && links) {
    throw new ConflictException({
      message: `${linked
        .map(
          (name) =>
            `${name} is linked to ${links[name].source}.${links[name].output}`,
        )
        .join(
          '; ',
        )} by the Project config, so it is not set on ${serviceName}; change the link in the config`,
      code: VARIABLE_IS_LINKED_CODE,
    });
  }
  if (missing.length > 0) {
    throw new NotFoundException({
      message: `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set on ${serviceName}`,
      code: VARIABLE_NOT_SET_CODE,
    });
  }
}

/**
 * Every name a Service has, sorted: those set on it and those its Project
 * config wires to an Output (ADR-0031), each with that Output or `null`.
 * Never a value (ADR 0019).
 */
export function variableNames(
  text: string | null,
  links: ConfigLinks | null | undefined,
): VariableList['variables'] {
  const names = new Set([
    ...Object.keys(parse(text ?? '')),
    ...Object.keys(links ?? {}),
  ]);
  return [...names].sort().map((name) => {
    const link = links && Object.hasOwn(links, name) ? links[name] : null;
    return {
      name,
      linkedTo: link ? { source: link.source, output: link.output } : null,
    };
  });
}
