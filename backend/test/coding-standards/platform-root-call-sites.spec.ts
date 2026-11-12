import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import * as ts from 'typescript';

/**
 * **Every expression in `src` that resolves the platform tree's root *without*
 * a machine says why it is local** (closing the class of local-root bugs).
 *
 * The defect this exists for is one mistake made seven times. The platform tree
 * has two roots — this instance's `CLOUDGATE_DIRECTORY` and the
 * `/etc/cloudgate` literal `serverSetupCommand` creates on a Server
 * (`common/config/cloudgate-directory.ts`) — and a path baked into a command
 * sent over SSH has to be the *second* one. One change landed
 * `cloudgateDirectoryOn(serverId)` as the one statement of that fork; a first
 * pass converted five source-tree sites; a second converted four more trees
 * and found a **sixth** source-tree site the first had missed.
 *
 * **The seventh was found by this file and is now closed, which is the first
 * evidence that the gate does the thing it was built for.**
 * `src/settings/traefik-files.service.ts` was declared here as `deferred` with
 * a write-up rather than as an unnoticed local root, and that write-up became
 * the ticket: `mainTraefikDirectory()` was frozen into a `MAIN_TRAEFIK_DIR`
 * *string* by a `useFactory` called once, so every Server-scoped Traefik-files
 * route named `{localRoot}/traefik/…` on a host where `serverSetupCommand`
 * created `/etc/cloudgate/traefik`, and `POST /settings/traefik/requests`
 * answered 404 *"No Traefik configuration on this server"* for a Server that
 * has one. Its entry is **gone rather than moved to `forks-in-place`**, per the
 * rule below: the file resolves the root through `cloudgateDirectoryOn` now and
 * so is no longer this census's subject.
 * `src/traefik/traefik-writer.service.ts` left with it — it was the last
 * `forks-in-place` verdict written out by hand, and its second spelling of the
 * fork was replaced with the one statement of it, which is what
 * `cloudgateDirectoryOn` was for and what stopped the two halves of the Traefik
 * tree disagreeing inside one service.
 *
 * **The last three went with the mount-source conversion, and the deferred cap
 * is 0.** They were the mount-source triple — `mounts.service.ts`'s
 * `baseFilesPath`, `mechanize.ts` and `databases/common/database-spec.ts` —
 * deferred here on the argument that a bind-mount *source* is resolved by
 * neither this process nor a build host and therefore by neither answer the
 * fork gives. That was half right: a bind source is a path in the **mounting
 * host's** filesystem, so it is the *run* Server's root, which is the fork's
 * remote answer reached with a different id. Their three entries are deleted
 * for the same reason the Traefik pair's were, and `applicationsDirectory` —
 * the export they all called — is gone with them, so what this file now walks
 * for is two helpers rather than three.
 *
 * **Why a census rather than another suite.** The first pass enumerated its
 * five by going looking for the paths a **Delete** names, so the site it missed
 * — `PatchService.generateApplyPatchesCommand`'s application arm, a second
 * *writer* into the tree — was never a candidate. And the suite written to hold
 * those five, `test/applications/source-tree-roots.e2e-spec.ts`, could not see
 * it either: the second pass measured that suite **8/8 green with the site
 * reverted** to the local root, because a test reads the programs it drives and
 * that file drives a deploy and a delete, not a patched deploy. Its docblock in
 * `deployment-engine.paths.ts` had claimed *"a sixth call site resolving the
 * root differently fails there"*; that sentence was corrected and this file is
 * the thing that makes the narrower claim unnecessary. An enumeration built
 * from the **helper's own callers** cannot miss a caller.
 *
 * **What is asserted, and what deliberately is not.** Asserted: the set of
 * call sites is exactly the set declared below, in both directions — an
 * undeclared one fails, and a declaration whose site is gone fails too, which
 * is the half that stops this becoming an append-only amnesty (the device
 * `describe-names.spec.ts`' baseline uses, for its reason).
 *
 * Not asserted: whether a declared site's path ever crosses SSH. That is the
 * question, and it is not statically decidable here — `MAIN_TRAEFIK_DIR` used to
 * be a `useFactory` string handed to a service that both `fs.writeFileSync`d it
 * and `execRemote`d it three methods apart (and the answer turned out to
 * be *both*), and the sixth source-tree site was a *string returned to a
 * caller* that dispatched it, two modules away. A checker
 * would need a call graph and a taint analysis; `ts.createSourceFile` gives
 * neither (`deployable-query-result-types.spec.ts` states the same limit for
 * the same reason it reads the parser rather than the checker). So what this
 * gate buys is not a verdict — it is that **a new site cannot arrive without
 * someone writing down which of the three answers it is**, which is exactly
 * what the first pass never had to do.
 *
 * The dynamic gate that was considered instead, and why it is not this: an
 * assertion inside the e2e exec double that no command sent to a Server names
 * the local root. It would only see dispatches a test drives, which is the
 * precise blind spot that let the sixth site through, so it could stand beside
 * this file but not replace it.
 *
 * This paragraph used to reject it on cost as well, and that half is gone.
 * Making it bite meant setting `CLOUDGATE_DIRECTORY` for the whole harness,
 * priced here at the **348** `/etc/cloudgate` literals across **63** files in
 * `test/` that would have to be rewritten. It was measured instead: most of
 * those literals are about a Server and stay correct under any local root, and
 * the ones that were not came to 13 e2e and 12 unit suites. Every lane now
 * runs with the two roots distinct (`test/utils/platform-root.ts`), so a test
 * that confuses them reds by construction, which is the test-side half of what
 * this file does for `src/`.
 */

const backendRoot = join(__dirname, '..', '..');
const srcRoot = join(backendRoot, 'src');

/**
 * The exports that answer "the platform root" with no machine, and the module
 * each comes from. `cloudgateDirectoryOn`, `applicationsDirectoryOn`,
 * `logsDirectoryOn`, `composeDirectoryOn`, `schedulesDirectoryOn`,
 * `patchReposDirectoryOn`, `volumeBackupsDirectoryOn`,
 * `volumeBackupLockPathOn` and `fileMountsDirectoryOnRunServer` are the
 * machine-taking forms and are not this file's subject — a caller passing a
 * machine is the shape `cloudgateDirectoryOn` set out for.
 *
 * `applicationsDirectory` was the third of these and is **gone** since the
 * mount-source triple was converted: its last caller passed no machine, and the
 * page's own rule is that a converted tree's no-argument spelling is deleted
 * rather than left as an export with no correct call site.
 *
 * `logsDirectory` is in the set although it has no caller in `src` at all: that
 * fact is claimed in `deployment-engine.paths.ts`' header, and this is what
 * keeps the claim true.
 */
const ROOT_HELPERS: ReadonlyMap<string, string> = new Map([
  ['localCloudgateDirectory', 'cloudgate-directory'],
  ['logsDirectory', 'deployment-engine.paths'],
]);

/**
 * The two files that *define* these helpers. A definition is not a call site:
 * `cloudgateDirectoryOn` calls `localCloudgateDirectory(env)` because it **is**
 * the fork, and `deployment-engine.paths.ts` builds `logsDirectory` — the one
 * no-argument export it has left — on top of it.
 */
const OWNERS: readonly string[] = [
  'src/common/config/cloudgate-directory.ts',
  'src/deployment-engine/deployment-engine.paths.ts',
];

/**
 * Which of the three answers a local root can be. Only `deferred` is a defect;
 * the other two are the reasons a local root is correct.
 *
 * `deferred` has no entry left and stays in the union deliberately:
 * the cap below asserts that nothing uses it, which is a statement a reader can
 * only check against an arm that exists. Deleting it would make a new site's
 * only options the two verdicts that mean *correct*, and the point of the cap
 * is that such a site has to be fixed rather than described.
 */
type Verdict =
  /** The expression itself chooses, `serverId ? REMOTE_… : local…`. */
  | 'forks-in-place'
  /** The tree is this process's own and no command carries it to a Server. */
  | 'platform-host-only'
  /** It should ask a machine and does not. Its own ticket, named here. */
  | 'deferred';

interface Declared {
  /** Repo-relative, from `backend/`. */
  readonly file: string;
  readonly verdict: Verdict;
  readonly why: string;
}

/**
 * Every file in `src` that resolves the root without a machine, and why.
 *
 * A file is one entry however many sites it has, because the question — does
 * this module's tree ever cross SSH? — is a fact about the module, not about
 * the line. Adding a site to a file already here therefore passes; that is the
 * limit above, stated once more where it costs something.
 */
const DECLARED: readonly Declared[] = [
  {
    file: 'src/settings/runtime-info.service.ts',
    verdict: 'forks-in-place',
    why: '`collect` picks `REMOTE_CLOUDGATE_DIRECTORY` for a Server and the local root for the platform host, and the value it reports is *about* the machine it probed.',
  },
  {
    file: 'src/realtime/ws.utils.ts',
    verdict: 'forks-in-place',
    why: "`readValidDirectory` forks on `serverId`, and the local branch resolves symlinks on purpose where the remote one compares lexically — resolving a Server's symlinks against this host's filesystem would answer about the wrong machine.",
  },
  {
    file: 'src/realtime/legacy-stats-series.ts',
    verdict: 'platform-host-only',
    why: "`monitoringDirectory()`: where the live stream's JSON series were written with `fs` in this process before it moved, and so where its boot purge removes them. The stream never had a remote branch.",
  },
  {
    file: 'src/realtime/local-server-setup.service.ts',
    verdict: 'platform-host-only',
    why: 'The local-terminal SSH key pair, created by `setupSshKey()` with `fs` and dialled from this process. A key on a Server would defeat the point of the local terminal.',
  },
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
 * The local names an import statement binds to one of the helpers.
 *
 * Read from the parser rather than by grep, because the names appear far more
 * often in prose than in code — `deployment-engine.paths.ts` alone mentions
 * `localCloudgateDirectory` five times inside docblocks, and a comment naming a
 * site is what this whole ticket is about not trusting. An alias (`import { x
 * as y }`) is followed, so renaming the import cannot hide a site.
 */
function boundHelperNames(source: ts.SourceFile): Set<string> {
  const bound = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const specifier = statement.moduleSpecifier.text;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;

    for (const element of bindings.elements) {
      const exported = (element.propertyName ?? element.name).text;
      const module = ROOT_HELPERS.get(exported);
      if (module && specifier.endsWith(module)) bound.add(element.name.text);
    }
  }
  return bound;
}

interface Site {
  /** Repo-relative, from `backend/`, so a failure is a thing you can open. */
  readonly file: string;
  readonly line: number;
  readonly called: string;
}

/** Every call of a helper in `src`, its definition files aside. */
function callSites(): Site[] {
  const sites: Site[] = [];

  for (const path of walk(srcRoot).sort()) {
    if (!path.endsWith('.ts')) continue;
    const file = relative(backendRoot, path).split('\\').join('/');
    if (OWNERS.includes(file)) continue;

    const text = readFileSync(path, 'utf8');
    const source = ts.createSourceFile(
      path,
      text,
      ts.ScriptTarget.Latest,
      true,
    );
    const bound = boundHelperNames(source);
    if (bound.size === 0) continue;

    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        bound.has(node.expression.text)
      ) {
        sites.push({
          file,
          line:
            source.getLineAndCharacterOfPosition(node.getStart(source)).line +
            1,
          called: node.expression.text,
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return sites;
}

const declaredFiles = new Set(DECLARED.map(({ file }) => file));

describe('localCloudgateDirectory, on every expression in src that resolves the platform root without a machine', () => {
  /**
   * The guard every gate of this shape needs: a walk that finds nothing passes
   * both assertions below for the wrong reason, and a rename of a helper is
   * exactly how it would come to find nothing.
   */
  it('finds the local-root call sites at all', () => {
    const found = callSites();

    expect(found.length).toBeGreaterThanOrEqual(DECLARED.length);
    expect(new Set(found.map(({ called }) => called))).toEqual(
      new Set(['localCloudgateDirectory']),
    );
  });

  it('leaves no expression resolving the platform root locally undeclared', () => {
    const undeclared = callSites()
      .filter(({ file }) => !declaredFiles.has(file))
      .map(({ file, line, called }) => `${file}:${line} :: ${called}()`);

    expect(undeclared).toEqual([]);
  });

  /**
   * The half that stops the list becoming an amnesty: an entry whose site was
   * converted or deleted stays behind as a standing "this file is allowed to be
   * local", so the next site in it passes unread. A conversion deletes its
   * entry.
   */
  it('carries no declaration for a file that no longer resolves the root locally', () => {
    const live = new Set(callSites().map(({ file }) => file));

    expect(
      DECLARED.map(({ file }) => file).filter((file) => !live.has(file)),
    ).toEqual([]);
  });

  /**
   * And the worklist only shrinks. `deferred` is the arm that means *wrong*, so
   * an entry over the cap is a regression of the local-root defect however well
   * it is written up — which is the objection to a pure "say why" gate,
   * answered.
   *
   * **The cap is 0, and the census is closed.** It was filed at 4, went to 3
   * when `traefik-files.service.ts` was closed, and reaches 0 with the
   * mount-source triple — `mounts.service.ts`, `mechanize.ts` and
   * `databases/common/database-spec.ts`, one question and one ticket, whose
   * three entries are **deleted rather than re-verdicted** because none of the
   * three resolves the root without a machine any more and this file's own rule
   * above is that a conversion deletes its entry. Every local root left in
   * `src` is now one of the two verdicts that mean *correct*.
   *
   * At 0 the assertion changes character, and deliberately: it no longer
   * ratchets a worklist down, it refuses a new one. A site that cannot answer
   * `forks-in-place` or `platform-host-only` has to be fixed rather than
   * written up, because there is no longer a batch it can be deferred into.
   */
  it('holds the deferred set at the size it was filed at, or smaller', () => {
    const deferred = DECLARED.filter(
      ({ verdict }) => verdict === 'deferred',
    ).map(({ file }) => file);

    expect(deferred).toEqual([]);
  });

  /** Every declaration says something, since saying it is the whole gate. */
  it('gives every declared file a verdict and a reason', () => {
    expect(
      DECLARED.filter(({ why }) => why.trim().length < 40).map(
        ({ file }) => file,
      ),
    ).toEqual([]);
    expect(new Set(DECLARED.map(({ file }) => file)).size).toBe(
      DECLARED.length,
    );
  });
});
