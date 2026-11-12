import type { InferenceRuntime } from '../ai-models/ai-model.schema';
import type { Application } from '../applications/application.schema';
import type { ServiceMount } from '../docker/docker.types';
import type { Environment } from '../environments/environment.schema';
import type { Port } from '../networking/ports/port.schema';
import type { Bitbucket } from '../git-providers/strategies/bitbucket/bitbucket.schema';
import type { Gitea } from '../git-providers/strategies/gitea/gitea.schema';
import type { Github } from '../git-providers/strategies/github/github.schema';
import type { Gitlab } from '../git-providers/strategies/gitlab/gitlab.schema';
import type { Project } from '../projects/project.schema';
import type { Registry } from '../registries/registry.schema';
import type { SshKey } from '../ssh-keys/ssh-key.schema';

/**
 * An application row loaded with the relations the deploy engine consumes.
 * Registry rows must carry decrypted credentials
 * (RegistriesService.findOneWithCredentials), unlike the sanitized rows
 * ApplicationsService.findOne returns.
 *
 * **Every field here is an inferred row type, or its query is projected to the
 * fields it declares — and that is the invariant, not an observation.**
 * `ApplicationsService.findDeployable` loads most of these as whole rows, which
 * is safe only because `typeof table.$inferSelect` is generated from the table
 * and so cannot be narrower than the row it is handed. `mounts` is the one
 * hand-written declaration in the set, and when it was fed whole rows the
 * `encryptedText` body of a file mount rode along into `rollback.full_context`
 * and out over HTTP with this type still saying it could not be there.
 * TypeScript will not catch the next one: a wider *variable* assigned
 * into a narrower field compiles clean, and only an inline literal trips
 * `TS2353`. So `test/coding-standards/deployable-query-result-types.spec.ts` is
 * what holds this type and its loader to each other, over every field of both
 * this and `DeployableCompose`.
 *
 * `registry`, `buildRegistry` and `customGitSSHKey` deliberately declare their
 * `encryptedText` column, as do the four git-provider rows and the environment
 * and project `env` — a build clones over a private key, pushes with a registry
 * password and runs with an env file. They need no exemption from the rule
 * above, because the rule is *"the type says what it gets"* rather than *"no
 * secret reaches the engine"*; declaring the column is what satisfies it.
 */
export type DeployableApplication = Application & {
  environment: Environment & { project: Project };
  github?: Github | null;
  gitlab?: Gitlab | null;
  gitea?: Gitea | null;
  bitbucket?: Bitbucket | null;
  registry?: Registry | null;
  buildRegistry?: Registry | null;
  customGitSSHKey?: SshKey | null;
  /**
   * Mount rows arrive with Phase 33; the service spec already honors them.
   * The one field on this type that is not an inferred row — `ServiceMount` is the
   * deploy engine's *input* shape, declared in `docker/docker.types.ts` — so
   * it is the one whose query has to be projected to it.
   */
  mounts?: ServiceMount[] | null;
  /** Published-port rows feeding the EndpointSpec fallback (Phase 32). */
  ports?: Port[] | null;
  /**
   * An AI model's facet, `null` on a plain Application: what puts the
   * service on `cloudgate-ai` alone, injects its runtime's env, and has the
   * deploy pull its model. Projected to these three, so the upstream secret
   * never reaches the engine or a rollback's stored context.
   */
  aiModel?: DeployableAiModel | null;
};

/** The facet columns a deploy reads, and only those. */
export interface DeployableAiModel {
  runtime: InferenceRuntime;
  model: string;
  imageTag: string | null;
}

// The clone dispatch (and its CloneSource shape) moved to git-providers in
// Phase 46 so patch repos share it; re-exported for existing importers.
export type { CloneSource } from '../git-providers/source-clone.service';
