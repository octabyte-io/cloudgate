import { parse, YAMLParseError } from 'yaml';

import { CONFIG_NAME_REGEX } from '../../project-config/format/config-schema';
import { parseProjectConfig } from '../../project-config/format/parse-config';
import type { ProjectConfig } from '../../project-config/project-config.types';
import { readCatalogueFile } from './catalogue-file';
import type { CatalogueEntry } from './catalogue-file';
import { CONFIG_FILES, folderFile } from './catalogue-layout';
import type { FolderYaml } from './catalogue-layout';
import { composeVariables } from './compose-variables';
import { readLogo } from './template-logo';
import type { TemplateLogo } from './template-logo';
import { TEMPLATE_RULES } from './template-rules';
import type { ComposeFile } from './template-rules';
import { readTemplateYaml } from './template-yaml';
import type { TemplateYaml } from './template-yaml';

/**
 * A **Template** this Cloudgate can offer, every file in it read: its
 * `template.yaml` fields, its `cloudgate.yaml` through the instance's own
 * Project config parser, its compose file, its config files and its logo.
 */
export interface Template extends TemplateYaml {
  /** The folder name: a Config name, unique in the catalogue, never changing. */
  readonly id: string;
  /** The last catalogue commit that changed the folder. */
  readonly revision: string;
  readonly config: ProjectConfig;
  /**
   * `cloudgate.yaml` (or `cloudgate.yml`) as written: the text setup renames and adds to a
   * Project's config, so the entries it adds are the ones this check read.
   */
  readonly configText: string;
  /**
   * `docker-compose.yaml` or `docker-compose.yml` as written; null when
   * there is no compose part.
   */
  readonly composeFile: string | null;
  /** The files under `files/`, by their path below it. */
  readonly configFiles: Readonly<Record<string, string>>;
  readonly logo: TemplateLogo;
}

/** A template this Cloudgate does not offer, and the one reason why. */
export interface HiddenTemplate {
  readonly id: string;
  readonly reason: string;
}

/**
 * The check's answer: the Templates to offer and every other one with its
 * reason, or the whole catalogue refused (too large, not a catalogue, a
 * format this Cloudgate does not read), when a reader keeps its last good copy.
 */
export type CatalogueCheck =
  | {
      readonly ok: true;
      readonly offered: readonly Template[];
      readonly hidden: readonly HiddenTemplate[];
    }
  | { readonly ok: false; readonly reason: string };

/** What the check knows of the instance it runs for. */
export interface CheckingInstance {
  /** This Cloudgate's version; a template needing a newer one is hidden. */
  readonly cloudgateVersion: string;
}

/**
 * **The Template check** (spec #1356): the bytes of a `catalogue.zip` in,
 * the Templates this instance can offer and the reason each other one is
 * hidden out. One bad template is hidden alone and never hides the rest;
 * a zip that is unsafe or holds a file no template has is refused whole
 * (ADR-0072).
 *
 * Pure: a function of its input, the instance's version and the instance's
 * own kind and schema tables, with no network, database or clock. That is
 * what lets three callers share it — the catalogue reader, the setup service
 * on the exact bytes it sets up from, and `cloudgate template check` in
 * `cg-templates` CI — and get one answer; CI catches mistakes early but never
 * replaces the install's own check.
 */
export function checkCatalogue(
  bytes: Uint8Array,
  instance: CheckingInstance,
): CatalogueCheck {
  const read = readCatalogueFile(bytes);
  if (!read.ok) return read;

  const offered: Template[] = [];
  const hidden: HiddenTemplate[] = [];
  for (const entry of read.entries) {
    const result = checkTemplate(entry, instance);
    if (result.ok) offered.push(result.template);
    else hidden.push({ id: entry.id, reason: result.reason });
  }
  return { ok: true, offered, hidden };
}

type TemplateResult =
  { ok: true; template: Template } | { ok: false; reason: string };

/** One template, from its folder name to the last template rule. */
function checkTemplate(
  entry: CatalogueEntry,
  instance: CheckingInstance,
): TemplateResult {
  const { id, revision, files } = entry;
  if (!CONFIG_NAME_REGEX.test(id)) {
    return {
      ok: false,
      reason: `the folder name ${JSON.stringify(id)} is not a Config name: use lowercase letters, digits and hyphens, starting with a letter, at most 63 characters`,
    };
  }

  const text = files as Readonly<Record<string, string>>;
  const templateYaml = textOf(text, 'template');
  const cloudgateYaml = textOf(text, 'cloudgate');
  const composeYaml = textOf(text, 'docker-compose');
  if (!templateYaml) return { ok: false, reason: 'has no template.yaml' };
  if (!cloudgateYaml) return { ok: false, reason: 'has no cloudgate.yaml' };

  const yaml = readTemplateYaml(
    templateYaml.content,
    instance.cloudgateVersion,
  );
  if (!yaml.ok) return { ok: false, reason: yaml.reason };

  const config = parseProjectConfig(cloudgateYaml.content);
  if (!config.ok) {
    return {
      ok: false,
      reason: `${cloudgateYaml.path}: ${config.refusal.message}`,
    };
  }

  let compose: ComposeFile | null = null;
  if (composeYaml) {
    const read = readComposeFile(composeYaml.content);
    if (!read.ok) {
      return { ok: false, reason: `${composeYaml.path} ${read.reason}` };
    }
    compose = read.file;
  }

  const logo = readLogo(files);
  if (!logo.ok) return { ok: false, reason: logo.reason };

  const template: Template = {
    ...yaml.template,
    id,
    revision,
    config: config.config,
    configText: cloudgateYaml.content,
    composeFile: composeYaml?.content ?? null,
    configFiles: Object.fromEntries(
      Object.entries(text)
        .filter(([path]) => path.startsWith(CONFIG_FILES))
        .map(([path, content]) => [path.slice(CONFIG_FILES.length), content]),
    ),
    logo: logo.logo,
  };
  const reading = { template, compose };
  for (const rule of TEMPLATE_RULES) {
    const reason = rule(reading);
    if (reason) return { ok: false, reason };
  }
  return { ok: true, template };
}

/**
 * One of the folder's YAML files under whichever spelling it has
 * (ADR-0090); null when it has neither. Which other files a folder may hold,
 * that each is text, and that none is there under both spellings, is the
 * catalogue's own check (`readCatalogueFile`), which refuses the whole zip
 * over them (ADR-0072), so a folder reaching here holds one spelling at most.
 */
function textOf(
  files: Readonly<Record<string, string>>,
  name: FolderYaml,
): { readonly path: string; readonly content: string } | null {
  const found = folderFile(files, name);
  if (found && 'both' in found) {
    throw new Error(`${found.both.join(' and ')} reached the template check`);
  }
  return found;
}

/** The compose file, as far as the rules read it: a map of services. */
function readComposeFile(
  source: string,
): { ok: true; file: ComposeFile } | { ok: false; reason: string } {
  let document: unknown;
  try {
    document = parse(source, { logLevel: 'error', maxAliasCount: 100 });
  } catch (error) {
    if (!(error instanceof YAMLParseError)) throw error;
    return {
      ok: false,
      reason: `is not valid YAML: ${error.message.split('\n')[0]}`,
    };
  }
  const services = isMap(document) ? document.services : undefined;
  if (!isMap(services) || !Object.values(services).every(isMap)) {
    return { ok: false, reason: 'must have services, each a map' };
  }
  return {
    ok: true,
    file: {
      services: services as ComposeFile['services'],
      variables: composeVariables(document),
    },
  };
}

function isMap(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
