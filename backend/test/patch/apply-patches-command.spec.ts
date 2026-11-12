import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { DrizzleDB } from '../../src/db/drizzle.module';
import type { Patch } from '../../src/patch/patch.schema';
import { PatchService } from '../../src/patch/patch.service';
import type { PermissionService } from '../../src/rbac/permission.service';

/**
 * The program a deploy runs on the build host to lay a Service's Patches over
 * its fresh checkout.
 *
 * A Patch's `filePath` used to go into that program raw, inside double quotes
 * that stop neither `"`, `$(…)` nor a backtick, and joined onto the checkout
 * with nothing stopping `..` — so any member who could write a Patch ran
 * commands, and wrote or deleted files, as the account that builds: root on
 * the Hosted platform host. The schemas now refuse such a path
 * (`patch.dto.spec.ts`); this is the other half, for a row saved before they
 * did, and for the quoting itself.
 *
 * The program is **run**, in a temporary `CLOUDGATE_DIRECTORY`, and the
 * assertions are on what the checkout and the directory around it are left
 * holding: a string assertion would restate the builder, and the builder is
 * the thing in question (`run-recorder.spec.ts`'s reasoning).
 */
describe('PatchService.generateApplyPatchesCommand', () => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'cloudgate-apply-patches-')),
  );
  const checkout = `${root}/applications/blog-app/code`;
  const original = process.env.CLOUDGATE_DIRECTORY;

  beforeAll(() => {
    process.env.CLOUDGATE_DIRECTORY = root;
  });

  afterAll(() => {
    if (original === undefined) delete process.env.CLOUDGATE_DIRECTORY;
    else process.env.CLOUDGATE_DIRECTORY = original;
    fs.rmSync(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(checkout, { recursive: true });
  });

  const row = (filePath: string, overrides: Partial<Patch> = {}): Patch =>
    ({
      patchId: `patch-${filePath}`,
      filePath,
      content: 'patched\n',
      type: 'update',
      enabled: true,
      applicationId: 'app-1',
      composeId: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
      ...overrides,
    }) as Patch;

  /**
   * The service over a database that answers the two reads the method makes:
   * the owning Application (a `.limit(1)`) and its Patches (an `.orderBy`).
   */
  const serviceWith = (rows: Patch[]) => {
    const chain: Record<string, unknown> = {};
    for (const method of ['select', 'from', 'innerJoin', 'where']) {
      chain[method] = () => chain;
    }
    chain.limit = () =>
      Promise.resolve([{ serviceId: 'app-1', appName: 'blog-app' }]);
    chain.orderBy = () => Promise.resolve(rows);
    return new PatchService(
      chain as unknown as DrizzleDB,
      {} as PermissionService,
    );
  };

  const commandFor = (rows: Patch[]) =>
    serviceWith(rows).generateApplyPatchesCommand({
      id: 'app-1',
      type: 'application',
      serverId: null,
    });

  const run = (program: string) =>
    execFileSync('bash', ['-c', `set -e;${program}`], { stdio: 'pipe' });

  it('writes and removes files inside the checkout, a path with shell punctuation as one word', async () => {
    fs.writeFileSync(`${checkout}/old.txt`, 'gone\n');
    // `;`, a space and `'` are not refused by the schema — they are ordinary
    // in a file name — so the program has to carry them as one quoted word.
    const awkward = "src/it's a; b.txt";

    run(
      await commandFor([
        row(awkward),
        row('old.txt', { type: 'delete', content: '' }),
      ]),
    );

    expect(fs.readFileSync(`${checkout}/${awkward}`, 'utf8')).toBe('patched\n');
    expect(fs.existsSync(`${checkout}/old.txt`)).toBe(false);
    expect(fs.readdirSync(`${checkout}/src`)).toEqual(["it's a; b.txt"]);
  });

  it.each([
    ['ends the double quotes', 'a"; touch "$CLOUDGATE_PWNED'],
    ['substitutes a command', 'a$(touch "$CLOUDGATE_PWNED").txt'],
    ['substitutes with backticks', 'a`touch "$CLOUDGATE_PWNED"`.txt'],
    ['is absolute', '/tmp/cloudgate-pwned'],
    ['climbs out of the checkout', '../../../pwned'],
  ])(
    'fails the deploy, naming the Patch, for a stored row whose path %s',
    async (_why, filePath) => {
      const pending = commandFor([row('ok.txt'), row(filePath)]);

      await expect(pending).rejects.toThrow(
        // JSON-quoted, so a path carrying a quote or a newline still reads
        // as one value in the deploy log.
        `Patch ${JSON.stringify(filePath)} cannot be applied: its path`,
      );
    },
  );

  it('fails a stored delete-patch that climbs out, and removes nothing outside', async () => {
    fs.writeFileSync(`${root}/keep.txt`, 'keep\n');

    await expect(
      commandFor([row('../../../keep.txt', { type: 'delete', content: '' })]),
    ).rejects.toThrow('cannot be applied');
    expect(fs.existsSync(`${root}/keep.txt`)).toBe(true);
  });

  /**
   * The repository is the customer's own, so a link committed in it is
   * theirs to point anywhere: the path's text is inside the checkout and the
   * file it reaches is not. The write, the folder it makes and the remove must
   * not go through one — the program stops the deploy instead, naming the
   * Patch, and leaves the place the link points at as it was.
   */
  describe('a link committed in the repository', () => {
    const outside = `${root}/outside`;

    beforeEach(() => {
      fs.mkdirSync(outside, { recursive: true });
    });

    const runFailing = (program: string) => {
      try {
        run(program);
      } catch (error) {
        const failed = error as { status: number; stdout: Buffer };
        return { status: failed.status, output: failed.stdout.toString() };
      }
      throw new Error('the program succeeded');
    };

    it('is not written through when the file itself is a link', async () => {
      fs.symlinkSync(`${outside}/cron`, `${checkout}/leak`);

      const failed = runFailing(await commandFor([row('leak')]));

      expect(failed.status).not.toBe(0);
      expect(failed.output).toContain('Patch "leak" cannot be applied');
      expect(fs.existsSync(`${outside}/cron`)).toBe(false);
    });

    it('is not written through when a folder on the path is a link', async () => {
      fs.symlinkSync(outside, `${checkout}/dir`);

      const failed = runFailing(await commandFor([row('dir/sub/x.conf')]));

      expect(failed.status).not.toBe(0);
      expect(failed.output).toContain(
        'Patch "dir/sub/x.conf" cannot be applied',
      );
      expect(fs.readdirSync(outside)).toEqual([]);
    });

    it('is not removed through when a folder on the path is a link', async () => {
      fs.writeFileSync(`${outside}/keep.txt`, 'keep\n');
      fs.symlinkSync(outside, `${checkout}/dir`);

      const failed = runFailing(
        await commandFor([
          row('dir/keep.txt', { type: 'delete', content: '' }),
        ]),
      );

      expect(failed.status).not.toBe(0);
      expect(fs.readFileSync(`${outside}/keep.txt`, 'utf8')).toBe('keep\n');
    });

    it('is itself removed by a delete Patch, leaving what it points at', async () => {
      fs.writeFileSync(`${outside}/keep.txt`, 'keep\n');
      fs.symlinkSync(`${outside}/keep.txt`, `${checkout}/link`);

      run(await commandFor([row('link', { type: 'delete', content: '' })]));

      expect(fs.existsSync(`${checkout}/link`)).toBe(false);
      expect(fs.readFileSync(`${outside}/keep.txt`, 'utf8')).toBe('keep\n');
    });

    it('stops the deploy before any Patch is applied', async () => {
      fs.symlinkSync(outside, `${checkout}/dir`);

      runFailing(await commandFor([row('first.txt'), row('dir/x')]));

      expect(fs.existsSync(`${checkout}/first.txt`)).toBe(false);
    });
  });
});
