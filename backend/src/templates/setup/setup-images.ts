import { parse } from 'yaml';

import type { Template } from '../check';

/**
 * Every image a Template's parts run, as written, each once: its compose
 * file's services' and its `docker`-sourced entries'. The setup form reads
 * them so it can say, before Set up, that one will not start on the host
 * picked (#104: MongoDB 8 on a kernel from 6.19 to 7.0.13).
 *
 * Only the images and not a verdict: which image is MongoDB 8 is the
 * console's question (`mongo-kernel.ts`), asked of the image field the
 * database create form also has, so the rule is written once.
 *
 * A database entry (`kind: postgres`) is not here: it runs its engine's own
 * image. The Template check has already refused a compose file that is not
 * a map of services and an image that is not tagged text, so nothing is
 * re-validated; a value that is not text is skipped rather than thrown on.
 */
export function templateImages(template: Template): string[] {
  const images = new Set<string>();
  if (template.composeFile !== null) {
    const document: unknown = parse(template.composeFile, {
      logLevel: 'error',
      maxAliasCount: 100,
    });
    const services = isMap(document) ? document.services : undefined;
    for (const service of Object.values(isMap(services) ? services : {})) {
      if (isMap(service) && typeof service.image === 'string') {
        images.add(service.image);
      }
    }
  }
  for (const entry of Object.values(template.config.services)) {
    if (!('source' in entry)) continue;
    if (entry.source?.sourceType === 'docker') {
      images.add(entry.source.dockerImage);
    }
  }
  return [...images];
}

function isMap(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
