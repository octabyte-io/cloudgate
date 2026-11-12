import {
  serviceDeploymentListSchema,
  serviceDomainListSchema,
  serviceRowSchema,
} from 'api-schemas';
import type { ServiceRow } from 'api-schemas';

import type { ApiClient } from './api-client.js';
import { CliError } from './errors.js';
import { EXIT } from './exit-codes.js';
import type { Target } from './target.js';

/**
 * Where a Service came from (CLI spec: uploaded / git / image). `git` names
 * its provider (`github`, `gitlab`, `bitbucket`, `gitea`, or `git` for a plain
 * URL, which is never repeated: it may carry a credential); `raw` is a Compose
 * file written in Cloudgate itself.
 */
export type ServiceSource =
  | { type: 'uploaded' }
  | { type: 'git'; provider: string; repository: string | null }
  | { type: 'image'; image: string | null }
  | { type: 'raw' };

/** One Service's whole picture, as `status` reports it. */
export interface ServiceStatus {
  /** The row's own state word: `idle | running | done | error | stopped`. */
  state: string | null;
  /** `null` for a kind that has none (a bucket). */
  source: ServiceSource | null;
  /** Each Domain as `host` or `host/path`. */
  domains: string[];
  /** The newest Deployment, `null` when there is none (or the kind has none). */
  latestDeployment: { id: string; status: string; createdAt: string } | null;
}

/**
 * Each Service kind's REST collection, and which of the per-Service reads it
 * has. Only Applications and Compose stacks have a Deployment history of their
 * own; a database or a bucket has no Domains read beside a bucket's.
 */
const KINDS: Record<
  string,
  { route: string; domains: boolean; deployments: boolean }
> = {
  application: { route: 'applications', domains: true, deployments: true },
  compose: { route: 'compose', domains: true, deployments: true },
  bucket: { route: 'buckets', domains: true, deployments: false },
  postgres: { route: 'postgres', domains: false, deployments: false },
  mysql: { route: 'mysql', domains: false, deployments: false },
  mariadb: { route: 'mariadb', domains: false, deployments: false },
  mongo: { route: 'mongo', domains: false, deployments: false },
  redis: { route: 'redis', domains: false, deployments: false },
  libsql: { route: 'libsql', domains: false, deployments: false },
};

/** The overview's word for a kind: `Application`, `Compose stack`, … */
const KIND_LABEL: Record<string, string> = {
  application: 'Application',
  compose: 'Compose stack',
  bucket: 'Bucket',
  postgres: 'Postgres database',
  mysql: 'MySQL database',
  mariadb: 'MariaDB database',
  mongo: 'MongoDB database',
  redis: 'Redis database',
  libsql: 'libSQL database',
};

export function kindLabel(kind: string): string {
  return KIND_LABEL[kind] ?? kind;
}

/** What each command that takes an Application only does to one, and where else to go. */
const APPLICATIONS_ONLY = {
  deploy: { does: 'uploads to', hint: undefined },
  vars: {
    does: 'reaches the variables of',
    hint: 'Change its variables in the console.',
  },
  logs: {
    does: 'reads the Runtime log of',
    hint: 'Its logs are in the console.',
  },
} as const;

/**
 * The refusal (exit 1) of a Service that is not an Application, by
 * `deploy`, `vars` and `logs` alike: `api is a Compose stack; cloudgate
 * deploy uploads to Applications only`. None for an Application.
 */
export function kindRefusal(
  service: Pick<Target['service'], 'configName' | 'kind'>,
  command: keyof typeof APPLICATIONS_ONLY,
): CliError | undefined {
  if (service.kind === 'application') return undefined;
  const label = kindLabel(service.kind);
  const article = /^[aeiou]/i.test(label) ? 'an' : 'a';
  const { does, hint } = APPLICATIONS_ONLY[command];
  return new CliError(
    `${service.configName} is ${article} ${label}; cloudgate ${command} ${does} Applications only`,
    EXIT.failed,
    hint,
  );
}

/**
 * Reads `service`'s state, source, Domains and latest Deployment from its
 * own routes, in the target's Organization (`client` already names it). A
 * read that is refused throws, as every read does; what it reads is reported,
 * never judged.
 */
export async function readServiceStatus(
  client: ApiClient,
  service: Target['service'],
): Promise<ServiceStatus> {
  const kind = KINDS[service.kind];
  if (!kind) {
    return { state: null, source: null, domains: [], latestDeployment: null };
  }
  const base = `/${kind.route}/${encodeURIComponent(service.id)}`;
  const [row, domains, deployments] = await Promise.all([
    client.get(base, serviceRowSchema),
    kind.domains
      ? client.get(`${base}/domains`, serviceDomainListSchema)
      : Promise.resolve([]),
    kind.deployments
      ? client.get(`${base}/deployments`, serviceDeploymentListSchema)
      : Promise.resolve([]),
  ]);
  const latest = deployments[0];
  return {
    state: row.applicationStatus ?? row.composeStatus ?? null,
    source: sourceOf(row, service.kind),
    domains: domains.map(({ host, path }) =>
      path && path !== '/' ? `${host}${path}` : host,
    ),
    latestDeployment: latest
      ? {
          id: latest.deploymentId,
          status: latest.status,
          createdAt: latest.createdAt,
        }
      : null,
  };
}

export function sourceOf(row: ServiceRow, kind: string): ServiceSource | null {
  const repository = (owner?: string | null, name?: string | null) =>
    owner && name ? `${owner}/${name}` : (name ?? null);
  switch (row.sourceType) {
    case 'drop':
      return { type: 'uploaded' };
    case 'docker':
      return { type: 'image', image: row.dockerImage ?? null };
    case 'raw':
      return { type: 'raw' };
    case 'git':
      return { type: 'git', provider: 'git', repository: null };
    case 'github':
      return {
        type: 'git',
        provider: 'github',
        repository: repository(row.owner, row.repository),
      };
    case 'gitlab':
      return {
        type: 'git',
        provider: 'gitlab',
        repository: repository(row.gitlabOwner, row.gitlabRepository),
      };
    case 'gitea':
      return {
        type: 'git',
        provider: 'gitea',
        repository: repository(row.giteaOwner, row.giteaRepository),
      };
    case 'bitbucket':
      return {
        type: 'git',
        provider: 'bitbucket',
        repository: repository(row.bitbucketOwner, row.bitbucketRepository),
      };
  }
  // A database has no source type: it runs the image it names.
  if (kind !== 'bucket' && row.dockerImage) {
    return { type: 'image', image: row.dockerImage };
  }
  return null;
}

/** The Source line: `uploaded files`, `github shop/api`, `image redis:7`. */
export function describeSource(source: ServiceSource | null): string {
  if (!source) return 'none';
  switch (source.type) {
    case 'uploaded':
      return 'uploaded files';
    case 'image':
      return source.image ? `image ${source.image}` : 'image';
    case 'raw':
      return 'Compose file written in Cloudgate';
    case 'git':
      return source.repository
        ? `${source.provider} ${source.repository}`
        : source.provider === 'git'
          ? 'git repository'
          : source.provider;
  }
}
