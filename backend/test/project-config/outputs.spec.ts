import {
  cloudTarget,
  outputsChangedBy,
  outputsOf,
  outputsWithoutValue,
  outputValues,
} from '../../src/project-config/outputs/outputs';
import {
  cloudStorageBucketValues,
  previewLinks,
} from '../../src/project-config/outputs/wired-env';

const SERVER = { tls: false, ca: null } as const;

describe('outputsOf and outputValues', () => {
  describe('the per-kind table', () => {
    it('lists postgres and redis Outputs, with ca only where the target reports a CA', () => {
      expect(outputsOf('postgres', { ca: false })).toEqual([
        'url',
        'host',
        'port',
        'user',
        'password',
        'database',
      ]);
      expect(outputsOf('postgres', { ca: true })).toContain('ca');
      expect(outputsOf('redis', { ca: false })).toEqual([
        'url',
        'host',
        'port',
        'password',
      ]);
      expect(outputsOf('redis', { ca: true })).toContain('ca');
    });

    it('lists the bucket Outputs, with no url and no ca on any target', () => {
      const bucket = [
        'name',
        'region',
        'endpoint',
        'access_key_id',
        'secret_access_key',
        'path_style',
      ];
      expect(outputsOf('bucket', { ca: false })).toEqual(bucket);
      expect(outputsOf('bucket', { ca: true })).toEqual(bucket);
    });

    it('lists the mysql Outputs as postgres does, with ca only where the target reports a CA', () => {
      expect(outputsOf('mysql', { ca: false })).toEqual([
        'url',
        'host',
        'port',
        'user',
        'password',
        'database',
      ]);
      expect(outputsOf('mysql', { ca: true })).toEqual([
        'url',
        'host',
        'port',
        'user',
        'password',
        'database',
        'ca',
      ]);
    });

    it.each(['web', 'worker', 'static', 'cron', 'mongo'])(
      'gives a %s nothing',
      (kind) => {
        expect(outputsOf(kind, { ca: true })).toEqual([]);
      },
    );
  });

  describe('values on a Server', () => {
    it('builds a postgres URL and its single parts', () => {
      const values = outputValues(
        { kind: 'postgres', user: 'shop', password: 's3cret', database: 'db' },
        { host: 'postgres-abc', port: 5432, ...SERVER },
      );
      expect(values).toEqual({
        url: 'postgresql://shop:s3cret@postgres-abc:5432/db',
        host: 'postgres-abc',
        port: '5432',
        user: 'shop',
        password: 's3cret',
        database: 'db',
      });
    });

    it('builds a mysql URL and its single parts', () => {
      const values = outputValues(
        { kind: 'mysql', user: 'shop', password: 's3cret', database: 'db' },
        { host: 'mysql-abc', port: 3306, ...SERVER },
      );
      expect(values).toEqual({
        url: 'mysql://shop:s3cret@mysql-abc:3306/db',
        host: 'mysql-abc',
        port: '3306',
        user: 'shop',
        password: 's3cret',
        database: 'db',
      });
    });

    it('builds a redis URL as the default user', () => {
      const values = outputValues(
        { kind: 'redis', password: 'tok' },
        { host: 'redis-abc', port: 6379, ...SERVER },
      );
      expect(values).toEqual({
        url: 'redis://default:tok@redis-abc:6379',
        host: 'redis-abc',
        port: '6379',
        password: 'tok',
      });
    });

    it('percent-encodes credentials in a URL, and only there', () => {
      const values = outputValues(
        { kind: 'postgres', user: 'a@b', password: 'p/w:@#', database: 'd' },
        { host: 'h', port: 5432, ...SERVER },
      );
      expect(values.url).toBe('postgresql://a%40b:p%2Fw%3A%40%23@h:5432/d');
      expect(values.password).toBe('p/w:@#');
      expect(new URL(values.url).password).toBe('p%2Fw%3A%40%23');
    });
  });

  describe('values of a bucket', () => {
    const uploads = {
      kind: 'bucket',
      name: 'uploads-k3j9x2ab',
      region: 'us-east-1',
      accessKeyId: 'GK3a1f',
      secretAccessKey: '9f8e7d',
      pathStyle: true,
    } as const;

    it("hands out its real name, region, key and path style, and the store's endpoint", () => {
      const values = outputValues(uploads, {
        host: 'bucket-abc',
        port: 3900,
        ...SERVER,
      });
      expect(values).toEqual({
        name: 'uploads-k3j9x2ab',
        region: 'us-east-1',
        endpoint: 'http://bucket-abc:3900',
        access_key_id: 'GK3a1f',
        secret_access_key: '9f8e7d',
        path_style: 'true',
      });
    });

    it('leaves the default port out of an endpoint, and says https where TLS is on', () => {
      expect(
        outputValues(uploads, {
          host: 'files.example.com',
          port: 443,
          tls: true,
          ca: null,
        }).endpoint,
      ).toBe('https://files.example.com');
      expect(
        outputValues(uploads, { host: 'files', port: 80, ...SERVER }).endpoint,
      ).toBe('http://files');
      expect(
        outputValues(
          { ...uploads, pathStyle: false },
          {
            host: 'h',
            port: 3900,
            ...SERVER,
          },
        ).path_style,
      ).toBe('false');
    });
  });

  describe('a bucket where the Service runs as its own role', () => {
    it('hands out no value for its key, and every other Output as on AWS', () => {
      const values = outputValues(
        {
          kind: 'bucket',
          name: 'uploads-k3f9a2qd-123456789012-eu-west-1-an',
          region: 'eu-west-1',
          accessKeyId: null,
          secretAccessKey: null,
          pathStyle: false,
        },
        { host: 's3.eu-west-1.amazonaws.com', port: 443, tls: true, ca: null },
      );
      expect(values).toEqual({
        name: 'uploads-k3f9a2qd-123456789012-eu-west-1-an',
        region: 'eu-west-1',
        endpoint: 'https://s3.eu-west-1.amazonaws.com',
        path_style: 'false',
      });
    });

    it('names the key Outputs as the ones with no value there, and none elsewhere', () => {
      expect(outputsWithoutValue('bucket', { ownRole: true })).toEqual([
        'access_key_id',
        'secret_access_key',
      ]);
      expect(outputsWithoutValue('bucket', { ownRole: false })).toEqual([]);
      expect(outputsWithoutValue('postgres', { ownRole: true })).toEqual([]);
      expect(outputsWithoutValue('web', { ownRole: true })).toEqual([]);
    });
  });

  describe('values where TLS is on', () => {
    const tls = { host: 'db.example', port: 5432, tls: true, ca: 'PEM' };

    it('asks a postgres client for TLS and hands out the CA', () => {
      const values = outputValues(
        { kind: 'postgres', user: 'u', password: 'p', database: 'd' },
        tls,
      );
      expect(values.url).toBe(
        'postgresql://u:p@db.example:5432/d?sslmode=require',
      );
      expect(values.ca).toBe('PEM');
    });

    it('gives a mysql URL no TLS parameter, and hands out the CA', () => {
      const values = outputValues(
        { kind: 'mysql', user: 'u', password: 'p/w@', database: 'd' },
        { ...tls, port: 3306 },
      );
      expect(values.url).toBe('mysql://u:p%2Fw%40@db.example:3306/d');
      expect(values.ca).toBe('PEM');
    });

    it('gives a redis URL the rediss scheme with the token as its password', () => {
      const values = outputValues(
        { kind: 'redis', password: 'tok' },
        { ...tls, port: 6379 },
      );
      expect(values.url).toBe('rediss://default:tok@db.example:6379');
    });

    it('gives a redis with no AUTH token a URL with no login, either scheme', () => {
      const source = { kind: 'redis', password: '' } as const;
      expect(outputValues(source, { ...tls, port: 6379 }).url).toBe(
        'rediss://db.example:6379',
      );
      expect(
        outputValues(source, { ...tls, tls: false, ca: null, port: 6379 }).url,
      ).toBe('redis://db.example:6379');
    });

    it('hands out no password at all for a redis with none, and a URL with no login (ADR-0042)', () => {
      expect(
        outputValues({ kind: 'redis', password: null }, { ...tls, port: 6379 }),
      ).toEqual({
        url: 'rediss://db.example:6379',
        host: 'db.example',
        port: '6379',
        ca: 'PEM',
      });
    });
  });

  describe('a bucket on Google Cloud (ADR-0032 as amended)', () => {
    it('has a value for every Output there, its key among them, unlike on AWS', () => {
      expect(outputsWithoutValue('bucket', cloudTarget('gcp'))).toEqual([]);
      expect(outputsWithoutValue('bucket', cloudTarget('aws'))).toEqual([
        'access_key_id',
        'secret_access_key',
      ]);
    });

    it("hands out its real name, region auto, Cloud Storage's S3 endpoint path-style and its HMAC key", () => {
      expect(
        cloudStorageBucketValues('cloudgate-xj4bnp4pahh6-a1b2c3d4', {
          accessKeyId: 'GOOG1EXAMPLEACCESSID',
          secretAccessKey: 'hmac-secret',
        }),
      ).toEqual({
        name: 'cloudgate-xj4bnp4pahh6-a1b2c3d4',
        region: 'auto',
        endpoint: 'https://storage.googleapis.com',
        access_key_id: 'GOOG1EXAMPLEACCESSID',
        secret_access_key: 'hmac-secret',
        path_style: 'true',
      });
    });
  });

  describe('a redis on Google Cloud (ADR-0042)', () => {
    it('names its password as the Output with no value there, and none on AWS', () => {
      expect(outputsWithoutValue('redis', cloudTarget('gcp'))).toEqual([
        'password',
      ]);
      expect(outputsWithoutValue('redis', cloudTarget('aws'))).toEqual([]);
      expect(outputsWithoutValue('postgres', cloudTarget('gcp'))).toEqual([]);
    });
  });
});

describe('outputsChangedBy', () => {
  it('names what a mysql login change changes, as for a postgres', () => {
    expect(outputsChangedBy('mysql', ['password'])).toEqual([
      'url',
      'password',
    ]);
    expect(outputsChangedBy('mysql', ['user', 'database'])).toEqual([
      'url',
      'user',
      'database',
    ]);
    expect(outputsChangedBy('mysql', ['size'])).toEqual([]);
  });
});

describe('previewLinks', () => {
  const links = {
    DATABASE_URL: { source: 'pg-1', output: 'url' },
    REDIS_URL: { source: 'redis', output: 'url' },
  };

  it("keeps the parent's links when previewEnv is unset or names none of them", () => {
    expect(previewLinks(links, null)).toBe(links);
    expect(previewLinks(links, 'NODE_ENV=staging')).toEqual(links);
  });

  it('drops each link previewEnv types a value for, even an empty one', () => {
    expect(
      previewLinks(links, 'NODE_ENV=staging\nDATABASE_URL=postgres://staging'),
    ).toEqual({ REDIS_URL: links.REDIS_URL });
    expect(previewLinks(links, 'REDIS_URL=')).toEqual({
      DATABASE_URL: links.DATABASE_URL,
    });
  });
});
