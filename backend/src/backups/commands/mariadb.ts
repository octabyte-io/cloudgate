import { quote } from 'shell-quote';
import type { BackupCommandBuilder, DatabaseCredentials } from './types';
import { DATABASE_PASSWORD_REF, engineShellCommand } from './utils';

// `mariadb-dump` piped through gzip, and `mariadb` reading it back. The
// password travels in the environment rather than in the command — see
// `DATABASE_PASSWORD_ENV`; `mariadb.databasePassword` is `encryptedText`.
export const mariadbBackupCommands: BackupCommandBuilder = {
  extension: 'sql.gz',
  dump(credentials: DatabaseCredentials) {
    const { database, databaseUser } = credentials;
    return engineShellCommand(
      'bash',
      `set -o pipefail; mariadb-dump --user=${quote([databaseUser ?? ''])} --password=${DATABASE_PASSWORD_REF} --single-transaction --quick --databases ${quote([database])} | gzip`,
      credentials,
    );
  },
  restore(credentials: DatabaseCredentials) {
    const { database, databaseUser } = credentials;
    return engineShellCommand(
      'sh',
      `mariadb -u ${quote([databaseUser ?? ''])} -p${DATABASE_PASSWORD_REF} ${quote([database])}`,
      credentials,
    );
  },
};
