import {
  CLOUD_NAMES,
  cloudOrLegacy,
} from '../../cloud-accounts/cloud-provider';
import type { CloudKind } from '../../cloud-accounts/cloud-account.schema';
import { kindsOn } from '../../project-config';
import type { DeployTarget } from '../../project-config';
import { referencesIn } from '../check';
import type { Template } from '../check';

/**
 * Whether an Environment can take a Template, and if not, why: worked out
 * from the plan's own per-cloud kind table (`kindsOn`), never from anything
 * the template declares (spec #1356, ADR-0063 as amended by ADR-0070), and
 * from whether each own `web` whose URL a value names gets a generated host
 * there (ADR-0064). `null` when it can.
 */
export function environmentRefusal(
  template: Template,
  target: DeployTarget,
  place: {
    readonly cloud: CloudKind | null;
    readonly hosted: boolean;
    /** Whether the platform host has a public address for a generated host. */
    readonly platformHostGeneratesHosts: boolean;
  },
): string | null {
  if (target.kind === 'platform-host' && place.hosted) {
    // ADR-0053: an Apply there would be refused, so the setup is too.
    return 'Its Deploy target is the platform host, which runs no Services on the Hosted instance';
  }
  // ADR-0064: a value naming an own web's URL is filled in at setup, so
  // that web must get a generated host here, or the app starts with none.
  const [named] = ownWebsNamed(template);
  const filledIn = `Its web ${named}'s URL is filled in at setup on a generated host`;
  if (target.kind === 'platform-host') {
    return named !== undefined && !place.platformHostGeneratesHosts
      ? `${filledIn}, and the platform host has no public address to carry in one: set it in Settings → Instance`
      : null;
  }
  if (target.kind !== 'cloud') return null;
  // A compose part runs on its own Stack VM there (ADR-0070, #1379):
  // `compose` is a kind every cloud makes, so the table answers for it.
  const cloud = cloudOrLegacy(place.cloud);
  const made: ReadonlySet<string> = kindsOn(cloud);
  for (const [part, entry] of Object.entries(template.config.services)) {
    if (!made.has(entry.kind)) {
      return `Its ${part} is a ${entry.kind}, which ${CLOUD_NAMES[cloud]} does not run`;
    }
  }
  if (named !== undefined) {
    return `${filledIn}, and a web in a Cloud Environment gets no generated host`;
  }
  // An own part's file is a file mount, and a cloud Service runs in no
  // container Cloudgate mounts into (`refuseMountsInCloud`). The compose
  // part's files are its Stack VM's, written there as on a Server.
  const mounted = template.files.find((file) => file.entry !== undefined);
  if (mounted?.entry !== undefined) {
    return `It ships a config file for ${mounted.entry}, and a Service in a Cloud account has no container to mount it in`;
  }
  return null;
}

/**
 * The own `web` parts, by the template's own name for them, whose URL or
 * host a value or a config file refers to (`{{domains.<web>.url}}`): each
 * gets its generated host at setup (ADR-0064). A `{{domains.<name>}}`
 * naming a compose service is the compose part's, and not here.
 */
export function ownWebsNamed(template: Template): string[] {
  const texts = [
    ...Object.values(template.inputs).flatMap((rule) =>
      'value' in rule ? [rule.value] : [],
    ),
    ...Object.values(template.configFiles),
  ];
  const named = new Set<string>();
  for (const text of texts) {
    for (const { reference } of referencesIn(text)) {
      if (reference?.kind !== 'domain') continue;
      const entry = template.config.services[reference.name];
      if (entry?.kind === 'web' && entry.managed !== 'console') {
        named.add(reference.name);
      }
    }
  }
  return [...named];
}

/**
 * Whether a new Project's `production` Environment can take a Template on
 * each kind of Deploy target, and if not, why (#1376): the setup form greys
 * out the targets it lists with a reason. {@link environmentRefusal} on a
 * stand-in target of each kind, so the two never disagree.
 */
export interface DeployTargetRefusals {
  readonly server: string | null;
  readonly platformHost: string | null;
  readonly aws: string | null;
  readonly gcp: string | null;
}

export function deployTargetRefusals(
  template: Template,
  place: {
    readonly hosted: boolean;
    readonly platformHostGeneratesHosts: boolean;
  },
): DeployTargetRefusals {
  const onHost = (target: DeployTarget) =>
    environmentRefusal(template, target, { cloud: null, ...place });
  const onCloud = (cloud: CloudKind) =>
    environmentRefusal(
      template,
      { kind: 'cloud', cloudAccountId: '', region: '' },
      { cloud, ...place },
    );
  return {
    server: onHost({ kind: 'server', serverId: '' }),
    platformHost: onHost({ kind: 'platform-host' }),
    aws: onCloud('aws'),
    gcp: onCloud('gcp'),
  };
}
