import { hostSchema } from '../../domains/dto/domain.dto';
import type { TemplateDomain } from '../../project-config';
import type { Template } from '../check';

/** One compose Domain a setup gives a host, under the name its host goes by. */
export interface SetupDomain {
  /**
   * The key of its host in a setup's `hosts`: the compose service it routes
   * to, which is the `{{domains.<name>}}` a value or a file refers to it by.
   * A service with two Domains is `<service>#1`, `<service>#2` in the order
   * `template.yaml` lists them: the Template check refuses a reference to
   * such a service, so no value needs its plain name.
   */
  readonly name: string;
  readonly service: string;
  readonly port: number;
  readonly path: string;
}

/** The compose Domains a template's setup picks a host for, in its order. */
export function setupDomains(template: Template): SetupDomain[] {
  const count = new Map<string, number>();
  for (const { service } of template.domains) {
    count.set(service, (count.get(service) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  return template.domains.map(({ service, port, path }) => {
    const at = (seen.get(service) ?? 0) + 1;
    seen.set(service, at);
    return {
      name: count.get(service) === 1 ? service : `${service}#${at}`,
      service,
      port,
      path,
    };
  });
}

/**
 * The name a compose Domain's generated host is made from: the setup form
 * offers `<this>-<hash>-<address>.sslip.io`, and setup asks whether the
 * host it is given is still that one (#1411).
 */
export function generatedHostName(
  template: Template,
  domain: SetupDomain,
): string {
  return `${template.id}-${domain.service}`;
}

/**
 * Whether a Template's compose Domain is served over HTTPS, which is also
 * whether `{{domains.<name>.url}}` is `https://`. The host the setup form
 * generated is plain HTTP, as a plan-made `web`'s generated Domain and a
 * console Domain on a generated host are (`https` starts off there); a host
 * the user typed takes a Let's Encrypt certificate, an `*.sslip.io` one
 * included, as an Application Domain on one does (#1411). In a Cloud
 * Environment every Domain is HTTPS: the load balancer holds its
 * certificate (ADR-0070).
 *
 * Rejected: HTTPS on every host, which made a compose part's generated host
 * the one generated host served otherwise than a web's of the same setup;
 * plain HTTP on every host, which would serve a typed domain unencrypted;
 * and plain HTTP on every `*.sslip.io` host, which took a typed one for a
 * generated one (#1411).
 */
export function templateDomainHttps(where: {
  readonly cloud: boolean;
  readonly generated: boolean;
}): boolean {
  return where.cloud || !where.generated;
}

/**
 * Whether an Apply serves a Template's compose Domain over HTTPS: as setup
 * decided, so the Domain agrees with the URL its values were filled with.
 * A Pending setup saved before setup recorded it (#1411) was filled in by
 * the rule of then, every `*.sslip.io` host plain HTTP, so it keeps it.
 */
export function appliedDomainHttps(domain: TemplateDomain): boolean {
  return domain.https ?? !domain.host.endsWith('.sslip.io');
}

export type PickedHosts =
  | { readonly ok: true; readonly domains: readonly TemplateDomain[] }
  | { readonly ok: false; readonly reason: string };

/**
 * Each compose Domain on the host a setup was given for it: every one needs
 * one, and each must be a hostname a Domain can hold (`hostSchema`, the rule
 * every Domain create applies), so a bad one is refused at setup rather
 * than at Apply. Whether a host is taken is asked by the caller.
 */
export function pickedHosts(
  domains: readonly SetupDomain[],
  hosts: Readonly<Record<string, string>>,
): PickedHosts {
  const picked: TemplateDomain[] = [];
  for (const domain of domains) {
    const given = hosts[domain.name];
    if (given === undefined || given.trim() === '') {
      return {
        ok: false,
        reason: `The Domain of ${domain.service} on port ${domain.port} needs a host`,
      };
    }
    const host = hostSchema.safeParse(given);
    if (!host.success) {
      return {
        ok: false,
        reason: `The host ${JSON.stringify(given)} of ${domain.service}'s Domain: ${host.error.issues[0].message}`,
      };
    }
    picked.push({
      service: domain.service,
      port: domain.port,
      path: domain.path,
      host: host.data,
    });
  }
  return { ok: true, domains: picked };
}
