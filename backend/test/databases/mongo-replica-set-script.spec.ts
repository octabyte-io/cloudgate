import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MongoService } from '../../src/databases/mongo/mongo.service';

/**
 * The replica-set bootstrap, run under real bash with stub `mongod` and
 * `mongosh` on the PATH.
 *
 * The bootstrap is PID 1 of the container, so the container lives exactly as
 * long as it does. It used to loop on a `mongosh` ping for ever when mongod had
 * exited at startup — a data directory the image could not read, exit 62 — so
 * Swarm saw a running task, neither restarted nor rolled back, and the deploy
 * read `done` over a server that refused every connection. What is pinned here
 * is the shell's own behaviour, not the text of the script: that it ends with
 * mongod's exit status, before readiness and after it, and with or without a
 * saved Run command.
 */
// Each case waits up to 15 s for the script to exit — the bound that tells
// "exits" from "loops for ever" — so the default 5 s would cut it short.
jest.setTimeout(30_000);

describe('MongoService', () => {
  /** `containerCommand` as `deployInternal` calls it; the DI arguments are
   * stored and never touched by it. */
  type CommandProbe = {
    containerCommand(row: unknown): { Command: string[]; Args: string[] };
  };
  const mongo = new MongoService(
    ...([null, null, null, null, null] as unknown as [
      never,
      never,
      never,
      never,
      never,
    ]),
  ) as unknown as CommandProbe;

  const scriptFor = (command: string | null): string => {
    const { Command, Args } = mongo.containerCommand({
      appName: 'main-db',
      replicaSets: true,
      command,
    });
    expect(Command).toEqual(['/bin/bash']);
    expect(Args[0]).toBe('-c');
    return Args[1];
  };

  let dir: string;
  let running: { pid: number } | null = null;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cg-mongo-rs-'));
  });

  afterEach(() => {
    // The script under test is its own process group, so a bootstrap that
    // loops for ever — the defect — takes its stubs with it here and does not
    // outlive the suite.
    if (running) {
      try {
        process.kill(-running.pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
      running = null;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  /** Writes an executable stub into the PATH directory. */
  const stub = (name: string, body: string) => {
    const path = join(dir, name);
    writeFileSync(path, `#!/bin/bash\n${body}\n`);
    chmodSync(path, 0o755);
  };

  /**
   * Runs the script and resolves with its exit status, or `'timeout'` once
   * `withinMs` has passed — the bounded time that tells "exits" from "loops".
   */
  const run = (
    script: string,
    withinMs: number,
    onStart?: (pid: number) => void,
  ): Promise<{ code: number | null; signal: string | null } | 'timeout'> =>
    new Promise((resolve) => {
      const child = spawn('bash', ['-c', script], {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, STUBS: dir },
      });
      running = { pid: child.pid! };
      const timer = setTimeout(() => resolve('timeout'), withinMs);
      child.on('exit', (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal });
      });
      onStart?.(child.pid!);
    });

  /** A mongosh that answers every question: ping succeeds, and the set is
   * already initiated, so the script goes straight to its tail. */
  const readyMongosh = () =>
    stub('mongosh', 'touch "$STUBS/ready"\necho 1\nexit 0');

  it('exits with mongod’s status when mongod exits before it is ready', async () => {
    stub('mongod', 'exit 62');
    stub('mongosh', 'exit 1');

    await expect(run(scriptFor(null), 15_000)).resolves.toEqual({
      code: 62,
      signal: null,
    });
  });

  it('exits with mongod’s status when mongod exits after the replica set is ready', async () => {
    stub('mongod', 'sleep 2\nexit 62');
    readyMongosh();

    await expect(run(scriptFor(null), 15_000)).resolves.toEqual({
      code: 62,
      signal: null,
    });
    expect(existsSync(join(dir, 'ready'))).toBe(true);
  });

  it('still exits with mongod’s status under a saved Run command that never returns', async () => {
    // The saved command used to *replace* the tail's `wait`, so a
    // long-running one left nothing watching mongod at all.
    stub('mongod', 'sleep 2\nexit 62');
    readyMongosh();

    await expect(
      run(scriptFor('touch "$STUBS/command-ran"; sleep 600'), 15_000),
    ).resolves.toEqual({ code: 62, signal: null });
    expect(existsSync(join(dir, 'command-ran'))).toBe(true);
  });

  it.each([
    ['no saved Run command', null],
    // A foreground command used to defer the trap until it returned, so a
    // Stop waited out the whole grace period; in the background it cannot.
    ['a saved Run command that never returns', 'sleep 600'],
  ])(
    'a Stop still reaches mongod and ends the script cleanly, with %s',
    async (_, command) => {
      // The trap, which this change must not lose: SIGTERM to the shell is
      // relayed to mongod, and the shell exits 0 once mongod has flushed.
      stub(
        'mongod',
        'trap \'touch "$STUBS/mongod-stopped"; exit 0\' TERM\nwhile :; do sleep 0.1; done',
      );
      readyMongosh();

      const outcome = run(scriptFor(command), 15_000, (pid) => {
        const poll = setInterval(() => {
          if (!existsSync(join(dir, 'ready'))) return;
          clearInterval(poll);
          // Give the script a moment past the ping to reach its tail.
          setTimeout(() => process.kill(pid, 'SIGTERM'), 500);
        }, 50);
      });

      await expect(outcome).resolves.toEqual({ code: 0, signal: null });
      expect(existsSync(join(dir, 'mongod-stopped'))).toBe(true);
    },
  );
});
