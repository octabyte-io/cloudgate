import { quote } from 'shell-quote';
import type { BackupCommandBuilder, DatabaseCredentials } from './types';
import { engineShellCommand } from './utils';

// `pg_dump -Fc` piped through gzip, and `pg_restore` reading it back.
//
// No credential in either direction, and the claim to that effect was
// checked rather than taken: `pg_dump` is given `--no-password`, which makes it
// *refuse* to prompt, and both commands run inside the postgres container as
// its own superuser over the local socket, where the image's `pg_hba.conf`
// trusts the local peer. So there is nothing to move into the environment here
// and `engineShellCommand` is called without credentials — which is also what
// keeps the emitted string byte-identical to the one before the change.
export const postgresBackupCommands: BackupCommandBuilder = {
  extension: 'sql.gz',
  dump({ database, databaseUser }: DatabaseCredentials) {
    return engineShellCommand(
      'bash',
      `set -o pipefail; pg_dump -Fc --no-acl --no-owner -h localhost -U ${quote([databaseUser ?? ''])} --no-password ${quote([database])} | gzip`,
    );
  },
  restore({ database, databaseUser }: DatabaseCredentials) {
    return engineShellCommand(
      'sh',
      `pg_restore -U ${quote([databaseUser ?? ''])} -d ${quote([database])} -O --clean --if-exists`,
    );
  },
};
