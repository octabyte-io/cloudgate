import { exec } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import {
  GetObjectCommand,
  PutBucketCorsCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { GenericContainer, Wait } from 'testcontainers';
import type { StartedTestContainer } from 'testcontainers';

import {
  GARAGE_IMAGE,
  GARAGE_REGION,
  GARAGE_S3_PORT,
  bucketCorsProgram,
  createBucketProgram,
  createKeyProgram,
  garageToml,
  newAdminCredential,
  readCreatedKey,
  readRemovedKeys,
  removeKeysProgram,
} from '../../src/buckets/garage';
import type { ObjectStorageTarget } from '../../src/object-storage/object-storage.port';
import { S3ObjectStorage } from '../../src/object-storage/s3-object-storage.adapter';

/**
 * Seam 4: a bucket on a Server as Cloudgate runs it — Garage
 * at its pinned image, with Cloudgate's config — reached by the
 * object-storage port's real adapter over the S3 protocol, and driven by
 * the very `garage` CLI programs a deploy, a Rotate key and an origins
 * change run on the Server (`src/buckets/garage.ts`, ADR-0037). Every e2e
 * spec fakes both.
 *
 * The container stands in for the bucket's Swarm task: it carries the
 * service-name label the programs find their task by, and each program runs
 * here as it does on the Server, a shell program calling `docker`. It needs
 * Docker and the `docker` CLI, as the moto lane does, and pulls
 * `CORS_CLIENT_IMAGE` for the origins check. Run with `pnpm test:moto`.
 *
 * Cloudgate's config binds Garage to `0.0.0.0`, so it runs on a Docker host
 * with no IPv6 sockets as well (a gVisor sandbox, `ipv6.disable=1`): bound
 * to `[::]` there, Garage logged "listening", then panicked with "Address
 * family not supported by protocol".
 */

const APP = 'garage-moto-spec-uploads';
const BUCKET = 'uploads';
const ORIGIN = 'https://app.example.com';
const run = promisify(exec);

let garage: StartedTestContainer;
let endpoint: string;
const storage = new S3ObjectStorage();
const scratch = mkdtempSync(join(tmpdir(), 'cloudgate-garage-'));

/** One program, run as the Server runs it; its stdout. */
async function onServer(program: string): Promise<string> {
  return (await run(program, { shell: '/bin/sh' })).stdout;
}

const targetFor = (key: {
  accessKeyId: string;
  secretAccessKey: string;
}): ObjectStorageTarget => ({
  endpoint,
  region: GARAGE_REGION,
  bucket: BUCKET,
  credential: key,
  pathStyle: true,
});

/** A key the bucket's programs made and printed. */
async function newKey(name: string) {
  const key = readCreatedKey(
    await onServer(createKeyProgram(APP, BUCKET, name)),
  );
  if (!key) throw new Error(`${name}: no key printed`);
  return key;
}

/** What Garage answers a browser's preflight from `origin`. */
async function preflight(origin: string) {
  const response = await fetch(`${endpoint}/${BUCKET}/file.txt`, {
    method: 'OPTIONS',
    headers: { Origin: origin, 'Access-Control-Request-Method': 'PUT' },
  });
  return {
    status: response.status,
    allowOrigin: response.headers.get('access-control-allow-origin'),
  };
}

beforeAll(async () => {
  garage = await new GenericContainer(GARAGE_IMAGE)
    .withLabels({ 'com.docker.swarm.service.name': APP })
    .withCopyContentToContainer([
      { content: garageToml(newAdminCredential()), target: '/etc/garage.toml' },
    ])
    .withExposedPorts(GARAGE_S3_PORT)
    .withWaitStrategy(Wait.forLogMessage(/S3 API server listening/i))
    .start();
  endpoint = `http://${garage.getHost()}:${garage.getMappedPort(GARAGE_S3_PORT)}`;
}, 300_000);

afterAll(async () => {
  rmSync(scratch, { recursive: true, force: true });
  await garage?.stop();
});

describe('garageToml, the garage programs and S3ObjectStorage, against Garage (ADR-0037)', () => {
  let key: { accessKeyId: string; secretAccessKey: string };

  it('makes the bucket, and a redeploy making it again changes nothing', async () => {
    await onServer(createBucketProgram(APP, BUCKET));
    await onServer(createBucketProgram(APP, BUCKET));

    key = await newKey(`${APP}-key-1`);
    await expect(storage.contentsOf(targetFor(key))).resolves.toBe('empty');
  });

  it('grants its key read and write on the bucket, through the S3 protocol', async () => {
    const directory = join(scratch, 'files');
    mkdirSync(join(directory, 'nested'), { recursive: true });
    writeFileSync(join(directory, 'a.txt'), 'hello');
    writeFileSync(join(directory, 'nested', 'b.json'), '{}');

    await expect(
      storage.uploadFolder(targetFor(key), {
        directory,
        prefix: 'one/',
      }),
    ).resolves.toEqual({ ok: true, files: 2, bytes: 7 });
    await storage.uploadFolder(targetFor(key), { directory, prefix: 'two/' });

    await expect(storage.contentsOf(targetFor(key))).resolves.toBe(
      'holds-files',
    );
    const listed = await storage.listFolders(targetFor(key), '');
    expect(listed.ok && [...listed.folders].sort()).toEqual(['one', 'two']);
    await expect(storage.deleteFolder(targetFor(key), 'one/')).resolves.toEqual(
      { ok: true },
    );
    await expect(storage.listFolders(targetFor(key), '')).resolves.toEqual({
      ok: true,
      folders: ['two'],
    });
  });

  it('never makes its key the owner: it cannot change the bucket’s settings', async () => {
    const client = new S3Client({
      region: GARAGE_REGION,
      endpoint,
      forcePathStyle: true,
      credentials: key,
    });
    try {
      await expect(
        client.send(
          new PutBucketCorsCommand({
            Bucket: BUCKET,
            CORSConfiguration: {
              CORSRules: [{ AllowedOrigins: ['*'], AllowedMethods: ['GET'] }],
            },
          }),
        ),
      ).rejects.toMatchObject({ name: 'AccessDenied' });
    } finally {
      client.destroy();
    }
  });

  it("sets the bucket's origins as its CORS, through a key made and deleted for the one request", async () => {
    await onServer(bucketCorsProgram(APP, BUCKET, [ORIGIN]));

    await expect(preflight(ORIGIN)).resolves.toEqual({
      status: 200,
      allowOrigin: ORIGIN,
    });
    expect((await preflight('https://elsewhere.example.com')).status).toBe(403);
    // The owner key it made for the request is gone: only the bucket's own
    // key is left.
    const keys = await onServer(
      `docker exec "$(docker ps -q --filter label=com.docker.swarm.service.name=${APP})" /garage key list`,
    );
    expect(keys).not.toContain(`${APP}-cors`);

    await onServer(bucketCorsProgram(APP, BUCKET, []));
    // Garage refuses a preflight no rule allows (its error carries a
    // wildcard origin, but a browser reads only a 2xx preflight).
    expect((await preflight(ORIGIN)).status).toBe(403);
  });

  it('rotates the key: the new one opens the bucket, the removed one no longer does', async () => {
    const rotated = await newKey(`${APP}-key-2`);
    await expect(storage.contentsOf(targetFor(rotated))).resolves.toBe(
      'holds-files',
    );

    const removed = readRemovedKeys(
      await onServer(removeKeysProgram(APP, [key.accessKeyId])),
    );
    expect(removed).toEqual([key.accessKeyId]);
    await expect(storage.contentsOf(targetFor(key))).resolves.toBe('unknown');

    // A key Garage no longer has counts as removed.
    expect(
      readRemovedKeys(
        await onServer(removeKeysProgram(APP, [key.accessKeyId])),
      ),
    ).toEqual([key.accessKeyId]);
    key = rotated;
  });

  it('empties the bucket with no versioning to list, and reads it empty', async () => {
    await expect(storage.empty(targetFor(key))).resolves.toEqual({ ok: true });
    await expect(storage.contentsOf(targetFor(key))).resolves.toBe('empty');

    const client = new S3Client({
      region: GARAGE_REGION,
      endpoint,
      forcePathStyle: true,
      credentials: key,
    });
    try {
      await expect(
        client.send(new GetObjectCommand({ Bucket: BUCKET, Key: 'two/a.txt' })),
      ).rejects.toMatchObject({ name: 'NoSuchKey' });
    } finally {
      client.destroy();
    }
  });
});
