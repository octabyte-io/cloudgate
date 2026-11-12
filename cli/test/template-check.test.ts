import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { checkCatalogue, encodeCatalogue } from 'cloudgate-template-check';
import { describe, expect, it } from 'vitest';

import { run } from '../src/run.js';

/**
 * `cloudgate template check` and `template pack` are thin doors onto the
 * backend's Template check and catalogue builder: they read a folder or a
 * catalogue.zip, hand it to that code, print the answer and exit by it. The
 * check's own rules are tested where they live
 * (`backend/test/templates/check/`); this proves the commands reach that
 * same code, by reasons only it gives, and exit 0 or 1 by its answer.
 */
function check(path: string) {
  return cloudgate('template', 'check', path);
}

async function cloudgate(...argv: string[]) {
  const out = { stdout: '', stderr: '' };
  const code = await run({
    argv,
    env: {},
    cwd: tmpdir(),
    stdinIsTTY: false,
    stdoutIsTTY: false,
    stderrIsTTY: false,
    stdout: (text) => (out.stdout += text),
    stderr: (text) => (out.stderr += text),
    fetch: () => Promise.reject(new Error('the check makes no request')),
    prompter: {
      ask: () => Promise.reject(new Error('never asked')),
    } as never,
    now: () => new Date('2026-11-10T12:00:00Z'),
  });
  return { code, ...out };
}

/** A template folder named `id`, needing Cloudgate `needs`. */
function templateFolder(parent: string, id: string, needs = '0.1.0'): string {
  const folder = join(parent, id);
  mkdirSync(folder, { recursive: true });
  writeFileSync(
    join(folder, 'template.yaml'),
    `name: Uptime Kuma\ndescription: Monitoring.\ntags: [monitoring]\ncloudgate: ${needs}\n`,
  );
  writeFileSync(
    join(folder, 'cloudgate.yaml'),
    'version: 1\nservices:\n  app:\n    kind: web\n    source: { image: "louislam/uptime-kuma:1.23" }\n',
  );
  writeFileSync(
    join(folder, 'logo.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"></svg>',
  );
  return folder;
}

describe('template check', () => {
  it('exits 0 when the check offers every template in the folder', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'cloudgate-templates-'));

    const result = await check(templateFolder(parent, 'uptime-kuma'));

    expect(result.code).toBe(0);
    expect(result.stdout).toBe('✓ uptime-kuma\n');
  });

  it("exits 1 with the check's own reason when it hides one", async () => {
    const parent = mkdtempSync(join(tmpdir(), 'cloudgate-templates-'));
    templateFolder(parent, 'uptime-kuma');
    templateFolder(parent, 'future', '999.0.0');

    const result = await check(parent);

    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(
      /^✓ uptime-kuma\n✗ future: needs Cloudgate 999\.0\.0 or newer; this is \d+\.\d+\.\d+\S*\n$/,
    );
  });

  it("passes a folder holding the website's index.md and screenshots", async () => {
    const parent = mkdtempSync(join(tmpdir(), 'cloudgate-templates-'));
    const folder = templateFolder(parent, 'uptime-kuma');
    writeFileSync(join(folder, 'index.md'), '# Uptime Kuma\n');
    mkdirSync(join(folder, 'screenshots'));
    writeFileSync(join(folder, 'screenshots', 'shot.png'), PNG_SIGNATURE);

    const result = await check(folder);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe('✓ uptime-kuma\n');
  });

  it("refuses the whole folder over a stray file at a template's root", async () => {
    const parent = mkdtempSync(join(tmpdir(), 'cloudgate-templates-'));
    templateFolder(parent, 'uptime-kuma');
    writeFileSync(join(templateFolder(parent, 'ghost'), 'notes.txt'), 'todo');

    const result = await check(parent);

    expect(result.code).toBe(1);
    // Refused whole: not even the sound template is printed.
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(
      'The catalogue holds templates/ghost/notes.txt, which is not a file a template holds',
    );
  });

  it('refuses the whole folder over a script under files/, even one template.yaml lists', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'cloudgate-templates-'));
    const folder = templateFolder(parent, 'uptime-kuma');
    writeFileSync(
      join(folder, 'template.yaml'),
      `${readFileSync(join(folder, 'template.yaml'), 'utf8')}files:\n  - path: run.sh\n`,
    );
    mkdirSync(join(folder, 'files'));
    writeFileSync(join(folder, 'files', 'run.sh'), 'echo hi\n');

    const result = await check(folder);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      'The catalogue holds templates/uptime-kuma/files/run.sh, which is not a kind of config file',
    );
  });

  it('refuses a catalogue.json, naming catalogue.zip', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'cloudgate-templates-'));
    const file = join(parent, 'catalogue.json');
    writeFileSync(file, JSON.stringify({ format: 1, templates: {} }));

    const result = await check(file);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('this Cloudgate reads a catalogue.zip');
  });

  it('checks a catalogue.zip like the folder it was built from', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'cloudgate-templates-'));
    const file = join(parent, 'catalogue.zip');
    writeFileSync(
      file,
      encodeCatalogue(
        ['uptime-kuma', 'future'].map((id) => ({
          id,
          revision: 'abc123',
          files: filesOf(
            templateFolder(parent, id, id === 'future' ? '999.0.0' : '0.1.0'),
          ),
        })),
      ),
    );

    const fromZip = await check(file);
    const fromFolder = await check(parent);

    expect(fromZip.code).toBe(1);
    expect(fromZip.stdout).toMatch(
      /^✓ uptime-kuma\n✗ future: needs Cloudgate 999\.0\.0/,
    );
    expect(fromZip).toEqual(fromFolder);
  });
});

describe('template pack', () => {
  it('writes a catalogue.zip that template check accepts', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'cloudgate-templates-'));
    const templates = join(parent, 'templates');
    templateFolder(templates, 'uptime-kuma');
    const ghost = templateFolder(templates, 'ghost');
    writeFileSync(join(ghost, 'index.md'), '# Ghost\n');
    const zip = join(parent, 'catalogue.zip');

    const packed = await cloudgate(
      'template',
      'pack',
      templates,
      zip,
      '--revision',
      'abc123',
    );
    const checked = await check(zip);

    expect(packed.code).toBe(0);
    expect(packed.stdout).toBe('✓ ghost\n✓ uptime-kuma\n');
    expect(packed.stderr).toContain(`Packed 2 templates into ${zip}`);
    expect(checked).toMatchObject({
      code: 0,
      stdout: '✓ ghost\n✓ uptime-kuma\n',
    });
    // The website's file stayed in the repository, out of the zip: a zip's
    // names are never compressed.
    expect(readFileSync(zip).includes('index.md')).toBe(false);
    const read = checkCatalogue(readFileSync(zip), {
      cloudgateVersion: '999.0.0',
    });
    expect(read.ok && read.offered).toMatchObject([
      { id: 'ghost', revision: 'abc123' },
      { id: 'uptime-kuma', revision: 'abc123' },
    ]);
  });

  it('refuses and writes nothing when a template is hidden', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'cloudgate-templates-'));
    const templates = join(parent, 'templates');
    templateFolder(templates, 'uptime-kuma');
    templateFolder(templates, 'future', '999.0.0');
    const zip = join(parent, 'catalogue.zip');

    const result = await cloudgate('template', 'pack', templates, zip);

    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/✗ future: needs Cloudgate 999\.0\.0/);
    expect(result.stderr).toContain(`${zip} was not written`);
    expect(existsSync(zip)).toBe(false);
  });

  it('refuses and writes nothing when the folder holds a stray file', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'cloudgate-templates-'));
    const folder = templateFolder(parent, 'uptime-kuma');
    writeFileSync(join(folder, 'notes.txt'), 'todo');
    const zip = join(parent, 'catalogue.zip');

    const result = await cloudgate('template', 'pack', folder, zip);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('templates/uptime-kuma/notes.txt');
    expect(existsSync(zip)).toBe(false);
  });
});

/** The first bytes of every PNG; enough for a screenshot nobody reads. */
const PNG_SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** A template folder's files, by their path inside it (no subfolders). */
function filesOf(folder: string): Record<string, Uint8Array> {
  return Object.fromEntries(
    readdirSync(folder).map((name) => [name, readFileSync(join(folder, name))]),
  );
}
