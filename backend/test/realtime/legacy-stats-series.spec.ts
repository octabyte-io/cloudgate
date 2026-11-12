import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { purgeLegacyStatsSeries } from '../../src/realtime/legacy-stats-series';

const SERIES = ['block.json', 'cpu.json', 'memory.json', 'network.json'];

function seed(root: string, appName: string, files: string[]): string {
  const dir = path.join(root, appName);
  fs.mkdirSync(dir, { recursive: true });
  for (const file of files) fs.writeFileSync(path.join(dir, file), '[]');
  return dir;
}

/**
 * Before the live stream stopped writing, every container anyone watched
 * left `monitoring/<task name>/` behind. The boot purge removes those — and
 * only those, because it runs unattended against a directory an operator can
 * reach.
 */
describe('purgeLegacyStatsSeries', () => {
  let root: string;
  let monitoring: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudgate-i528-purge-'));
    monitoring = path.join(root, 'monitoring');
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('removes every series directory the old store left, and the empty root', async () => {
    seed(monitoring, 'cloudgate', [...SERIES, 'disk.json']);
    seed(monitoring, 'app-t64tnx.1.ihmnf9wytekqp9q8g6dor0a60', SERIES);

    await expect(purgeLegacyStatsSeries(monitoring)).resolves.toBe(2);

    expect(fs.existsSync(monitoring)).toBe(false);
  });

  it('leaves a directory holding anything the store never wrote', async () => {
    const foreign = seed(monitoring, 'mine', [...SERIES, 'notes.txt']);
    seed(monitoring, 'cloudgate', SERIES);

    await expect(purgeLegacyStatsSeries(monitoring)).resolves.toBe(1);

    expect(fs.readdirSync(foreign).sort()).toEqual([...SERIES, 'notes.txt']);
    expect(fs.readdirSync(monitoring)).toEqual(['mine']);
  });

  it('leaves a loose file and a symlinked directory alone', async () => {
    const elsewhere = seed(root, 'elsewhere', SERIES);
    fs.mkdirSync(monitoring);
    fs.writeFileSync(path.join(monitoring, 'README'), 'kept');
    fs.symlinkSync(elsewhere, path.join(monitoring, 'linked'));

    await expect(purgeLegacyStatsSeries(monitoring)).resolves.toBe(0);

    expect(fs.readdirSync(monitoring).sort()).toEqual(['README', 'linked']);
    expect(fs.readdirSync(elsewhere).sort()).toEqual(SERIES);
  });

  it('does nothing where no store was ever written', async () => {
    await expect(purgeLegacyStatsSeries(monitoring)).resolves.toBe(0);
  });
});
