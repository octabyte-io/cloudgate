import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import * as ts from 'typescript';

/**
 * **Every file in `src` that writes a file or a directory says what mode it
 * lands with, and why that is enough**.
 *
 * The defect this exists for is one mistake made at four sites, each found by a
 * separate phase of the U-run: a custom certificate's `privkey.key`, a file
 * mount's content, every stack's and Application's `.env`, and a build log —
 * all `0644` under `0755` directories, so the console's unprivileged
 * `cloudgate` user, and every other local account, could read what the database
 * held as `enc:v1:`. Nobody chose `0644`: every writer took the process umask,
 * and a writer that does not have to say what mode it writes with never gets
 * asked. So this is the question asked of every writer, the way
 * `platform-root-call-sites.spec.ts` asks every local root which answer it is.
 *
 * **What counts as a writer, read off the parser.** Two shapes, found in code
 * rather than prose so a docblock that mentions a redirect is not a site:
 *
 * - a call into `node:fs` that creates or writes (`writeFileSync`, `mkdir`,
 *   `appendFile`, `createWriteStream`, `rename`, …), through whichever local
 *   name the file imported it under;
 * - a shell redirect or `tee`/`touch` inside a string or template literal — the
 *   `echo "<base64>" | base64 -d > <path>` every remote write in the tree is,
 *   and the `>> <log>` every logged program ends with — excluding the ones into
 *   `/dev/*` and the `2>&1` family.
 *
 * **What it deliberately cannot see.** A tool that writes by *argument* rather
 * than by redirect — `git clone <dir>`, `tar -x`, `ssh-keygen -f`, `docker cp`,
 * `rclone copy` — is not a redirect and is not found. Neither is a caller of a
 * writer function in another file: `getCreateFileCommand` is one entry
 * (`docker/docker.utils.ts`) for its three callers, and its declaration names
 * where the directory around each is closed. And a second site added to a file
 * already declared passes, because the question is asked per module. Those are
 * the limits `platform-root-call-sites.spec.ts` states for the same reason — a
 * parser gives no call graph — and what the gate still buys is the thing none
 * of the four original sites ever had to do: write down its mode before it lands.
 *
 * **The verdicts that claim protection are checked, not taken.** An
 * `owner-only-file` entry must call the helper that writes one, and an
 * `owner-only-directory` entry must name the files that close its directory,
 * each of which must call the helper that does. So an entry cannot say "this is
 * protected" of a site that has stopped being.
 *
 * Both directions, as the precedent has it: an undeclared writer fails, and so
 * does a declaration whose file no longer writes anything.
 */

const backendRoot = join(__dirname, '..', '..');
const srcRoot = join(backendRoot, 'src');

/** The helpers themselves: `common/files/owner-only.ts` and its boot sweep. */
const OWNERS: readonly string[] = [
  'src/common/files/owner-only.ts',
  'src/common/files/owner-only-trees.service.ts',
];

/** The helper calls that make a file owner-only, and those that close a directory. */
const FILE_HELPERS = ['writeOwnerOnlyFileSync', 'writeOwnerOnlyFileCommand'];
const DIRECTORY_HELPERS = [
  'makeOwnerOnlyDirectorySync',
  'ownerOnlyDirectoryCommand',
];

type Verdict =
  /** `0600` in a `0700` directory, through `writeOwnerOnlyFile*`. The reader is root. */
  | 'owner-only-file'
  /**
   * Written into a directory `closedBy` makes `0700`, with the file's own mode
   * left for a reader that is not root (a container's user, an image's).
   */
  | 'owner-only-directory'
  /** Under the platform tree at the umask's mode, and nothing in it is a secret. */
  | 'default-mode'
  /** Not under the platform tree at all; the why says where, and how that is held. */
  | 'outside-platform-tree'
  /** Can carry operator secret material and is not closed yet. Named in the why. */
  | 'deferred';

interface Declared {
  /** Repo-relative, from `backend/`. */
  readonly file: string;
  readonly verdict: Verdict;
  /** For `owner-only-directory`: the files whose helper call closes the directory. */
  readonly closedBy?: readonly string[];
  readonly why: string;
}

const DECLARED: readonly Declared[] = [
  // ── The four original sites ──────────────────────────────────────────────
  {
    file: 'src/traefik/traefik-writer.service.ts',
    verdict: 'owner-only-file',
    why: "`writeCertificate`: `privkey.key` and `chain.crt`, `0600` in the certificate's own `0700` directory on both machines, and the `certificate+<certificatePath>.yml` fragment at the top of `dynamic/`, `0600` and renamed into place (`replaceOwnerOnlyFile*`); Traefik reads them as root. `writeConfig`'s `{appName}.yml` is `default-mode` inside the same file — routing config, whose basic-auth entries are bcrypt hashes the Files tree already redacts.",
  },
  {
    file: 'src/docker/docker.utils.ts',
    verdict: 'owner-only-directory',
    closedBy: [
      'src/mounts/mounts.service.ts',
      'src/deployment-engine/deployment-engine.service.ts',
    ],
    why: "`getCreateFileCommand`: a file mount's content (`MountsService.writeFileMount`, which closes the Service directory first) and the build context's `.env`, `nginx.conf`, `.dockerignore` and `Dockerfile` (the dockerfile and static strategies, inside `code`, which the deploy's first step closes). The file keeps the umask's mode because a container's user reads a mount and an image's user reads a `COPY`d `.env`.",
  },
  {
    file: 'src/compose/compose.utils.ts',
    verdict: 'owner-only-directory',
    closedBy: ['src/deployment-engine/deployment-engine.service.ts'],
    why: "`getCreateComposeEnvFileCommand` writes the stack's `.env` — every generated secret — and `writeComposeFileCommand` the converted compose file, both into `code`, inside the stack directory `deployCompose`'s clone step closes. A `build: .` may carry the `.env` into an image, so its own mode is left for that image's user.",
  },
  {
    file: 'src/deployments/deployments.service.ts',
    verdict: 'owner-only-directory',
    closedBy: ['src/deployments/deployments.service.ts'],
    why: '`initLogFile` closes `logs/{appName}` as it creates the log: a build log is whatever the build printed. Only root reads it back, through the log socket.',
  },
  {
    file: 'src/remote/run-target.ts',
    verdict: 'owner-only-directory',
    closedBy: ['src/deployments/deployments.service.ts'],
    why: "`execToLog` appends a program's output to its Deployment's log: on a Server or the platform host by the program's own `>> log` redirect, and for a stack on its Stack VM here on the platform host as the output streams back, into the log `initLogFile` made inside the `logs/{appName}` directory it closes. Only root reads it back, through the log socket.",
  },
  {
    file: 'src/deployment-queue/cloud-runs.service.ts',
    verdict: 'owner-only-directory',
    closedBy: ['src/deployments/deployments.service.ts'],
    why: "`logLine` appends a Cloud run's last line — how it ended, Cloudgate's own sentence — to its Deployment's log, which `initLogFile` made inside the `logs/{appName}` directory it closes. Only root reads it back, through the log socket.",
  },
  {
    file: 'src/applications/cloud-delete.ts',
    verdict: 'owner-only-directory',
    closedBy: ['src/applications/cloud-delete.ts'],
    why: "A cloud Service's Delete records its Deployment as `initLogFile` does: it closes `logs/{appName}` as it creates the log, which holds only `tofu destroy`'s lines and Cloudgate's report. Only root reads it back, through the log socket.",
  },
  {
    file: 'src/databases/common/cloud-database-deletes.ts',
    verdict: 'owner-only-directory',
    closedBy: ['src/databases/common/cloud-database-deletes.ts'],
    why: "A cloud database's Delete records its Deployment as a cloud Service's does: it closes `logs/{appName}` as it creates the log, which holds only `tofu destroy`'s lines and Cloudgate's report. Only root reads it back, through the log socket.",
  },
  {
    file: 'src/compose/stack-vm-deletes.ts',
    verdict: 'owner-only-directory',
    closedBy: ['src/compose/stack-vm-deletes.ts'],
    why: "A stack on a Stack VM's Delete (#1367) records its Deployment as a cloud database's does: it closes `logs/{appName}` as it creates the log, which holds only `tofu destroy`'s lines and Cloudgate's report. Only root reads it back, through the log socket.",
  },
  {
    file: 'src/project-config/applier/cloud-deploy-steps.ts',
    verdict: 'owner-only-directory',
    closedBy: ['src/deployments/deployments.service.ts'],
    why: "`pushProgram` appends a cloud deploy's `docker login`, `push` and `image rm` output to its Deployment's log, which `initLogFile` made inside the `logs/{appName}` directory it closes. The login's own output is sent to /dev/null, and its password is never a word of the program.",
  },
  // ── A hosted cloud build ────────────────────────────────────────
  {
    file: 'src/project-config/applier/aws-cloud-builds.service.ts',
    verdict: 'owner-only-directory',
    closedBy: ['src/deployment-engine/deployment-engine.service.ts'],
    why: "The source zip goes to `applications/{appName}/cloud-builds/{deploymentId}/upload` (`0700`, the zip itself `0600`), inside the Service directory the deploy's first step closes. It carries the build's variables and build secrets as files for CodeBuild, so it is removed with its folder once the build has ended, uploaded or not.",
  },
  {
    file: 'src/cloud-builds/codebuild-program.ts',
    verdict: 'outside-platform-tree',
    why: "`codeBuildScript` writes the ECR credential helper's `config.json` and `docker image inspect`'s answer inside the CodeBuild build's own container, in the customer's account: never on the platform host.",
  },
  {
    file: 'src/project-config/applier/google-cloud-builds.service.ts',
    verdict: 'owner-only-directory',
    closedBy: ['src/deployment-engine/deployment-engine.service.ts'],
    why: "Cloud Build's source zip goes to the same `applications/{appName}/cloud-builds/{deploymentId}/upload` (`0700`, the zip `0600`) as CodeBuild's, inside the Service directory the deploy's first step closes, and is removed with its folder once the build has ended, uploaded or not.",
  },
  {
    file: 'src/cloud-accounts/definitions/stack-vm-cloud-init.ts',
    verdict: 'outside-platform-tree',
    why: "`stackVmCloudInit` is a Stack VM's first boot (ADR-0070): its `/etc/fstab` line for the data disk and Docker's apt source are written on the Stack VM itself, in the customer's account, by cloud-init: never on the platform host, and nothing in them is a secret.",
  },
  {
    file: 'src/cloud-builds/google-build-program.ts',
    verdict: 'outside-platform-tree',
    why: "`googleBuildScript` writes `docker image inspect`'s answer to `$BUILDER_OUTPUT/output` inside the Cloud Build step's own container, in the customer's project: never on the platform host.",
  },
  // ── A Trace store's config ───────────────────────────────────────
  {
    file: 'src/traces/trace-store.ts',
    verdict: 'owner-only-directory',
    closedBy: ['src/traces/trace-store.ts'],
    why: "The Trace store's `config.yaml` carries both of its `basicauth` credentials, so the store's directory is closed before the file is written, and the file is `0600` before the config reaches it — from the program's environment, never its text. The store runs as the account that wrote it.",
  },
  // ── A Cloud run's working folder ─────────────────────────────────
  {
    file: 'src/cloud-accounts/tofu/tofu-runner.ts',
    verdict: 'outside-platform-tree',
    why: "A Cloud run's `tofu` working folder is `mkdtemp`'s under the system temporary folder — `0700` by `mkdtemp` itself — and is removed when the run ends. It holds the definition, the pin files, the CLI config and OpenTofu's own encrypted plan, and on a Google run the credential configuration file (`0600`, which the Google provider reads only from a file); every other secret reaches `tofu` through its environment, never a file here (`tofu-runner.spec.ts` holds both).",
  },
  // ── Into a Service directory the deploy closes ──────────────────────────
  {
    file: 'src/deployment-engine/deployment-engine.service.ts',
    verdict: 'owner-only-directory',
    closedBy: [
      'src/deployments/deployments.service.ts',
      'src/deployment-engine/deployment-engine.service.ts',
    ],
    why: "Appends the deploy's steps and failure lines to the build log `initLogFile` closed, and closes the Service directory itself before the clone — which is what the `.env` writers above rely on.",
  },
  {
    file: 'src/git-providers/strategies/raw.strategy.ts',
    verdict: 'owner-only-directory',
    closedBy: ['src/deployment-engine/deployment-engine.service.ts'],
    why: "A raw stack's compose file, into `code` inside the stack directory `deployCompose` closes before running this clone step.",
  },
  {
    file: 'src/patch/patch.service.ts',
    verdict: 'owner-only-directory',
    closedBy: ['src/deployment-engine/deployment-engine.service.ts'],
    why: "`generateApplyPatchesCommand` writes a patch's files into `code`, after the deploy's clone step has closed the Service directory around it.",
  },
  {
    file: 'src/applications/drop-archive.ts',
    verdict: 'owner-only-directory',
    closedBy: ['src/applications/drop-archive.ts'],
    why: "An uploaded archive's entries, into `code`: `materializeDrop` closes the Service directory before it writes them, because an upload lands before any deploy has and an uploaded tree can carry a `.env`.",
  },
  {
    file: 'src/applications/drop-changes.ts',
    verdict: 'owner-only-directory',
    closedBy: ['src/applications/drop-changes.ts'],
    why: "An upload of only the changed files: `applyDropChangesCommand` closes the Service directory before it builds the new tree and its file lists in a working directory inside it, for `materializeDrop`'s reason.",
  },
  // ── Logs, under a log directory `initLogFile` closes ────────────────────
  {
    file: 'src/scheduling/schedules/schedule-commands.ts',
    verdict: 'owner-only-directory',
    closedBy: ['src/scheduling/schedules/schedule-commands.ts'],
    why: "`buildScriptMaterializationCommand` closes `schedules/{appName}` before it writes the operator's script into it — a script is where a curl token goes, and this census found it `0755`. Its log appends go to the deployment log `initLogFile` closed.",
  },
  {
    file: 'src/backups/commands/utils.ts',
    verdict: 'default-mode',
    why: "Appends backup progress lines to the run's log. What reaches it is `[date]` lines and rclone's error text, and rclone never echoes S3 credentials; the log's directory is `logs/{appName}`, which `initLogFile` and the boot sweep close.",
  },
  {
    file: 'src/backups/run-recorder.service.ts',
    verdict: 'default-mode',
    why: "Creates a backup run's log with its first line, under `logs/{appName}`. The same content as `backups/commands/utils.ts`; the directory is closed by a deployment's `initLogFile` or the boot sweep, not here.",
  },
  {
    file: 'src/cron-services/cron-runs.service.ts',
    verdict: 'default-mode',
    why: "Appends a Cron service's run output and exit code to its run log, the `run-recorder.service.ts` log: the container's own stdout and stderr, as a build's output is the builder's, under `logs/{appName}`, which a deployment's `initLogFile` or the boot sweep closes.",
  },
  {
    file: 'src/volume-backups/volume-backups.service.ts',
    verdict: 'default-mode',
    why: "Appends a volume backup's script output to its run log, the `run-recorder.service.ts` log; its content is tar and rclone progress.",
  },
  // ── Under the platform tree, and not secret ─────────────────────────────
  {
    file: 'src/settings/traefik-files.service.ts',
    verdict: 'default-mode',
    why: "`traefik.yml` and the dynamic configs the Traefik file editor saves: routing config Traefik reads, which the console shows the operator; it withholds `privkey.key` and redacts basic-auth hashes rather than holding either here. The log rotation `rename`s Traefik's own access log.",
  },
  {
    file: 'src/servers/server-setup.ts',
    verdict: 'default-mode',
    why: "`serverSetupCommand`'s heredocs write a Server's `traefik.yml` and `middlewares.yml` — the stock static config and the redirect middleware, the same bytes on every Server.",
  },
  {
    file: 'src/monitoring/access-log.index.ts',
    verdict: 'default-mode',
    why: "The access log's hour index beside it, `{log}.hours`: byte offsets and hour buckets, no request content.",
  },
  {
    file: 'src/realtime/local-server-setup.service.ts',
    verdict: 'owner-only-file',
    why: '`setupSshKey` creates `ssh/` `0700` itself, and `ssh-keygen` writes the private key `0600`. It predates the helper and spells `mode: 0o700` directly; the key is written by argv, which this census cannot see.',
  },
  // ── Not under the platform tree ─────────────────────────────────────────
  {
    file: 'src/git-providers/strategies/git.strategy.ts',
    verdict: 'outside-platform-tree',
    why: "The clone SSH key and `known_hosts`, in the clone's own `mktemp -d` directory (`0700` by construction) on the build host, removed when the clone ends; the key is `chmod 600`d on the next line, which `ssh` itself insists on.",
  },
  {
    file: 'src/git-providers/git-clone-lines.ts',
    verdict: 'outside-platform-tree',
    why: "`tee`s `git clone`'s output into a `mktemp -d` directory (`0700` by construction) to grep it for a credentials prompt, and removes it.",
  },
  {
    file: 'src/bought-servers/storage.ts',
    verdict: 'outside-platform-tree',
    why: "`storageCommand` appends the extra storage's mount line to a Bought Server's `/etc/fstab` and asks the kernel to rescan the Volume under `/sys`: the machine's own system files, no secret in either.",
  },
  {
    file: 'src/docker-ops/docker-ops.service.ts',
    verdict: 'outside-platform-tree',
    why: 'A file uploaded into a container is staged in `/tmp` for `docker cp` and removed whatever the copy did.',
  },
  {
    file: 'src/realtime/gateways/server-terminal.gateway.ts',
    verdict: 'outside-platform-tree',
    why: "Appends the platform's public key to the SSH user's `authorized_keys`, whose mode `sshd` already requires.",
  },
  {
    file: 'src/settings/gpu-setup-script.ts',
    verdict: 'outside-platform-tree',
    why: "Docker's `daemon.json` and the NVIDIA runtime's `config.toml` in `/etc`, both the tools' own configuration files.",
  },
];

/** Every `.ts` file under `dir`, recursively. */
function walk(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(path));
    else if (entry.name.endsWith('.ts')) found.push(path);
  }
  return found;
}

const FS_MODULES = new Set([
  'fs',
  'node:fs',
  'fs/promises',
  'node:fs/promises',
]);
const FS_WRITES = new Set([
  'writeFileSync',
  'writeFile',
  'appendFileSync',
  'appendFile',
  'createWriteStream',
  'copyFileSync',
  'copyFile',
  'cpSync',
  'cp',
  'renameSync',
  'rename',
  'mkdirSync',
  'mkdir',
  'mkdtempSync',
  'mkdtemp',
  'symlinkSync',
  'symlink',
]);

/**
 * A redirect into a file, a `tee` or a `touch`. `(?<![\w&<=-])` keeps out
 * `2>&1`, `=>`, `->` and an HTML tag's `>`, and a `/dev/` target is not a file
 * anyone reads. A redirect whose target is interpolated ends its template
 * piece, which the second pattern is for.
 */
const REDIRECT =
  /(?<![\w&<=>-])>>?\s*(?:["']?\$|["']?\/(?!dev\/)|")|\btee\s+(?:-a\s+)?\S|\|\s*(?:sudo\s+)?tee\b|\btouch\s+\S/;
const REDIRECT_AT_END = /(?<![\w&<=>-])>>?\s*["']?$/;

interface Site {
  readonly file: string;
  readonly line: number;
  readonly how: string;
}

/** The local names bound to `node:fs` (or its promises API) in `source`. */
function fsBindings(source: ts.SourceFile): {
  namespaces: Set<string>;
  functions: Set<string>;
} {
  const namespaces = new Set<string>();
  const functions = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (!FS_MODULES.has(statement.moduleSpecifier.text)) continue;
    const clause = statement.importClause;
    if (!clause) continue;
    if (clause.name) namespaces.add(clause.name.text);
    const bindings = clause.namedBindings;
    if (!bindings) continue;
    if (ts.isNamespaceImport(bindings)) {
      namespaces.add(bindings.name.text);
      continue;
    }
    for (const element of bindings.elements) {
      const imported = (element.propertyName ?? element.name).text;
      if (imported === 'promises') namespaces.add(element.name.text);
      else if (FS_WRITES.has(imported)) functions.add(element.name.text);
    }
  }
  return { namespaces, functions };
}

/** `fs.x`, `fs.promises.x` or `fsPromises.x`, for a bound namespace `fs`. */
function isFsReceiver(node: ts.Expression, namespaces: Set<string>): boolean {
  if (ts.isIdentifier(node)) return namespaces.has(node.text);
  return (
    ts.isPropertyAccessExpression(node) &&
    node.name.text === 'promises' &&
    ts.isIdentifier(node.expression) &&
    namespaces.has(node.expression.text)
  );
}

/** Every write site in `src`, the helpers' own files aside. */
function writeSites(): Site[] {
  const sites: Site[] = [];
  for (const path of walk(srcRoot).sort()) {
    const file = relative(backendRoot, path).split('\\').join('/');
    if (OWNERS.includes(file)) continue;
    const source = ts.createSourceFile(
      path,
      readFileSync(path, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const { namespaces, functions } = fsBindings(source);
    const at = (node: ts.Node) =>
      source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;

    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        if (
          ts.isPropertyAccessExpression(callee) &&
          FS_WRITES.has(callee.name.text) &&
          isFsReceiver(callee.expression, namespaces)
        ) {
          sites.push({ file, line: at(node), how: `fs.${callee.name.text}` });
        } else if (ts.isIdentifier(callee) && functions.has(callee.text)) {
          sites.push({ file, line: at(node), how: `fs.${callee.text}` });
        }
      }
      const piece =
        ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
          ? { text: node.text, interpolated: false }
          : ts.isTemplateHead(node) || ts.isTemplateMiddle(node)
            ? { text: node.text, interpolated: true }
            : ts.isTemplateTail(node)
              ? { text: node.text, interpolated: false }
              : null;
      if (piece) {
        for (const text of piece.text.split('\n')) {
          if (
            REDIRECT.test(text) ||
            (piece.interpolated && REDIRECT_AT_END.test(text))
          ) {
            sites.push({ file, line: at(node), how: text.trim() });
            break;
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return sites;
}

/** Whether `file` calls one of `helpers` by name, read off the parser. */
function calls(file: string, helpers: readonly string[]): boolean {
  const source = ts.createSourceFile(
    file,
    readFileSync(join(backendRoot, file), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  let found = false;
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      helpers.includes(node.expression.text)
    ) {
      found = true;
    }
    if (!found) ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

const declaredFiles = new Set(DECLARED.map(({ file }) => file));

describe('writeOwnerOnlyFileCommand, on every file in src that writes under the platform tree', () => {
  /**
   * The guard every gate of this shape needs: a walk that finds nothing passes
   * the two assertions after it. Pinned on the four sites this gate was written
   * for, so a scanner that stops seeing either shape fails here first.
   */
  it('finds the writers this gate was written for', () => {
    const files = new Set(writeSites().map(({ file }) => file));

    expect(
      [
        'src/traefik/traefik-writer.service.ts',
        'src/docker/docker.utils.ts',
        'src/compose/compose.utils.ts',
        'src/deployments/deployments.service.ts',
      ].filter((file) => !files.has(file)),
    ).toEqual([]);
  });

  it('leaves no writer undeclared', () => {
    const undeclared = writeSites()
      .filter(({ file }) => !declaredFiles.has(file))
      .map(({ file, line, how }) => `${file}:${line} :: ${how}`);

    expect(undeclared).toEqual([]);
  });

  /** The half that stops the list becoming an amnesty. */
  it('carries no declaration for a file that no longer writes', () => {
    const live = new Set(writeSites().map(({ file }) => file));

    expect(
      DECLARED.map(({ file }) => file).filter((file) => !live.has(file)),
    ).toEqual([]);
  });

  /**
   * A verdict that claims protection is held to the call that gives it. The
   * SSH key's entry is the exception, and is named: it spells `mode: 0o700`
   * and leaves the key to `ssh-keygen`, both older than the helper.
   */
  it('backs every owner-only verdict with the helper call that makes it true', () => {
    const unbacked = DECLARED.flatMap(({ file, verdict, closedBy }) => {
      if (verdict === 'owner-only-file') {
        return file === 'src/realtime/local-server-setup.service.ts' ||
          calls(file, FILE_HELPERS)
          ? []
          : [`${file} :: no ${FILE_HELPERS.join(' or ')}`];
      }
      if (verdict === 'owner-only-directory') {
        if (!closedBy?.length) return [`${file} :: names no closedBy`];
        return closedBy
          .filter((closer) => !calls(closer, DIRECTORY_HELPERS))
          .map(
            (closer) =>
              `${file} :: ${closer} calls no ${DIRECTORY_HELPERS.join(' or ')}`,
          );
      }
      return closedBy ? [`${file} :: closedBy on a ${verdict} verdict`] : [];
    });

    expect(unbacked).toEqual([]);
  });

  /**
   * **The cap is 0.** The census was filed with one entry here — the schedule
   * script, which it found and which was closed in the same change — so a
   * site that cannot answer one of the other four verdicts has to be fixed
   * rather than written up, because there is no batch left to defer it into.
   */
  it('defers no writer', () => {
    expect(
      DECLARED.filter(({ verdict }) => verdict === 'deferred').map(
        ({ file }) => file,
      ),
    ).toEqual([]);
  });

  it('gives every declared file a verdict and a reason', () => {
    expect(
      DECLARED.filter(({ why }) => why.trim().length < 40).map(
        ({ file }) => file,
      ),
    ).toEqual([]);
    expect(declaredFiles.size).toBe(DECLARED.length);
  });
});
