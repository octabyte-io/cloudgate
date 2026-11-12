import { exec } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';

import { withArgvExec } from './exec-double';

/**
 * The platform host as a cloud Service's e2e drives it: a real bash for
 * `RemoteExecService.execAsync`, run under a temporary `CLOUDGATE_DIRECTORY`
 * with each fake program (`docker`, as a rule) ahead of `PATH`, and no
 * Server (`execAsyncRemote` answers nothing).
 *
 * One place for what eleven specs each wrote out (a review): the
 * root's save and restore, the fakes' `bin` and the shell around them.
 * `setUp` belongs in `beforeAll` before the app is made, `tearDown` in
 * `afterAll` after it is torn down.
 */
export function fakeBinShell(
  prefix: string,
  fakes: Readonly<Record<string, string>>,
) {
  const root = fs.mkdtempSync(
    nodePath.join(os.tmpdir(), `cloudgate-${prefix}-`),
  );
  const bin = nodePath.join(root, 'bin');
  const savedRoot = process.env.CLOUDGATE_DIRECTORY;

  const execMock = withArgvExec({
    execAsync: jest.fn(
      (command: string, options?: { env?: NodeJS.ProcessEnv }) =>
        new Promise((resolve, reject) => {
          exec(
            command,
            {
              shell: '/bin/bash',
              env: {
                ...process.env,
                ...options?.env,
                PATH: `${bin}:${process.env.PATH}`,
              },
            },
            (error, stdout, stderr) =>
              error
                ? reject(Object.assign(error, { stdout, stderr }))
                : resolve({ stdout, stderr, exitCode: 0 }),
          );
        }),
    ),
    execAsyncRemote: jest.fn(),
  });

  return {
    /** The temporary platform root, removed by `tearDown`. */
    root,
    execMock,
    setUp(): void {
      process.env.CLOUDGATE_DIRECTORY = root;
      fs.mkdirSync(bin);
      for (const [name, script] of Object.entries(fakes)) {
        fs.writeFileSync(nodePath.join(bin, name), script, { mode: 0o755 });
      }
    },
    tearDown(): void {
      if (savedRoot === undefined) delete process.env.CLOUDGATE_DIRECTORY;
      else process.env.CLOUDGATE_DIRECTORY = savedRoot;
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
