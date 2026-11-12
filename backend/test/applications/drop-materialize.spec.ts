import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { materializeDrop } from '../../src/applications/drop-archive';
import type { DropArchiveEntry } from '../../src/applications/drop-archive';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import type { ServerKeyProvider } from '../../src/remote/server-key.provider';
import { unverifiedHostKey } from '../../src/remote/host-key';

/**
 * ssh2 is a system boundary — mocked, as a loopback sshd rather than a
 * recorder (the shape `test/remote/remote-exec-remote-env.spec.ts` uses): the
 * exec request goes through a real `/bin/sh -c`, the way sshd hands it to the
 * account's login shell, with stdin wired to the channel. So a request too big
 * for one argument fails here exactly as it does on a Server.
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
        child = spawn('/bin/sh', ['-c', command]);
      } catch (error) {
        // E2BIG is thrown synchronously by spawn; sshd would fail the exec
        // and close the channel non-zero.
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

/**
 * Bytes as their SHA-256, so a mismatch in a 3 MB file is one line of diff and
 * not a jest walk over three million elements.
 */
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

const asTree = (entries: DropArchiveEntry[]) =>
  Object.fromEntries(
    entries.flatMap((entry) =>
      entry.content === null ? [] : [[entry.path, digest(entry.content)]],
    ),
  );

/**
 * A real project folder: a few hundred small files, a couple of large ones —
 * several MB in all, so both the one-file and the many-files case are past the
 * 128 KiB Linux allows a single argument (MAX_ARG_STRLEN), which the base64'd
 * tree used to be sent as.
 */
function projectTree(): DropArchiveEntry[] {
  const entries: DropArchiveEntry[] = [
    { path: 'src', content: null },
    { path: 'public/assets', content: null },
    { path: 'public/assets/bundle.bin', content: randomBytes(3 * 1024 * 1024) },
    { path: 'public/logo.png', content: randomBytes(600 * 1024) },
    { path: 'it\'s a "quoted" $(name).txt', content: Buffer.from('ok\n') },
  ];
  for (let index = 0; index < 400; index += 1) {
    entries.push({
      path: `src/module-${index}/index.js`,
      content: Buffer.from(`export const value = ${index};\n`.repeat(40)),
    });
  }
  return entries;
}

describe('materializeDrop', () => {
  let root: string;
  let code: string;

  beforeEach(() => {
    root = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'cloudgate-drop-'));
    code = nodePath.join(root, 'applications', 'drop-app', 'code');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('lands a several-MB tree on the platform host byte for byte', async () => {
    const entries = projectTree();

    await materializeDrop(new RemoteExecService(), null, code, entries);

    expect(treeAt(code)).toEqual(asTree(entries));
  });

  it('lands a several-MB tree on a Server byte for byte', async () => {
    const entries = projectTree();

    await materializeDrop(
      new RemoteExecService(keyProvider),
      'server-1',
      code,
      entries,
    );

    expect(treeAt(code)).toEqual(asTree(entries));
  });

  it('replaces the previous upload with a small one, and closes the Service directory', async () => {
    const service = new RemoteExecService();
    await materializeDrop(service, null, code, projectTree());

    const small: DropArchiveEntry[] = [
      { path: 'index.js', content: Buffer.from('console.log("hello");\n') },
      { path: 'src', content: null },
    ];
    await materializeDrop(service, null, code, small);

    // An upload replaces, it never merges: nothing of the large tree is left.
    expect(treeAt(code)).toEqual({
      'index.js': digest(Buffer.from('console.log("hello");\n')),
    });
    expect(fs.statSync(nodePath.dirname(code)).mode & 0o777).toBe(0o700);
  });
});
