import { readdir, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

import { Inject, Injectable } from '@nestjs/common';

import { DEPLOYMENTS_PREFIX } from '../../cloud-accounts/aws/definitions/static-definition';
import { CloudAccountsService } from '../../cloud-accounts/cloud-accounts.service';
import type { GcpCloudAccount } from '../../cloud-accounts/cloud-provider';
import { serviceName } from '../../cloud-accounts/gcp/definitions/names';
import { LIVE_PREFIX } from '../../cloud-accounts/gcp/definitions/static-definition';
import {
  GOOGLE_CLOUD_PORT,
  NOT_FOUND,
} from '../../cloud-accounts/google-cloud.port';
import type {
  GoogleAccessToken,
  GoogleAnswer,
  GoogleCloudPort,
  StoredObject,
} from '../../cloud-accounts/google-cloud.port';
import { describeError } from '../../common/describe-error';
import { DRIZZLE } from '../../db/drizzle.module';
import type { DrizzleDB } from '../../db/drizzle.module';
import type { CloudRunControl } from '../../deployment-queue/cloud-run-job.types';
import { contentTypeOf } from '../../object-storage/content-type';
import type {
  EmptyOutcome,
  FolderListing,
  FolderUpload,
  UploadOutcome,
} from '../../object-storage/object-storage.port';
import { deployedDomains } from './deployed-domains';
import { clearSiteCache, urlMapOf } from './google-cache-clears';
import { counted, STATIC_DEPLOY_CAP_MS } from './static-place';
import type { StaticFolders, StaticHalf, StaticSite } from './static-place';
import { elapsed, STATIC_SPREAD_CLOCK } from './static-spread';
import type { SpreadClock } from './static-spread';

/** A sign-in is asked again after this long (its access token lasts an hour). */
const SESSION_REFRESH_MS = 10 * 60_000;

/** How many objects are uploaded, copied or deleted at once. */
const OBJECTS_AT_ONCE = 8;

/**
 * How many times the copy into `live/` is tried before the Deployment fails
 * running it again is safe, since each try lists `live/` again and
 * copies only what is not there yet.
 */
const COPY_TRIES = 3;

/** The wait before the second try; each later one waits that much longer. */
const COPY_RETRY_MS = 5_000;

/** What the log and the page say once a copy into `live/` has begun and not finished. */
export const MIXED_LIVE_SITE =
  'The live site may have files from both versions; deploy again or roll back to fix it';

/** What a Deployment cut off by a restart once its copy has begun ends with. */
export const CUT_OFF_WHILE_COPYING = `Cut off by a Cloudgate restart while copying into the live site, and not run again. ${MIXED_LIVE_SITE}`;

/** What they say when it stopped before changing anything in `live/`. */
const PREVIOUS_VERSION = 'The site still serves its previous version';

/** The name a folder's page is served at besides its own (`about/` for `about/index.html`). */
const FOLDER_PAGE = 'index.html';

/** Whether a file is an HTML page, which goes live after every other file. */
function isPage(name: string): boolean {
  return /\.html?$/i.test(name);
}

/** One object to make in `live/`, from the Deployment folder's copy of it. */
interface LiveCopy {
  readonly from: string;
  readonly to: string;
  readonly md5Hash: string | null;
  readonly page: boolean;
}

/**
 * What `live/` must hold for the files under `source`: each file at its own
 * name, and each folder's `index.html` again at the folder's name, ending in
 * `/` (`live/about/`, and `live/` for `/`), so the network's one `/` →
 * `/live/` rewrite serves `/about/` at any depth and
 * `/about` stays a plain 404.
 */
export function liveCopies(
  source: string,
  objects: readonly StoredObject[],
): LiveCopy[] {
  const copies: LiveCopy[] = [];
  for (const object of objects) {
    const path = object.name.slice(source.length);
    if (path === '' || path.endsWith('/')) continue;
    const page = isPage(path);
    copies.push({
      from: object.name,
      to: `${LIVE_PREFIX}${path}`,
      md5Hash: object.md5Hash,
      page,
    });
    if (path === FOLDER_PAGE || path.endsWith(`/${FOLDER_PAGE}`)) {
      copies.push({
        from: object.name,
        to: `${LIVE_PREFIX}${path.slice(0, -FOLDER_PAGE.length)}`,
        md5Hash: object.md5Hash,
        page: true,
      });
    }
  }
  return copies;
}

/** Runs `work` on each item, a few at once; the first refusal stops what is not begun. */
async function each<T>(
  items: readonly T[],
  work: (item: T) => Promise<string | null>,
): Promise<string | null> {
  let next = 0;
  let refused: string | null = null;
  const worker = async () => {
    while (refused === null && next < items.length) {
      const item = items[next++];
      const answer = await work(item);
      if (answer !== null && refused === null) refused = answer;
    }
  };
  await Promise.all(Array.from({ length: OBJECTS_AT_ONCE }, () => worker()));
  return refused;
}

/** Every file under a folder, its subfolders' too; links are not followed. */
async function filesUnder(directory: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await filesUnder(path)));
    else if (entry.isFile()) found.push(path);
  }
  return found;
}

/** How one try of the copy into `live/` ended. */
type CopyTry =
  | { readonly ok: true }
  | {
      readonly ok: false;
      /** What stopped it, in Google's words where Google said it. */
      readonly reason: string;
      /** Whether it had asked for a change to `live/`, so the site may be mixed. */
      readonly touched: boolean;
      /** Whether the Deployment's cap stopped it, which is not tried again. */
      readonly capped: boolean;
    };

/** Google's refusal in its own words, as a line names it. */
function refusalText(answer: GoogleAnswer<unknown>): string | null {
  return answer.ok ? null : `${answer.code}: ${answer.message}`;
}

/**
 * **Google Cloud's half of a static site's Deployment** (the Google Cloud
 * buckets spec "Static site on Cloud Storage and Cloud CDN", as corrected):
 * the site's private Cloud Storage bucket, reached through the
 * Google client port on the platform host with the run's own access token,
 * so no Google credential reaches a Server. `CloudStaticDeploys` runs the
 * Deployment and hands it here for:
 *
 * - **the folders**: each Deployment's own `deployments/<id>/` folder, its
 *   files uploaded with the content type each is served as;
 * - **going live**: the network always serves the fixed `live/` folder
 *   (`LIVE_PREFIX`), so a Deployment never changes the network and needs no
 *   network run and no wait. Its folder is copied into `live/` on Google's
 *   side, skipping each file whose MD5 is already there, in an order that
 *   never leaves a page pointing at a missing file: every file but the
 *   pages, then the pages (each folder's `index.html` again at the folder's
 *   own name, {@link liveCopies}), then the files `live/` holds that this
 *   version lacks are deleted;
 * - **settling**: the cache is cleared once per Domain, by host on the
 *   network's URL map (`clearSiteCache`). A site with no Domain
 *   answers nowhere, so there is no cache to clear. Nothing is
 *   served from a Deployment folder, so the clean-up spares none but the
 *   rollback points: with rollbacks off, this Deployment's own folder goes
 *   once copied;
 * - **failing** ("Failure and cap"): a copy that stops partway is
 *   tried again, up to three tries, since each lists `live/` again. Out of
 *   tries, at the 30-minute cap (a ceiling on the whole Deployment, counted
 *   on the static clock from the run's start) or once the run is asked to
 *   end, the Deployment fails, with {@link MIXED_LIVE_SITE} once `live/`
 *   may have changed, and the cache is still cleared per Domain. Unlike
 *   CloudFront's spread on AWS, nothing finishes on its own here, so the
 *   cap is never "done, still spreading". The cap holds the upload and
 *   the per-Domain cache clears too: an upload past it stops with the site
 *   on its previous version, and a clear past it names the Domains not
 *   cleared.
 */
@Injectable()
export class GoogleStaticDeploys {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    @Inject(GOOGLE_CLOUD_PORT) private readonly google: GoogleCloudPort,
    @Inject(STATIC_SPREAD_CLOCK) private readonly clock: SpreadClock,
    private readonly cloudAccounts: CloudAccountsService,
  ) {}

  /** The site on Cloud Storage + Cloud CDN in `account`. */
  halfOf(site: StaticSite, account: GcpCloudAccount): StaticHalf {
    const { found, region, bucket } = site;
    const token = this.sessions(account);
    const folders = this.folders(bucket, token);
    return {
      folders,
      serving: () => ({
        place: `Cloud Storage + Cloud CDN in Cloud account ${account.name} (${region})`,
        servedBy: `served from its ${LIVE_PREFIX} folder by backend bucket ${serviceName(found.applicationId)}`,
        settings: "the backend bucket's settings",
        cutOff: CUT_OFF_WHILE_COPYING,
        goLive: async ({ folder, startedAt, control, log }) => {
          const copied = await this.copyIntoLive(bucket, folder, token, {
            startedAt,
            control,
            log,
          });
          if (copied.ok) return;
          // Whatever `live/` holds now, every Domain should see it alike,
          // and nothing deleted from it should stay cached.
          if (copied.touched) {
            await this.clearAfterFailure(found, account, token, log);
          }
          throw new Error(copied.message);
        },
        settle: async ({ startedAt, log }) => {
          const domains = await deployedDomains(this.db, found.applicationId);
          if (domains.length === 0) {
            await log(
              '🌐 [Clear] No Domain yet, so there is no cache to clear: the site answers nowhere until a Domain is added',
            );
          } else {
            await this.clearDomains(
              found,
              account,
              domains,
              token,
              log,
              this.pastCap(startedAt),
            );
          }
          // Nothing is served from a Deployment folder: `live/` is a copy.
          return { live: null, previous: null };
        },
      }),
    };
  }

  /**
   * Step 3: the cache of each of the site's Domains cleared by host
   * on the network's URL map, after the copy, so every Domain sees this
   * version at once and the network's other sites keep their cache.
   */
  private async clearDomains(
    found: StaticSite['found'],
    account: GcpCloudAccount,
    domains: readonly { host: string }[],
    token: () => Promise<GoogleAccessToken>,
    log: (line: string) => Promise<void>,
    capped?: () => boolean,
  ): Promise<void> {
    const urlMap = await urlMapOf(this.db, found);
    if (!urlMap) {
      throw new Error(
        'The Environment network is not made, so its load balancer has no cache to clear for this site’s Domains',
      );
    }
    await clearSiteCache(
      this.google,
      token,
      { projectId: account.cloudId, urlMap },
      domains.map((one) => one.host),
      log,
      capped,
    );
  }

  /** Whether a Deployment begun at `startedAt` has reached its 30-minute cap. */
  private pastCap(startedAt: number): () => boolean {
    return () => this.clock.now() - startedAt >= STATIC_DEPLOY_CAP_MS;
  }

  /**
   * A failed copy's cache clear (the Google Cloud buckets spec "Failure and cap"): as
   * after a copy that finished, once per Domain. A clear that fails too is
   * logged, never put before the copy's own failure, which the Deployment
   * ends with.
   */
  private async clearAfterFailure(
    found: StaticSite['found'],
    account: GcpCloudAccount,
    token: () => Promise<GoogleAccessToken>,
    log: (line: string) => Promise<void>,
  ): Promise<void> {
    try {
      const domains = await deployedDomains(this.db, found.applicationId);
      if (domains.length === 0) return;
      await log(
        '🌐 [Clear] The copy did not finish; clearing the cache anyway, so every Domain serves what the live site holds now',
      );
      await this.clearDomains(found, account, domains, token, log);
    } catch (error) {
      await log(`⚠️ [Clear] ${describeError(error)}`);
    }
  }

  /** The site's own bucket, as the run reaches its Deployment folders. */
  private folders(
    bucket: string,
    token: () => Promise<GoogleAccessToken>,
  ): StaticFolders {
    return {
      where: (prefix) => `gs://${bucket}/${prefix}`,
      upload: (upload, startedAt) =>
        this.upload(
          bucket,
          upload,
          token,
          startedAt === undefined ? () => false : this.pastCap(startedAt),
        ),
      list: async (prefix): Promise<FolderListing> => {
        const listed = await this.list(bucket, prefix, token);
        if (!listed.ok) return listed;
        const folders = new Set<string>();
        for (const object of listed.objects) {
          const rest = object.name.slice(prefix.length);
          const cut = rest.indexOf('/');
          if (cut > 0) folders.add(rest.slice(0, cut));
        }
        return { ok: true, folders: [...folders] };
      },
      delete: async (prefix): Promise<EmptyOutcome> => {
        const listed = await this.list(bucket, prefix, token);
        if (!listed.ok) return listed;
        const refused = await this.deleteAll(
          bucket,
          listed.objects.map((object) => object.name),
          token,
        );
        return refused === null
          ? { ok: true }
          : { ok: false, message: refused };
      },
    };
  }

  private async upload(
    bucket: string,
    upload: FolderUpload,
    token: () => Promise<GoogleAccessToken>,
    capped: () => boolean,
  ): Promise<UploadOutcome> {
    try {
      const files = await filesUnder(upload.directory);
      let bytes = 0;
      const refused = await each(files, async (file) => {
        if (capped()) {
          return 'the Deployment reached its 30-minute cap while uploading';
        }
        const name =
          upload.prefix + relative(upload.directory, file).split(sep).join('/');
        const answer = await this.google.uploadObject(await token(), {
          bucket,
          name,
          file,
          contentType: contentTypeOf(file),
        });
        if (!answer.ok) return `${name}: ${refusalText(answer)}`;
        // Read first: `bytes +=` across an `await` would lose another's add.
        const { size } = await stat(file);
        bytes += size;
        return null;
      });
      if (refused !== null) return { ok: false, message: refused };
      return { ok: true, files: files.length, bytes };
    } catch (error) {
      return { ok: false, message: describeError(error) };
    }
  }

  private async list(
    bucket: string,
    prefix: string,
    token: () => Promise<GoogleAccessToken>,
  ): Promise<
    | { readonly ok: true; readonly objects: StoredObject[] }
    | { readonly ok: false; readonly message: string }
  > {
    try {
      const answer = await this.google.listObjects(await token(), {
        bucket,
        prefix,
      });
      return answer.ok
        ? { ok: true, objects: answer.value }
        : { ok: false, message: refusalText(answer) ?? '' };
    } catch (error) {
      return { ok: false, message: describeError(error) };
    }
  }

  /** Each object deleted; one already gone counts as deleted. */
  private deleteAll(
    bucket: string,
    names: readonly string[],
    token: () => Promise<GoogleAccessToken>,
  ): Promise<string | null> {
    return each(names, (name) => this.deleteOne(bucket, name, token));
  }

  /** One object deleted, or Google's refusal (or no answer) naming it. */
  private async deleteOne(
    bucket: string,
    name: string,
    token: () => Promise<GoogleAccessToken>,
  ): Promise<string | null> {
    try {
      const answer = await this.google.deleteObject(await token(), {
        bucket,
        name,
      });
      if (answer.ok || answer.code === NOT_FOUND) return null;
      return `${name} was not deleted: ${refusalText(answer)}`;
    } catch (error) {
      return `${name} was not deleted: ${describeError(error)}`;
    }
  }

  /**
   * Step 2's copy (the Google Cloud buckets spec "Deploy and rollback"), tried up to
   * {@link COPY_TRIES} times ("Failure and cap"): a try that stops
   * partway is tried again after a wait, since each try lists `live/` again
   * and copies only what is not there yet. It is not tried again past the
   * 30-minute cap, a ceiling on the whole Deployment counted from
   * `startedAt`, nor once the run is asked to end. A failure says whether
   * the site may hold files from both versions: so once any try has asked
   * for a change to `live/`.
   */
  private async copyIntoLive(
    bucket: string,
    folder: string,
    token: () => Promise<GoogleAccessToken>,
    run: {
      readonly startedAt: number;
      readonly control: CloudRunControl;
      readonly log: (line: string) => Promise<void>;
    },
  ): Promise<
    | { readonly ok: true }
    | {
        readonly ok: false;
        readonly touched: boolean;
        readonly message: string;
      }
  > {
    const { control, log } = run;
    const capped = this.pastCap(run.startedAt);
    let touched = false;
    const failed = (opening: string) => ({
      ok: false as const,
      touched,
      message: `${opening}. ${touched ? MIXED_LIVE_SITE : PREVIOUS_VERSION}`,
    });
    const atCap = () =>
      failed(
        `The Deployment reached its 30-minute cap ${touched ? 'while' : 'before'} copying into the live site`,
      );
    const ended = (reason: string) =>
      failed(`The run was ended while copying into the live site (${reason})`);
    const interrupted = new Promise<void>((resolve) =>
      control.signal.onInterrupt(resolve),
    );
    for (let attempt = 1; ; attempt++) {
      if (capped()) return atCap();
      const tried = await this.copyOnce(bucket, folder, token, capped, log);
      if (tried.ok) return tried;
      touched ||= tried.touched;
      if (tried.capped) return atCap();
      if (control.signal.interrupted) return ended(tried.reason);
      if (attempt >= COPY_TRIES) {
        return failed(
          `The copy into the live site stopped after ${COPY_TRIES} tries (${tried.reason})`,
        );
      }
      const wait = COPY_RETRY_MS * attempt;
      await log(
        `⚠️ [Copy] The copy stopped partway (${tried.reason}); trying again in ${elapsed(wait)} (try ${attempt + 1} of ${COPY_TRIES})`,
      );
      await Promise.race([this.clock.sleep(wait), interrupted]);
      if (control.signal.interrupted) return ended(tried.reason);
    }
  }

  /**
   * One try of the copy: `folder` into `live/`, changed files only, every
   * file but the pages first, then the pages, then what this version lacks
   * deleted. No change to `live/` is asked for once the cap has passed.
   */
  private async copyOnce(
    bucket: string,
    folder: string,
    token: () => Promise<GoogleAccessToken>,
    capped: () => boolean,
    log: (line: string) => Promise<void>,
  ): Promise<CopyTry> {
    let touched = false;
    let stoppedByCap = false;
    const stopped = (reason: string): CopyTry => ({
      ok: false,
      reason,
      touched,
      capped: stoppedByCap,
    });
    /**
     * One change to `live/`, unless the cap has come first. Each change
     * catches a call that gets no answer at all (a timeout, a dropped
     * connection) as a refusal: it may have reached Google, so `live/` may
     * have changed, and the next try lists it again.
     */
    const change = async (
      ask: () => Promise<string | null>,
    ): Promise<string | null> => {
      if (capped()) {
        stoppedByCap = true;
        return 'the 30-minute cap';
      }
      touched = true;
      return ask();
    };

    const source = `${DEPLOYMENTS_PREFIX}${folder}/`;
    const wanted = await this.list(bucket, source, token);
    if (!wanted.ok) {
      return stopped(
        `the files of this version could not be listed in ${bucket}: ${wanted.message}`,
      );
    }
    const live = await this.list(bucket, LIVE_PREFIX, token);
    if (!live.ok) {
      return stopped(
        `the live site's files could not be listed in ${bucket}: ${live.message}`,
      );
    }
    const there = new Map(
      live.objects.map((object) => [object.name, object.md5Hash]),
    );
    const copies = liveCopies(source, wanted.objects);
    const changed = copies.filter(
      (copy) => copy.md5Hash === null || there.get(copy.to) !== copy.md5Hash,
    );
    const keep = new Set(copies.map((copy) => copy.to));
    const old = live.objects
      .map((object) => object.name)
      .filter((name) => !keep.has(name));

    await log(
      `🔁 [Copy] Copying into the live site (${changed.length.toLocaleString('en-US')} changed)`,
    );
    for (const pages of [false, true]) {
      const refused = await each(
        changed.filter((one) => one.page === pages),
        (one) =>
          change(async () => {
            try {
              const answer = await this.google.copyObject(await token(), {
                bucket,
                from: one.from,
                to: one.to,
              });
              return answer.ok ? null : `${one.to}: ${refusalText(answer)}`;
            } catch (error) {
              return `${one.to}: ${describeError(error)}`;
            }
          }),
      );
      if (refused !== null) return stopped(refused);
    }
    const refused = await each(old, (name) =>
      change(() => this.deleteOne(bucket, name, token)),
    );
    if (refused !== null) return stopped(refused);
    if (old.length > 0) {
      await log(`🧹 [Copy] Removed ${counted(old.length, 'old file')}`);
    }
    return { ok: true };
  }

  /**
   * The run's access token, signed once and again when near its end. A
   * refusal fails the run before any change, naming the Cloud account.
   */
  private sessions(account: GcpCloudAccount): () => Promise<GoogleAccessToken> {
    let held: { token: GoogleAccessToken; at: number } | null = null;
    return async () => {
      if (held && Date.now() - held.at < SESSION_REFRESH_MS) return held.token;
      const signed = await this.cloudAccounts.googleRunSession(account);
      if (!signed.ok) throw new Error(signed.refusal);
      held = { token: signed.token, at: Date.now() };
      return signed.token;
    };
  }
}
