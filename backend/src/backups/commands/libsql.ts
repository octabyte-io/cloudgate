import { quote } from 'shell-quote';
import type { BackupCommandBuilder, DatabaseCredentials } from './types';
import { engineShellCommand } from './utils';

// sqld has no dump tool, so the database directory is tarred whole (the z flag
// on restore undoes the piped gzip).
//
// Named `.tar.gz` because that is what it is. It was `.sql.gz`, which
// told an operator — or a tool — reading the bucket to pipe it into an SQL
// client. Objects written under the old name stay restorable: the restore picks
// its pipeline by the row's engine (`BackupsService.restore`), never by the
// object's extension, and retention still matches `sql.gz`
// (`BACKUP_FILES_INCLUDE`).
export const libsqlBackupCommands: BackupCommandBuilder = {
  extension: 'tar.gz',
  dump({ database }: DatabaseCredentials) {
    return engineShellCommand(
      'sh',
      `tar cf - -C /var/lib/sqld ${quote([database])} | gzip`,
    );
  },
  // sqld restores need no credentials — the tarball just unpacks in place.
  restore() {
    return engineShellCommand('sh', 'tar xzf - -C /var/lib/sqld');
  },
};
