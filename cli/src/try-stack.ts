import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';

import { composeVariables, TEST_VALUES_FILE } from 'cloudgate-template-check';
import type { Template } from 'cloudgate-template-check';
import {
  applyComposeDefaults,
  composeDotenvLine,
  fillFileText,
  makeValues,
  publishStackVmPorts,
  setupDomains,
} from 'cloudgate-template-setup';
import type { InputRule, SetupAnswers } from 'cloudgate-template-setup';
import RandExp from 'randexp';
import { parse, stringify } from 'yaml';

import { CliError } from './errors.js';
import { EXIT } from './exit-codes.js';

/** One Domain as `try` reaches it: on a loopback port of this computer. */
export interface TryDomain {
  readonly service: string;
  /** The container port, as the Template writes it. */
  readonly port: number;
  readonly path: string;
  /** The free port on 127.0.0.1 it is published on. */
  readonly hostPort: number;
}

/**
 * A Template's compose part as an Instance's stack folder holds it
 * (spec #5): `code/docker-compose.yml`, `code/.env`, and `files/<path>`,
 * so the Template's `../files/…` mounts resolve as they do on a Server.
 */
export interface TryStack {
  readonly composeFile: string;
  readonly env: string;
  /** By path below `files/`. */
  readonly files: Readonly<Record<string, string>>;
  readonly domains: readonly TryDomain[];
}

/**
 * Prepares `template`'s compose part as setup and a Server's deploy would,
 * with the backend's own code: the values by `makeValues`, the config files
 * by `fillFileText`, the compose file with `applyComposeDefaults`. Only the
 * Domains differ: there is no Traefik, so each Domain's container port is
 * published on a free `127.0.0.1` port (by `publishStackVmPorts`' rules),
 * and that port is what the values' Domain URLs carry.
 *
 * An `ask` input takes its value in `testValues` (the folder's
 * `test-values.yaml`), else its default, else a sample. Refused, naming the
 * input, when an `ask` has no value `try` can make.
 */
export async function prepareStack(
  template: Template & { readonly composeFile: string },
  project: string,
  testValues: Readonly<Record<string, string>> = {},
): Promise<TryStack> {
  const hostPorts = new Map<string, number>();
  const named = new Map<string, TryDomain>();
  const domains: TryDomain[] = [];
  for (const domain of setupDomains(template)) {
    const key = `${domain.service}:${domain.port}`;
    if (!hostPorts.has(key)) hostPorts.set(key, await freePort(hostPorts));
    const reached = { ...domain, hostPort: hostPorts.get(key) as number };
    named.set(domain.name, reached);
    domains.push(reached);
  }
  const answers: SetupAnswers = {
    asked: { ...askedSamples(template.inputs), ...testValues },
    domain: (name, part) => {
      const domain = named.get(name);
      if (domain === undefined) return null;
      return part === 'host'
        ? 'localhost'
        : `http://localhost:${domain.hostPort}`;
    },
  };

  const made = makeValues(template.inputs, answers);
  if (!made.ok) {
    throw new CliError(
      `${template.id}: try has no value it can use for ${made.problems
        .map(({ input, message }) => `${input} (${message})`)
        .join('; ')}`,
      EXIT.failed,
    );
  }

  let published: string;
  try {
    published = publishStackVmPorts(
      template.composeFile,
      domains.map(({ service, port }) => ({
        host: 'localhost',
        serviceName: service,
        port,
      })),
      (route) => ({
        ip: '127.0.0.1',
        port: hostPorts.get(`${route.serviceName}:${route.port}`) as number,
      }),
    );
  } catch (error) {
    throw new CliError(
      `${template.id}: ${(error as Error).message}`,
      EXIT.failed,
    );
  }
  const spec = applyComposeDefaults(
    { composeType: 'docker-compose' },
    parse(published) as Parameters<typeof applyComposeDefaults>[1],
    {},
  );

  const files: Record<string, string> = {};
  for (const file of template.files) {
    if ((file.entry ?? template.compose) !== template.compose) continue;
    files[file.path] = fillFileText(
      template.configFiles[file.path] ?? '',
      answers,
      made.values,
    );
  }

  return {
    composeFile: stringify(spec, { lineWidth: 1000 }),
    env: envFile(template, project, made.values),
    files,
    domains,
  };
}

/**
 * The `.env` Cloudgate writes beside a stack's compose file: `APP_NAME`
 * and `COMPOSE_PROJECT_NAME`, then the inputs the compose file uses, each
 * line as Compose reads it back. Setup's own rule picks the inputs: every
 * one the file mentions, but one it reads only with a default and made
 * blank, so the default applies. `DOCKER_CONFIG` is left out: on a Server
 * it points at root's Docker config, and here it would hide the person's.
 */
function envFile(
  template: Template & { readonly composeFile: string },
  project: string,
  values: Readonly<Record<string, string>>,
): string {
  const read = composeVariables(
    parse(template.composeFile, { logLevel: 'error', maxAliasCount: 100 }),
  );
  const lines = [`APP_NAME=${project}`, `COMPOSE_PROJECT_NAME=${project}`];
  for (const name of Object.keys(template.inputs)) {
    if (!read.mentions.has(name)) continue;
    const value = values[name] ?? '';
    if (!read.needs.has(name) && value === '') continue;
    lines.push(`${name}=${value}`);
  }
  return `${lines.map(composeDotenvLine).join('\n')}\n`;
}

/**
 * The values `template`'s folder gives its `ask` inputs in
 * `test-values.yaml` (ADR-0078), none when it has no such file. Every value
 * is read as text, as written: `1` is `"1"`, not a number. Refused, naming
 * them, when the file is not a map of names to text or names anything but
 * an `ask` input.
 */
export function readTestValues(
  folder: string,
  template: Template,
): Record<string, string> {
  let text: string;
  try {
    text = readFileSync(join(folder, TEST_VALUES_FILE), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  const refused = (why: string) =>
    new CliError(`${template.id}: ${TEST_VALUES_FILE} ${why}`, EXIT.failed);

  let document: unknown;
  try {
    document = parse(text, { schema: 'failsafe' });
  } catch (error) {
    throw refused(`is not YAML: ${(error as Error).message}`);
  }
  if (document === null || document === undefined) return {};
  if (typeof document !== 'object' || Array.isArray(document)) {
    throw refused("is not a map of an ask input's name to its text");
  }
  const values = document as Record<string, unknown>;
  const notText = Object.keys(values).filter(
    (name) => typeof values[name] !== 'string',
  );
  if (notText.length > 0) {
    throw refused(
      `gives ${notText.join(', ')} something other than text; each value is one line or block of text`,
    );
  }
  const notAsked = Object.keys(values).filter((name) => {
    const rule = Object.hasOwn(template.inputs, name)
      ? template.inputs[name]
      : undefined;
    return rule === undefined || !('ask' in rule);
  });
  if (notAsked.length > 0) {
    throw refused(
      `gives a value for ${notAsked.join(', ')}, but only an ask input of this template takes one`,
    );
  }
  return values as Record<string, string>;
}

/** A sample for each `format`, fixed so a run's values can be read. */
const FORMAT_SAMPLES = {
  email: 'try@example.com',
  url: 'https://example.com',
  number: '1',
} as const;

/**
 * What `try` answers each `ask` input with no default: a fixed sample for a
 * `format`, a string made from a `pattern`, otherwise `try`. An ask with a
 * default is left to `makeValues`, which takes the default as setup does.
 * Every value still goes through `makeValues`, so a sample its rule refuses
 * fails the run, naming the input.
 */
function askedSamples(
  inputs: Readonly<Record<string, InputRule>>,
): Record<string, string> {
  const asked: Record<string, string> = {};
  for (const [name, rule] of Object.entries(inputs)) {
    if (!('ask' in rule) || rule.ask.default !== undefined) continue;
    const { format, pattern } = rule.ask;
    if (format !== undefined) asked[name] = FORMAT_SAMPLES[format];
    else if (pattern !== undefined) asked[name] = patternSample(pattern);
    else asked[name] = 'try';
  }
  return asked;
}

/** A string made to match `pattern`, read whole as the check reads it. */
function patternSample(pattern: string): string {
  let whole: RegExp;
  try {
    whole = new RegExp(`^(?:${pattern})$`, 'u');
  } catch {
    // The check refused it already; makeValues names it again.
    return '';
  }
  const sample = new RandExp(whole);
  sample.max = 8;
  return sample.gen();
}

/** A port nothing on 127.0.0.1 listens on now, not one already `taken`. */
async function freePort(taken: ReadonlyMap<string, number>): Promise<number> {
  const used = new Set(taken.values());
  for (;;) {
    const probe = createServer();
    await new Promise<void>((resolve, reject) => {
      probe.once('error', reject);
      probe.listen(0, '127.0.0.1', () => resolve());
    });
    const { port } = probe.address() as AddressInfo;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    if (!used.has(port)) return port;
  }
}
