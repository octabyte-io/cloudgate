import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  CONTAINER_LOG_DRIVER,
  containerLogConfig,
  containerLogOptions,
  containerLogRunFlags,
  DEFAULT_CONTAINER_LOG_MAX_FILE,
  DEFAULT_CONTAINER_LOG_MAX_SIZE,
  serviceLogDriver,
} from '../../src/common/config/container-logs';

// The retention ceiling an earlier fix set, and the two things it turned out nothing was
// asserting: the values it emits into each of its four shapes, and the *set* of
// places that have to call it.

describe('containerLogOptions', () => {
  it('caps at 10m x 3 with no env', () => {
    expect(containerLogOptions({})).toEqual({
      'max-size': DEFAULT_CONTAINER_LOG_MAX_SIZE,
      'max-file': DEFAULT_CONTAINER_LOG_MAX_FILE,
    });
  });

  it('takes an operator override from the env, whitespace trimmed', () => {
    expect(
      containerLogOptions({
        CONTAINER_LOG_MAX_SIZE: ' 50m ',
        CONTAINER_LOG_MAX_FILE: '5',
      }),
    ).toEqual({ 'max-size': '50m', 'max-file': '5' });
  });

  it('falls back to the default for an empty override rather than emitting an empty value', () => {
    // `--log-opt max-size=` is not "no cap", it is a Docker error at create
    // time, so a blank env entry has to read as absent.
    expect(
      containerLogOptions({
        CONTAINER_LOG_MAX_SIZE: '   ',
        CONTAINER_LOG_MAX_FILE: '',
      }),
    ).toEqual({
      'max-size': DEFAULT_CONTAINER_LOG_MAX_SIZE,
      'max-file': DEFAULT_CONTAINER_LOG_MAX_FILE,
    });
  });
});

describe('backend/src/common/config/container-logs.ts', () => {
  const env = { CONTAINER_LOG_MAX_SIZE: '50m', CONTAINER_LOG_MAX_FILE: '5' };

  // Swarm's spec says Name/Options where a container's says Type/Config, which
  // is the whole reason two helpers exist rather than one. Reading the same
  // override through all four is what pins them to one source.
  it('carries the same values through the container, service and flag shapes', () => {
    expect(containerLogConfig(env)).toEqual({
      Type: CONTAINER_LOG_DRIVER,
      Config: { 'max-size': '50m', 'max-file': '5' },
    });
    expect(serviceLogDriver(env)).toEqual({
      Name: CONTAINER_LOG_DRIVER,
      Options: { 'max-size': '50m', 'max-file': '5' },
    });
    expect(containerLogRunFlags(env)).toEqual([
      '--log-driver json-file',
      '--log-opt max-size=50m',
      '--log-opt max-file=5',
    ]);
  });
});

/**
 * The meta-test, and the reason it exists rather than a fifth per-call-site
 * assertion.
 *
 * Every assertion that this cap is applied lives beside the site that applies it
 * — `mechanize.spec.ts`, `database-spec.spec.ts`, `forward-auth-proxy.spec.ts`,
 * `server-setup.spec.ts`. That set of tests can only fail for a site it already
 * knows about, so a create site added *without* the cap is asserted by nobody,
 * which is exactly how the compose path ran uncapped for a wave until a VPS run
 * measured it. This asserts the set instead of the members.
 *
 * A file-content assertion rather than a lint rule, on the same grounds
 * `server-setup.spec.ts:287` gives for pinning `deploy/install.sh` from here:
 * there is no eslint rule that can see across a call and the config helper it
 * should have been given.
 */
describe('backend/src', () => {
  const srcRoot = path.resolve(__dirname, '../../src');

  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return walk(full);
      return entry.isFile() && full.endsWith('.ts') ? [full] : [];
    });

  const creators = walk(srcRoot)
    .map((file) => ({ file, text: fs.readFileSync(file, 'utf8') }))
    .filter(({ text }) => /\.(createService|createContainer)\(/.test(text))
    .map(({ file, text }) => ({
      file: path.relative(srcRoot, file),
      // A Cron service's run job is built by `buildRunJobSettings`,
      // which spreads `buildServiceSettings`' task, log driver and all.
      capped: /serviceLogDriver|containerLogConfig|buildRunJobSettings/.test(
        text,
      ),
    }));

  it('finds the create sites the enumeration in container-logs.ts names', () => {
    // Listing the current set as the expected value is the point: a seventh
    // site is a failure here rather than a finding on a host a wave later. When
    // one is added legitimately, add it to this list *and* to the enumeration
    // in `container-logs.ts` — the two are meant to be read together.
    expect(creators.map((site) => site.file).sort()).toEqual([
      'cron-services/swarm-cron-run-place.ts',
      'databases/common/database-spec.ts',
      'deployment-engine/mechanize.ts',
      'enterprise/forward-auth/forward-auth-proxy.service.ts',
      'settings/traefik-setup.service.ts',
    ]);
  });

  it('gives every one of them a log driver', () => {
    expect(
      creators.filter((site) => !site.capped).map((site) => site.file),
    ).toEqual([]);
  });

  /**
   * The same assertion for the third kind of create site, and the reading H-98
   * cost a wave: **the set of commands that bring a compose stack up.**
   *
   * Kind 3 is capped by an injection into the converted compose file rather than
   * by a helper at a create call, so the grep above cannot see it — and neither
   * can the per-call-site specs. What went wrong was not the injection: it was
   * that a *second* command created containers from that file.
   * `ComposeService.start` ran `docker compose up -d` over the stored converted
   * file and regenerated nothing, so every stack whose file predated the log-cap fixes
   * came back from a Start with `RestartPolicy=no` and an uncapped driver — four
   * such stacks on the VPS, `restart:` and `logging:` zero times in every stored
   * file.
   *
   * So the invariant asserted here is the one that generalises: a command that
   * brings a compose stack up is built in the module that applies the platform
   * defaults, and nowhere else. A third one — a restart rung, a rollback, a
   * repair route — fails here rather than on a host a wave later.
   *
   * Prose is excluded by line, not by hope: `up -d` appears in half a dozen
   * docblocks in this tree, and a docblock creates nothing.
   */
  const bringsUpAStack = walk(srcRoot)
    .map((file) => ({ file, text: fs.readFileSync(file, 'utf8') }))
    .filter(({ text }) =>
      text
        .split('\n')
        .filter((line) => {
          const trimmed = line.trim();
          return (
            !trimmed.startsWith('*') &&
            !trimmed.startsWith('//') &&
            !trimmed.startsWith('/*')
          );
        })
        .some((line) => /up -d|stack deploy -c/.test(line)),
    )
    .map(({ file, text }) => ({
      file: path.relative(srcRoot, file),
      defaults: /applyComposeDefaults/.test(text),
    }));

  it('builds every compose bring-up command in one module', () => {
    expect(bringsUpAStack.map((site) => site.file).sort()).toEqual([
      'compose/compose.utils.ts',
    ]);
  });

  it('applies the platform defaults in that module', () => {
    expect(bringsUpAStack.filter((site) => !site.defaults)).toEqual([]);
  });
});

/**
 * The third kind of create site: the containers a tenant's own compose file
 * produces, which no grep over create calls can see and which therefore ran on
 * Docker's stock unbounded driver until the fix. The cap reaches them through the
 * `logging:` block `applyComposeDefaults` writes into the converted file, which
 * is asserted in full in `test/compose/compose-domains.spec.ts`; what is pinned
 * here is only that the compose path reads *this* module rather than growing a
 * second copy of the ceiling. `applyComposeDefaults` lives in `compose-file.ts`,
 * the pure part of `compose.utils.ts` the CLI bundles (spec #5).
 */
describe('backend/src/compose/compose-file.ts', () => {
  it('imports the driver and the options from here rather than restating them', () => {
    const utils = fs.readFileSync(
      path.join(srcFile('compose/compose-file.ts')),
      'utf8',
    );

    expect(utils).toContain("from '../common/config/container-logs'");
    expect(utils).toContain('containerLogOptions(env)');
    // The values themselves must not appear: two writers of one ceiling is how
    // the Traefik version once ended up disagreeing with itself.
    expect(utils).not.toContain(DEFAULT_CONTAINER_LOG_MAX_SIZE);
    expect(utils).not.toContain("'json-file'");
  });
});

function srcFile(relative: string): string {
  return path.resolve(__dirname, '../../src', relative);
}
