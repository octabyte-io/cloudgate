import {
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import * as semver from 'semver';
import { FETCH_CLIENT } from '../git-providers/fetch.provider';
import type { FetchClient } from '../git-providers/fetch.provider';
import { RemoteExecService } from '../remote/remote-exec.service';

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

export interface UpdateData {
  /** The newest Cloudgate version on GitHub Releases, as its tag `vX.Y.Z`. */
  latestVersion: string | null;
  updateAvailable: boolean;
  /** The command that upgrades this instance to `latestVersion`, only when that is newer. */
  upgradeCommand: string | null;
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
  ) {}

  /** The tags of this repository's releases, or a thrown error that says what went wrong. */
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
    return (data as ({ tag_name?: unknown } | null)[])
      .map((release) => release?.tag_name)
      .filter((tag): tag is string => typeof tag === 'string');
  }

  /** Compare the running version to the latest Cloudgate version. */
  async getUpdateData(currentVersion: string): Promise<UpdateData> {
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
          updateAvailable && latestVersion
            ? upgradeCommandFor(latestVersion)
            : null,
        error: null,
      };
    } catch (error) {
      const message = messageOf(error);
      this.logger.error(`Update check failed: ${message}`);
      return {
        latestVersion: null,
        updateAvailable: false,
        upgradeCommand: null,
        error: message,
      };
    }
  }

  /**
   * Fire-and-forget service update when a newer version is published.
   *
   * A check that did not complete is refused rather than treated as "nothing to
   * do" — the caller asked to be moved onto the newest version and we do not
   * know what that is.
   */
  async updateServer(currentVersion: string): Promise<void> {
    const data = await this.getUpdateData(currentVersion);
    if (data.error) {
      throw new ServiceUnavailableException(
        `The update check did not complete, so there is nothing to update to: ${data.error}`,
      );
    }
    if (data.updateAvailable) {
      void this.remoteExec.execFileAsync('docker', [
        'service',
        'update',
        '--force',
        '--image',
        `${CLOUDGATE_IMAGE}:${data.latestVersion}`,
        'cloudgate',
      ]);
    }
  }
}
