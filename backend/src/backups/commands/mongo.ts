import { quote } from 'shell-quote';
import type { BackupCommandBuilder, DatabaseCredentials } from './types';
import { DATABASE_PASSWORD_REF, engineShellCommand } from './utils';

// mongodump's --gzip archive streams to stdout, so the pipeline has no separate
// gzip.
//
// The password travels in the environment rather than in the command.
// The MongoDB Database Tools have no password environment variable of their own
// — the alternatives are `--config`, a YAML file that would have to be written
// inside the container, and an interactive prompt that needs a TTY `docker exec
// -i` does not give it — so the flag stays and only its value moves. The
// suggestion of "a URI on stdin" is not a mechanism these tools have, and stdin
// is taken by the archive on the restore side regardless.
// `mongo.databasePassword` is `encryptedText`.
export const mongoBackupCommands: BackupCommandBuilder = {
  extension: 'bson.gz',
  dump(credentials: DatabaseCredentials) {
    const { database, databaseUser } = credentials;
    return engineShellCommand(
      'bash',
      `set -o pipefail; mongodump -d ${quote([database])} -u ${quote([databaseUser ?? ''])} -p ${DATABASE_PASSWORD_REF} --archive --authenticationDatabase admin --gzip`,
      credentials,
    );
  },
  restore(credentials: DatabaseCredentials) {
    const { database, databaseUser } = credentials;
    return engineShellCommand(
      'sh',
      `mongorestore --username ${quote([databaseUser ?? ''])} --password ${DATABASE_PASSWORD_REF} --authenticationDatabase admin --db ${quote([database])} --archive --drop`,
      credentials,
    );
  },
};
