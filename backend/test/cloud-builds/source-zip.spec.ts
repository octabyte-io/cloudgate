import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { readDropArchive } from '../../src/applications/drop-archive';
import { writeSourceZip } from '../../src/cloud-builds/source-zip';

/**
 * The source zip a hosted cloud build uploads: read back by
 * Cloudgate's own drop reader and by Info-ZIP's `unzip`, which is what a
 * build service's extraction behaves like.
 */
describe('writeSourceZip', () => {
  let root: string;
  let tree: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'source-zip-'));
    tree = path.join(root, 'code');
    fs.mkdirSync(path.join(tree, 'src/empty'), { recursive: true });
    fs.mkdirSync(path.join(tree, '.git'), { recursive: true });
    fs.mkdirSync(path.join(tree, 'vendor/lib/.git'), { recursive: true });
    fs.writeFileSync(
      path.join(tree, '.git/config'),
      '[remote "origin"]\n  url = https://oauth2:ghs_secret@github.com/acme/shop\n',
    );
    fs.writeFileSync(path.join(tree, 'vendor/lib/.git/HEAD'), 'ref: main\n');
    fs.writeFileSync(path.join(tree, 'package.json'), '{"name":"shop"}\n');
    fs.writeFileSync(path.join(tree, 'src/index.js'), 'x'.repeat(10_000));
    fs.writeFileSync(path.join(tree, 'gradlew'), '#!/bin/sh\n', {
      mode: 0o755,
    });
    fs.symlinkSync('src/index.js', path.join(tree, 'main.js'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('holds the tree under its folder and the files beside it, never a .git', async () => {
    const zip = path.join(root, 'source.zip');
    const written = await writeSourceZip(zip, {
      tree: { path: tree, under: 'code/' },
      files: [
        { path: 'cloudgate/build.sh', content: 'echo hi\n', mode: 0o755 },
      ],
    });

    const entries = readDropArchive(fs.readFileSync(zip));
    expect(entries.map((entry) => entry.path).sort()).toEqual(
      [
        'code',
        'code/gradlew',
        'code/main.js',
        'code/package.json',
        'code/src',
        'code/src/empty',
        'code/src/index.js',
        'code/vendor',
        'code/vendor/lib',
        'cloudgate/build.sh',
      ].sort(),
    );
    const content = (name: string) =>
      entries.find((entry) => entry.path === name)?.content?.toString('utf8');
    expect(content('code/src/index.js')).toBe('x'.repeat(10_000));
    expect(content('cloudgate/build.sh')).toBe('echo hi\n');
    expect(fs.readFileSync(zip).toString('latin1')).not.toContain('ghs_secret');
    expect(written).toEqual({
      entries: 10,
      bytes: fs.statSync(zip).size,
    });
  });

  it('extracts with unzip as the checkout was: modes, a symlink and an empty folder', async () => {
    const zip = path.join(root, 'source.zip');
    await writeSourceZip(zip, { tree: { path: tree, under: 'code/' } });
    const out = path.join(root, 'out');
    execFileSync('unzip', ['-q', zip, '-d', out]);

    expect(fs.statSync(path.join(out, 'code/gradlew')).mode & 0o777).toBe(
      0o755,
    );
    expect(fs.lstatSync(path.join(out, 'code/main.js')).isSymbolicLink()).toBe(
      true,
    );
    expect(fs.readlinkSync(path.join(out, 'code/main.js'))).toBe(
      'src/index.js',
    );
    expect(fs.statSync(path.join(out, 'code/src/empty')).isDirectory()).toBe(
      true,
    );
    expect(fs.readFileSync(path.join(out, 'code/package.json'), 'utf8')).toBe(
      '{"name":"shop"}\n',
    );
    expect(fs.existsSync(path.join(out, 'code/.git'))).toBe(false);
  });

  it('writes zip64 end records for more than 65,535 entries, which unzip reads', async () => {
    const many = path.join(root, 'many');
    fs.mkdirSync(many);
    const zip = path.join(root, 'many.zip');
    const written = await writeSourceZip(zip, {
      tree: { path: many, under: 'code/' },
      files: Array.from({ length: 70_000 }, (_, at) => ({
        path: `code/f${at}`,
        content: '',
      })),
    });
    expect(written.entries).toBe(70_001);
    const listed = execFileSync('unzip', ['-Z1', zip], {
      maxBuffer: 64 * 1024 * 1024,
    })
      .toString('utf8')
      .trim()
      .split('\n');
    expect(listed).toHaveLength(70_001);
  }, 120_000);
});
