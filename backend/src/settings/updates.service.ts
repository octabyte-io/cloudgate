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
import { getCloudgateImageTag } from './docker-resource.service';

/** The Docker Hub repository this instance's image would be published to. */
export const UPDATE_REPOSITORY = 'cloudgate/cloudgate';

const TAGS_URL = `https://hub.docker.com/v2/repositories/${UPDATE_REPOSITORY}/tags`;

export interface UpdateData {
  latestVersion: string | null;
  updateAvailable: boolean;
  /**
   * `null` when the check ran to completion — including when it completed and
   * found nothing newer. A sentence when it did **not** run to completion, so
   * "Docker Hub has no such repository" and "you are up to date" stop being the
   * same answer.
   */
  error: string | null;
}

/** The answer when the check completed and had nothing to compare against. */
export const DEFAULT_UPDATE_DATA: UpdateData = {
  latestVersion: null,
  updateAvailable: false,
  error: null,
};

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

interface TagPage {
  next: string | null;
  results: { digest: string; name: string }[];
}

/**
 * The update check, against the cloudgate/cloudgate Docker Hub repository.
 *
 * ## Why this reports its own failures
 *
 * The check as first written could not fail loudly. A 404 body carries no
 * `results`, so `allResults.concat(data.results)` seeded the array with
 * `undefined`, `data?.next` ended the loop, and
 * `.find(t => t.name === 'latest')` threw on that `undefined` element —
 * straight into a `catch` that returned
 * `{latestVersion: null, updateAvailable: false}`. That is byte-identical to
 * the honest "checked, nothing newer" answer, so an instance whose repository
 * does not exist at all was told it was current. On the native install this
 * project ships there is no published `cloudgate/cloudgate` image, so that is
 * exactly what every operator saw.
 *
 * Every failure now travels in `UpdateData.error` instead: HTTP status, an
 * unreachable host, or a body that is not a tag page. Callers that act on the
 * result — `updateServer`, and the console's Danger Zone — can refuse rather
 * than quietly do nothing.
 */
@Injectable()
export class UpdatesService {
  private readonly logger = new Logger(UpdatesService.name);

  constructor(
    @Inject(FETCH_CLIENT) private readonly fetchClient: FetchClient,
    private readonly remoteExec: RemoteExecService,
  ) {}

  /** The image digest the `cloudgate` swarm service is running. */
  async getServiceImageDigest(): Promise<string> {
    const { stdout } = await this.remoteExec.execAsync(
      "docker service inspect cloudgate --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}'",
    );

    const currentDigest = stdout.trim().split('@')[1];
    if (!currentDigest) {
      throw new Error('Could not get current service image digest');
    }
    return currentDigest;
  }

  /** One page of tags, or a thrown error that says what went wrong. */
  private async fetchTagPage(url: string): Promise<TagPage> {
    let response: Response;
    try {
      response = await this.fetchClient(url, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      throw new Error(
        `Could not reach hub.docker.com: ${messageOf(error)}. ` +
          'The update check needs outbound HTTPS from this host.',
      );
    }

    if (!response.ok) {
      throw new Error(
        response.status === 404
          ? `Docker Hub has no repository ${UPDATE_REPOSITORY} (404). ` +
              'This instance is not built from an image published there, so there is nothing to compare it against.'
          : `Docker Hub answered ${response.status} for ${UPDATE_REPOSITORY}.`,
      );
    }

    const data = (await response.json()) as Partial<TagPage> | null;
    if (!Array.isArray(data?.results)) {
      throw new Error(
        `Docker Hub returned no tag list for ${UPDATE_REPOSITORY}.`,
      );
    }
    return { next: data.next ?? null, results: data.results };
  }

  /** Compare the running version to Docker Hub. */
  async getUpdateData(currentVersion: string): Promise<UpdateData> {
    try {
      let url: string | null = `${TAGS_URL}?page_size=100`;
      let allResults: { digest: string; name: string }[] = [];

      while (url) {
        const page = await this.fetchTagPage(url);
        allResults = allResults.concat(page.results);
        url = page.next;
      }

      const currentImageTag = getCloudgateImageTag();

      // Development tags (canary/feature) change too often for version
      // checks — only flag a digest drift on the same tag.
      if (currentImageTag === 'canary' || currentImageTag === 'feature') {
        const currentDigest = await this.getServiceImageDigest();
        const latestDigest = allResults.find(
          (t) => t.name === currentImageTag,
        )?.digest;
        if (!latestDigest) {
          return DEFAULT_UPDATE_DATA;
        }
        return {
          latestVersion: currentImageTag,
          updateAvailable: currentDigest !== latestDigest,
          error: null,
        };
      }

      // Stable: find the version tag sharing "latest"'s digest, semver-compare.
      const latestTag = allResults.find((t) => t.name === 'latest');
      if (!latestTag) {
        return DEFAULT_UPDATE_DATA;
      }

      const latestVersionTag = allResults.find(
        (t) => t.digest === latestTag.digest && t.name.startsWith('v'),
      );
      if (!latestVersionTag) {
        return DEFAULT_UPDATE_DATA;
      }

      const latestVersion = latestVersionTag.name;
      const cleanedCurrent = semver.clean(currentVersion);
      const cleanedLatest = semver.clean(latestVersion);
      if (!cleanedCurrent || !cleanedLatest) {
        return DEFAULT_UPDATE_DATA;
      }

      return {
        latestVersion,
        updateAvailable: semver.gt(cleanedLatest, cleanedCurrent),
        error: null,
      };
    } catch (error) {
      const message = messageOf(error);
      this.logger.error(`Update check failed: ${message}`);
      return { latestVersion: null, updateAvailable: false, error: message };
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
        `${UPDATE_REPOSITORY}:${data.latestVersion}`,
        'cloudgate',
      ]);
    }
  }
}
