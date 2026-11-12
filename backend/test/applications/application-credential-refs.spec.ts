import { NotFoundException } from '@nestjs/common';
import {
  APPLICATION_CREDENTIAL_REFS,
  ApplicationsService,
} from '../../src/applications/applications.service';
import { updateApplicationSchema } from '../../src/applications/dto/application.dto';
import type { UpdateApplicationDto } from '../../src/applications/dto/application.dto';
import type { DrizzleDB } from '../../src/db/drizzle.module';
import type { BitbucketService } from '../../src/git-providers/strategies/bitbucket/bitbucket.service';
import type { GiteaService } from '../../src/git-providers/strategies/gitea/gitea.service';
import type { GithubService } from '../../src/git-providers/strategies/github/github.service';
import type { GitlabService } from '../../src/git-providers/strategies/gitlab/gitlab.service';
import type {
  PermissionCtx,
  PermissionService,
} from '../../src/rbac/permission.service';
import type { RegistriesService } from '../../src/registries/registries.service';
import type { RemoteExecService } from '../../src/remote/remote-exec.service';
import type { SshKeysService } from '../../src/ssh-keys/ssh-keys.service';
import type { TraefikAppConfigService } from '../../src/traefik/app-config.service';
import type { TraefikWriterService } from '../../src/traefik/traefik-writer.service';

/**
 * `PATCH /applications/:id` accepts seven parent ids that name a
 * credential-bearing row — the four git providers, the custom-git SSH key and
 * both registries — and `update` resolved **none** of them: it checked
 * `buildServerId` (an earlier fix, and its comment says so) and then wrote
 * `.set(data)`, so all seven landed on a foreign key that requires only that
 * the row exist. `findDeployable` loads every one of them back as a relation
 * "with credentials intact" and the engine authenticates with them.
 *
 * The e2e half is `applications-credential-tenancy.e2e-spec.ts`, which is where
 * two real accounts, the byte-identical 404 and the untouched stored row
 * belong. What is pinned **here** is what an e2e cannot vary cheaply:
 *
 * - that each of the seven goes through the service that *owns* the row rather
 *   than through a lookup written in `ApplicationsService` (§1.4, and the
 *   decision one id over) — asserted per id, against the owning service's own
 *   `findOne`, because a guard resolving six of seven would pass every
 *   status-code test that named the six;
 * - that the refusal order is `APPLICATION_CREDENTIAL_REFS`' and not V8's key
 *   ordering, so a body carrying two foreign ids has one answer;
 * - that `undefined` and `null` resolve nothing, which is the difference
 *   between this guard and one that breaks every rename and every detach;
 * - and that the list itself covers the schema — the assertion a *later*
 *   credential id has to fail against.
 *
 * Written against the two reads `update` makes rather than through Postgres,
 * on `compose-update-routable.spec.ts`' terms: the org-scoped `findOwned`
 * join and the update itself.
 */

const ctx: PermissionCtx = {
  user: { id: 'user-1' },
  session: { activeOrganizationId: 'org-1' },
};

interface Written {
  values?: Record<string, unknown>;
}

const makeDb = (written: Written) =>
  ({
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          // The AI model locks' read: a plain Application, no facet.
          where: () => ({ limit: () => Promise.resolve([]) }),
          innerJoin: () => ({
            where: () => ({
              limit: () =>
                Promise.resolve([
                  {
                    applicationId: 'app-1',
                    appName: 'web-app',
                    serverId: null,
                    // Not a cloud Service (the cloud refusals ask).
                    cloudAccountId: null,
                  },
                ]),
            }),
          }),
        }),
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: () => ({
          returning: () => {
            written.values = values;
            return Promise.resolve([{ applicationId: 'app-1', ...values }]);
          },
        }),
      }),
    }),
  }) as unknown as DrizzleDB;

/**
 * One `findOne` per owning service, each answering with a row carrying the id
 * it was handed — which is what the real ones do, their `where` being
 * `id = ? AND organization_id = ?`.
 */
function makeResolvers() {
  const findOne = (idColumn: string) =>
    jest.fn((_ctx: PermissionCtx, id: string) =>
      Promise.resolve({ [idColumn]: id }),
    );
  return {
    sshKeys: { findOne: findOne('sshKeyId') },
    registries: { findOne: findOne('registryId') },
    github: { findOne: findOne('githubId') },
    gitlab: { findOne: findOne('gitlabId') },
    gitea: { findOne: findOne('giteaId') },
    bitbucket: { findOne: findOne('bitbucketId') },
  };
}

type Resolvers = ReturnType<typeof makeResolvers>;

function makeService(resolvers: Resolvers = makeResolvers()) {
  const written: Written = {};
  const applications = new ApplicationsService(
    makeDb(written),
    {
      checkServiceAccess: jest.fn().mockResolvedValue(undefined),
      checkPermission: jest.fn().mockResolvedValue(undefined),
    } as unknown as PermissionService,
    {} as RemoteExecService,
    {} as TraefikWriterService,
    resolvers.sshKeys as unknown as SshKeysService,
    resolvers.registries as unknown as RegistriesService,
    resolvers.github as unknown as GithubService,
    resolvers.gitlab as unknown as GitlabService,
    resolvers.gitea as unknown as GiteaService,
    resolvers.bitbucket as unknown as BitbucketService,
    {} as TraefikAppConfigService,
    // The Stop hook; nothing here Stops a Service.
    {} as never,
    // The platform host URL; nothing here reads an AI model.
    {} as never,
    // A cloud Service's lifecycle; nothing here Stops a Service.
    {} as never,
    // The instance mode; nothing here creates a Service.
    {} as never,
  );
  return { applications, written, resolvers };
}

const patch = (data: Partial<UpdateApplicationDto>) =>
  data as UpdateApplicationDto;

/** Which owning service each id is required to be resolved through. */
const OWNED_BY: Record<
  (typeof APPLICATION_CREDENTIAL_REFS)[number],
  { service: keyof Resolvers; refusal: string }
> = {
  githubId: { service: 'github', refusal: 'GitHub provider not found' },
  gitlabId: { service: 'gitlab', refusal: 'GitLab provider not found' },
  giteaId: { service: 'gitea', refusal: 'Gitea provider not found' },
  bitbucketId: {
    service: 'bitbucket',
    refusal: 'Bitbucket provider not found',
  },
  customGitSSHKeyId: { service: 'sshKeys', refusal: 'SSH key not found' },
  registryId: { service: 'registries', refusal: 'Registry not found' },
  buildRegistryId: { service: 'registries', refusal: 'Registry not found' },
};

describe('ApplicationsService.update, on the credential-bearing ids in its body', () => {
  it.each(APPLICATION_CREDENTIAL_REFS.map((ref) => [ref] as const))(
    'resolves %s through the service that owns the row, and writes the id that lookup authorized',
    async (ref) => {
      const { applications, written, resolvers } = makeService();

      await applications.update(ctx, 'app-1', patch({ [ref]: 'their-id' }));

      const owner = resolvers[OWNED_BY[ref].service];
      expect(owner.findOne).toHaveBeenCalledWith(ctx, 'their-id');
      expect(written.values).toEqual({ [ref]: 'their-id' });
    },
  );

  it.each(APPLICATION_CREDENTIAL_REFS.map((ref) => [ref] as const))(
    'refuses %s when its owning service does not find it, and writes nothing',
    async (ref) => {
      // The refusal is the owning service's own, unmodified — which is what
      // makes a foreign id and an id that exists nowhere indistinguishable
      // (§2.2 / ADR-0008): one `where` covers both, so there is no second
      // wording for this file to get wrong.
      const resolvers = makeResolvers();
      const refusal = new NotFoundException(OWNED_BY[ref].refusal);
      resolvers[OWNED_BY[ref].service].findOne.mockRejectedValue(refusal);
      const { applications, written } = makeService(resolvers);

      await expect(
        applications.update(ctx, 'app-1', patch({ [ref]: 'their-id' })),
      ).rejects.toThrow(refusal);
      // Nothing was written on the way to being refused. The pre-fix
      // behaviour was a *successful* 200 carrying the foreign id, so a fix
      // that wrote and then threw would also reject here.
      expect(written.values).toBeUndefined();
    },
  );

  it('resolves both registry columns through the one Registry lookup', async () => {
    // `registryId` and `buildRegistryId` are two references to the same table
    // — pull credentials and push credentials — which is why `findDeployable`
    // loads `registry` and `buildRegistry` off it, and why one lookup serves
    // both rather than each getting its own.
    const { applications, written, resolvers } = makeService();

    await applications.update(
      ctx,
      'app-1',
      patch({ registryId: 'reg-1', buildRegistryId: 'reg-2' }),
    );

    expect(resolvers.registries.findOne.mock.calls.map(([, id]) => id)).toEqual(
      ['reg-1', 'reg-2'],
    );
    expect(written.values).toEqual({
      registryId: 'reg-1',
      buildRegistryId: 'reg-2',
    });
  });

  it('refuses a body carrying two foreign ids for the first of them in list order', async () => {
    // Deterministically the first, and the list decides — not V8's key
    // ordering and not the order the request happened to serialize them in.
    // A neighbouring fix was about a write that had to say which of
    // two ids it authorized.
    const resolvers = makeResolvers();
    resolvers.github.findOne.mockRejectedValue(
      new NotFoundException('GitHub provider not found'),
    );
    resolvers.registries.findOne.mockRejectedValue(
      new NotFoundException('Registry not found'),
    );
    const { applications, written } = makeService(resolvers);

    await expect(
      applications.update(
        ctx,
        'app-1',
        // Registry first in the body; `githubId` is first in the list.
        patch({ registryId: 'their-registry', githubId: 'their-github' }),
      ),
    ).rejects.toThrow('GitHub provider not found');
    // Sequential, not `Promise.all`: the second lookup is never reached, so
    // the answer cannot depend on which rejection settled first.
    expect(resolvers.registries.findOne).not.toHaveBeenCalled();
    expect(written.values).toBeUndefined();
  });

  it('resolves nothing for a PATCH that mentions no credential id', async () => {
    const { applications, written, resolvers } = makeService();

    await applications.update(ctx, 'app-1', patch({ name: 'Renamed' }));

    for (const resolver of Object.values(resolvers)) {
      expect(resolver.findOne).not.toHaveBeenCalled();
    }
    expect(written.values).toEqual({ name: 'Renamed' });
  });

  it('detaches a credential on an explicit null without resolving anything', async () => {
    // `null` is how the console removes a registry or disconnects a provider,
    // and `updateApplicationSchema` is `.partial()`, so `undefined` is
    // "untouched". A guard that resolved either would have refused both the
    // detach and every unrelated rename.
    const { applications, written, resolvers } = makeService();

    await applications.update(
      ctx,
      'app-1',
      patch({ registryId: null, githubId: null }),
    );

    expect(resolvers.registries.findOne).not.toHaveBeenCalled();
    expect(resolvers.github.findOne).not.toHaveBeenCalled();
    expect(written.values).toEqual({ registryId: null, githubId: null });
  });
});

describe('APPLICATION_CREDENTIAL_REFS', () => {
  /**
   * `buildServerId` is `checkServerAccess`' job — a different table and
   * an `undefined`-means-platform-host contract the credential loop must not
   * imitate. `gitlabProjectId` is GitLab's own numeric project id, not a row
   * on this instance.
   */
  const NOT_A_CREDENTIAL_ROW = ['buildServerId', 'gitlabProjectId'];

  it('covers every parent id updateApplicationSchema accepts', () => {
    // The direction the `Record<ApplicationCredentialRef, …>` lookup table
    // cannot check. That type refuses a *name* added to the list with no
    // lookup; this refuses an eighth `*Id` added to the DTO with no entry in
    // the list, which is exactly how the defect came to exist — `buildServerId` was
    // resolved and the seven beside it were not.
    const ids = Object.keys(updateApplicationSchema.shape)
      .filter((key) => key.endsWith('Id'))
      .filter((key) => !NOT_A_CREDENTIAL_ROW.includes(key));

    expect([...ids].sort()).toEqual([...APPLICATION_CREDENTIAL_REFS].sort());
  });
});
