import path from 'node:path';

import { SHELL_UNSAFE } from '../../common/shell-safe-path';
import { filePathSchema } from '../../mounts/dto/mount.dto';
import type { Template } from './template-check';
import { domainCounts } from './template-domains';
import { referenceProblem } from './template-inputs';
import { referencesIn } from './template-references';
import type { TemplateReading } from './template-rules';

/**
 * `template.yaml`'s `files` against the files under `files/` (spec #1356):
 * every file there is listed once, and every listing names a file there,
 * belongs to an entry, and mounts where that entry needs it.
 *
 * A path is both where the file sits under `files/` and where it lands in the
 * Service's files directory, so it passes the one shared file-path rule
 * (#222, `filePathSchema`) that every mount row passes, not a copy of it.
 * Two more are added here because the check sees the path long before any
 * mount row does: no character `assertShellSafePath` would refuse at Apply,
 * and the path written plainly, so the name a reviewer reads is the name
 * the file lands at.
 */
export function filesRule({ template }: TemplateReading): string | null {
  const listed = new Set<string>();
  for (const [at, file] of template.files.entries()) {
    const problem = configPathProblem(file.path);
    if (problem) return `template.yaml: files.${at}.path ${problem}`;
    if (listed.has(file.path)) {
      return `template.yaml: files lists ${file.path} twice`;
    }
    listed.add(file.path);
    if (template.configFiles[file.path] === undefined) {
      return `template.yaml: files.${at} lists ${file.path}, which is not under files/`;
    }
    const belonging = belongingProblem(template, file);
    if (belonging) return `template.yaml: files.${at}${belonging}`;
  }
  for (const file of Object.keys(template.configFiles)) {
    if (!listed.has(file)) {
      return `files/${file} is not listed in template.yaml's files`;
    }
  }
  return referencesProblem(template);
}

/**
 * Why a config file's path, below `files/`, is not one it may sit at; null
 * when it may. Asked here of each `files` listing, and of each file in a
 * catalogue zip before any template is checked (ADR-0072).
 */
export function configPathProblem(file: string): string | null {
  if (!filePathSchema.safeParse(file).success) {
    return `${file} must stay inside the Service's files directory`;
  }
  if (SHELL_UNSAFE.test(file)) {
    return `${file} must not hold ", \`, $, \\ or a line break`;
  }
  const plain = path.posix.normalize(file);
  return plain === file ? null : `${file} must be written plainly, as ${plain}`;
}

/**
 * Which entry a file belongs to, and whether it mounts as that entry needs:
 * the compose part's own compose file binds `../files/<path>`, so it takes no
 * mount; an own entry's container has nothing else to say where the file goes.
 */
function belongingProblem(
  template: Template,
  file: Template['files'][number],
): string | null {
  const name = file.entry ?? template.compose;
  if (name === undefined) {
    return ' names no entry, and there is no compose part for it to belong to';
  }
  const entry = template.config.services[name];
  if (entry === undefined) {
    return `.entry names ${name}, which cloudgate.yaml does not list`;
  }
  if (name === template.compose) {
    return file.mount === undefined
      ? null
      : ` belongs to the compose part, which takes no mount: its docker-compose.yml binds ../files/${file.path}`;
  }
  if (entry.kind === 'bucket') {
    return ` belongs to ${name}, a bucket, which runs no container to mount it in`;
  }
  if (file.mount === undefined) {
    return ` belongs to ${name}, an own entry, so it needs a mount: where in the container the file goes`;
  }
  if (!file.mount.startsWith('/')) {
    return `.mount must be an absolute path in the container, e.g. /${file.mount}`;
  }
  return null;
}

/**
 * A config file's text uses the same `{{…}}` references as a fixed value,
 * but config files have their own uses for braces (Handlebars, Jinja, Go
 * templates), so only a `{{domains.…}}` reference is held to its Domain;
 * a `{{NAME}}` that names no input, or any other braces, is the file's own
 * text and is left as written. Refusing every unknown `{{…}}`, as a fixed
 * value does, was rejected: it would refuse an app's own template file.
 */
function referencesProblem(template: Template): string | null {
  const domains = domainCounts(template);
  for (const [file, text] of Object.entries(template.configFiles)) {
    for (const { written, reference } of referencesIn(text)) {
      if (reference?.kind !== 'domain') continue;
      const problem = referenceProblem(
        written,
        reference,
        template.inputs,
        domains,
      );
      if (problem) return `files/${file} ${problem}`;
    }
  }
  return null;
}
