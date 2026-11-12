import { bucketDomainRefusal } from '../../src/domains/bucket-domain';

describe('bucketDomainRefusal', () => {
  it('takes a whole-host Domain on Garage S3 port, sent or left out', () => {
    expect(bucketDomainRefusal({})).toBeNull();
    expect(
      bucketDomainRefusal({
        port: 3900,
        path: '/',
        internalPath: '/',
        stripPath: false,
      }),
    ).toBeNull();
  });

  it.each([
    [{ port: 8080 }, 'port: the port is always 3900'],
    [{ path: '/files' }, 'path: a path breaks every signed request'],
    [{ internalPath: '/files' }, 'internalPath: a rewritten path'],
    [{ stripPath: true }, 'stripPath: a rewritten path'],
    [{ serviceName: 'web' }, 'serviceName: a compose service'],
    [
      { forwardAuthEnabled: true },
      'forwardAuthEnabled: an S3 client cannot sign in',
    ],
  ])('refuses %j, naming the field', (row, words) => {
    expect(bucketDomainRefusal(row)).toContain(words);
  });
});
