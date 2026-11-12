import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { selectUploadFiles, summarizeUpload } from '../src/upload-files.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cloudgate-upload-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Writes each `path: content` under the folder, making its folders. */
function folder(files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
}

const uploaded = () => selectUploadFiles(root).files.map((file) => file.path);

describe('selectUploadFiles', () => {
  it('takes every file, with its size, at any depth, in path order', () => {
    folder({ 'package.json': '{}', 'src/index.js': 'hello', 'b.txt': '' });

    expect(selectUploadFiles(root).files).toEqual([
      { path: 'b.txt', size: 0 },
      { path: 'package.json', size: 2 },
      { path: 'src/index.js', size: 5 },
    ]);
  });

  it('always leaves out .git/ and .cloudgate/, at any depth', () => {
    folder({
      'index.js': '',
      '.git/HEAD': 'ref',
      '.cloudgate/link.json': '{}',
      'vendor/lib/.git/config': '',
      'apps/web/.cloudgate/link.json': '{}',
      'apps/web/page.js': '',
    });

    expect(uploaded()).toEqual(['apps/web/page.js', 'index.js']);
  });

  describe('.gitignore, git repository or not', () => {
    it('leaves out a name it lists at any depth, and a folder with all it holds', () => {
      folder({
        '.gitignore': '# built\nnode_modules\n*.log\n\n',
        'index.js': '',
        'debug.log': '',
        'src/trace.log': '',
        'node_modules/x/index.js': '',
        'packages/a/node_modules/y.js': '',
      });

      expect(uploaded()).toEqual(['.gitignore', 'index.js']);
    });

    it('anchors a pattern with a slash to its own folder, and a trailing slash matches folders only', () => {
      folder({
        '.gitignore': '/dist\nbuild/\nconfig/local.json\n',
        'dist/a.js': '',
        'src/dist/b.js': '',
        'build/out.js': '',
        'src/build': 'a file named build',
        'config/local.json': '',
        'config/base.json': '',
      });

      expect(uploaded()).toEqual([
        '.gitignore',
        'config/base.json',
        'src/build',
        'src/dist/b.js',
      ]);
    });

    it('reads ** as any number of folders, and ? and [] as one character', () => {
      folder({
        '.gitignore': '**/cache/**\ndocs/**/*.tmp\nfile?.txt\nlog[0-9].txt\n',
        'cache/a': '',
        'a/b/cache/c': '',
        'docs/x.tmp': '',
        'docs/deep/er/y.tmp': '',
        'docs/keep.md': '',
        'file1.txt': '',
        'file10.txt': '',
        'log5.txt': '',
        'logx.txt': '',
      });

      expect(uploaded()).toEqual([
        '.gitignore',
        'docs/keep.md',
        'file10.txt',
        'logx.txt',
      ]);
    });

    it('applies a nested .gitignore to its own folder only, and ! brings a file back', () => {
      folder({
        '.gitignore': '*.secret\n!public.secret\n',
        'a.secret': '',
        'public.secret': '',
        'web/.gitignore': '/out\n!a.secret\n',
        'web/out/x.js': '',
        'web/a.secret': '',
        'out/kept.js': '',
      });

      expect(uploaded()).toEqual([
        '.gitignore',
        'out/kept.js',
        'public.secret',
        'web/.gitignore',
        'web/a.secret',
      ]);
    });

    it('cannot bring back a file inside a folder it left out, as git cannot', () => {
      folder({
        '.gitignore': 'dist/\n!dist/keep.js\n',
        'dist/keep.js': '',
      });

      expect(uploaded()).toEqual(['.gitignore']);
    });
  });

  describe('.cloudgateignore', () => {
    it('leaves out what it lists, on top of .gitignore', () => {
      folder({
        '.gitignore': 'node_modules\n',
        '.cloudgateignore': 'tests/\n*.md\n',
        'node_modules/a.js': '',
        'tests/a.test.js': '',
        'README.md': '',
        'index.js': '',
      });

      expect(uploaded()).toEqual([
        '.cloudgateignore',
        '.gitignore',
        'index.js',
      ]);
    });

    it('brings back with ! what any .gitignore left out, a folder included', () => {
      folder({
        '.gitignore': 'dist/\n*.generated.js\n',
        'web/.gitignore': 'schema.json\n',
        '.cloudgateignore': '!dist/\n!api.generated.js\n!schema.json\n',
        'dist/app.js': '',
        'api.generated.js': '',
        'other.generated.js': '',
        'web/schema.json': '',
      });

      expect(uploaded()).toEqual([
        '.cloudgateignore',
        '.gitignore',
        'api.generated.js',
        'dist/app.js',
        'web/.gitignore',
        'web/schema.json',
      ]);
    });
  });

  describe('.env files', () => {
    it('leaves out .env and .env.* even when nothing ignores them, keeping .env.example, and names them', () => {
      folder({
        '.env': 'SECRET=1',
        '.env.local': '',
        'api/.env.production': '',
        '.env.example': 'SECRET=',
        '.envrc': '',
        'index.js': '',
      });

      const selection = selectUploadFiles(root);

      expect(selection.files.map((file) => file.path)).toEqual([
        '.env.example',
        '.envrc',
        'index.js',
      ]);
      expect(selection.leftOutEnvFiles).toEqual([
        '.env',
        '.env.local',
        'api/.env.production',
      ]);
    });

    it('names a .env file a .gitignore already leaves out', () => {
      folder({ '.gitignore': '.env\n', '.env': '' });

      expect(selectUploadFiles(root).leftOutEnvFiles).toEqual(['.env']);
    });

    it('brings one back with ! in .cloudgateignore', () => {
      folder({
        '.cloudgateignore': '!.env\n',
        '.env': 'PORT=3000',
        '.env.local': '',
      });

      const selection = selectUploadFiles(root);

      expect(selection.files.map((file) => file.path)).toEqual([
        '.cloudgateignore',
        '.env',
      ]);
      expect(selection.leftOutEnvFiles).toEqual(['.env.local']);
    });

    it('names none when there are none', () => {
      folder({ 'index.js': '' });

      expect(selectUploadFiles(root).leftOutEnvFiles).toEqual([]);
    });
  });

  describe('symlinks', () => {
    it('leaves out a link to a file or a folder, naming it, and never follows it', () => {
      folder({ 'index.js': '', 'shared/util.js': '' });
      symlinkSync(join(root, 'index.js'), join(root, 'main.js'));
      symlinkSync(join(root, 'shared'), join(root, 'lib'));
      symlinkSync(join(root, 'nowhere'), join(root, 'broken'));

      const selection = selectUploadFiles(root);

      expect(selection.files.map((file) => file.path)).toEqual([
        'index.js',
        'shared/util.js',
      ]);
      expect(selection.symlinks).toEqual(['broken', 'lib', 'main.js']);
    });

    it('says nothing of a link an ignore file leaves out anyway', () => {
      folder({ '.gitignore': 'node_modules\n', 'pkg/index.js': '' });
      mkdirSync(join(root, 'node_modules'));
      symlinkSync(join(root, 'pkg'), join(root, 'node_modules', 'pkg'));

      expect(selectUploadFiles(root).symlinks).toEqual([]);
    });
  });
});

describe('summarizeUpload', () => {
  it('counts the files and their total size', () => {
    expect(
      summarizeUpload([
        { path: 'a.js', size: 10 },
        { path: 'src/b.js', size: 5 },
      ]),
    ).toEqual({ count: 2, totalSize: 15, large: false, biggestFolders: [] });
  });

  it('above 100 MB, names the five biggest top-level folders, biggest first', () => {
    const MB = 1_000_000;
    const summary = summarizeUpload([
      { path: 'node_modules/a/x.js', size: 60 * MB },
      { path: 'node_modules/b.js', size: 10 * MB },
      { path: 'assets/video.mp4', size: 25 * MB },
      { path: 'big-root-file.bin', size: 50 * MB },
      { path: 'src/a.js', size: 1 * MB },
      { path: 'docs/a.md', size: 2 * MB },
      { path: 'tests/a.js', size: 3 * MB },
      { path: 'tiny/a', size: 1 },
    ]);

    expect(summary.large).toBe(true);
    expect(summary.biggestFolders).toEqual([
      { path: 'node_modules', size: 70 * MB },
      { path: 'assets', size: 25 * MB },
      { path: 'tests', size: 3 * MB },
      { path: 'docs', size: 2 * MB },
      { path: 'src', size: 1 * MB },
    ]);
  });

  it('is not large at exactly 100 MB', () => {
    expect(summarizeUpload([{ path: 'a', size: 100_000_000 }]).large).toBe(
      false,
    );
  });
});
