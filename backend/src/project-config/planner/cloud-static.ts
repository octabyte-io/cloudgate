import type { CloudKind } from '../../cloud-accounts/cloud-account.schema';
import { byCloud } from '../../cloud-accounts/cloud-provider';
import type { PerCloud } from '../../cloud-accounts/cloud-provider';
import type { StaticEntry } from '../project-config.types';
import type { CloudStaticSite, FieldDiff, PlanNote } from './plan.types';

/**
 * The fields a `static` entry may set that only a container has (the AWS
 * buckets spec "Config format"), in the order the config writes them.
 * On S3 + CloudFront nothing runs, so they are ignored, never refused: one
 * config still deploys to a Server and to AWS. `source`, `publish`,
 * `submodules`, `watch_paths` and `create_env_file` keep their meaning.
 */
export const IGNORED_ON_S3 = [
  'size',
  'command',
  'args',
  'env',
  'build_args',
  'build_secrets',
] as const;

/** The ignored fields a `static` entry sets: stated, or listing anything. */
export function ignoredFieldsOf(entry: StaticEntry): string[] {
  const sets: Record<(typeof IGNORED_ON_S3)[number], boolean> = {
    size: entry.size !== undefined,
    command: entry.command !== undefined,
    args: entry.args !== undefined,
    env:
      entry.env.length > 0 ||
      (entry.links !== undefined && Object.keys(entry.links).length > 0),
    build_args: entry.buildArgs.length > 0,
    build_secrets: entry.buildSecrets.length > 0,
  };
  return IGNORED_ON_S3.filter((field) => sets[field]);
}

/**
 * Where a `static` site is served, by its cloud (ADR-0043): what its note on
 * the ignored fields names. S3 + CloudFront on AWS, a private Cloud
 * Storage bucket behind a Cloud CDN backend bucket on Google Cloud.
 */
const STATIC_PLACES: PerCloud<{
  readonly kind: 'ignored-on-s3' | 'ignored-on-cloud-cdn';
  readonly place: string;
}> = {
  aws: { kind: 'ignored-on-s3', place: 'S3 + CloudFront' },
  gcp: { kind: 'ignored-on-cloud-cdn', place: 'Cloud Storage + Cloud CDN' },
};

/**
 * The one note a `static` site in a Cloud account gets for the
 * container-only fields it sets, naming them all and where it
 * is served; `null` when it sets none.
 */
export function ignoredOnCloud(
  cloud: CloudKind,
  configName: string,
  entry: StaticEntry,
): PlanNote | null {
  const fields = ignoredFieldsOf(entry);
  if (fields.length === 0) return null;
  const { kind, place } = byCloud(cloud, STATIC_PLACES);
  const named = fields.map((field) => `\`${field}\``).join(', ');
  return {
    kind,
    configName,
    fields,
    message: `${configName}: ${named} ${fields.length === 1 ? 'has' : 'have'} no meaning on ${place}, so ${fields.length === 1 ? 'it is' : 'they are'} ignored`,
  };
}

/**
 * What a `static` site's create plans beside its step, by its cloud: nothing
 * more on AWS, where CloudFront's own name answers at once; on Google
 * Cloud (the Google Cloud buckets spec) its cost — nothing fixed,
 * serving charged by use — and that it answers nowhere until a Domain is
 * added, since there is no generated Domain.
 */
export function staticCreateNotes(
  cloud: CloudKind,
  configName: string,
): PlanNote[] {
  return byCloud<PlanNote[]>(cloud, {
    aws: [],
    gcp: [
      {
        kind: 'static-by-use',
        configName,
        message: `${configName}: its Cloud Storage bucket and Cloud CDN backend bucket are $0/month fixed; serving is charged by use (stored files, requests and Cloud CDN traffic). The Environment network already pays for the load balancer`,
      },
      {
        kind: 'static-no-domain',
        configName,
        message: `${configName}: answers nowhere until a Domain is added: a static site on Google Cloud has no address of its own. Add one in the console once its first deploy is done`,
      },
    ],
  });
}

/**
 * A field diff a `static` site on AWS does not plan: one of the
 * container-only fields, or a wired variable (`env.<NAME>`), which nothing
 * on S3 reads.
 */
export function isIgnoredOnS3(diff: FieldDiff): boolean {
  return (
    (IGNORED_ON_S3 as readonly string[]).includes(diff.field) ||
    diff.field.startsWith('env.')
  );
}

/**
 * What a made `static` site's change plans, by its cloud (ADR-0043). On AWS
 * its `spa` is its distribution's, so the change reads AWS with the
 * `spa` it will have. On Google Cloud (the Google Cloud buckets spec) `spa` is
 * the error policy on its host rules in the Environment network, and no
 * config field reaches its own state, so the change reads nothing of the
 * site: its Apply saves it, and a `spa` change runs the network, which
 * clears the cache of the site's Domains at its end, as its note says.
 */
export function staticChangeOf(
  cloud: CloudKind,
  configName: string,
  fields: readonly FieldDiff[],
): { readonly reads: boolean; readonly notes: PlanNote[] } {
  return byCloud(cloud, {
    aws: { reads: true, notes: [] },
    gcp: {
      reads: false,
      notes: fields.some((diff) => diff.field === 'build.spa')
        ? [
            {
              kind: 'static-spa-change',
              configName,
              message: `${configName}: changing \`spa\` is a run of the Environment network, which clears the cache of the site's Domains at its end. Some visitors may see the old behaviour for missing pages for a few minutes, and a missing page cached with the shell can last up to a day`,
            },
          ]
        : [],
    },
  });
}

/** What a `static` site's definition is written from: its `spa`. */
export function cloudStaticSite(entry: StaticEntry): CloudStaticSite {
  return { spa: entry.build?.isStaticSpa ?? false };
}
