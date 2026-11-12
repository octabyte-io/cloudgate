import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { CloudAccountsService } from '../../src/cloud-accounts/cloud-accounts.service';
import type { GcpCloudAccount } from '../../src/cloud-accounts/cloud-provider';
import type { DrizzleDB } from '../../src/db/drizzle.module';
import type { Application } from '../../src/db/schema';
import type { CloudRunControl } from '../../src/deployment-queue/cloud-run-job.types';
import { GoogleStaticDeploys } from '../../src/project-config/applier/google-static-deploys.service';
import type { SpreadClock } from '../../src/project-config/applier/static-spread';
import { FakeGoogleCloudPort } from '../utils/fake-google-cloud-port';

const BUCKET = 'cloudgate-bw7upcvsg6j2-p4x8m2rt';

const MINUTE = 60_000;

/** The static clock, moved by hand: a wait between tries moves it on at once. */
class HandClock implements SpreadClock {
  at = Date.UTC(2026, 9, 26, 9, 0, 0);
  slept: number[] = [];
  now(): number {
    return this.at;
  }
  sleep(ms: number): Promise<void> {
    this.slept.push(ms);
    this.at += ms;
    return Promise.resolve();
  }
}

/** A run nobody asks to end. */
const control: CloudRunControl = {
  signal: {
    interrupted: false,
    killed: false,
    onInterrupt: () => undefined,
    onKill: () => undefined,
  },
  beginApply: () => true,
  holdTimeLimit: () => () => undefined,
};

/** A database whose Service has no Domain, so there is no cache to clear. */
const noDomains = {
  select: () => ({
    from: () => ({
      where: () =>
        Object.assign(Promise.resolve([]), {
          orderBy: () => Promise.resolve([]),
        }),
    }),
  }),
} as unknown as DrizzleDB;

/**
 * Google Cloud's half of a static site's Deployment against the
 * Google client port's fake, whose recorded object operations make the copy
 * order observable (spec "Testing Decisions"): every file but the
 * pages, then the pages with their folders' `/`-named copies, then what the
 * new version lacks deleted, unchanged files skipped.
 */
describe('GoogleStaticDeploys, a deploy into live/', () => {
  const google = new FakeGoogleCloudPort();
  const cloudAccounts = {
    googleRunSession: () =>
      Promise.resolve({
        ok: true,
        credential: {},
        token: { accessToken: 'fake-impersonated-token' },
      }),
  } as unknown as CloudAccountsService;
  const clock = new HandClock();
  const deploys = new GoogleStaticDeploys(
    noDomains,
    google,
    clock,
    cloudAccounts,
  );
  const account = { name: 'Production Google' } as GcpCloudAccount;
  const site = {
    found: { applicationId: 'app-docs' } as Application,
    name: 'docs',
    region: 'europe-west1',
    bucket: BUCKET,
  };
  const half = deploys.halfOf(site, account);
  const root = mkdtempSync(join(tmpdir(), 'cloudgate-google-static-'));
  let lines: string[];
  const log = (line: string) => {
    lines.push(line);
    return Promise.resolve();
  };

  /** A `publish` folder holding these files. */
  let made = 0;
  function publish(name: string, files: Record<string, string>): string {
    made += 1;
    const directory = join(root, `${name}-${made}`);
    for (const [path, body] of Object.entries(files)) {
      mkdirSync(dirname(join(directory, path)), { recursive: true });
      writeFileSync(join(directory, path), body);
    }
    return directory;
  }

  /** Uploads `files` to the Deployment's own folder. */
  async function uploaded(id: string, files: Record<string, string>) {
    const done = await half.folders.upload({
      directory: publish(id, files),
      prefix: `deployments/${id}/`,
    });
    expect(done).toMatchObject({ ok: true });
    google.calls.length = 0;
  }

  /** Copies an uploaded folder into live/, as a Deployment started `startedAt`. */
  const goLive = (folder: string, startedAt = clock.now()) =>
    half.serving().goLive({ folder, startedAt, control, log });

  /** Uploads to the Deployment's folder, then copies it into live/. */
  async function deploy(id: string, files: Record<string, string>) {
    await uploaded(id, files);
    await goLive(id);
  }

  const liveFiles = () =>
    google.objectsOf(BUCKET).filter((one) => one.startsWith('live/'));

  beforeEach(() => {
    google.reset();
    lines = [];
    clock.slept = [];
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
    google.dispose();
  });

  it('uploads each file to the Deployment’s own folder with the type it is served as', async () => {
    const uploaded = await half.folders.upload({
      directory: publish('dep_up', {
        'index.html': '<h1>Docs</h1>',
        'assets/app.js': 'go()',
      }),
      prefix: 'deployments/dep_up/',
    });

    expect(uploaded).toEqual({ ok: true, files: 2, bytes: 17 });
    expect(google.objectsOf(BUCKET)).toEqual([
      'deployments/dep_up/assets/app.js',
      'deployments/dep_up/index.html',
    ]);
    expect(
      google.objectOf(BUCKET, 'deployments/dep_up/index.html')?.contentType,
    ).toMatch(/^text\/html/);
  });

  it('copies every other file, then the pages and their folder objects, into live/', async () => {
    await deploy('dep_1', {
      'index.html': 'home',
      'about/index.html': 'about',
      'assets/app.js': 'v1',
    });

    const operations = google.objectOperations();
    expect(operations.map((one) => one.op)).toEqual([
      'copy',
      'copy',
      'copy',
      'copy',
      'copy',
    ]);
    const targets = operations.map((one) => (one.op === 'copy' ? one.to : ''));
    expect(targets[0]).toBe('live/assets/app.js');
    expect(new Set(targets.slice(1))).toEqual(
      new Set([
        'live/index.html',
        'live/',
        'live/about/index.html',
        'live/about/',
      ]),
    );
    expect(google.objectOf(BUCKET, 'live/about/')).toEqual(
      google.objectOf(BUCKET, 'deployments/dep_1/about/index.html'),
    );
    expect(lines).toEqual(['🔁 [Copy] Copying into the live site (5 changed)']);
  });

  it('skips unchanged files and deletes what the new version lacks, last', async () => {
    await deploy('dep_1', {
      'index.html': 'home',
      'about/index.html': 'about',
      'assets/app.js': 'v1',
      'old.css': 'gone soon',
    });
    lines = [];

    await deploy('dep_2', {
      'index.html': 'home, new',
      'about/index.html': 'about',
      'assets/app.js': 'v2',
    });

    expect(google.objectOperations()).toEqual([
      {
        op: 'copy',
        bucket: BUCKET,
        from: 'deployments/dep_2/assets/app.js',
        to: 'live/assets/app.js',
      },
      expect.objectContaining({ op: 'copy', to: 'live/index.html' }),
      expect.objectContaining({ op: 'copy', to: 'live/' }),
      { op: 'delete', bucket: BUCKET, name: 'live/old.css' },
    ]);
    expect(
      google.objectsOf(BUCKET).filter((one) => one.startsWith('live/')),
    ).toEqual([
      'live/',
      'live/about/',
      'live/about/index.html',
      'live/assets/app.js',
      'live/index.html',
    ]);
    expect(lines).toEqual([
      '🔁 [Copy] Copying into the live site (3 changed)',
      '🧹 [Copy] Removed 1 old file',
    ]);
  });

  it('names the Deployment folders under deployments/, and deletes one whole', async () => {
    await deploy('dep_1', { 'index.html': 'a' });
    await deploy('dep_2', { 'index.html': 'b' });

    expect(await half.folders.list('deployments/')).toEqual({
      ok: true,
      folders: ['dep_1', 'dep_2'],
    });
    expect(await half.folders.delete('deployments/dep_1/')).toEqual({
      ok: true,
    });
    expect(
      google.objectsOf(BUCKET).filter((one) => one.startsWith('deployments/')),
    ).toEqual(['deployments/dep_2/index.html']);
  });

  /**
   * Spec "Failure and cap": running the copy again is safe,
   * since each try lists `live/` again and copies only what is not there yet.
   */
  describe('a copy that stops partway', () => {
    const v1 = {
      'index.html': 'home',
      'about/index.html': 'about',
      'assets/app.js': 'v1',
      'assets/app.css': 'v1',
    };

    it('is tried again after a wait, copying only what is not live yet, and ends with every file live', async () => {
      await uploaded('dep_1', v1);
      // The second object's copy meets a passing error.
      google.refuseSome('copyObject', '503', 'Backend Error', { after: 1 });

      await goLive('dep_1');

      expect(liveFiles()).toEqual([
        'live/',
        'live/about/',
        'live/about/index.html',
        'live/assets/app.css',
        'live/assets/app.js',
        'live/index.html',
      ]);
      // The one copied before the error is not copied again.
      const copies = google
        .objectOperations()
        .flatMap((one) => (one.op === 'copy' ? [one.to] : []));
      expect(copies.filter((to) => to === copies[0])).toHaveLength(1);
      expect(clock.slept).toHaveLength(1);
      expect(lines).toEqual([
        '🔁 [Copy] Copying into the live site (6 changed)',
        expect.stringMatching(
          /^⚠️ \[Copy\] The copy stopped partway \(live\/\S+: 503: Backend Error\); trying again in 5s \(try 2 of 3\)$/,
        ) as unknown,
        '🔁 [Copy] Copying into the live site (5 changed)',
      ]);
    });

    it('fails after its third try, saying the live site may have files from both versions', async () => {
      await uploaded('dep_1', v1);
      google.refuseSome('copyObject', '503', 'Backend Error', {
        after: 1,
        times: 99,
      });

      await expect(goLive('dep_1')).rejects.toThrow(
        /^The copy into the live site stopped after 3 tries \(live\/\S+: 503: Backend Error\)\. The live site may have files from both versions; deploy again or roll back to fix it$/,
      );
      expect(clock.slept).toEqual([5_000, 10_000]);
      expect(
        lines.filter((line) => line.startsWith('🔁 [Copy] Copying')),
      ).toHaveLength(3);
    });

    it('tries a copy again when a call gets no answer at all, as when it meets a refusal', async () => {
      await uploaded('dep_1', v1);
      // The second object's copy times out: no answer, the call throws.
      google.failSome('copyObject', 'The request timed out after 60000 ms', {
        after: 1,
      });

      await goLive('dep_1');

      expect(liveFiles()).toHaveLength(6);
      expect(clock.slept).toHaveLength(1);
      expect(lines[1]).toMatch(
        /^⚠️ \[Copy\] The copy stopped partway \(live\/\S+: The request timed out after 60000 ms\); trying again in 5s \(try 2 of 3\)$/,
      );
    });

    it('fails after its third try when a delete keeps getting no answer, saying the live site may have files from both versions', async () => {
      await deploy('dep_1', { ...v1, 'old.css': 'gone soon' });
      await uploaded('dep_2', v1);
      lines = [];
      google.failSome('deleteObject', 'socket hang up', { times: 99 });

      await expect(goLive('dep_2')).rejects.toThrow(
        'The copy into the live site stopped after 3 tries (live/old.css was not deleted: socket hang up). The live site may have files from both versions; deploy again or roll back to fix it',
      );
      expect(clock.slept).toEqual([5_000, 10_000]);
    });

    it('fails when Google refuses every copy, the live site maybe holding both versions', async () => {
      await uploaded('dep_x', { 'index.html': 'x' });
      google.permissionDenied('copyObject');

      await expect(goLive('dep_x')).rejects.toThrow(
        'The live site may have files from both versions; deploy again or roll back to fix it',
      );
    });

    it('fails at the 30-minute cap mid-copy, without trying again', async () => {
      await uploaded('dep_1', v1);
      const startedAt = clock.now();
      // The first copy takes Google 31 minutes to answer.
      google.whenCalled('copyObject', (count) => {
        if (count === 1) clock.at += 31 * MINUTE;
      });

      await expect(goLive('dep_1', startedAt)).rejects.toThrow(
        'The Deployment reached its 30-minute cap while copying into the live site. The live site may have files from both versions; deploy again or roll back to fix it',
      );
      expect(clock.slept).toEqual([]);
      expect(
        google.objectOperations().filter((one) => one.op === 'copy').length,
      ).toBeLessThan(6);
    });

    it('stops the upload at the 30-minute cap, the site on its previous version', async () => {
      const startedAt = clock.now();
      // The first file takes Google 31 minutes to take.
      google.whenCalled('uploadObject', (count) => {
        if (count === 1) clock.at += 31 * MINUTE;
      });

      const done = await half.folders.upload(
        {
          directory: publish('dep_slow', {
            ...v1,
            'a.js': 'a',
            'b.js': 'b',
            'c.js': 'c',
            'd.js': 'd',
            'e.js': 'e',
            'f.js': 'f',
            'g.js': 'g',
            'h.js': 'h',
          }),
          prefix: 'deployments/dep_slow/',
        },
        startedAt,
      );

      expect(done).toEqual({
        ok: false,
        message: 'the Deployment reached its 30-minute cap while uploading',
      });
      expect(
        google.calls.filter((one) => one.method === 'uploadObject').length,
      ).toBeLessThan(12);
    });

    it('fails at the 30-minute cap before copying anything when the upload outlasted it, the site on its previous version', async () => {
      await uploaded('dep_1', v1);

      await expect(goLive('dep_1', clock.now() - 31 * MINUTE)).rejects.toThrow(
        'The Deployment reached its 30-minute cap before copying into the live site. The site still serves its previous version',
      );
      expect(google.objectOperations()).toEqual([]);
    });
  });

  /** The cap is a ceiling on the whole Deployment, its per-Domain clears too. */
  describe('the cache clears at the 30-minute cap', () => {
    const hosts = ['docs.acme.dev', 'www.docs.acme.dev', 'api.docs.acme.dev'];
    /** A database whose Service has three live Domains on a made network. */
    const rows = hosts.map((host, index) => ({
      domainId: `dom-${index}`,
      host,
      path: '/',
      certificateAttempt: 1,
      cloudCertificateStatus: 'live',
      urlMapName: 'cloudgate-urls',
    }));
    const withDomains = {
      select: () => ({
        from: () => ({
          where: () =>
            Object.assign(Promise.resolve(rows), {
              orderBy: () => Promise.resolve(rows),
            }),
        }),
      }),
    } as unknown as DrizzleDB;
    const served = new GoogleStaticDeploys(
      withDomains,
      google,
      clock,
      cloudAccounts,
    )
      .halfOf(site, account)
      .serving();
    const settle = (startedAt: number) =>
      served.settle({
        deploymentId: 'dep_1',
        folder: 'dep_1',
        startedAt,
        control,
        log,
      });

    it('clears every Domain inside the cap', async () => {
      await settle(clock.now());

      expect(lines).toEqual(
        hosts.map((host) => `🌐 [Clear] Cleared the cache for ${host}`),
      );
    });

    it('stops at the cap, naming the Domains not cleared', async () => {
      const startedAt = clock.now();
      // The first clear takes Google 31 minutes to answer.
      google.whenCalled('invalidateCache', (count) => {
        if (count === 1) clock.at += 31 * MINUTE;
      });

      await expect(settle(startedAt)).rejects.toThrow(
        'The Deployment reached its 30-minute cap before the cache was cleared for www.docs.acme.dev, api.docs.acme.dev. The live site serves this version, but those Domains may serve what Cloud CDN cached before for up to a day; deploy again to clear it',
      );
      expect(
        google.calls.filter((one) => one.method === 'invalidateCache'),
      ).toHaveLength(1);
      expect(lines).toEqual(['🌐 [Clear] Cleared the cache for docs.acme.dev']);
    });
  });
});
