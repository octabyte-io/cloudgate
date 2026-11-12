import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { Injectable } from '@nestjs/common';
import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  ListObjectVersionsCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { ObjectIdentifier } from '@aws-sdk/client-s3';

import { contentTypeOf } from './content-type';
import type {
  BucketAccess,
  BucketContents,
  EmptyOutcome,
  FolderListing,
  FolderUpload,
  ObjectStoragePort,
  ObjectStorageTarget,
  UploadOutcome,
} from './object-storage.port';
import { describeError } from '../common/describe-error';

/** S3's own cap on one DeleteObjects call, and on one list page. */
const PAGE = 1000;

/** How long an access check waits for its one list. */
const ACCESS_TIMEOUT_MS = 30_000;

/** How many files a folder's upload sends at once. */
const UPLOADS_AT_ONCE = 8;

/**
 * How many list-and-delete rounds an emptying makes before it calls itself
 * stuck: a bucket another writer keeps filling is never emptied by waiting.
 */
const MAX_ROUNDS = 10_000;

/**
 * Whether S3 said it does not implement a call. Garage has no versioning, so
 * it answers ListObjectVersions this way (ADR-0037); with no versioning its
 * plain listing is every file there is, delete markers included (it has
 * none).
 */
function notImplemented(error: unknown): boolean {
  const found = error as {
    name?: string;
    Code?: string;
    $metadata?: { httpStatusCode?: number };
  };
  return (
    found?.name === 'NotImplemented' ||
    found?.Code === 'NotImplemented' ||
    found?.$metadata?.httpStatusCode === 501
  );
}

/**
 * The object-storage port's real adapter (`object-storage.port.ts`): the S3
 * protocol through the AWS SDK, to Garage or to S3, on the platform host.
 * Never run by the normal e2e lane, which fakes the whole port; the release
 * lane runs it against moto and a Garage container (spec seam 4).
 *
 * **Versions first.** "Empty" means no objects, no old versions and no delete
 * markers, so both calls list versions; a store that does not
 * implement that listing (Garage) is read with the plain one, which there is
 * the whole bucket.
 */
@Injectable()
export class S3ObjectStorage implements ObjectStoragePort {
  async contentsOf(target: ObjectStorageTarget): Promise<BucketContents> {
    const client = clientFor(target);
    try {
      const page = await firstPage(client, target.bucket, 1);
      return page.length > 0 ? 'holds-files' : 'empty';
    } catch {
      return 'unknown';
    } finally {
      client.destroy();
    }
  }

  async access(target: ObjectStorageTarget): Promise<BucketAccess> {
    const client = clientFor(target);
    try {
      await client.send(
        new ListObjectsV2Command({ Bucket: target.bucket, MaxKeys: 1 }),
        { abortSignal: AbortSignal.timeout(ACCESS_TIMEOUT_MS) },
      );
      return 'ok';
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } })
        .$metadata?.httpStatusCode;
      if (noSuchBucket(error) || status === 404) return 'not-found';
      if (status === 403 || status === 401) return 'denied';
      return 'unknown';
    } finally {
      client.destroy();
    }
  }

  async empty(target: ObjectStorageTarget): Promise<EmptyOutcome> {
    const client = clientFor(target);
    try {
      for (let round = 0; round < MAX_ROUNDS; round += 1) {
        const page = await firstPage(client, target.bucket, PAGE);
        if (page.length === 0) return { ok: true };
        const answer = await client.send(
          new DeleteObjectsCommand({
            Bucket: target.bucket,
            Delete: { Objects: page, Quiet: true },
          }),
        );
        const [failed] = answer.Errors ?? [];
        if (failed) {
          return {
            ok: false,
            message: `${failed.Key ?? 'a file'} was not deleted: ${failed.Message ?? failed.Code ?? 'no reason given'}`,
          };
        }
      }
      return {
        ok: false,
        message: 'files kept arriving while it was being emptied',
      };
    } catch (error) {
      // A bucket that is not there holds nothing: a static site whose
      // create stopped before its bucket was made is Deleted all the same,
      // and never left "partly emptied" for a bucket that never was.
      if (noSuchBucket(error)) return { ok: true };
      return { ok: false, message: describeError(error) };
    } finally {
      client.destroy();
    }
  }

  async uploadFolder(
    target: ObjectStorageTarget,
    upload: FolderUpload,
  ): Promise<UploadOutcome> {
    const client = clientFor(target);
    try {
      const files = await filesUnder(upload.directory);
      let bytes = 0;
      let next = 0;
      const worker = async () => {
        while (next < files.length) {
          const file = files[next++];
          const size = (await stat(file)).size;
          const key =
            upload.prefix +
            relative(upload.directory, file).split(sep).join('/');
          await client.send(
            new PutObjectCommand({
              Bucket: target.bucket,
              Key: key,
              Body: createReadStream(file),
              ContentLength: size,
              ContentType: contentTypeOf(file),
            }),
          );
          bytes += size;
        }
      };
      await Promise.all(
        Array.from({ length: UPLOADS_AT_ONCE }, () => worker()),
      );
      return { ok: true, files: files.length, bytes };
    } catch (error) {
      return { ok: false, message: describeError(error) };
    } finally {
      client.destroy();
    }
  }

  async listFolders(
    target: ObjectStorageTarget,
    prefix: string,
  ): Promise<FolderListing> {
    const client = clientFor(target);
    try {
      const folders: string[] = [];
      let token: string | undefined;
      do {
        const page = await client.send(
          new ListObjectsV2Command({
            Bucket: target.bucket,
            Prefix: prefix,
            Delimiter: '/',
            ContinuationToken: token,
          }),
        );
        for (const one of page.CommonPrefixes ?? []) {
          if (one.Prefix) folders.push(one.Prefix.slice(prefix.length, -1));
        }
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
      return { ok: true, folders };
    } catch (error) {
      return { ok: false, message: describeError(error) };
    } finally {
      client.destroy();
    }
  }

  async deleteFolder(
    target: ObjectStorageTarget,
    prefix: string,
  ): Promise<EmptyOutcome> {
    const client = clientFor(target);
    try {
      for (let round = 0; round < MAX_ROUNDS; round += 1) {
        const page = await client.send(
          new ListObjectsV2Command({
            Bucket: target.bucket,
            Prefix: prefix,
            MaxKeys: PAGE,
          }),
        );
        const keys = (page.Contents ?? [])
          .filter((one) => one.Key !== undefined)
          .map((one) => ({ Key: one.Key as string }));
        if (keys.length === 0) return { ok: true };
        const answer = await client.send(
          new DeleteObjectsCommand({
            Bucket: target.bucket,
            Delete: { Objects: keys, Quiet: true },
          }),
        );
        const [failed] = answer.Errors ?? [];
        if (failed) {
          return {
            ok: false,
            message: `${failed.Key ?? 'a file'} was not deleted: ${failed.Message ?? failed.Code ?? 'no reason given'}`,
          };
        }
      }
      return { ok: false, message: 'files kept arriving while it was deleted' };
    } catch (error) {
      return { ok: false, message: describeError(error) };
    } finally {
      client.destroy();
    }
  }
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

/** Whether S3 said the bucket does not exist. */
function noSuchBucket(error: unknown): boolean {
  const found = error as { name?: string; Code?: string };
  return found?.name === 'NoSuchBucket' || found?.Code === 'NoSuchBucket';
}

function clientFor(target: ObjectStorageTarget): S3Client {
  return new S3Client({
    region: target.region,
    ...(target.endpoint === null ? {} : { endpoint: target.endpoint }),
    forcePathStyle: target.pathStyle,
    credentials: {
      accessKeyId: target.credential.accessKeyId,
      secretAccessKey: target.credential.secretAccessKey,
      ...(target.credential.sessionToken
        ? { sessionToken: target.credential.sessionToken }
        : {}),
    },
    // Only what a call requires: Garage and S3 both take that, and a
    // checksum on every call is a newer SDK default not every store reads.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    maxAttempts: 3,
  });
}

/**
 * Up to `max` of what the bucket holds — versions and delete markers when
 * the store lists them, its objects when it does not — as the identifiers a
 * DeleteObjects takes.
 */
async function firstPage(
  client: S3Client,
  bucket: string,
  max: number,
): Promise<ObjectIdentifier[]> {
  try {
    const answer = await client.send(
      new ListObjectVersionsCommand({ Bucket: bucket, MaxKeys: max }),
    );
    return [...(answer.Versions ?? []), ...(answer.DeleteMarkers ?? [])]
      .filter((one) => one.Key !== undefined)
      .slice(0, max)
      .map((one) => ({
        Key: one.Key as string,
        // Named even when it is S3's `null` version: a delete with no
        // version on a bucket that ever had versioning only adds a marker.
        ...(one.VersionId ? { VersionId: one.VersionId } : {}),
      }));
  } catch (error) {
    if (!notImplemented(error)) throw error;
  }
  const answer = await client.send(
    new ListObjectsV2Command({ Bucket: bucket, MaxKeys: max }),
  );
  return (answer.Contents ?? [])
    .filter((one) => one.Key !== undefined)
    .map((one) => ({ Key: one.Key as string }));
}
