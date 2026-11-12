import { backup, backupServiceFk } from '../../src/backups/backup.schema';
import { listBackupsSchema } from '../../src/backups/dto/backup.dto';

// `GET /backups?serviceId=&serviceType=` — the list-by-service query, mirroring
// mounts'. Its serviceType vocabulary is load-bearing twice over: it picks the
// backup FK column filtered on, and it picks the table the ownership lookup
// joins through. A value with no backup FK must never reach the service.
describe('listBackupsSchema', () => {
  it('accepts every service a backup can hang off', () => {
    for (const serviceType of [
      'postgres',
      'mysql',
      'mariadb',
      'mongo',
      'libsql',
      'compose',
    ]) {
      expect(
        listBackupsSchema.parse({ serviceId: 'svc-1', serviceType }),
      ).toEqual({ serviceId: 'svc-1', serviceType });
    }
  });

  it('rejects a service type the backup table has no FK for', () => {
    // Redis has no dump command (BACKUP_COMMANDS has no entry) and
    // applications are not backed up — neither has a backup_* column.
    for (const serviceType of ['redis', 'application', 'web-server', '']) {
      expect(
        listBackupsSchema.safeParse({ serviceId: 'svc-1', serviceType })
          .success,
      ).toBe(false);
    }
  });

  it('rejects a query with no service', () => {
    expect(
      listBackupsSchema.safeParse({ serviceType: 'postgres' }).success,
    ).toBe(false);
    expect(
      listBackupsSchema.safeParse({ serviceId: '', serviceType: 'postgres' })
        .success,
    ).toBe(false);
  });

  it('maps each accepted service type to that service’s FK column', () => {
    // Read off the drizzle table rather than restated, so a renamed column
    // cannot silently point a listing at the wrong FK.
    expect(backupServiceFk).toEqual({
      postgres: backup.postgresId,
      mysql: backup.mysqlId,
      mariadb: backup.mariadbId,
      mongo: backup.mongoId,
      libsql: backup.libsqlId,
      compose: backup.composeId,
    });
    expect(Object.keys(backupServiceFk).sort()).toEqual(
      listBackupsSchema.shape.serviceType.options.slice().sort(),
    );
  });
});
