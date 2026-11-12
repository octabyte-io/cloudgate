import type {
  GarageEndpoint,
  GarageReach,
} from '../../src/buckets/garage-reach';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type {
  BucketAccess,
  BucketContents,
  EmptyOutcome,
  FolderListing,
  FolderUpload,
  ObjectStoragePort,
  ObjectStorageTarget,
  UploadOutcome,
} from '../../src/object-storage/object-storage.port';

/** What a bucket holds: each object, old version and delete marker by key. */
export type FakeEntryKind = 'object' | 'version' | 'delete-marker';

interface FakeBucket {
  entries: { key: string; kind: FakeEntryKind }[];
  unreadable: boolean;
  /** Entries an emptying deletes before it fails; `null` never fails. */
  failEmptyAfter: number | null;
}

/**
 * Where the fake reach says a Garage's S3 API is. Any address does: the
 * fake port keys buckets by name.
 */
export const FAKE_GARAGE_ENDPOINT = 'http://127.0.0.1:39000';

/**
 * The reach to a Garage's S3 API (`GARAGE_REACH`) faked: no relay, no SSH,
 * an address handed back at once, and every open and close counted so a
 * spec can see each was closed.
 */
export class FakeGarageReach implements GarageReach {
  readonly opened: { serverId: string | null; appName: string }[] = [];
  closed = 0;

  open(found: {
    readonly serverId: string | null;
    readonly appName: string;
  }): Promise<GarageEndpoint> {
    this.opened.push({ serverId: found.serverId, appName: found.appName });
    return Promise.resolve({
      endpoint: FAKE_GARAGE_ENDPOINT,
      close: () => {
        this.closed += 1;
        return Promise.resolve();
      },
    });
  }

  reset(): void {
    this.opened.length = 0;
    this.closed = 0;
  }
}

/**
 * The object-storage port faked in memory (seam 4): buckets by
 * real name, each holding objects, old versions and delete markers, which
 * can be made unreadable ("can't tell") or made to fail an emptying partway.
 * A bucket never put here is empty.
 *
 * `createTestApp` registers one for every e2e spec, with its {@link reach},
 * so no spec reaches Garage or S3; `resetDb` empties it. A spec gets it as
 * `ctx.objectStorage`.
 */
export class FakeObjectStorage implements ObjectStoragePort {
  /** Every call, in order, with the target it was handed. */
  readonly calls: {
    call:
      | 'contentsOf'
      | 'empty'
      | 'access'
      | 'uploadFolder'
      | 'listFolders'
      | 'deleteFolder';
    target: ObjectStorageTarget;
    /** The upload's folder, or the prefix listed or deleted. */
    directory?: string;
    prefix?: string;
  }[] = [];
  /**
   * The files an upload puts when its folder is not on disk: the
   * e2e suite's exec double runs no checkout, so the folder a deploy copies
   * `publish` into is never written. A folder that is there is read.
   */
  siteFiles: string[] = ['index.html', 'assets/app.js'];
  /**
   * The bytes of each file an upload read off disk, by `bucket/key`:
   * a hosted cloud build's source zip, which its Cloud run removes from its
   * folder once uploaded, read back by the spec.
   */
  readonly bodies = new Map<string, Buffer>();
  readonly reach = new FakeGarageReach();
  private readonly buckets = new Map<string, FakeBucket>();
  /** The buckets a credential's list reaches; any other is `denied`. */
  private readonly reached = new Set<string>();
  /** The next upload's failure, after putting this many files; `null` never fails. */
  private uploadFailure: { afterFiles: number; message: string } | null = null;

  /** Puts `kind` entries under `keys` into the bucket. */
  put(bucket: string, kind: FakeEntryKind, ...keys: string[]): void {
    this.bucketOf(bucket).entries.push(...keys.map((key) => ({ key, kind })));
  }

  /** What the bucket holds now, as `kind:key`. */
  entriesOf(bucket: string): string[] {
    return (this.buckets.get(bucket)?.entries ?? []).map(
      (entry) => `${entry.kind}:${entry.key}`,
    );
  }

  /** Makes the bucket answer every read as unreadable. */
  makeUnreadable(bucket: string): void {
    this.bucketOf(bucket).unreadable = true;
  }

  /**
   * Makes the next upload fail, in S3's words, once it has put `afterFiles`
   * of its files: a half-uploaded folder, as a dropped connection leaves.
   */
  failUploadAfter(afterFiles: number, message: string): void {
    this.uploadFailure = { afterFiles, message };
  }

  /** Makes an emptying of the bucket fail after deleting `count` entries. */
  failEmptyAfter(bucket: string, count: number): void {
    this.bucketOf(bucket).failEmptyAfter = count;
  }

  contentsOf(target: ObjectStorageTarget): Promise<BucketContents> {
    this.calls.push({ call: 'contentsOf', target });
    const found = this.buckets.get(target.bucket);
    if (found?.unreadable) return Promise.resolve('unknown');
    return Promise.resolve(
      (found?.entries.length ?? 0) > 0 ? 'holds-files' : 'empty',
    );
  }

  /**
   * A list made with a bucket's key reaches `bucket`: the operator
   * added the grant (`true`), or took it off again (`false`). Until then
   * the list is `denied`, as a key with no grant is.
   */
  keyReaches(bucket: string, reaches: boolean): void {
    if (reaches) this.reached.add(bucket);
    else this.reached.delete(bucket);
  }

  access(target: ObjectStorageTarget): Promise<BucketAccess> {
    this.calls.push({ call: 'access', target });
    return Promise.resolve(this.reached.has(target.bucket) ? 'ok' : 'denied');
  }

  empty(target: ObjectStorageTarget): Promise<EmptyOutcome> {
    this.calls.push({ call: 'empty', target });
    const found = this.buckets.get(target.bucket);
    if (!found) return Promise.resolve({ ok: true });
    if (found.unreadable) {
      return Promise.resolve({ ok: false, message: 'Access Denied' });
    }
    if (found.failEmptyAfter !== null) {
      found.entries.splice(0, found.failEmptyAfter);
      return Promise.resolve({
        ok: false,
        message: 'We encountered an internal error. Please try again.',
      });
    }
    found.entries.length = 0;
    return Promise.resolve({ ok: true });
  }

  uploadFolder(
    target: ObjectStorageTarget,
    upload: FolderUpload,
  ): Promise<UploadOutcome> {
    this.calls.push({
      call: 'uploadFolder',
      target,
      directory: upload.directory,
      prefix: upload.prefix,
    });
    const onDisk = existsSync(upload.directory);
    const files = onDisk
      ? filesUnder(upload.directory).map((file) =>
          relative(upload.directory, file).split(sep).join('/'),
        )
      : this.siteFiles;
    if (onDisk) {
      for (const file of files) {
        this.bodies.set(
          `${target.bucket}/${upload.prefix}${file}`,
          readFileSync(join(upload.directory, file)),
        );
      }
    }
    const failure = this.uploadFailure;
    this.uploadFailure = null;
    const put = failure ? files.slice(0, failure.afterFiles) : files;
    this.put(
      target.bucket,
      'object',
      ...put.map((file) => upload.prefix + file),
    );
    if (failure)
      return Promise.resolve({ ok: false, message: failure.message });
    return Promise.resolve({ ok: true, files: files.length, bytes: 0 });
  }

  listFolders(
    target: ObjectStorageTarget,
    prefix: string,
  ): Promise<FolderListing> {
    this.calls.push({ call: 'listFolders', target, prefix });
    const found = this.buckets.get(target.bucket);
    if (found?.unreadable) {
      return Promise.resolve({ ok: false, message: 'Access Denied' });
    }
    const folders = new Set<string>();
    for (const entry of found?.entries ?? []) {
      if (entry.kind !== 'object' || !entry.key.startsWith(prefix)) continue;
      const rest = entry.key.slice(prefix.length);
      if (rest.includes('/')) folders.add(rest.slice(0, rest.indexOf('/')));
    }
    return Promise.resolve({ ok: true, folders: [...folders] });
  }

  deleteFolder(
    target: ObjectStorageTarget,
    prefix: string,
  ): Promise<EmptyOutcome> {
    this.calls.push({ call: 'deleteFolder', target, prefix });
    const found = this.buckets.get(target.bucket);
    if (!found) return Promise.resolve({ ok: true });
    if (found.unreadable) {
      return Promise.resolve({ ok: false, message: 'Access Denied' });
    }
    found.entries = found.entries.filter(
      (entry) => !entry.key.startsWith(prefix),
    );
    return Promise.resolve({ ok: true });
  }

  /** The folders under `prefix` that hold files now. */
  foldersOf(bucket: string, prefix = 'deployments/'): string[] {
    const folders = new Set<string>();
    for (const entry of this.buckets.get(bucket)?.entries ?? []) {
      if (!entry.key.startsWith(prefix)) continue;
      const rest = entry.key.slice(prefix.length);
      if (rest.includes('/')) folders.add(rest.slice(0, rest.indexOf('/')));
    }
    return [...folders].sort();
  }

  reset(): void {
    this.siteFiles = ['index.html', 'assets/app.js'];
    this.reached.clear();
    this.uploadFailure = null;
    this.calls.length = 0;
    this.bodies.clear();
    this.buckets.clear();
    this.reach.reset();
  }

  private bucketOf(bucket: string): FakeBucket {
    let found = this.buckets.get(bucket);
    if (!found) {
      found = { entries: [], unreadable: false, failEmptyAfter: null };
      this.buckets.set(bucket, found);
    }
    return found;
  }
}

function filesUnder(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...filesUnder(path));
    else if (entry.isFile()) found.push(path);
  }
  return found;
}
