import type { Template } from './template-check';
import type { TemplateReading } from './template-rules';

/**
 * Each Domain in `template.yaml` names a service in the compose file
 * (spec #1356). An own `web` is never listed: it gets the generated Domain a
 * plan-created `web` already gets, so listing it would ask setup for a second
 * one nothing routes.
 */
export function domainsRule({
  template,
  compose,
}: TemplateReading): string | null {
  for (const [at, { service }] of template.domains.entries()) {
    if (compose?.services[service] !== undefined) continue;
    const entry = template.config.services[service];
    const problem =
      entry?.kind === 'web' && entry.managed !== 'console'
        ? `${service}, an own web, which gets its generated Domain without being listed; domains lists only compose services`
        : compose === null
          ? `${service}, but there is no docker-compose.yml`
          : `${service}, which is not a service in docker-compose.yml`;
    return `template.yaml: domains.${at} names ${problem}`;
  }
  return null;
}

/**
 * How many Domains each name a `{{domains.<name>.…}}` reference may use has
 * (ADR-0064): each compose service listed in `domains`, once per listing, and
 * each own `web`, which gets the one generated Domain a plan-created `web`
 * gets. Only `web` counts: a `web-private` or a `worker` gets no Domain.
 *
 * A name with two Domains names neither, so a reference to it is refused
 * rather than guessed at; the ADR leaves `<name>` meaning one Domain and a
 * compose service may have several (a site and its admin on another port).
 */
export function domainCounts(template: Template): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const { service } of template.domains) {
    counts.set(service, (counts.get(service) ?? 0) + 1);
  }
  for (const [name, entry] of Object.entries(template.config.services)) {
    if (entry.kind === 'web' && entry.managed !== 'console') {
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  return counts;
}
