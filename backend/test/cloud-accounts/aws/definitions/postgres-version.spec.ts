import { rdsPostgresVersion } from '../../../../src/cloud-accounts/aws/definitions/postgres-version';
import { rdsNameRefusal } from '../../../../src/cloud-accounts/aws/definitions/rds-names';

describe('rdsPostgresVersion (spec "Version rules")', () => {
  it("runs a major alone on RDS's default minor, with automatic minor upgrades", () => {
    expect(rdsPostgresVersion('pg-1', 'postgres:17')).toEqual({
      ok: true,
      version: {
        written: '17',
        major: 17,
        minor: null,
        engineVersion: '17',
        autoMinorUpgrade: true,
        droppedSuffix: null,
      },
    });
  });

  it('pins a major and minor, with automatic minor upgrades off', () => {
    expect(rdsPostgresVersion('pg-1', 'postgres:17.2')).toMatchObject({
      ok: true,
      version: {
        written: '17.2',
        engineVersion: '17.2',
        autoMinorUpgrade: false,
      },
    });
  });

  it.each([
    ['postgres:17-alpine', '17', '-alpine'],
    ['postgres:16.4-bookworm', '16.4', '-bookworm'],
  ])(
    'drops an image suffix and says so: %s',
    (image, engineVersion, dropped) => {
      expect(rdsPostgresVersion('pg-1', image)).toMatchObject({
        ok: true,
        version: { engineVersion, droppedSuffix: dropped },
      });
    },
  );

  it('keeps what the config wrote', () => {
    const read = rdsPostgresVersion('pg-1', 'postgres:17-alpine');

    expect(read.ok && read.version.written).toBe('17-alpine');
  });

  it.each(['postgres:12', 'postgres:19', 'postgres:9.6'])(
    'refuses a version RDS does not offer, naming it: %s',
    (image) => {
      const read = rdsPostgresVersion('pg-1', image);

      expect(read.ok).toBe(false);
      if (read.ok) return;
      expect(read.refusal.at).toBe('pg-1.version');
      expect(read.refusal.message).toContain(
        `PostgreSQL ${image.slice(9).split('.')[0]} is not offered by RDS`,
      );
    },
  );

  it('refuses a version that is no number', () => {
    const read = rdsPostgresVersion('pg-1', 'postgres:latest');

    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.refusal.message).toContain('latest');
  });
});

describe('rdsNameRefusal (US18)', () => {
  it.each(['app', 'app_pg_1', 'Admin2', 'postgres', 'a'.repeat(63)])(
    'takes %s',
    (name) => {
      expect(rdsNameRefusal('pg-1', 'user', name)).toBeNull();
    },
  );

  it.each([
    ['app-user', 'letters, digits or underscores'],
    ['1app', 'starting with a letter'],
    ['_app', 'starting with a letter'],
    ['a'.repeat(64), '1 to 63'],
    ['rdsadmin', 'reserved word'],
    ['RDSADMIN', 'reserved word'],
    ['user', 'reserved word'],
    ['pg_1', 'PostgreSQL reserves role names starting with pg_'],
    ['PG_admin', 'choose another user:'],
  ])('refuses %s, naming the field', (name, why) => {
    const refusal = rdsNameRefusal('pg-1', 'user', name);

    expect(refusal?.at).toBe('pg-1.user');
    expect(refusal?.message).toContain('pg-1.user');
    expect(refusal?.message).toContain(why);
  });

  it('takes pg_1 as a database, since only role names are reserved', () => {
    expect(rdsNameRefusal('pg-1', 'database', 'pg_1')).toBeNull();
  });

  it('names the database field for a database name', () => {
    expect(rdsNameRefusal('pg-1', 'database', 'my-db')?.at).toBe(
      'pg-1.database',
    );
  });
});
