import type { Environment } from '../environments/environment.schema';
import type { Bitbucket } from '../git-providers/strategies/bitbucket/bitbucket.schema';
import type { Gitea } from '../git-providers/strategies/gitea/gitea.schema';
import type { Github } from '../git-providers/strategies/github/github.schema';
import type { Gitlab } from '../git-providers/strategies/gitlab/gitlab.schema';
import type { Project } from '../projects/project.schema';
import type { SshKey } from '../ssh-keys/ssh-key.schema';
import type { TraefikDomain } from '../traefik/config/types';
import type { Compose } from './compose.schema';

// The compose specification, trimmed from the generated compose-spec
// JSON-Schema types to the fields cloudgate touches: everything else flows
// through the open index signatures untouched.

/** Service labels: compose accepts both list (`k=v`) and map form. */
export type ComposeLabels = string[] | Record<string, string | number | null>;

/** Service networks: list of names or map of name → per-service config. */
export type ComposeServiceNetworks =
  string[] | Record<string, Record<string, unknown> | null>;

export interface ComposeDeploySpec {
  labels?: ComposeLabels;
  [k: string]: unknown;
}

/** Compose's logging block: `json-file` driver plus its two options. */
export interface ComposeLoggingSpec {
  driver?: string;
  options?: Record<string, string | number | null>;
  [k: string]: unknown;
}

export interface ComposeServiceSpec {
  image?: string;
  labels?: ComposeLabels;
  /** Swarm mode (`docker stack deploy`) reads labels from deploy.labels. */
  deploy?: ComposeDeploySpec;
  networks?: ComposeServiceNetworks;
  /**
   * Compose's own restart policy. Cloudgate defaults it when the author left it
   * out; a value the author wrote is never overwritten. Declared
   * `string` for the value Cloudgate writes — an author's explicit
   * `restart: false` parses as a boolean and flows through the index signature
   * untouched, which is exactly what the precedence rule requires.
   */
  restart?: string;
  /**
   * The retention ceiling on this service's containers. Cloudgate defaults it
   * when the author's file is silent and never merges into one the
   * author wrote, so a declared block survives whole.
   */
  logging?: ComposeLoggingSpec;
  [k: string]: unknown;
}

export interface ComposeNetworkSpec {
  external?: boolean;
  driver?: string;
  attachable?: boolean;
  [k: string]: unknown;
}

export interface ComposeSpecification {
  version?: string;
  name?: string;
  services?: Record<string, ComposeServiceSpec>;
  networks?: Record<string, ComposeNetworkSpec | null>;
  volumes?: Record<string, unknown>;
  [k: string]: unknown;
}

/**
 * A domain routed into a compose service: phase 19's plain Traefik domain
 * input plus the compose service it attaches to. Phase 30's domains table
 * will feed its rows through this shape.
 */
export type ComposeDomain = TraefikDomain & { serviceName: string };

/** The compose columns domain injection and command building read. */
export type ComposeSpecSource = Pick<
  Compose,
  'appName' | 'composeType' | 'isolatedDeployment'
>;

/**
 * The compose row slice the deploy-command builders read, with the parent
 * environment/project env for `${{project.X}}`/`${{environment.X}}`
 * interpolation.
 *
 * `serverId` joined the slice later, and it is not a machine to dispatch to
 * — the callers already hold that — but the machine whose *root* the project
 * tree is under. `composeDirectoryOn` carries why a stack has one answer where
 * an Application has two.
 */
export type DeployableComposeSource = ComposeSpecSource &
  Pick<Compose, 'sourceType' | 'composePath' | 'command' | 'env' | 'serverId'> &
  // Where a stack in a Cloud account runs (`stackRootId`); optional only
  // for a builder's narrow test slice.
  Partial<Pick<Compose, 'composeId' | 'cloudAccountId'>> & {
    environment: { env: string | null; project: { env: string | null } };
  };

/**
 * A compose row loaded with the relations the deploy path consumes
 * (git-provider rows with decrypted credentials).
 */
export type DeployableCompose = Compose & {
  environment: Environment & { project: Project };
  github?: Github | null;
  gitlab?: Gitlab | null;
  gitea?: Gitea | null;
  bitbucket?: Bitbucket | null;
  customGitSSHKey?: SshKey | null;
};
