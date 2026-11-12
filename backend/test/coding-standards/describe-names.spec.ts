import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * CODING_STANDARDS §1.7, made checkable: *"`describe` names the unit under test
 * for a unit spec (the exported function, verbatim) … nested `describe`s name a
 * behaviour group … not a method."*
 *
 * Nothing in ESLint can hold this. `no-restricted-syntax` sees one file's AST,
 * and deciding whether `'serverSetupCommand'` is a name `src` binds means
 * reading another file; `eslint-plugin-jest`'s `jest/valid-title` takes a regex
 * rather than a symbol table, and is not installed. So it is checked from here,
 * the way the `.optional()` sweep is checked from
 * `test/common/server-id-nullish.spec.ts` — walk, collect offenders, assert the
 * list is empty.
 *
 * **Why "a name `src` binds" rather than §1.7's literal "exported".** The
 * stricter reading rejects `describe('serverId')`, whose subject is the DTO
 * field declared once in `src/docker-ops/dto/docker-ops.dto.ts` and shared by
 * twenty schemas — a real unit with no `export` keyword in front of it. The
 * looser rule absolves exactly one title on this tree, and it still rejects
 * every prose title, which is what the rule is for. The `export` half stays an
 * aspiration in §1.7 rather than a gate here.
 *
 * The second escape is for a spec whose unit is a committed artefact rather
 * than a symbol: `deploy/install.sh` cannot pin itself, so `server-setup.spec.ts`
 * pins it, and the path *is* the name of the unit under test, verbatim. A title
 * whose first token looks like a path is accepted only if that path exists — so
 * a typo in it fails rather than passing as prose.
 *
 * `*.e2e-spec.ts` is deliberately out of scope: §1.7 gives those the different
 * `'<Feature> (e2e)'` shape.
 */

const backendRoot = join(__dirname, '..', '..');
const repoRoot = join(backendRoot, '..');

/**
 * The 37 titles that predate this gate and are **not** endorsed — recorded in
 * CODING_STANDARDS §4 so a reviewer cannot cite them as violations, and frozen
 * here so nobody adds a forty-third without editing this list and being asked
 * why. The only correct edit is a deletion. A new spec adds nothing here; it
 * names its unit.
 *
 * Not all thirty-seven read as prose. `TRUSTED_ORIGINS`, `CLOUDGATE_DIRECTORY` and
 * `CORS` name an env key or a protocol verbatim, which is the discipline §1.7
 * asks for; they are listed because nothing in `src` *binds* those names, not
 * because the titles are bad. `rotateAccessLog` names a method rather than a
 * unit, which §1.7 rules out for a different reason. Sorting the defensible
 * from the rest is the follow-up this list exists to make possible.
 */
const BASELINE: readonly string[] = [
  'test/auth/trusted-origins.spec.ts :: TRUSTED_ORIGINS',
  'test/backups/backup-script.spec.ts :: container search commands',
  'test/backups/backup-script.spec.ts :: the generated mongo restore, executed',
  'test/common/cloudgate-directory.spec.ts :: CLOUDGATE_DIRECTORY',
  'test/common/cors.spec.ts :: CORS',
  'test/common/encryption.spec.ts :: encryption',
  'test/common/env.schema.spec.ts :: env validation',
  'test/common/pagination.spec.ts :: pagination helper',
  'test/common/trust-proxy.spec.ts :: env validation of TRUST_PROXY',
  'test/db/columns.spec.ts :: db column helpers',
  'test/deployment-engine/volume-lock.spec.ts :: the generated shell, executed',
  'test/enterprise/license/license-lapse-warning.spec.ts :: the warning a license lapse produces',
  'test/git-providers/bitbucket.strategy.spec.ts :: strategy registry',
  'test/git-providers/gitea.strategy.spec.ts :: strategy registry',
  'test/git-providers/github.strategy.spec.ts :: strategy registry',
  'test/git-providers/gitlab.strategy.spec.ts :: strategy registry',
  // The Testcontainers smoke test, not a unit spec at all.
  'test/harness.spec.ts :: Test harness (Testcontainers smoke test)',
  'test/mail/templates.spec.ts :: mail templates',
  'test/monitoring/access-log.index.spec.ts :: the index on disk',
  'test/monitoring/access-log.seek.spec.ts :: a ranged read over an indexed log',
  'test/monitoring/access-log.seek.spec.ts :: a log rotated out from under the index',
  'test/monitoring/access-log.seek.spec.ts :: a half-written trailing line',
  'test/monitoring/access-log.service.spec.ts :: the two queries read the same slice',
  'test/notifications/channel-strategies.spec.ts :: event formats beyond build-success (slack literals, per-trigger payloads)',
  'test/notifications/channel-strategies.spec.ts :: event formats beyond build-success (custom webhook payloads)',
  'test/notifications/channel-strategies.spec.ts :: event emails beyond build-success (subjects and skip rules)',
  'test/openapi/openapi.spec.ts :: the instance publishes an OpenAPI document',
  'test/rbac/access-control.spec.ts :: access control statements and static roles',
  'test/realtime/pty-spawn-helper.spec.ts :: the platform gate on these tests',
  "test/realtime/pty-spawn-helper.spec.ts :: node-pty's spawn-helper",
  'test/realtime/terminal-resize-round-trip.spec.ts :: a resize over a real terminal socket',
  'test/realtime/ws.utils.spec.ts :: ws.utils validators',
  'test/settings/traefik-access-log-rotation.spec.ts :: the generated Traefik config',
  'test/settings/traefik-access-log-rotation.spec.ts :: rotateAccessLog',
  'test/volume-backups/volume-backup-commands.spec.ts :: no generated volume script carries an S3 credential flag',
  'test/volume-backups/volume-backup-commands.spec.ts :: the generated restore shell, executed',
];

/** Every file under `dir`, recursively. */
function walk(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(path));
    else found.push(path);
  }
  return found;
}

/**
 * Every name `backend/src` binds at module scope — `export`ed or not — plus the
 * names re-exported through an `export { … }` clause.
 */
function namesSrcBinds(): Set<string> {
  const names = new Set<string>();
  const declaration =
    /^(?:export\s+)?(?:declare\s+)?(?:abstract\s+)?(?:default\s+)?(?:async\s+)?(?:function\s*\*?|const|let|var|class|interface|type|enum|namespace)\s+([A-Za-z_$][\w$]*)/gm;

  for (const file of walk(join(backendRoot, 'src'))) {
    if (!file.endsWith('.ts')) continue;
    const text = readFileSync(file, 'utf8');
    for (const [, name] of text.matchAll(declaration)) names.add(name);
    for (const [, clause] of text.matchAll(/^export\s*\{([^}]*)\}/gm)) {
      for (const specifier of clause.split(',')) {
        const trimmed = specifier.trim();
        if (!trimmed) continue;
        const renamed = /\bas\s+([A-Za-z_$][\w$]*)$/.exec(trimmed);
        names.add(
          renamed ? renamed[1] : trimmed.replace(/^type\s+/, '').trim(),
        );
      }
    }
  }
  return names;
}

interface DescribeTitle {
  /** Path relative to `backend/`, so a failure is a thing you can open. */
  readonly file: string;
  readonly line: number;
  readonly title: string;
}

/** Every top-level `describe` title in a non-e2e spec. */
function topLevelDescribeTitles(): DescribeTitle[] {
  const titles: DescribeTitle[] = [];
  const files = walk(join(backendRoot, 'test'))
    .filter((file) => file.endsWith('.spec.ts'))
    .filter((file) => !file.endsWith('.e2e-spec.ts'))
    .sort();

  for (const file of files) {
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((text, index) => {
        // Column zero is what makes it top-level: a nested `describe` is
        // indented, and Prettier is an `error` in this config, so it stays that
        // way.
        const opened = /^describe\(\s*(['"`])(.*?)\1/.exec(text);
        if (opened) {
          titles.push({
            file: relative(backendRoot, file),
            line: index + 1,
            title: opened[2],
          });
        }
      });
  }
  return titles;
}

/** What BASELINE keys on: stable when the lines around it move. */
const key = ({ file, title }: DescribeTitle) => `${file} :: ${title}`;

function offenders(): DescribeTitle[] {
  const bound = namesSrcBinds();

  return topLevelDescribeTitles().filter(({ title }) => {
    // The leading symbol, not the whole title: `CdnService.validateDomain`,
    // `checkServerAccess` and `dockerfileStrategy.getCommand` all name
    // their unit and all carry something after it, and requiring the title to
    // *equal* a bound name rejects sixty-two of those across this tree — so the
    // strict reading of §1.7's "verbatim" is not what this gate enforces.
    //
    // The cost is real and is stated in §4 rather than hidden: a bound name
    // with prose bolted on (`trustedProxyRanges as the gate on an incoming
    // chain`) passes. This gate refuses a title that *opens* with prose, which
    // is every one of the forty-two first found; it does not refuse prose that
    // hides behind a symbol.
    const named = /^[A-Za-z_$][\w$]*/.exec(title);
    if (named && bound.has(named[0])) return false;

    // A path, and only if it resolves — `deploy/install.sh` is a unit, `deploy
    // the console by hand` is prose, and the `.`/`/` is what tells them apart.
    const [firstToken = ''] = title.split(/\s+/);
    if (/[./]/.test(firstToken) && existsSync(join(repoRoot, firstToken))) {
      return false;
    }
    return true;
  });
}

describe('CODING_STANDARDS.md', () => {
  describe('§1.7, on what a top-level describe is allowed to be called', () => {
    it('leaves no unit spec naming a describe after prose', () => {
      const unbaselined = offenders()
        .filter((found) => !BASELINE.includes(key(found)))
        .map(({ file, line, title }) => `${file}:${line} :: ${title}`);

      expect(unbaselined).toEqual([]);
    });

    /**
     * The load-bearing half. Without it the baseline is an append-only amnesty
     * and the test above can be satisfied by writing the new violation down.
     */
    it('holds the baseline at the size it was frozen at, or smaller', () => {
      expect(BASELINE.length).toBeLessThanOrEqual(38);
    });

    /**
     * And the other way a baseline rots: an entry whose describe was fixed or
     * deleted stays behind as a standing amnesty for that file and title, so a
     * later re-introduction of the same prose passes. Every entry has to name a
     * live offender.
     */
    it('carries no baseline entry for a describe that is no longer there', () => {
      const live = new Set(offenders().map(key));

      expect(BASELINE.filter((entry) => !live.has(entry))).toEqual([]);
    });
  });
});
