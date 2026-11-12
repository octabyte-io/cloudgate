import { BadRequestException } from '@nestjs/common';
import { ComposeService } from '../../src/compose/compose.service';
import type { SettleClock } from '../../src/compose/compose.utils';
import type { DrizzleDB } from '../../src/db/drizzle.module';
import type { Compose } from '../../src/db/schema';
import type { DomainsService } from '../../src/domains/domains.service';
import type { BitbucketService } from '../../src/git-providers/strategies/bitbucket/bitbucket.service';
import type { GiteaService } from '../../src/git-providers/strategies/gitea/gitea.service';
import type { GithubService } from '../../src/git-providers/strategies/github/github.service';
import type { GitlabService } from '../../src/git-providers/strategies/gitlab/gitlab.service';
import type { SshKeysService } from '../../src/ssh-keys/ssh-keys.service';
import type {
  PermissionCtx,
  PermissionService,
} from '../../src/rbac/permission.service';
import type { RemoteExecService } from '../../src/remote/remote-exec.service';
import type { UpdateComposeDto } from '../../src/compose/dto/compose.dto';

/**
 * `PATCH /compose/:id` is the one seam that could still *create* the state the
 * map-form labels rule made a refusal everywhere else:
 * `assertComposeContentClaimable` reads the file and has no idea which of its
 * services carry Domain rows, so a PATCH rewriting a routed service's `labels:`
 * from a list into a map was taken, and the Domain row went on pointing at a
 * service Cloudgate can no longer add routing to.
 *
 * The e2e half is `compose-map-form-labels.e2e-spec.ts`, which is where the
 * refusal's status code and its untouched row belong. What is pinned **here**
 * is the part the e2e cannot vary cheaply and the part the rule's own unit cases
 * (`compose-domains.spec.ts`, on the predicate) do not reach: *which* content
 * and *which* `composeType` the guard is asked about, over *every* Domain row
 * of the stack rather than one. Both are decisions about the row the request
 * leaves behind — `updateComposeSchema` is `.partial()`, so the body may carry
 * a file with no `composeType`, a `composeType` with no file, or neither — and
 * a suite that only ever sent both fields together would agree with a guard
 * that read the body instead of the resulting row.
 *
 * Written against the two reads `update` makes rather than through Postgres,
 * on `preview-deployments.service.spec.ts`' terms: the org-scoped `findOwned`
 * join, the `findRow` select, and the update itself.
 */

const ctx: PermissionCtx = {
  user: { id: 'user-1' },
  session: { activeOrganizationId: 'org-1' },
};

const LIST_LABELLED = `services:
  wordpress:
    image: wordpress:6
    labels:
      - com.example.owner=platform
  db:
    image: mariadb:11
`;

const MAP_LABELLED = `services:
  wordpress:
    image: wordpress:6
    labels:
      com.example.owner: platform
  db:
    image: mariadb:11
`;

const MAP_LABELLED_DEPLOY = `services:
  wordpress:
    image: wordpress:6
    deploy:
      labels:
        com.example.owner: platform
  db:
    image: mariadb:11
`;

/** The sentence `compose.utils.ts` owns, spelled out once (§1.7). */
const refusal = (service: string, host: string, block = 'labels') =>
  `Domain "${host}" is attached to service "${service}", which declares "${block}" as a map — Cloudgate adds Traefik routing labels only to the list form. Rewrite that service's labels as a list of "key=value" entries, or attach this domain to a service that already uses one`;

const composeRow = (overrides: Partial<Compose> = {}) =>
  ({
    composeId: 'compose-1',
    appName: 'wp-stack',
    name: 'Wordpress',
    composeType: 'docker-compose',
    sourceType: 'raw',
    composeFile: LIST_LABELLED,
    serverId: null,
    ...overrides,
  }) as unknown as Compose;

interface Written {
  values?: Partial<Compose>;
}

/**
 * `findOwned`'s join and `findRow`'s select are told apart by the join itself:
 * the first is `.select({…}).from(compose).innerJoin(…).innerJoin(…)`, the
 * second is `.select().from(compose).where(…)`.
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
      set: (values: Partial<Compose>) => ({
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

const domainRow = (serviceName: string, host: string) =>
  ({
    domainId: `domain-${host}`,
    host,
    serviceName,
    port: 80,
    https: false,
    uniqueConfigKey: 1,
  }) as unknown;

/** The five credential-owning services `ComposeService` takes. */
type ComposeCredentialServices = [
  SshKeysService,
  GithubService,
  GitlabService,
  GiteaService,
  BitbucketService,
];

const FIVE_UNCONSULTED = Array.from({ length: 5 }, () => ({
  findOne: jest.fn(() => {
    throw new Error(
      'a credential lookup was consulted by a case that names no *Id',
    );
  }),
})) as unknown as ComposeCredentialServices;

function makeService(
  row: Compose,
  attached: unknown[],
): {
  compose: ComposeService;
  written: Written;
  findComposeDomains: jest.Mock;
  assertHostsUnclaimedInOrganization: jest.Mock;
} {
  const written: Written = {};
  const findComposeDomains = jest.fn().mockResolvedValue(attached);
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
    // The five credential-owning services added to the constructor. Every
    // case in this file patches content columns and never a `*Id`, so
    // `resolveCredentialRefs` resolves nothing and none of these is consulted;
    // `compose-credential-refs.spec.ts` is where they are. They are `findOne`
    // stubs that reject rather than `{}`, so a case here that grew a `*Id`
    // would fail on this line and not silently take an unresolved id.
    ...FIVE_UNCONSULTED,
    // The Stop hook; nothing here Stops a Service.
    {} as never,
    // InstanceMode; nothing here creates a stack.
    {} as never,
  );
  return {
    compose,
    written,
    findComposeDomains,
    assertHostsUnclaimedInOrganization,
  };
}

const patch = (data: Partial<UpdateComposeDto>) => data as UpdateComposeDto;

describe('ComposeService.update, on a stack whose Domain rows have to stay routable', () => {
  it('refuses a PATCH that turns a routed service’s labels into a map, and writes nothing', async () => {
    const { compose, written } = makeService(composeRow(), [
      domainRow('wordpress', 'shop.example.com'),
    ]);

    await expect(
      compose.update(ctx, 'compose-1', patch({ composeFile: MAP_LABELLED })),
    ).rejects.toThrow(
      new BadRequestException(refusal('wordpress', 'shop.example.com')),
    );
    // Nothing was written on the way to being refused: the file the operator
    // was told 400 about is genuinely not stored, and neither is any other
    // column the same PATCH carried.
    expect(written.values).toBeUndefined();
  });

  it('takes the PATCH that rewrites the map back into a list', async () => {
    // Remediation always gets through — `assertParentRowsRoutable`'s rule.
    // What is checked is the file the request leaves behind, so the fix for
    // this refusal is never itself refused.
    const { compose, written } = makeService(
      composeRow({ composeFile: MAP_LABELLED }),
      [domainRow('wordpress', 'shop.example.com')],
    );

    await compose.update(
      ctx,
      'compose-1',
      patch({ composeFile: LIST_LABELLED }),
    );

    expect(written.values).toEqual({ composeFile: LIST_LABELLED });
  });

  it('reads every Domain row of the stack, not one named by the request', async () => {
    // The whole-parent half, and the asymmetry with the per-row pre-flight
    // at the domain seams: a `PATCH /compose/:id` names no Domain, and one file
    // is shared by every row — so a guard looking at a single row would watch
    // this PATCH poison a sibling. The first row here is fine and the second is
    // not.
    const { compose, written } = makeService(composeRow(), [
      domainRow('db', 'admin.example.com'),
      domainRow('wordpress', 'shop.example.com'),
    ]);

    await expect(
      compose.update(ctx, 'compose-1', patch({ composeFile: MAP_LABELLED })),
    ).rejects.toThrow(
      new BadRequestException(refusal('wordpress', 'shop.example.com')),
    );
    expect(written.values).toBeUndefined();
  });

  it('refuses a PATCH that carries no composeFile while the stored file is a map', async () => {
    // The map-form rule's no-backfill case, reached through the `.partial()`
    // hole `update` already closed for H-83: the rule is a statement about the
    // row's resulting state, `data.composeFile ?? row.composeFile`, so a body
    // naming only `name` is examined against the stored file.
    const { compose, written } = makeService(
      composeRow({ composeFile: MAP_LABELLED }),
      [domainRow('wordpress', 'shop.example.com')],
    );

    await expect(
      compose.update(ctx, 'compose-1', patch({ name: 'Renamed' })),
    ).rejects.toThrow(
      new BadRequestException(refusal('wordpress', 'shop.example.com')),
    );
    expect(written.values).toBeUndefined();
  });

  it('reads the block the resulting composeType names, not the stored one', async () => {
    // The other half of the same rule, and the H-87 shape: `composeType` is a
    // column this very PATCH may rewrite, and it decides whether the question
    // is asked at all. A `stack` gets no labels — its Domains are
    // routed by the file provider — so the same file is two different answers.
    const stored = composeRow({
      composeType: 'stack',
      composeFile: MAP_LABELLED,
    });
    const attached = [domainRow('wordpress', 'shop.example.com')];

    // Stored type alone: a stack is injected into nowhere, so a map anywhere
    // in its file is taken, and the injector agrees.
    const asStack = makeService(stored, attached);
    await asStack.compose.update(ctx, 'compose-1', patch({ name: 'Renamed' }));
    expect(asStack.written.values).toEqual({ name: 'Renamed' });

    // The same stored file, with the PATCH moving it to Docker Compose: now the
    // map is in the block the injector would append to.
    const asCompose = makeService(stored, attached);
    await expect(
      asCompose.compose.update(
        ctx,
        'compose-1',
        patch({ composeType: 'docker-compose' }),
      ),
    ).rejects.toThrow(
      new BadRequestException(refusal('wordpress', 'shop.example.com')),
    );
    expect(asCompose.written.values).toBeUndefined();

    // And a stack's own `deploy.labels` map is not a refusal either.
    const deployMap = makeService(
      composeRow({ composeType: 'stack', composeFile: MAP_LABELLED_DEPLOY }),
      attached,
    );
    await deployMap.compose.update(
      ctx,
      'compose-1',
      patch({ name: 'Renamed' }),
    );
    expect(deployMap.written.values).toEqual({ name: 'Renamed' });
  });

  it('takes a map-form sibling that carries no Domain row', async () => {
    const { compose, written } = makeService(composeRow(), [
      domainRow('db', 'admin.example.com'),
    ]);

    await compose.update(
      ctx,
      'compose-1',
      patch({ composeFile: MAP_LABELLED }),
    );

    expect(written.values).toEqual({ composeFile: MAP_LABELLED });
  });

  it.each([
    ['an empty file', ''],
    [
      'a service the incoming content does not declare',
      `services:
  ghost:
    image: ghost:5
    labels:
      com.example.owner: platform
`,
    ],
  ])('fails open on %s', async (_case, composeFile) => {
    // Each is already some other guard's refusal — `getConverted`'s empty-file
    // 400, its unknown-service 400 — and none of them is one
    // `PATCH /compose/:id` has ever made. A seam that grew new refusals while
    // it was here for one would be a second rule riding inside this one.
    const { compose, written } = makeService(composeRow(), [
      domainRow('wordpress', 'shop.example.com'),
    ]);

    await compose.update(ctx, 'compose-1', patch({ composeFile }));

    expect(written.values).toEqual({ composeFile });
  });

  it('is never the thing that answers for YAML that does not parse', async () => {
    // The third fail-open case the predicate carries — and at *this* seam it
    // stays unreachable, which is worth stating rather than asserting a
    // fail-open that never runs. `assertComposeContentClaimable` goes first and
    // its `readComposeHostClaims` parses, so an unparseable file is already
    // answered for by the time this rule would be asked anything.
    //
    // That was recorded as a finding and has been settled: the parse used to be
    // **unguarded** here, so the `YAMLParseError` escaped a documented-400/409
    // guard as a 500. It is now a 400 carrying `unparseableComposeRefusal`'s
    // sentence — and on the request paths `composeFileSchema` refuses the body
    // before `update` is entered at all, so the fail-open case is now two
    // guards away from this seam rather than one. What is asserted below is
    // still the same negative: this rule is not what answers.
    const { compose, written, findComposeDomains } = makeService(composeRow(), [
      domainRow('wordpress', 'shop.example.com'),
    ]);

    await expect(
      compose.update(
        ctx,
        'compose-1',
        patch({ composeFile: 'services: [oh: no: :' }),
      ),
    ).rejects.toThrow(
      new BadRequestException(
        'Compose file is not valid YAML: Nested mappings are not allowed in compact mappings at line 1, column 20',
      ),
    );
    // Not this rule's sentence, and this rule was not consulted at all.
    expect(findComposeDomains).not.toHaveBeenCalled();
    expect(written.values).toBeUndefined();
  });

  it('asks the routing question of a stack that claims no hostname of its own', async () => {
    // The negative assertion that keeps the two guards apart: none of the files
    // above carries a `traefik.*` label, so H-83's ownership query never runs
    // and every refusal here is this rule's rather than a claimable check
    // firing by accident.
    const { compose, assertHostsUnclaimedInOrganization, findComposeDomains } =
      makeService(composeRow(), [domainRow('wordpress', 'shop.example.com')]);

    await expect(
      compose.update(ctx, 'compose-1', patch({ composeFile: MAP_LABELLED })),
    ).rejects.toThrow(BadRequestException);

    expect(assertHostsUnclaimedInOrganization).not.toHaveBeenCalled();
    expect(findComposeDomains).toHaveBeenCalledWith('compose-1');
  });
});
