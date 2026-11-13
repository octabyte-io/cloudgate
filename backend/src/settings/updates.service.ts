import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import * as semver from 'semver';
import { FETCH_CLIENT } from '../git-providers/fetch.provider';
import type { FetchClient } from '../git-providers/fetch.provider';
import { InstanceMode } from '../instance-mode/instance-mode.service';
import { RemoteExecService } from '../remote/remote-exec.service';
import {
  CLOUDGATE_RESOURCE,
  DockerResourceService,
} from './docker-resource.service';

/** This repository's releases on the GitHub API; each Cloudgate version is one (ADR-0082). */
const RELEASES_URL =
  'https://api.github.com/repos/octabyte-io/cloudgate/releases?per_page=100';

/** The one-command install. Re-running it with `CLOUDGATE_VERSION` is the upgrade. */
const INSTALL_SCRIPT_URL =
  'https://raw.githubusercontent.com/octabyte-io/cloudgate/main/install.sh';

/**
 * A Cloudgate version's tag, `vX.Y.Z` and nothing else. The CLI is released
 * from the same repository as `cli-vX.Y.Z`, and none of those is a Cloudgate
 * version, however high its number.
 */
const CLOUDGATE_VERSION_TAG = /^v\d+\.\d+\.\d+$/;

/**
 * The image `updateServer` moves the swarm service onto. That control predates
 * the native install and still cannot work on one (spec #39 leaves it out of
 * scope); the update check itself no longer asks Docker Hub anything.
 */
const CLOUDGATE_IMAGE = 'cloudgate/cloudgate';

/**
 * The tarball publish-version.yml attaches to a Cloudgate version's release.
 * A release without it is not one yet: made by hand, or still being
 * published, and the install would refuse it (root `install.sh` asks for the
 * same name).
 */
const tarballName = (tag: string): string =>
  `cloudgate-${tag.replace(/^v/, '')}-linux-amd64.tar.gz`;

/**
 * What `POST /settings/update-server` answers on an instance that is not the
 * `cloudgate` Docker service: every install `deploy/install.sh` makes, the
 * Hosted instance's included, runs two systemd units, and there is no service
 * to move. A 409 for `NOT_A_DOCKER_INSTALL_REFUSAL`'s reason: the backend
 * composed it, and the console passes a 409's words through.
 */
export const NOT_UPDATABLE_IN_PLACE_REFUSAL =
  'Cloudgate is not a Docker service on this host, so there is nothing here to update: ' +
  'upgrade it by running the install again with CLOUDGATE_VERSION, the command the update check shows, ' +
  'as the Upgrades section of docs/deploy.md describes';

export interface UpdateData {
  /** The newest Cloudgate version on GitHub Releases, as its tag `vX.Y.Z`. */
  latestVersion: string | null;
  updateAvailable: boolean;
  /**
   * The command that upgrades this instance to `latestVersion`, only when that
   * is newer, and never on the Hosted instance: its updater installs each
   * Cloudgate version by itself (ADR-0081), and the one-command install run
   * there by hand would leave out `HOSTED_MODE`.
   */
  upgradeCommand: string | null;
  /**
   * Whether this instance runs as the `cloudgate` Docker service, the one shape
   * `updateServer` can move. False on every native install.
   */
  canUpdateInPlace: boolean;
  /**
   * `null` when the check ran to completion — including when it completed and
   * found nothing newer. A sentence when it did **not** run to completion, so
   * "GitHub could not be asked" and "you are up to date" stay different answers.
   */
  error: string | null;
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** The command that installs `version` over the running one (docs/deploy.md §7). */
const upgradeCommandFor = (version: string): string =>
  `curl -fsSL ${INSTALL_SCRIPT_URL} | sudo CLOUDGATE_VERSION=${version} sh`;

/**
 * The update check: the running version against the latest Cloudgate version
 * on this repository's GitHub Releases (ADR-0082).
 *
 * ## Why this reports its own failures
 *
 * The Docker Hub check this replaced could not fail loudly: a 404 for a
 * repository that never existed fell into a `catch` that returned
 * `{latestVersion: null, updateAvailable: false}`, byte-identical to the honest
 * "checked, nothing newer" answer, so every native install was told it was
 * current. Every failure here travels in `UpdateData.error` instead: an
 * unreachable host, an HTTP status (GitHub's unauthenticated rate limit is a
 * 403), or a body that is not a release list. Callers that act on the result —
 * `updateServer`, and the console's Danger Zone — can refuse rather than
 * quietly do nothing.
 *
 * One page of 100 releases is read. GitHub lists them newest first, so the
 * latest Cloudgate version is on it unless a hundred CLI releases have been
 * published since; following `Link` pages was rejected as cost for a case
 * that does not happen.
 */
@Injectable()
export class UpdatesService {
  private readonly logger = new Logger(UpdatesService.name);

  constructor(
    @Inject(FETCH_CLIENT) private readonly fetchClient: FetchClient,
    private readonly remoteExec: RemoteExecService,
    private readonly instanceMode: InstanceMode,
    private readonly dockerResources: DockerResourceService,
  ) {}

  /** Whether this instance is the `cloudgate` Docker service on the platform host. */
  private async runsAsDockerService(): Promise<boolean> {
    return (
      (await this.dockerResources.getDockerResourceType(CLOUDGATE_RESOURCE)) ===
      'service'
    );
  }

  /**
   * The tags of this repository's releases that carry their Cloudgate version
   * tarball, or a thrown error that says what went wrong.
   */
  private async fetchReleaseTags(): Promise<string[]> {
    let response: Response;
    try {
      response = await this.fetchClient(RELEASES_URL, {
        method: 'GET',
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'Cloudgate',
        },
      });
    } catch (error) {
      throw new Error(
        `Could not reach api.github.com: ${messageOf(error)}. ` +
          'The update check needs outbound HTTPS from this host.',
      );
    }

    if (!response.ok) {
      throw new Error(
        `GitHub answered ${response.status} when asked for Cloudgate's releases.`,
      );
    }

    const data = (await response.json()) as unknown;
    if (!Array.isArray(data)) {
      throw new Error('GitHub returned no release list for Cloudgate.');
    }
    type ListedRelease = {
      tag_name?: unknown;
      assets?: { name?: unknown }[] | null;
    } | null;
    return (data as ListedRelease[]).flatMap((release) => {
      const tag = release?.tag_name;
      if (typeof tag !== 'string') return [];
      const assets = Array.isArray(release?.assets) ? release.assets : [];
      return assets.some((asset) => asset?.name === tarballName(tag))
        ? [tag]
        : [];
    });
  }

  /** Compare the running version to the latest Cloudgate version. */
  async getUpdateData(currentVersion: string): Promise<UpdateData> {
    const canUpdateInPlace = await this.runsAsDockerService();
    try {
      const versions = (await this.fetchReleaseTags()).filter((tag) =>
        CLOUDGATE_VERSION_TAG.test(tag),
      );
      const latestVersion = versions.sort(semver.rcompare)[0] ?? null;
      const cleanedCurrent = semver.clean(currentVersion);
      const updateAvailable =
        latestVersion !== null &&
        cleanedCurrent !== null &&
        semver.gt(latestVersion, cleanedCurrent);

      return {
        latestVersion,
        updateAvailable,
        upgradeCommand:
          updateAvailable && latestVersion && !this.instanceMode.isHosted
            ? upgradeCommandFor(latestVersion)
            : null,
        canUpdateInPlace,
        error: null,
      };
    } catch (error) {
      const message = messageOf(error);
      this.logger.error(`Update check failed: ${message}`);
      return {
        latestVersion: null,
        updateAvailable: false,
        upgradeCommand: null,
        canUpdateInPlace,
        error: message,
      };
    }
  }

  /**
   * Fire-and-forget service update when a newer version is published.
   *
   * A check that did not complete is refused rather than treated as "nothing to
   * do" — the caller asked to be moved onto the newest version and we do not
   * know what that is. So is an instance that is not the `cloudgate` Docker
   * service, which is every native install (`NOT_UPDATABLE_IN_PLACE_REFUSAL`).
   *
   * Not awaited, because the update replaces the task running this very
   * request; but caught, because a rejection nobody handles ends this Node
   * process, and a failed `docker service update` is a log line, not a crash.
   */
  async updateServer(currentVersion: string): Promise<void> {
    const data = await this.getUpdateData(currentVersion);
    if (data.error) {
      throw new ServiceUnavailableException(
        `The update check did not complete, so there is nothing to update to: ${data.error}`,
      );
    }
    if (!data.canUpdateInPlace) {
      throw new ConflictException(NOT_UPDATABLE_IN_PLACE_REFUSAL);
    }
    if (data.updateAvailable) {
      this.remoteExec
        .execFileAsync('docker', [
          'service',
          'update',
          '--force',
          '--image',
          `${CLOUDGATE_IMAGE}:${data.latestVersion}`,
          CLOUDGATE_RESOURCE,
        ])
        .catch((error: unknown) => {
          this.logger.error(
            `docker service update onto ${data.latestVersion} failed: ${messageOf(error)}`,
          );
        });
    }
  }
}
