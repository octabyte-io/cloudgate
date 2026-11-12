import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LibsqlService } from '../../src/databases/libsql/libsql.service';

/**
 * What a saved `command` does to a LibSQL's start command.
 *
 * The console said a Command was *"saved and then ignored"*, and a Command of
 * `sqld` took a live database off the network: `containerCommand` honours the
 * column, and replaces the whole generated invocation with it — listen
 * addresses and `--db-path` included. The docblock records honouring it as
 * deliberate, so the console was changed to say so, and this pins the half it
 * now describes.
 */
describe('LibsqlService', () => {
  /** `containerCommand` as `deployInternal` calls it. `protected` keeps it off
   * the public surface; the DI arguments are stored and never touched by it. */
  type CommandProbe = {
    containerCommand(row: unknown): { Command: string[]; Args: string[] };
  };
  const libsql = new LibsqlService(
    ...([null, null, null, null, null] as unknown as [
      never,
      never,
      never,
      never,
      never,
    ]),
  ) as unknown as CommandProbe;

  // Written out rather than imported: `DEFAULT_SQLD_COMMAND` is not exported,
  // and an expectation derived from the constant would pin the test to itself.
  const generated =
    'sqld --db-path iku.db --http-listen-addr 0.0.0.0:8080 --grpc-listen-addr 0.0.0.0:5001 --admin-listen-addr 0.0.0.0:5000';

  describe('the start command', () => {
    it('starts sqld on every listener and on iku.db when no command is saved', () => {
      expect(
        libsql.containerCommand({ command: null, enableNamespaces: false }),
      ).toEqual({ Command: ['/bin/sh'], Args: ['-c', `exec ${generated}`] });
    });

    it('replaces the whole sqld invocation with a saved command, keeping only the namespaces flag', () => {
      expect(
        libsql.containerCommand({ command: 'sqld', enableNamespaces: true }),
      ).toEqual({
        Command: ['/bin/sh'],
        Args: ['-c', 'exec sqld --enable-namespaces'],
      });
      // Nothing of the generated launcher survives: no listen address, so
      // sqld's own default of 127.0.0.1:8080 is what runs.
      expect(
        libsql.containerCommand({ command: 'sqld', enableNamespaces: false })
          .Args[1],
      ).not.toContain('--http-listen-addr');
    });

    it('ignores args', () => {
      expect(
        libsql.containerCommand({
          command: null,
          args: ['--http-listen-addr', '127.0.0.1:9'],
          enableNamespaces: false,
        }),
      ).toEqual({ Command: ['/bin/sh'], Args: ['-c', `exec ${generated}`] });
    });
  });

  /**
   * The console carries a copy of the generated invocation (`launcher` in
   * `features/database/kinds.ts`), because it has to show it before any
   * deploy and no route answers it. A copy is what drifts: a flag changed here
   * would leave the Run command card telling an operator to carry the old one.
   */
  it('emits the launcher the console tells an operator a Command must carry', () => {
    const kinds = readFileSync(
      join(
        __dirname,
        '..',
        '..',
        '..',
        'frontend/src/features/database/kinds.ts',
      ),
      'utf8',
    );
    const emitted = libsql
      .containerCommand({ command: null, enableNamespaces: false })
      .Args[1].replace(/^exec /, '');

    expect(kinds).toContain(`"${emitted}"`);
  });
});
