import { quote } from 'shell-quote';
import type { BackupCommandBuilder, DatabaseCredentials } from './types';
import { DATABASE_PASSWORD_REF, engineShellCommand } from './utils';

// MySQL always dumps and restores as root, so databasePassword carries the root
// password.
//
// Both directions read the password out of the environment rather than taking
// it as a word of the command — `DATABASE_PASSWORD_ENV` carries why, and
// `mysql.databaseRootPassword` is the `encryptedText` column at the other end.
export const mysqlBackupCommands: BackupCommandBuilder = {
  extension: 'sql.gz',
  dump(credentials: DatabaseCredentials) {
    const { database } = credentials;
    return engineShellCommand(
      'bash',
      `set -o pipefail; mysqldump --default-character-set=utf8mb4 -u root --password=${DATABASE_PASSWORD_REF} --single-transaction --no-tablespaces --quick ${quote([database])} | gzip`,
      credentials,
    );
  },
  restore(credentials: DatabaseCredentials) {
    const { database } = credentials;
    // `-p` takes its value attached, with no space — so the reference is
    // concatenated onto the flag. It is already double-quoted, which keeps the
    // expansion one word without splitting the flag off it.
    return engineShellCommand(
      'sh',
      `mysql -u root -p${DATABASE_PASSWORD_REF} ${quote([database])}`,
      credentials,
    );
  },
};
