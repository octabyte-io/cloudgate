import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { stageStaticFilesCommand } from '../../src/deployment-engine/cloud-build';

const execFileAsync = promisify(execFile);

/**
 * A cloud static site's `publish` folder is copied with `cp -a` on the
 * platform host and uploaded to the customer's bucket. A `publish` folder
 * committed as a link to `/`, or reached through a build path that leaves the
 * checkout, copied the host's own files; the step now resolves the folder's
 * real path and refuses one outside the checkout.
 */
describe('stageStaticFilesCommand', () => {
  /** A checkout with `site/index.html`, and a host file beside it. */
  async function layout() {
    const root = await mkdtemp(join(tmpdir(), 'cloudgate-stage-static-'));
    const checkout = join(root, 'code');
    const host = join(root, 'host');
    await mkdir(join(checkout, 'site'), { recursive: true });
    await writeFile(join(checkout, 'site', 'index.html'), '<h1>site</h1>');
    await mkdir(host);
    await writeFile(join(host, 'secret'), 'another tenant');
    return { root, checkout, host, to: join(root, 'upload') };
  }

  async function staged(input: {
    checkout: string;
    from: string;
    to: string;
    publish: string;
  }): Promise<{ ok: boolean; output: string }> {
    const command = stageStaticFilesCommand({ ...input, place: 'S3' });
    try {
      const { stdout, stderr } = await execFileAsync('sh', ['-c', command]);
      return { ok: true, output: stdout + stderr };
    } catch (error) {
      const failed = error as { stdout: string; stderr: string };
      return { ok: false, output: failed.stdout + failed.stderr };
    }
  }

  const filesIn = (directory: string) =>
    readdir(directory).catch(() => [] as string[]);

  it('copies a publish folder inside the checkout', async () => {
    const { checkout, to } = await layout();
    const result = await staged({
      checkout,
      from: join(checkout, 'site'),
      to,
      publish: 'site',
    });
    expect(result.ok).toBe(true);
    expect(await filesIn(to)).toEqual(['index.html']);
  });

  it('copies a publish folder that is a link to another folder inside the checkout', async () => {
    const { checkout, to } = await layout();
    await symlink(join(checkout, 'site'), join(checkout, 'public'));
    const result = await staged({
      checkout,
      from: join(checkout, 'public'),
      to,
      publish: 'public',
    });
    expect(result.ok).toBe(true);
    expect(await filesIn(to)).toEqual(['index.html']);
  });

  it('fails on a publish folder that is a link leading outside the checkout, naming it, and copies nothing', async () => {
    const { checkout, host, to } = await layout();
    await symlink(host, join(checkout, 'public'));
    const result = await staged({
      checkout,
      from: join(checkout, 'public'),
      to,
      publish: 'public',
    });
    expect(result.ok).toBe(false);
    expect(result.output).toContain(
      "The publish folder 'public' leads outside the checkout",
    );
    expect(await filesIn(to)).not.toContain('secret');
  });

  it('fails on a folder the build path walks out of the checkout to', async () => {
    const { checkout, to } = await layout();
    const result = await staged({
      checkout,
      from: join(checkout, '..', 'host'),
      to,
      publish: '.',
    });
    expect(result.ok).toBe(false);
    expect(result.output).toContain('leads outside the checkout');
    expect(await filesIn(to)).toEqual([]);
  });

  it('does not take a sibling folder whose name starts with the checkout’s', async () => {
    const { root, checkout, to } = await layout();
    await mkdir(join(root, 'code-other'));
    await writeFile(join(root, 'code-other', 'secret'), 'x');
    await symlink(join(root, 'code-other'), join(checkout, 'public'));
    const result = await staged({
      checkout,
      from: join(checkout, 'public'),
      to,
      publish: 'public',
    });
    expect(result.ok).toBe(false);
  });

  it('copies the checkout itself when publish is its root', async () => {
    const { checkout, to } = await layout();
    const result = await staged({ checkout, from: checkout, to, publish: '.' });
    expect(result.ok).toBe(true);
    expect(await filesIn(to)).toEqual(['site']);
  });

  it('still fails on a publish folder that is not in the checkout', async () => {
    const { checkout, to } = await layout();
    const result = await staged({
      checkout,
      from: join(checkout, 'dist'),
      to,
      publish: 'dist',
    });
    expect(result.ok).toBe(false);
    expect(result.output).toContain('is not in the checkout');
  });
});
