import type { ComposeVariables } from './compose-variables';
import type { Template } from './template-check';
import { domainsRule } from './template-domains';
import { filesRule } from './template-files';
import {
  composeOutputRule,
  inputNamesRule,
  inputReferencesRule,
} from './template-inputs';

/**
 * A template's compose file, read as far as the rules need it: its services
 * by name, each as written, and the variables it interpolates.
 */
export interface ComposeFile {
  readonly services: Readonly<
    Record<string, Readonly<Record<string, unknown>>>
  >;
  readonly variables: ComposeVariables;
}

/** Everything a rule may look at: the template, and its compose file read. */
export interface TemplateReading {
  readonly template: Template;
  /** Null when the template has no compose part. */
  readonly compose: ComposeFile | null;
}

/**
 * One rule across a whole template, once every file in it has been read:
 * the reason the template is hidden, or null when it holds.
 */
export type TemplateRule = (reading: TemplateReading) => string | null;

/**
 * Every rule a read template must pass, in the order they are reported, each
 * seeing the same {@link TemplateReading}. The order is what a reason may
 * lean on: Domains are checked before the references that point at them, a
 * compose part needing an Output before it is reported as a missing input
 * rule (which no rule could fill), and inputs before the config file text
 * that may refer to them.
 */
export const TEMPLATE_RULES: readonly TemplateRule[] = [
  composePartRule,
  imageTagRule,
  domainsRule,
  composeOutputRule,
  inputNamesRule,
  inputReferencesRule,
  filesRule,
];

/**
 * The compose part is written as it will be after setup,
 * `{ kind: compose, managed: console }`, beside its file at the one fixed name
 * `docker-compose.yml`; `template.yaml`'s `compose` names it. It is the only
 * console-managed entry a template may have, since a Plan creates a
 * console-managed Service only from a Pending setup's stack (ADR-0065).
 */
function composePartRule({
  template,
  compose,
}: TemplateReading): string | null {
  const { services } = template.config;
  for (const [name, entry] of Object.entries(services)) {
    if (name === template.compose) continue;
    if (entry.managed === 'console') {
      return `cloudgate.yaml: ${name} is console-managed; a template's only console-managed entry is its compose part, named by compose in template.yaml`;
    }
    if (entry.kind === 'compose') {
      return `cloudgate.yaml: ${name} names a repository's compose file; a template's compose part is written { kind: compose, managed: console }, with its file beside it as docker-compose.yml`;
    }
  }
  if (template.compose === undefined) {
    if (compose !== null) {
      return 'docker-compose.yml is here, but template.yaml names no compose entry';
    }
    if (template.size !== undefined) {
      return "template.yaml: size is the compose part's minimum size, but there is no compose entry";
    }
    return null;
  }
  const entry = services[template.compose];
  if (entry?.kind !== 'compose' || entry.managed !== 'console') {
    return `template.yaml: compose names ${template.compose}, which cloudgate.yaml must list as { kind: compose, managed: console }`;
  }
  if (compose === null) {
    return `template.yaml: compose names ${template.compose}, but there is no docker-compose.yml`;
  }
  return null;
}

/**
 * Every image names a version tag (ADR-0062): `latest`, no tag, or a tag
 * that comes from a variable would let the app's version drift under the
 * people who set it up. A digest is not required, and alone is not a tag.
 */
function imageTagRule({ template, compose }: TemplateReading): string | null {
  for (const [name, service] of Object.entries(compose?.services ?? {})) {
    const image = service.image;
    if (image === undefined) continue;
    const problem =
      typeof image === 'string' ? imageTagProblem(image) : 'must be text';
    if (problem) {
      return `docker-compose.yml: ${name}'s image ${problem}`;
    }
  }
  for (const [name, entry] of Object.entries(template.config.services)) {
    if (entry.managed === 'console' || !('source' in entry)) continue;
    if (entry.source?.sourceType !== 'docker') continue;
    const problem = imageTagProblem(entry.source.dockerImage);
    if (problem) return `cloudgate.yaml: ${name}'s image ${problem}`;
  }
  return null;
}

function imageTagProblem(image: string): string | null {
  if (image.includes('$')) {
    return `${image} is named through a variable; write its version tag in the file`;
  }
  const named = image.split('@')[0];
  const lastPart = named.slice(named.lastIndexOf('/') + 1);
  const colon = lastPart.indexOf(':');
  if (colon === -1) {
    return `${image} has no tag; name the version it runs, e.g. ${named}:1.2`;
  }
  if (lastPart.slice(colon + 1) === 'latest') {
    return `${image} is tagged latest; name the version it runs instead`;
  }
  return null;
}
