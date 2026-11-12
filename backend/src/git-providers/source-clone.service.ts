import { Injectable } from '@nestjs/common';
import type { Application } from '../applications/application.schema';
import { getGitProviderStrategy } from './git-provider.strategy';
import type { SourceProgram } from './source-program';
import type { Bitbucket } from './strategies/bitbucket/bitbucket.schema';
import { GiteaService } from './strategies/gitea/gitea.service';
import type { Gitea } from './strategies/gitea/gitea.schema';
import { GithubService } from './strategies/github/github.service';
import type { Github } from './strategies/github/github.schema';
import { GitlabService } from './strategies/gitlab/gitlab.service';
import type { Gitlab } from './strategies/gitlab/gitlab.schema';
import type { SshKey } from '../ssh-keys/ssh-key.schema';
import {
  OutboundAddressGuard,
  outboundAddressRefused,
} from '../outbound/outbound-address-guard';
import type { OutboundScope } from '../outbound/outbound-address-guard';
import type { CheckedDial } from './git-clone-lines';
import { cloneUrlDial } from './git-clone-url';
import {
  BASE_URL_REFUSAL,
  GIT_PROTOCOL_REFUSAL,
  platformHostCloneRefused,
  SUBMODULES_REFUSAL,
} from './platform-host-clone';

/**
 * The source columns the clone dispatch reads — the shape application and
 * compose rows share (Phase 29). Docker-source fields are optional because
 * compose rows don't have them.
 */
export type CloneSource = Pick<
  Application,
  | 'appName'
  | 'sourceType'
  | 'enableSubmodules'
  | 'customGitUrl'
  | 'customGitBranch'
  | 'owner'
  | 'repository'
  | 'branch'
  | 'gitlabOwner'
  | 'gitlabRepository'
  | 'gitlabBranch'
  | 'gitlabPathNamespace'
  | 'giteaOwner'
  | 'giteaRepository'
  | 'giteaBranch'
  | 'bitbucketOwner'
  | 'bitbucketRepository'
  | 'bitbucketBranch'
> & {
  github?: Github | null;
  gitlab?: Gitlab | null;
  gitea?: Gitea | null;
  bitbucket?: Bitbucket | null;
  customGitSSHKey?: SshKey | null;
  dockerImage?: string | null;
  registryUrl?: string | null;
  username?: string | null;
  password?: string | null;
};

/**
 * Where a clone runs and whose it is: the machine (`null` for the platform
 * host) and the Service it fetches the source of.
 */
export interface CloneOn {
  readonly serverId: string | null;
  readonly serviceId: string;
}

/**
 * The sourceType → strategy dispatch, shared by application and compose
 * deploys and the patch-repo clones (extracted from DeploymentEngineService
 * in Phase 46 so patch repos reuse it without a module cycle).
 *
 * **`cloneCommand` became `cloneProgram`, and the string return it
 * gave up was the obstacle three tickets recorded.** One named it as the
 * reason the registry login could not take the environment; another measured
 * its other three obstacles away and left this one standing, because a build's
 * environment *originates* in `DeploymentEngineService.buildProgram` while a
 * pull credential originates here, four call frames down inside a strategy. Now
 * the value comes back with the command — see {@link SourceProgram} for what
 * that buys and for the four providers it deliberately does not cover.
 *
 * The blast radius was the three call sites the ticket predicted, and the
 * rename is what made them three rather than "the ones somebody remembered":
 * `DeploymentEngineService.deploy` and `deployCompose`, and
 * `PatchRepoService.ensureRepo`. The last of those never receives an
 * environment and cannot — `CLONABLE_SOURCE_TYPES` excludes `docker`, the only
 * source type that fills one — so it reads `.command` and says so at its own
 * site rather than plumbing an environment through `execOnServer` for a branch
 * that is unreachable.
 */
@Injectable()
export class SourceCloneService {
  constructor(
    private readonly githubService: GithubService,
    private readonly gitlabService: GitlabService,
    private readonly giteaService: GiteaService,
    private readonly guard: OutboundAddressGuard,
  ) {}

  /**
   * The address a clone on the platform host must dial for `url`, or `null`
   * when it is not held to one: on a customer's own Server, which dials from
   * their machine onto their network, and for a dial acting for the instance
   * organization, exempt as every guarded dial is (ADR-0013). Throws
   * `OutboundAddressGuard`'s 400, naming the field the host was set in, for a
   * host that is loopback, a private or link-local range or the metadata
   * address, and for a URL whose host {@link cloneUrlDial} cannot read for
   * certain.
   *
   * **The check used to stop at the name, and the shell `git` then dialled
   * whatever it liked.** It looked the host up and threw the address away, so
   * three things got past it: a URL WHATWG and curl read different hosts out
   * of (`http://example.com\@127.0.0.1/`), a redirect from a checked server to
   * an unchecked one, and a name whose records changed between the check and
   * git's own lookup. With the clone's output in the Deployment log, each was a
   * port scan of the platform host's network. Now {@link cloneUrlDial} refuses
   * the first, and the address comes back for the strategy to pin — curl's
   * resolve entry and no redirects for http(s), ssh's `HostName` for ssh — so
   * git makes no lookup of its own. `git://` has no such option and is
   * refused; `baseUrl` is a Gitea or GitLab connection's, which the strategy
   * splices a token in front of, so it must be http(s) with no user of its own.
   */
  private async dialFor(
    on: CloneOn,
    url: string | null | undefined,
    scope: OutboundScope,
    { baseUrl = false }: { baseUrl?: boolean } = {},
  ): Promise<CheckedDial | null> {
    if (on.serverId !== null || !url) return null;
    if (await this.actsForInstance(scope)) return null;
    const dial = cloneUrlDial(url);
    if (dial === null) throw outboundAddressRefused(scope.field);
    if (baseUrl && (dial.transport !== 'http' || url.includes('@'))) {
      throw platformHostCloneRefused(scope.field, BASE_URL_REFUSAL);
    }
    if (dial.transport === 'git') {
      throw platformHostCloneRefused(scope.field, GIT_PROTOCOL_REFUSAL);
    }
    const address = await this.guard.addressToDial(dial.host, scope);
    return { ...dial, address };
  }

  /**
   * Refuses submodules for a clone on the platform host that is not the
   * instance organization's: `--recurse-submodules` has git dial every URL in
   * the repository's `.gitmodules`, which no check sees, GitHub's and
   * Bitbucket's repositories included. Checking and pinning each one would
   * mean cloning, reading `.gitmodules`, checking every host and running
   * `git submodule update` once per submodule with its own pin — a second clone
   * program for a setting few cloud Services use, so the refusal is the
   * simpler correct answer, and a Server of their own clones them as before.
   */
  private async refuseSubmodules(
    on: CloneOn,
    application: CloneSource,
  ): Promise<void> {
    if (on.serverId !== null || !application.enableSubmodules) return;
    const scope: OutboundScope = {
      place: { serviceId: on.serviceId },
      field: 'enableSubmodules',
    };
    if (await this.actsForInstance(scope)) return;
    throw platformHostCloneRefused(scope.field, SUBMODULES_REFUSAL);
  }

  /** Whether a dial for `scope` is the instance organization's (ADR-0013). */
  private actsForInstance(scope: OutboundScope): Promise<boolean> {
    return this.guard.actsForInstance(scope);
  }

  async cloneProgram(
    application: CloneSource,
    outputPath: string,
    options: {
      /**
       * The platform a ready-made image is pulled for: a Service on Cloud
       * Run takes `linux/amd64` on any host. Unset, the
       * host's own.
       */
      readonly platform?: string;
      /** Where the clone runs, which decides whether its host is checked. */
      readonly on: CloneOn;
    },
  ): Promise<SourceProgram> {
    const { on } = options;
    const strategy = getGitProviderStrategy(application.sourceType);

    switch (application.sourceType) {
      // A `drop` needs no inputs but the path: the archive was extracted into
      // it at upload time, so there is nothing to fetch and nothing to
      // decrypt — see `strategies/drop.strategy.ts` for why the arm exists at
      // all and what it guards. Before `cloneProgram` this fell through to `default:`,
      // which is what made a `drop` Application undeployable.
      //
      // `raw` deliberately stays in `default:` beside it, even though it now
      // has a registered strategy too: a raw compose stack's content is the
      // *converted* file `deployCompose` computes and this dispatch cannot
      // see, so an arm here would write an empty `docker-compose.yml` where
      // the raise says the truth.
      case 'drop':
        return strategy.cloneProgram({ outputPath });
      case 'git': {
        await this.refuseSubmodules(on, application);
        const dial = await this.dialFor(on, application.customGitUrl, {
          place: { serviceId: on.serviceId },
          field: 'customGitUrl',
        });
        return strategy.cloneProgram({
          outputPath,
          url: application.customGitUrl,
          branch: application.customGitBranch,
          sshKey: application.customGitSSHKey,
          enableSubmodules: application.enableSubmodules,
          dial,
        });
      }
      case 'docker':
        return strategy.cloneProgram({
          outputPath,
          dockerImage: application.dockerImage,
          registryUrl: application.registryUrl,
          username: application.username,
          password: application.password,
          platform: options.platform ?? null,
        });
      case 'github': {
        await this.refuseSubmodules(on, application);
        if (!application.github) {
          throw new Error(
            `Application "${application.appName}" has no GitHub provider linked`,
          );
        }
        const githubToken = await this.githubService.getGithubToken(
          application.github,
        );
        return strategy.cloneProgram({
          outputPath,
          owner: application.owner,
          repository: application.repository,
          branch: application.branch,
          githubToken,
          enableSubmodules: application.enableSubmodules,
        });
      }
      case 'gitlab': {
        await this.refuseSubmodules(on, application);
        if (!application.gitlab) {
          throw new Error(
            `Application "${application.appName}" has no GitLab provider linked`,
          );
        }
        const fresh = await this.gitlabService.refreshToken(application.gitlab);
        const dial = await this.dialFor(
          on,
          fresh.gitlabUrl,
          {
            place: { gitProviderId: application.gitlab.gitProviderId },
            field: 'gitlabUrl',
          },
          { baseUrl: true },
        );
        return strategy.cloneProgram({
          outputPath,
          owner: application.gitlabOwner,
          repository: application.gitlabRepository,
          branch: application.gitlabBranch,
          gitlabPathNamespace: application.gitlabPathNamespace,
          gitlabUrl: fresh.gitlabUrl,
          accessToken: fresh.accessToken,
          enableSubmodules: application.enableSubmodules,
          dial,
        });
      }
      case 'gitea': {
        await this.refuseSubmodules(on, application);
        if (!application.gitea) {
          throw new Error(
            `Application "${application.appName}" has no Gitea provider linked`,
          );
        }
        const fresh = await this.giteaService.refreshToken(application.gitea);
        const dial = await this.dialFor(
          on,
          fresh.giteaUrl,
          {
            place: { gitProviderId: application.gitea.gitProviderId },
            field: 'giteaUrl',
          },
          { baseUrl: true },
        );
        return strategy.cloneProgram({
          outputPath,
          owner: application.giteaOwner,
          repository: application.giteaRepository,
          branch: application.giteaBranch,
          giteaUrl: fresh.giteaUrl,
          accessToken: fresh.accessToken,
          enableSubmodules: application.enableSubmodules,
          dial,
        });
      }
      case 'bitbucket': {
        await this.refuseSubmodules(on, application);
        if (!application.bitbucket) {
          throw new Error(
            `Application "${application.appName}" has no Bitbucket provider linked`,
          );
        }
        return strategy.cloneProgram({
          outputPath,
          owner: application.bitbucketOwner,
          repository: application.bitbucketRepository,
          branch: application.bitbucketBranch,
          username: application.bitbucket.bitbucketUsername,
          apiToken: application.bitbucket.apiToken,
          appPassword: application.bitbucket.appPassword,
          enableSubmodules: application.enableSubmodules,
        });
      }
      default:
        throw new Error(
          `Deploying source type "${application.sourceType}" is not supported yet`,
        );
    }
  }
}
