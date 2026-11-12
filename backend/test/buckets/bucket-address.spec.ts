import { bucketAddress } from '../../src/buckets/bucket-address';
import { outputValues } from '../../src/project-config/outputs/outputs';

/** The `endpoint` Output a bucket hands out at the address read off its Domains. */
function endpointOf(domains: Parameters<typeof bucketAddress>[1]): string {
  return outputValues(
    {
      kind: 'bucket',
      name: 'uploads-a1b2c3d4',
      region: 'us-east-1',
      accessKeyId: 'GK1',
      secretAccessKey: 'secret',
      pathStyle: true,
    },
    bucketAddress('bucket-quiet-river-1a2b3c', domains),
  ).endpoint;
}

describe('bucketAddress', () => {
  it('is the Garage S3 API inside the Server network while the bucket has no Domain', () => {
    expect(endpointOf([])).toBe('http://bucket-quiet-river-1a2b3c:3900');
  });

  it('is https://<host> on its Domain with HTTPS on, the default port left out', () => {
    expect(
      endpointOf([
        {
          host: 'uploads-1a2b3c-203-0-113-10.sslip.io',
          https: true,
          createdAt: '2026-10-17T00:00:00.000Z',
          uniqueConfigKey: 1,
        },
      ]),
    ).toBe('https://uploads-1a2b3c-203-0-113-10.sslip.io');
  });

  it('is http://<host> on a Domain with HTTPS off', () => {
    expect(
      endpointOf([
        {
          host: 'files.example.com',
          https: false,
          createdAt: '2026-10-17T00:00:00.000Z',
          uniqueConfigKey: 1,
        },
      ]),
    ).toBe('http://files.example.com');
  });

  it('is the oldest of several Domains, so adding one never moves it', () => {
    expect(
      endpointOf([
        {
          host: 'new.example.com',
          https: true,
          createdAt: '2026-10-17T10:00:00.000Z',
          uniqueConfigKey: 7,
        },
        {
          host: 'same-instant.example.com',
          https: true,
          createdAt: '2026-10-17T09:00:00.000Z',
          uniqueConfigKey: 12,
        },
        {
          host: 'old.example.com',
          https: true,
          createdAt: '2026-10-17T09:00:00.000Z',
          uniqueConfigKey: 9,
        },
      ]),
    ).toBe('https://old.example.com');
  });
});
