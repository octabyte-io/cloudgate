import {
  BACKUP_COMMANDS,
  BACKUP_FILES_INCLUDE,
} from '../../src/backups/commands';

// `BACKUP_COMMANDS`' per-engine dump and restore builders — the docker-exec
// dump and import pipelines every backup/restore streams through rclone. Each
// expected literal is the exact command the builder emits. The three engines
// that authenticate name `$CLOUDGATE_DB_PASSWORD` and pass it through with
// `docker exec -e`, because a credential in a command string is
// journalled by `ExecError` (ADR 0015).
// `backup-credential-never-carried.spec.ts` is the property; these are the
// literals, and they are here so the password's spelling is visible rather
// than a reader's surprise.
describe('backup command builders', () => {
  it('postgres dump: pg_dump custom format piped to gzip', () => {
    expect(
      BACKUP_COMMANDS.postgres.dump({
        database: 'shop',
        databaseUser: 'shop_user',
      }).command,
    ).toBe(
      "docker exec -i $CONTAINER_ID bash -c 'set -o pipefail; pg_dump -Fc --no-acl --no-owner -h localhost -U shop_user --no-password shop | gzip'",
    );
  });

  it('postgres restore: pg_restore reading the dump from stdin', () => {
    expect(
      BACKUP_COMMANDS.postgres.restore({
        database: 'shop',
        databaseUser: 'shop_user',
      }).command,
    ).toBe(
      "docker exec -i $CONTAINER_ID sh -c 'pg_restore -U shop_user -d shop -O --clean --if-exists'",
    );
  });

  it('mysql dump: mysqldump as root piped to gzip', () => {
    expect(
      BACKUP_COMMANDS.mysql.dump({
        database: 'shop',
        databasePassword: 'r00t-secret',
      }).command,
    ).toBe(
      'docker exec -e CLOUDGATE_DB_PASSWORD -i $CONTAINER_ID bash -c \'set -o pipefail; mysqldump --default-character-set=utf8mb4 -u root --password="$CLOUDGATE_DB_PASSWORD" --single-transaction --no-tablespaces --quick shop | gzip\'',
    );
  });

  it('mysql restore: mysql client as root reading from stdin', () => {
    expect(
      BACKUP_COMMANDS.mysql.restore({
        database: 'shop',
        databasePassword: 'r00t-secret',
      }).command,
    ).toBe(
      'docker exec -e CLOUDGATE_DB_PASSWORD -i $CONTAINER_ID sh -c \'mysql -u root -p"$CLOUDGATE_DB_PASSWORD" shop\'',
    );
  });

  it('mariadb dump: mariadb-dump single transaction piped to gzip', () => {
    expect(
      BACKUP_COMMANDS.mariadb.dump({
        database: 'shop',
        databaseUser: 'shop_user',
        databasePassword: 's3cret',
      }).command,
    ).toBe(
      'docker exec -e CLOUDGATE_DB_PASSWORD -i $CONTAINER_ID bash -c \'set -o pipefail; mariadb-dump --user=shop_user --password="$CLOUDGATE_DB_PASSWORD" --single-transaction --quick --databases shop | gzip\'',
    );
  });

  it('mariadb restore: mariadb client reading from stdin', () => {
    expect(
      BACKUP_COMMANDS.mariadb.restore({
        database: 'shop',
        databaseUser: 'shop_user',
        databasePassword: 's3cret',
      }).command,
    ).toBe(
      'docker exec -e CLOUDGATE_DB_PASSWORD -i $CONTAINER_ID sh -c \'mariadb -u shop_user -p"$CLOUDGATE_DB_PASSWORD" shop\'',
    );
  });

  it('mongo dump: mongodump gzipped archive to stdout', () => {
    expect(BACKUP_COMMANDS.mongo.extension).toBe('bson.gz');
    expect(
      BACKUP_COMMANDS.mongo.dump({
        database: 'shop',
        databaseUser: 'shop_user',
        databasePassword: 's3cret',
      }).command,
    ).toBe(
      'docker exec -e CLOUDGATE_DB_PASSWORD -i $CONTAINER_ID bash -c \'set -o pipefail; mongodump -d shop -u shop_user -p "$CLOUDGATE_DB_PASSWORD" --archive --authenticationDatabase admin --gzip\'',
    );
  });

  it('mongo restore: mongorestore dropping and reading the archive', () => {
    expect(
      BACKUP_COMMANDS.mongo.restore({
        database: 'shop',
        databaseUser: 'shop_user',
        databasePassword: 's3cret',
      }).command,
    ).toBe(
      'docker exec -e CLOUDGATE_DB_PASSWORD -i $CONTAINER_ID sh -c \'mongorestore --username shop_user --password "$CLOUDGATE_DB_PASSWORD" --authenticationDatabase admin --db shop --archive --drop\'',
    );
  });

  it('libsql dump: tars the sqld data directory piped to gzip', () => {
    // A gzipped tar, and named as one — `.sql.gz` promised an SQL dump.
    expect(BACKUP_COMMANDS.libsql.extension).toBe('tar.gz');
    expect(BACKUP_COMMANDS.libsql.dump({ database: 'shop' }).command).toBe(
      "docker exec -i $CONTAINER_ID sh -c 'tar cf - -C /var/lib/sqld shop | gzip'",
    );
  });

  it('libsql restore: untars into the sqld data directory', () => {
    expect(BACKUP_COMMANDS.libsql.restore({ database: 'shop' }).command).toBe(
      "docker exec -i $CONTAINER_ID sh -c 'tar xzf - -C /var/lib/sqld'",
    );
  });
});

// Retention's `rclone lsf --include`. The pattern has to match every
// extension a dump is written under, or `keepLatestNBackups` silently stops
// pruning that engine — and `sql.gz` for as long as a LibSQL object written
// before the fix can still be in a bucket.
describe('BACKUP_FILES_INCLUDE', () => {
  const alternatives = (pattern: string) => {
    const match = /^\*\.\{([^}]*)\}$/.exec(pattern);
    if (!match) throw new Error(`not a *.{…} pattern: ${pattern}`);
    return match[1].split(',');
  };

  it('is the brace pattern the prune has always pinned, plus tar.gz', () => {
    expect(BACKUP_FILES_INCLUDE).toBe('*.{sql.gz,bson.gz,tar.gz}');
  });

  it.each(Object.entries(BACKUP_COMMANDS))(
    "covers %s's extension",
    (_engine, builder) => {
      expect(alternatives(BACKUP_FILES_INCLUDE)).toContain(builder.extension);
    },
  );

  it('still covers a LibSQL dump written as .sql.gz by older releases', () => {
    expect(alternatives(BACKUP_FILES_INCLUDE)).toContain('sql.gz');
  });
});
