import * as semver from 'semver';
import { isMap, isScalar, parse, parseDocument, YAMLParseError } from 'yaml';
import { z } from 'zod';

import { pathSchema } from '../../domains/dto/domain.dto';
import { CONFIG_NAME_REGEX } from '../../project-config/format/config-schema';
import { SIZE_NAMES } from '../../project-config/format/config-size';

/**
 * `template.yaml`: what only a Template has, beside its ordinary
 * `cloudgate.yaml` (spec #1356, Template folder format). Every object is
 * strict, so a field Cloudgate does not know hides the template and is named,
 * rather than being skipped: a typo fails `cg-templates` CI instead of being
 * ignored (user story 18).
 *
 * There is deliberately no `id` (the id is the folder name, which cannot
 * disagree with itself) and no `logo` (the logo is `logo.svg` or `logo.png`
 * beside this file, at a fixed name).
 *
 * `inputs`, `domains` and `files` are read for their shape here. Which names
 * need a rule, where a reference points, which compose service a Domain names
 * and whether a file path is safe are the template rules' (#1363), which see
 * the whole template at once.
 */

const MAX_DESCRIPTION = 300;

/** A required piece of text; "is required" when it is absent. */
function text(what = 'text') {
  return z
    .string({
      error: (issue) =>
        issue.input === undefined ? 'is required' : `must be ${what}`,
    })
    .trim()
    .min(1, 'must not be empty');
}

const httpUrl = z.url({
  protocol: /^https?$/,
  error: 'must be an http or https address',
});

/** A variable's name, as a compose file's `${NAME}` can spell it. */
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const variableName = z
  .string()
  .regex(VARIABLE_NAME, 'must be a variable name, e.g. ADMIN_EMAIL');

/**
 * One input's rule, ADR-0064's kinds less the Wired one, which is a link in
 * `cloudgate.yaml` and never written here. A rule is picked by the one key
 * that names its kind, so a mistake inside `ask` is reported as an `ask`
 * mistake rather than as "matches none of three shapes".
 */
const GENERATED = ['password', 'hex', 'base64', 'uuid'] as const;

const plainGenerateRule = z.strictObject({
  generate: z.enum([...GENERATED, 'jwt']),
});

const jwtRule = z.strictObject({
  generate: z.literal('jwt'),
  /** The input whose value signs it (HS256). */
  secret: variableName,
  payload: z.record(z.string(), z.unknown(), {
    error: (issue) =>
      issue.input === undefined ? 'is required' : 'must be a map of claims',
  }),
});

const askRule = z.strictObject({
  ask: z
    .strictObject({
      label: text(),
      description: z.string().optional(),
      default: z.string().optional(),
      /** True when not written. */
      required: z.boolean().optional(),
      secret: z.boolean().optional(),
      format: z.enum(['email', 'url', 'number']).optional(),
      pattern: z.string().optional(),
    })
    .refine((ask) => ask.format === undefined || ask.pattern === undefined, {
      message: 'takes at most one check, format or pattern',
    }),
});

const valueRule = z.strictObject({ value: z.string() });

/** The schema for a rule of each kind; `jwt` alone takes more than its kind. */
const RULE_KINDS = {
  generate: (raw: object) =>
    'generate' in raw && raw.generate === 'jwt' ? jwtRule : plainGenerateRule,
  ask: () => askRule,
  value: () => valueRule,
};

export type InputRule =
  | { readonly generate: (typeof GENERATED)[number] }
  | z.infer<typeof jwtRule>
  | z.infer<typeof askRule>
  | z.infer<typeof valueRule>;

const inputRule = z.unknown().transform((raw, context): InputRule => {
  const kinds =
    raw !== null && typeof raw === 'object'
      ? (Object.keys(RULE_KINDS) as (keyof typeof RULE_KINDS)[]).filter(
          (kind) => kind in raw,
        )
      : [];
  if (raw === null || typeof raw !== 'object' || kinds.length !== 1) {
    context.addIssue({
      code: 'custom',
      message: 'must be one rule: generate, ask or value',
    });
    return z.NEVER;
  }
  const result = RULE_KINDS[kinds[0]](raw).safeParse(raw);
  if (result.success) return result.data as InputRule;
  for (const issue of result.error.issues) {
    context.addIssue({ ...issue, path: issue.path });
  }
  return z.NEVER;
});

const domain = z.strictObject({
  /** A service in the compose file (checked by the template rules). */
  service: text(),
  port: z
    .number({ error: 'must be a port number' })
    .int('must be a port number')
    .min(1, 'must be a port number')
    .max(65535, 'must be a port number'),
  /**
   * Held to `pathSchema`, the rule every Domain create applies, so a path
   * the Apply's Domain create would refuse hides the template at check time
   * rather than failing its Apply.
   */
  path: z
    .string()
    .default('/')
    .superRefine((path, issues) => {
      const held = pathSchema.safeParse(path);
      if (!held.success) {
        issues.addIssue({
          code: 'custom',
          message: `is not a Domain path: ${held.error.issues[0].message}`,
        });
      }
    }),
  /**
   * Never written: setup picks each host (spec #1356). Named here rather
   * than left to the strict object's "not a field a template has", because
   * a host is the field an author most expects to write, and the reason it
   * is refused is worth saying.
   */
  host: z
    .never({
      error:
        "is not written in a template: setup gives each Domain its host, a generated one on a Server and the user's own in a cloud",
    })
    .optional(),
});

const file = z.strictObject({
  /** Both where it sits under `files/` and where it lands. */
  path: text(),
  /** The Config name of the entry it belongs to; the compose entry when absent. */
  entry: z
    .string()
    .regex(CONFIG_NAME_REGEX, 'must be a Config name')
    .optional(),
  /** Where an own-kind entry mounts it. */
  mount: text().optional(),
});

/**
 * The version a template needs, and the field read before every other: a
 * template written for a newer Cloudgate may carry fields this one does not
 * know, and must be hidden for its version rather than for those fields.
 */
const cloudgateVersion = z
  .string({
    error: (issue) =>
      issue.input === undefined
        ? 'is required'
        : 'must be a version in quotes, e.g. "0.2.0"',
  })
  .refine((version) => semver.valid(version) !== null, {
    message: 'must be a version, e.g. 0.2.0',
  });

export const templateYamlSchema = z.strictObject({
  name: text(),
  description: text().max(
    MAX_DESCRIPTION,
    `must be at most ${MAX_DESCRIPTION} characters`,
  ),
  /**
   * The app's version, display only. Text, never a number: YAML reads `5.10`
   * as 5.1, which is a different version.
   */
  version: text('text in quotes, e.g. "5.10"').optional(),
  tags: z
    .array(text(), {
      error: (issue) =>
        issue.input === undefined ? 'is required' : 'must be a list of tags',
    })
    .min(1, 'must name at least one tag'),
  links: z
    .strictObject({
      website: httpUrl.optional(),
      docs: httpUrl.optional(),
      source: httpUrl.optional(),
    })
    .default({}),
  /** The Config name of the compose entry, when the template has one. */
  compose: z
    .string()
    .regex(CONFIG_NAME_REGEX, 'must be a Config name')
    .optional(),
  cloudgate: cloudgateVersion,
  /**
   * The size the compose part starts from, a minimum (ADR-0070): a Stack VM
   * smaller than this would not hold the app.
   */
  size: z.enum(SIZE_NAMES).optional(),
  inputs: z.record(variableName, inputRule).default({}),
  domains: z.array(domain).default([]),
  files: z.array(file).default([]),
});

export type TemplateYaml = z.infer<typeof templateYamlSchema>;

export type TemplateYamlRead =
  | { readonly ok: true; readonly template: TemplateYaml }
  | { readonly ok: false; readonly reason: string; readonly newer?: true };

/**
 * Reads `template.yaml`. A template needing a newer Cloudgate than
 * `cloudgateVersion` is refused for that alone, with `newer` set, before its
 * other fields are read.
 */
export function readTemplateYaml(
  source: string,
  cloudgateVersion: string,
): TemplateYamlRead {
  let document: unknown;
  try {
    document = parse(source, { logLevel: 'error', maxAliasCount: 100 });
  } catch (error) {
    if (!(error instanceof YAMLParseError)) throw error;
    const twice =
      error.code === 'DUPLICATE_KEY' ? inputWrittenTwice(source) : null;
    return {
      ok: false,
      reason: twice
        ? `template.yaml: inputs has two rules for ${twice}; a name has exactly one`
        : `template.yaml is not valid YAML: ${error.message.split('\n')[0]}`,
    };
  }
  if (
    document === null ||
    typeof document !== 'object' ||
    Array.isArray(document)
  ) {
    return { ok: false, reason: 'template.yaml must be a map of fields' };
  }

  const needed = templateYamlSchema.shape.cloudgate.safeParse(
    (document as Record<string, unknown>).cloudgate,
  );
  if (!needed.success) {
    return {
      ok: false,
      reason: `template.yaml: ${describe(needed.error.issues[0], ['cloudgate'])}`,
    };
  }
  if (semver.gt(needed.data, cloudgateVersion)) {
    return {
      ok: false,
      newer: true,
      reason: `needs Cloudgate ${needed.data} or newer; this is ${cloudgateVersion}`,
    };
  }

  const result = templateYamlSchema.safeParse(document);
  if (!result.success) {
    return {
      ok: false,
      reason: `template.yaml: ${describe(result.error.issues[0], [])}`,
    };
  }
  return { ok: true, template: result.data };
}

/**
 * The first name `inputs` writes twice. YAML itself refuses a repeated key,
 * but its message gives only a line and column, and the ticket (#1363) asks
 * for two rules for one name to be refused with the name. So the file is
 * read once more with repeats allowed, only to find which one it was.
 */
function inputWrittenTwice(source: string): string | null {
  const inputs = parseDocument(source, { uniqueKeys: false }).get('inputs');
  if (!isMap(inputs)) return null;
  const seen = new Set<string>();
  for (const { key } of inputs.items) {
    if (!isScalar(key)) continue;
    const name = String(key.value);
    if (seen.has(name)) return name;
    seen.add(name);
  }
  return null;
}

/** One zod issue as a sentence naming its field: `links.docs must be …`. */
function describe(issue: z.core.$ZodIssue, base: PropertyKey[]): string {
  const path = [...base, ...issue.path];
  const field = (more: PropertyKey[] = []) =>
    [...path, ...more].map(String).join('.');
  if (issue.code === 'unrecognized_keys') {
    return `${field([issue.keys[0]])} is not a field a template has`;
  }
  if (path.length === 0) return issue.message;
  // Zod's own messages read "Invalid option: expected one of …"; the
  // schema's read as a predicate ("must not be empty"). Both follow the field.
  const message = issue.message
    .replace(/^Invalid option: expected one of /, 'must be one of ')
    .replace(/^Invalid input: expected (\w+), received \w+$/, 'must be a $1')
    .replace(/^Invalid input$/, 'is not valid');
  return `${field()} ${message}`;
}
