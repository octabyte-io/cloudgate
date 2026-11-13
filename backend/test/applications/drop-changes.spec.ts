import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { ConflictException } from '@nestjs/common';

import type { DropArchiveEntry } from '../../src/applications/drop-archive';
import {
  applyDropChanges,
  applyDropChangesCommand,
  readBuildHostTree,
} from '../../src/applications/drop-changes';
import { unverifiedHostKey } from '../../src/remote/host-key';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import type { ServerKeyProvider } from '../../src/remote/server-key.provider';

/**
 * ssh2 is a system boundary — mocked, as a loopback sshd rather than a
 * recorder (`drop-materialize.spec.ts`'s shape): the exec request goes through
 * a real `/bin/sh -c`, the way sshd hands it to the account's login shell,
 * with stdin wired to the channel. So the programs run on a "Server" exactly
 * as they would there, a program too big for one argument included.
 */
jest.mock('ssh2', () => {
  type Callback = (err: Error | undefined, stream: unknown) => void;

  class Client extends EventEmitter {
    exec(command: string, callback: Callback) {
      const stream = new EventEmitter() as EventEmitter & {
        stderr: EventEmitter;
        write: (chunk: string) => boolean;
        end: (chunk?: string) => unknown;
      };
      stream.stderr = new EventEmitter();
      let child: ReturnType<typeof spawn>;
      try {
        // The test's own environment, which Jest keeps apart from the one
        // `spawn` would otherwise hand the child: a test puts a `mv` first
        // on its PATH.
        child = spawn('/bin/sh', ['-c', command], { env: process.env });
      } catch (error) {
        callback(undefined, stream);
        process.nextTick(() => {
          stream.stderr.emit('data', String(error));
          stream.emit('close', 126);
        });
        return this;
      }
      child.on('error', (error) => {
        stream.stderr.emit('data', String(error));
        stream.emit('close', 126);
      });
      stream.write = (chunk: string) => child.stdin?.write(chunk) ?? false;
      stream.end = (chunk?: string) => {
        if (chunk !== undefined) child.stdin?.write(chunk);
        child.stdin?.end();
        return stream;
      };
      child.stdout?.on('data', (data: Buffer) =>
        stream.emit('data', data.toString()),
      );
      child.stderr?.on('data', (data: Buffer) =>
        stream.stderr.emit('data', data.toString()),
      );
      child.on('close', (code: number | null) =>
        stream.emit('close', code ?? 0),
      );
      callback(undefined, stream);
      return this;
    }

    connect() {
      process.nextTick(() => this.emit('ready'));
      return this;
    }

    end() {}
  }
  return { Client };
});

const keyProvider: ServerKeyProvider = {
  getConnection: () =>
    Promise.resolve({
      host: '203.0.113.10',
      port: 22,
      username: 'deploy',
      privateKey: 'fake',
      hostKey: unverifiedHostKey(),
    }),
};

const digest = (bytes: Buffer) =>
  createHash('sha256').update(bytes).digest('hex');

/** The tree as it now is on disk under `root`, as {relative path: digest}. */
function treeAt(root: string): Record<string, string> {
  const found: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = nodePath.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else found[nodePath.relative(root, full)] = digest(fs.readFileSync(full));
    }
  };
  walk(root);
  return found;
}

/** `entries` laid down under `root`, as a build host's code directory. */
function plant(root: string, entries: DropArchiveEntry[]) {
  for (const entry of entries) {
    const full = nodePath.join(root, entry.path);
    if (entry.content === null) {
      fs.mkdirSync(full, { recursive: true });
    } else {
      fs.mkdirSync(nodePath.dirname(full), { recursive: true });
      fs.writeFileSync(full, entry.content);
    }
  }
}

const listOf = (entries: DropArchiveEntry[]) =>
  entries.flatMap((entry) =>
    entry.content === null
      ? []
      : [{ path: entry.path, sha256: digest(entry.content) }],
  );

/**
 * A real project folder, several MB: a few hundred small files and a couple
 * of large ones, so the changes alone are past the 128 KiB Linux allows one
 * argument, and names a shell or a newline-ended listing would trip over.
 */
function projectTree(): DropArchiveEntry[] {
  const entries: DropArchiveEntry[] = [
    { path: 'public/assets/bundle.bin', content: randomBytes(3 * 1024 * 1024) },
    { path: 'public/logo.png', content: randomBytes(600 * 1024) },
    { path: 'it\'s a "quoted" $(name).txt', content: Buffer.from('ok\n') },
    { path: 'back\\slash.txt', content: Buffer.from('b\n') },
    { path: 'new\nline.txt', content: Buffer.from('n\n') },
  ];
  for (let index = 0; index < 400; index += 1) {
    entries.push({
      path: `src/module-${index}/index.js`,
      content: Buffer.from(`export const value = ${index};\n`.repeat(40)),
    });
  }
  return entries;
}

let root: string;
let code: string;
const onServer = new RemoteExecService(keyProvider);

beforeEach(() => {
  root = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'cloudgate-changes-'));
  code = nodePath.join(root, 'applications', 'drop-app', 'code');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('readBuildHostTree', () => {
  it('reads a tree on a Server with every name as it is', async () => {
    const entries = projectTree();
    plant(code, entries);
    fs.symlinkSync('src', nodePath.join(code, 'linked'));

    const tree = await readBuildHostTree(onServer, 'server-1', code);

    expect(Object.fromEntries(tree)).toEqual({
      ...Object.fromEntries(
        listOf(entries).map((file) => [file.path, file.sha256]),
      ),
      linked: '-',
    });
  });
});

describe('applyDropChanges', () => {
  it('lands several MB of changes on a Server, with the deletions, byte for byte', async () => {
    const previous = projectTree();
    plant(code, previous);
    fs.symlinkSync('src', nodePath.join(code, 'linked'));
    const changed: DropArchiveEntry[] = [
      {
        path: 'public/assets/bundle.bin',
        content: randomBytes(2 * 1024 * 1024),
      },
      { path: 'src/added/new.js', content: Buffer.from('export {};\n') },
    ];
    const kept = previous.filter(
      (entry) =>
        entry.path !== 'public/assets/bundle.bin' &&
        entry.path !== 'public/logo.png' &&
        entry.path !== 'src/module-7/index.js',
    );
    const folder = [...kept, ...changed];

    await applyDropChanges(onServer, 'server-1', code, listOf(folder), changed);

    expect(treeAt(code)).toEqual(
      Object.fromEntries(listOf(folder).map((f) => [f.path, f.sha256])),
    );
    expect(fs.existsSync(nodePath.join(code, 'src/module-7'))).toBe(false);
    expect(fs.readdirSync(nodePath.dirname(code))).toEqual(['code']);
    expect(fs.statSync(nodePath.dirname(code)).mode & 0o777).toBe(0o700);
  });

  it('leaves the previous tree on a Server when the result does not match the list', async () => {
    const previous = projectTree();
    plant(code, previous);
    const before = treeAt(code);
    const list = listOf(previous).map((file) =>
      file.path === 'src/module-1/index.js'
        ? { ...file, sha256: digest(Buffer.from('what the folder holds\n')) }
        : file,
    );

    await expect(
      applyDropChanges(onServer, 'server-1', code, list, []),
    ).rejects.toThrow(ConflictException);

    expect(treeAt(code)).toEqual(before);
    expect(fs.readdirSync(nodePath.dirname(code))).toEqual(['code']);
  });

  describe('a swap that fails half-way', () => {
    let originalPath: string | undefined;
    let shims: string;

    beforeEach(() => {
      // A `mv` that refuses to move the new tree into place, and moves
      // anything else as the real one does: the Server's first move (the
      // previous tree out of the way) succeeds, the second fails.
      shims = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'cloudgate-mv-'));
      const realMv = execFileSync('/bin/sh', ['-c', 'command -v mv'])
        .toString()
        .trim();
      fs.writeFileSync(
        nodePath.join(shims, 'mv'),
        `#!/bin/sh\ncase "$1" in */tree) echo "mv: refused" >&2; exit 1;; esac\nexec ${realMv} "$@"\n`,
        { mode: 0o755 },
      );
      originalPath = process.env.PATH;
      process.env.PATH = `${shims}:${originalPath}`;
    });

    afterEach(() => {
      process.env.PATH = originalPath;
      fs.rmSync(shims, { recursive: true, force: true });
    });

    it('puts the previous tree back on a Server and answers a conflict', async () => {
      const previous = projectTree();
      plant(code, previous);
      const before = treeAt(code);
      const changed: DropArchiveEntry[] = [
        { path: 'src/added/new.js', content: Buffer.from('export {};\n') },
      ];

      await expect(
        applyDropChanges(
          onServer,
          'server-1',
          code,
          listOf([...previous, ...changed]),
          changed,
        ),
      ).rejects.toThrow(ConflictException);

      expect(treeAt(code)).toEqual(before);
      // The working directory went once the previous tree was back.
      expect(fs.readdirSync(nodePath.dirname(code))).toEqual(['code']);
    });
  });
});

/**
 * The SSH connection dropping mid-apply. The session has no tty, so killing
 * `sshd-session` sends the apply's `sh -s` no SIGHUP and its hangup trap
 * never fires: it went on and swapped its tree in after the backend had
 * already answered 409, unsupervised beside the CLI's retried apply (#29).
 * What it does see is its output: the channel's other end is gone, so a write
 * fails. Run here as `sh -s` with that end already closed.
 */
describe('applyDropChangesCommand, its connection gone', () => {
  it('swaps nothing in once nothing reads its output, and leaves the previous tree', async () => {
    const previous: DropArchiveEntry[] = [
      { path: 'index.js', content: Buffer.from('old\n') },
    ];
    plant(code, previous);
    const next: DropArchiveEntry[] = [
      { path: 'index.js', content: Buffer.from('new\n') },
    ];

    const child = spawn('/bin/sh', ['-s'], { stdio: ['pipe', 'pipe', 'pipe'] });
    // The reading end of its output, closed as a dead SSH channel's is.
    child.stdout.destroy();
    child.stdin.end(applyDropChangesCommand(code, listOf(next), next));
    const exitCode = await new Promise<number | null>((resolve) =>
      child.on('close', (code) => resolve(code)),
    );

    expect(exitCode).not.toBe(0);
    expect(treeAt(code)).toEqual(
      Object.fromEntries(listOf(previous).map((f) => [f.path, f.sha256])),
    );
    expect(fs.readdirSync(nodePath.dirname(code))).toEqual(['code']);
  });
});
