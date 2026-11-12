import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { NotFoundException } from '@nestjs/common';
import { APPLICATION_CREDENTIAL_REFS as REPUBLISHED_BY_APPLICATIONS } from '../../src/applications/applications.service';
import {
  APPLICATION_CREDENTIAL_REFS,
  COMPOSE_CREDENTIAL_REFS,
  resolveCredentialRefs,
} from '../../src/common/credential-refs';
import type { CredentialRefResolvers } from '../../src/common/credential-refs';
import { COMPOSE_CREDENTIAL_REFS as REPUBLISHED_BY_COMPOSE } from '../../src/compose/compose.service';

/**
 * The rule *"a parent id that carries a credential is resolved
 * organization-scoped before it is written"* was stated in three modules with
 * no single home: once for `sshKeyId` on a Server, and twice more — once
 * in `ApplicationsService` and once in `ComposeService`, because the only
 * in-set alternative was one of them importing the other's loop, which inverts
 * the dependency direction the tree keeps.
 *
 * `common/owned-server.ts` is the precedent and its docblock is about exactly
 * this failure: five copies of an ownership lookup that drifted apart, plus the
 * one that was never written, which was the security bug. So the mechanism
 * has one home and each module supplies only its own column list.
 *
 * What is pinned here is what the per-module specs cannot see:
 *
 * - the loop's own contract — list order, sequential, `undefined` skips, `null`
 *   detaches, a refusal is the resolver's own and is never reworded;
 * - that a resolver bundle needs **no `PermissionCtx`**, which is the shape a
 *   system run has to be able to supply (`BackupsService.runScheduled` reaches
 *   `findForScheduledRun(row.destinationId)` with no session on purpose) and the
 *   one a ctx-bearing signature would have closed the door on;
 * - that there is exactly **one** copy of the mechanism in `src`, asserted over
 *   the directory rather than against a list of the modules that had one — the
 *   fourth module is the one this issue is about;
 * - and that both lists are still importable from the services that used to own
 *   them, because `RollbacksService.EXCLUDED_FROM_CONTEXT` spreads
 *   `APPLICATION_CREDENTIAL_REFS` from there and that file is not this change's
 *   to edit.
 *
 * The behavioural half — that each id goes through the service owning its row,
 * and that two real accounts get a byte-identical 404 — stays in
 * `test/applications/application-credential-refs.spec.ts`,
 * `test/compose/compose-credential-refs.spec.ts` and the two tenancy e2e
 * suites, unchanged by the move. Those passing over the extracted loop is the
 * evidence that behaviour did not shift.
 */

type Ref = 'githubId' | 'registryId' | 'customGitSSHKeyId';

const REFS: readonly Ref[] = ['githubId', 'registryId', 'customGitSSHKeyId'];

/**
 * A bundle that records what it was asked, answering with the id it was handed
 * — which is what the real lookups do, their `where` being `id = ? AND
 * organization_id = ?`.
 */
function makeBundle() {
  const asked: string[] = [];
  const resolvers: CredentialRefResolvers<Ref> = {
    githubId: (id) => {
      asked.push(`githubId:${id}`);
      return Promise.resolve(id);
    },
    registryId: (id) => {
      asked.push(`registryId:${id}`);
      return Promise.resolve(id);
    },
    customGitSSHKeyId: (id) => {
      asked.push(`customGitSSHKeyId:${id}`);
      return Promise.resolve(id);
    },
  };
  return { asked, resolvers };
}

describe('resolveCredentialRefs', () => {
  it('hands back the id each resolver authorized, for every ref the body names', async () => {
    const { asked, resolvers } = makeBundle();

    const authorized = await resolveCredentialRefs(REFS, resolvers, {
      githubId: 'gh-1',
      registryId: 'reg-1',
    });

    expect(authorized).toEqual({ githubId: 'gh-1', registryId: 'reg-1' });
    expect(asked).toEqual(['githubId:gh-1', 'registryId:reg-1']);
  });

  it('resolves in list order rather than in the order the body serialized them', async () => {
    // The list decides, not V8's key ordering — which is what makes the
    // refusal below deterministic for a body carrying two foreign ids.
    const { asked, resolvers } = makeBundle();

    await resolveCredentialRefs(REFS, resolvers, {
      customGitSSHKeyId: 'key-1',
      registryId: 'reg-1',
      githubId: 'gh-1',
    });

    expect(asked).toEqual([
      'githubId:gh-1',
      'registryId:reg-1',
      'customGitSSHKeyId:key-1',
    ]);
  });

  it('stops at the first refusal and never reaches the resolver after it', async () => {
    // Sequential, not `Promise.all`: a body naming two foreign ids has one
    // answer, and it cannot depend on which rejection settled first.
    const { asked, resolvers } = makeBundle();
    const refusal = new NotFoundException('GitHub provider not found');
    resolvers.githubId = () => Promise.reject(refusal);

    await expect(
      resolveCredentialRefs(REFS, resolvers, {
        registryId: 'their-registry',
        githubId: 'their-github',
      }),
    ).rejects.toThrow(refusal);

    expect(asked).toEqual([]);
  });

  it('raises the resolver refusal unmodified, so a foreign id reads like one that exists nowhere', async () => {
    // §2.2 / ADR-0008. The owning service's `where` is `id = ? AND
    // organization_id = ?`, so it cannot tell a foreign id from an unknown one
    // and neither wording exists for this loop to get wrong. A 404 saying
    // "Registry not found" beside one saying "that registry is in another
    // organization" would pass a status check and be an enumeration oracle.
    const { resolvers } = makeBundle();
    const refusal = new NotFoundException('Registry not found');
    resolvers.registryId = () => Promise.reject(refusal);

    const raised = await resolveCredentialRefs(REFS, resolvers, {
      registryId: 'theirs',
    }).catch((error: unknown) => error);

    expect(raised).toBe(refusal);
  });

  it('resolves nothing for a body that names no credential id', async () => {
    const { asked, resolvers } = makeBundle();

    const authorized = await resolveCredentialRefs(REFS, resolvers, {});

    expect(authorized).toEqual({});
    expect(asked).toEqual([]);
  });

  it('resolves nothing for an undefined ref and nothing for an explicit null, and keeps neither', async () => {
    // `undefined` is "this PATCH does not mention the column" and `null` is
    // "detach". Resolving either would refuse both a rename and the only way
    // to remove a registry — and returning a `null` here would put it back on
    // the write twice rather than once.
    const { asked, resolvers } = makeBundle();

    const authorized = await resolveCredentialRefs(REFS, resolvers, {
      githubId: undefined,
      registryId: null,
    });

    expect(authorized).toEqual({});
    expect(asked).toEqual([]);
  });

  it('runs a bundle that closes over no PermissionCtx at all', async () => {
    // The shape a system run needs, and the reason this function takes no
    // `ctx`. `BackupsService.runScheduled` resolves `destinationId` through
    // `findForScheduledRun(id)` — no session, no organization filter, because
    // the row was organization-checked when it was written. A ctx-bearing
    // signature could not express that without a nullable ctx threaded through
    // every lookup, which is the shape `findParentService`'s
    // `organizationId: string | null` already regrets.
    const asked: string[] = [];
    const systemRun: CredentialRefResolvers<'destinationId'> = {
      destinationId: (id) => {
        asked.push(id);
        return Promise.resolve(id);
      },
    };

    const authorized = await resolveCredentialRefs(
      ['destinationId'],
      systemRun,
      { destinationId: 'dest-1' },
    );

    expect(authorized).toEqual({ destinationId: 'dest-1' });
    expect(asked).toEqual(['dest-1']);
  });
});

const backendRoot = join(__dirname, '..', '..');

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
 * Comments blanked, lines preserved — `composed-creates.spec.ts`'s helper and
 * load-bearing for the same reason: the docblocks in
 * `common/credential-refs.ts` and in both services *quote* the loop they are
 * about, so reading a comment as code would make every file that explains the
 * mechanism look like a file that copied it.
 */
function withoutComments(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      if (
        trimmed.startsWith('//') ||
        trimmed.startsWith('*') ||
        trimmed.startsWith('/*')
      ) {
        return '';
      }
      return line.replace(/([^:'"`])\/\/.*$/, '$1');
    })
    .join('\n');
}

function sourceFiles(): { path: string; text: string }[] {
  return walk(join(backendRoot, 'src'))
    .filter((file) => file.endsWith('.ts'))
    .sort()
    .map((file) => ({
      path: relative(backendRoot, file),
      text: withoutComments(readFileSync(file, 'utf8')),
    }));
}

/** A hand-written copy of the loop: iterating a ref list to resolve each id. */
const HAND_WRITTEN_LOOP =
  /for\s*\(\s*const\s+[A-Za-z_$][\w$]*\s+of\s+[A-Za-z_$][\w$]*CREDENTIAL_REFS\b/;

/** A hand-written copy of the resolver bundle's type. */
const HAND_WRITTEN_BUNDLE = /Record<\s*[A-Za-z_$][\w$]*CredentialRef\s*,\s*\(/;

describe('CredentialRefResolvers, as the single home for the rule', () => {
  it('leaves no module resolving credential ids through a loop of its own', () => {
    // The property, not a list of the three modules that had one. All three
    // were each found by reading; a fourth module written next
    // month is what this is for.
    const offenders = sourceFiles()
      .filter(
        ({ path }) => path !== join('src', 'common', 'credential-refs.ts'),
      )
      .filter(
        ({ text }) =>
          HAND_WRITTEN_LOOP.test(text) || HAND_WRITTEN_BUNDLE.test(text),
      )
      .map(({ path }) => path);

    expect(offenders).toEqual([]);
  });

  /**
   * The anti-rot half, and the one that makes the assertion above mean
   * something: an empty set satisfies "leaves no module resolving …"
   * perfectly, and renaming `resolveCredentialRefs` produces exactly that.
   * Frozen rather than derived — a third module delegating here is a normal
   * thing to add, but not silently.
   *
   * Two arrived later, and they are the pair this signature was shaped
   * around rather than a widening of it: `backups/` and `volume-backups/` each
   * resolve `destinationId` through `DestinationsService.findOne(ctx, …)` on
   * `create` and `update`, and each resolves the same column with **no ctx**
   * from `runScheduled`, which is the asymmetry
   * `common/credential-refs.ts`' own docblock cites for taking no
   * `PermissionCtx`. Their two run seams are deliberately not callers: they
   * write no id and need the decrypted row back, which is stated at
   * `BackupsService.runScheduled`.
   */
  it('is delegated to by the modules the rule was extracted from', () => {
    const delegating = sourceFiles()
      .filter(({ text }) =>
        /import\s*\{[^}]*\bresolveCredentialRefs\b[^}]*\}\s*from\s*'[^']*common\/credential-refs'/.test(
          text,
        ),
      )
      .map(({ path }) => path);

    expect(delegating).toEqual([
      join('src', 'applications', 'applications.service.ts'),
      join('src', 'backups', 'backups.service.ts'),
      join('src', 'compose', 'compose.service.ts'),
      join('src', 'volume-backups', 'volume-backups.service.ts'),
    ]);
  });

  /**
   * The compatibility promise the move rests on. `rollbacks/` is a module this
   * change does not touch and `RollbacksService.EXCLUDED_FROM_CONTEXT` spreads
   * `APPLICATION_CREDENTIAL_REFS` imported from `applications.service`, so the
   * name has to keep resolving from there — and to the *same* array, not a
   * copy that could drift back apart.
   */
  it('is re-exported by both services under the names they already published', () => {
    expect(REPUBLISHED_BY_APPLICATIONS).toBe(APPLICATION_CREDENTIAL_REFS);
    expect(REPUBLISHED_BY_COMPOSE).toBe(COMPOSE_CREDENTIAL_REFS);
  });

  /**
   * Expected values written out rather than derived from the lists this file
   * imports (§1.7): the seven and the five are read off
   * `updateApplicationSchema` and `updateComposeSchema` by the per-module
   * specs, and what is worth pinning *here* is that the move did not drop or
   * reorder one on the way.
   */
  it('carries both lists, in the order they are resolved in', () => {
    expect([...APPLICATION_CREDENTIAL_REFS]).toEqual([
      'githubId',
      'gitlabId',
      'giteaId',
      'bitbucketId',
      'customGitSSHKeyId',
      'registryId',
      'buildRegistryId',
    ]);
    expect([...COMPOSE_CREDENTIAL_REFS]).toEqual([
      'githubId',
      'gitlabId',
      'giteaId',
      'bitbucketId',
      'customGitSSHKeyId',
    ]);
  });
});
