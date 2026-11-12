import { S3Client } from '@aws-sdk/client-s3';

import { S3ObjectStorage } from '../../src/object-storage/s3-object-storage.adapter';
import type { ObjectStorageTarget } from '../../src/object-storage/object-storage.port';

const TARGET: ObjectStorageTarget = {
  endpoint: null,
  region: 'eu-central-1',
  bucket: 'docs-p4x8m2rt-123456789012-eu-central-1-an',
  credential: {
    accessKeyId: 'ASIAEXAMPLE',
    secretAccessKey: 'secret',
    sessionToken: 'session',
  },
  pathStyle: false,
};

/** S3's `send`, stubbed to refuse with an S3 error named `name`. */
function refusing(name: string, message: string) {
  // `send`'s promise overload, the one the adapter calls; its callback
  // overloads return void, which a rejecting stub does not fit.
  const client: { send(command: unknown): Promise<unknown> } =
    S3Client.prototype;
  jest
    .spyOn(client, 'send')
    .mockRejectedValue(Object.assign(new Error(message), { name, Code: name }));
}

/**
 * The real adapter's emptying, with S3's answers stubbed: a bucket
 * that is not there holds nothing, any other refusal stops it.
 */
describe('S3ObjectStorage.empty', () => {
  afterEach(() => jest.restoreAllMocks());

  it('empties a bucket that is not there: it holds nothing', async () => {
    refusing('NoSuchBucket', 'The specified bucket does not exist');

    await expect(new S3ObjectStorage().empty(TARGET)).resolves.toEqual({
      ok: true,
    });
  });

  it('stops on any other refusal, with its message', async () => {
    refusing('AccessDenied', 'Access Denied');

    await expect(new S3ObjectStorage().empty(TARGET)).resolves.toEqual({
      ok: false,
      message: 'Access Denied',
    });
  });
});
