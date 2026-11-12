import { NotFoundException } from '@nestjs/common';
import {
  COMPOSE_CREDENTIAL_REFS,
  ComposeService,
} from '../../src/compose/compose.service';
import type { SettleClock } from '../../src/compose/compose.utils';
import { updateComposeSchema } from '../../src/compose/dto/compose.dto';
import type { UpdateComposeDto } from '../../src/compose/dto/compose.dto';
import type { DrizzleDB } from '../../src/db/drizzle.module';
import type { Compose } from '../../src/db/schema';
import type { DomainsService } from '../../src/domains/domains.service';
import type { BitbucketService } from '../../src/git-providers/strategies/bitbucket/bitbucket.service';
import type { GiteaService } from '../../src/git-providers/strategies/gitea/gitea.service';
import type { GithubService } from '../../src/git-providers/strategies/github/github.service';
import type { GitlabService } from '../../src/git-providers/strategies/gitlab/gitlab.service';
import type {
  PermissionCtx,
  PermissionService,
} from '../../src/rbac/permission.service';
import type { RemoteExecService } from '../../src/remote/remote-exec.service';
import type { SshKeysService } from '../../src/ssh-keys/ssh-keys.service';

/**
 * The compose half of the credential-reference check. `PATCH /compose/:id`
 * accepts five parent ids that name a credential-bearing row — the four git
 * providers and the custom-git SSH key — and `update` resolved none of them
 * before `.set(data)` wrote all five. `findDeployable` loads them back for the
 * build and `SourceCloneService` passes `customGitSSHKey` into the clone as
 * `sshKey`, so the private key on a neighbouring organization's row was
 * fetched, decrypted and used.
 *
 * Sibling of `application-credential-refs.spec.ts`, which carries the argument
 * for what these cases assert. What is different here and worth its own file:
 * the list is five rather than seven (a stack has no registry columns and no
 * `buildServerId`), and `update` has two content guards of its own — H-83's
 * claimable check and the routable one — so the *order* of the three is
 * asserted rather than left to whichever refusal happens to fire.
 *
 * The e2e half is `compose-credential-tenancy.e2e-spec.ts`.
 */

const ctx: PermissionCtx = {
  user: { id: 'user-1' },
  session: { activeOrganizationId: 'org-1' },
};

/** A stack whose file claims no hostname and carries no map-form labels, so
 * neither content guard has anything to say about any case below. */
const PLAIN_FILE = `services:
  web:
    image: nginx:1
`;

interface Written {
  values?: Record<string, unknown>;
}

const composeRow = (overrides: Partial<Compose> = {}) =>
  ({
    composeId: 'compose-1',
    appName: 'wp-stack',
    name: 'Wordpress',
    composeType: 'docker-compose',
    sourceType: 'raw',
    composeFile: PLAIN_FILE,
    serverId: null,
    ...overrides,
  }) as unknown as Compose;

/**
 * `findOwned`'s join and `findRow`'s select are told apart by the join itself,
 * exactly as `compose-update-routable.spec.ts` does it: the first is
 * `.select({…}).from(compose).innerJoin(…).innerJoin(…)`, the second is
 * `.select().from(compose).where(…)`.
 */
const makeDb = (row: Compose, written: Written) => {
  const select = () => {
    let joined = false;
    const chain = {
      innerJoin: () => {
        joined = true;
        return chain;
      },
      where: () => ({
        limit: () =>
          Promise.resolve(joined ? [{ composeId: row.composeId }] : [row]),
      }),
    };
    return { from: () => chain };
  };
  return {
    select,
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: () => ({
          returning: () => {
            written.values = values;
            return Promise.resolve([{ ...row, ...values }]);
          },
        }),
      }),
    }),
  } as unknown as DrizzleDB;
};

function makeResolvers() {
  const findOne = (idColumn: string) =>
    jest.fn((_ctx: PermissionCtx, id: string) =>
      Promise.resolve({ [idColumn]: id }),
    );
  return {
    sshKeys: { findOne: findOne('sshKeyId') },
    github: { findOne: findOne('githubId') },
    gitlab: { findOne: findOne('gitlabId') },
    gitea: { findOne: findOne('giteaId') },
    bitbucket: { findOne: findOne('bitbucketId') },
  };
}

type Resolvers = ReturnType<typeof makeResolvers>;

function makeService(
  resolvers: Resolvers = makeResolvers(),
  row: Compose = composeRow(),
) {
  const written: Written = {};
  const findComposeDomains = jest.fn().mockResolvedValue([]);
  const assertHostsUnclaimedInOrganization = jest
    .fn()
    .mockResolvedValue(undefined);
  const compose = new ComposeService(
    makeDb(row, written),
    {
      checkServiceAccess: jest.fn().mockResolvedValue(undefined),
      checkPermission: jest.fn().mockResolvedValue(undefined),
    } as unknown as PermissionService,
    {} as RemoteExecService,
    {
      findComposeDomains,
      assertHostsUnclaimedInOrganization,
    } as unknown as DomainsService,
    {} as SettleClock,
    resolvers.sshKeys as unknown as SshKeysService,
    resolvers.github as unknown as GithubService,
    resolvers.gitlab as unknown as GitlabService,
    resolvers.gitea as unknown as GiteaService,
    resolvers.bitbucket as unknown as BitbucketService,
    // The Stop hook; nothing here Stops a Service.
    {} as never,
    // InstanceMode; nothing here creates a stack.
    {} as never,
  );
  return { compose, written, resolvers, findComposeDomains };
}

const patch = (data: Partial<UpdateComposeDto>) => data as UpdateComposeDto;

/** Which owning service each id is required to be resolved through. */
const OWNED_BY: Record<
  (typeof COMPOSE_CREDENTIAL_REFS)[number],
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
};

describe('ComposeService.update, on the credential-bearing ids in its body', () => {
  it.each(COMPOSE_CREDENTIAL_REFS.map((ref) => [ref] as const))(
    'resolves %s through the service that owns the row, and writes the id that lookup authorized',
    async (ref) => {
      const { compose, written, resolvers } = makeService();

      await compose.update(ctx, 'compose-1', patch({ [ref]: 'their-id' }));

      expect(resolvers[OWNED_BY[ref].service].findOne).toHaveBeenCalledWith(
        ctx,
        'their-id',
      );
      expect(written.values).toEqual({ [ref]: 'their-id' });
    },
  );

  it.each(COMPOSE_CREDENTIAL_REFS.map((ref) => [ref] as const))(
    'refuses %s when its owning service does not find it, and writes nothing',
    async (ref) => {
      const resolvers = makeResolvers();
      const refusal = new NotFoundException(OWNED_BY[ref].refusal);
      resolvers[OWNED_BY[ref].service].findOne.mockRejectedValue(refusal);
      const { compose, written } = makeService(resolvers);

      await expect(
        compose.update(ctx, 'compose-1', patch({ [ref]: 'their-id' })),
      ).rejects.toThrow(refusal);
      // Nothing was written on the way to being refused.
      expect(written.values).toBeUndefined();
    },
  );

  it('refuses a body carrying two foreign ids for the first of them in list order', async () => {
    const resolvers = makeResolvers();
    resolvers.github.findOne.mockRejectedValue(
      new NotFoundException('GitHub provider not found'),
    );
    resolvers.sshKeys.findOne.mockRejectedValue(
      new NotFoundException('SSH key not found'),
    );
    const { compose, written } = makeService(resolvers);

    await expect(
      compose.update(
        ctx,
        'compose-1',
        patch({ customGitSSHKeyId: 'their-key', githubId: 'their-github' }),
      ),
    ).rejects.toThrow('GitHub provider not found');
    // Sequential, not `Promise.all`: the SSH key lookup is never reached.
    expect(resolvers.sshKeys.findOne).not.toHaveBeenCalled();
    expect(written.values).toBeUndefined();
  });

  it('resolves nothing for a PATCH that mentions no credential id', async () => {
    const { compose, written, resolvers } = makeService();

    await compose.update(ctx, 'compose-1', patch({ name: 'Renamed' }));

    for (const resolver of Object.values(resolvers)) {
      expect(resolver.findOne).not.toHaveBeenCalled();
    }
    expect(written.values).toEqual({ name: 'Renamed' });
  });

  it('disconnects a git provider on an explicit null without resolving anything', async () => {
    const { compose, written, resolvers } = makeService();

    await compose.update(
      ctx,
      'compose-1',
      patch({ githubId: null, customGitSSHKeyId: null }),
    );

    expect(resolvers.github.findOne).not.toHaveBeenCalled();
    expect(resolvers.sshKeys.findOne).not.toHaveBeenCalled();
    expect(written.values).toEqual({
      githubId: null,
      customGitSSHKeyId: null,
    });
  });

  it('settles the credential ids before it asks whether the stack stays routable', async () => {
    // The order of the three guards `update` now runs, asserted rather than
    // inferred. A PATCH that is both a cross-organization attach and a
    // map-form labels break gets the cross-organization answer, and the
    // whole-parent read is not even reached — so the refusal a caller sees for
    // a foreign id does not depend on the state of their own compose file.
    const resolvers = makeResolvers();
    resolvers.github.findOne.mockRejectedValue(
      new NotFoundException('GitHub provider not found'),
    );
    const { compose, written, findComposeDomains } = makeService(resolvers);

    await expect(
      compose.update(
        ctx,
        'compose-1',
        patch({
          githubId: 'their-github',
          composeFile: `services:
  web:
    image: nginx:1
    labels:
      com.example.owner: platform
`,
        }),
      ),
    ).rejects.toThrow('GitHub provider not found');

    expect(findComposeDomains).not.toHaveBeenCalled();
    expect(written.values).toBeUndefined();
  });
});

describe('COMPOSE_CREDENTIAL_REFS', () => {
  /** GitLab's own numeric project id, not a row on this instance. */
  const NOT_A_CREDENTIAL_ROW = ['gitlabProjectId'];

  it('covers every parent id updateComposeSchema accepts', () => {
    // The direction the `Record<ComposeCredentialRef, …>` lookup table cannot
    // check: a sixth `*Id` added to the DTO with no entry in the list.
    const ids = Object.keys(updateComposeSchema.shape)
      .filter((key) => key.endsWith('Id'))
      .filter((key) => !NOT_A_CREDENTIAL_ROW.includes(key));

    expect([...ids].sort()).toEqual([...COMPOSE_CREDENTIAL_REFS].sort());
  });
});
