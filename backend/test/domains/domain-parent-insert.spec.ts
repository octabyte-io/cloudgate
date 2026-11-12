import type { ModuleRef } from '@nestjs/core';
import { DomainsService } from '../../src/domains/domains.service';
import { InstanceMode } from '../../src/instance-mode/instance-mode.service';
import type { CreateDomainDto } from '../../src/domains/dto/domain.dto';
import type { DrizzleDB } from '../../src/db/drizzle.module';
import {
  aiModelFacet,
  application,
  compose,
  domain,
  webServerSettings,
} from '../../src/db/schema';
import type {
  PermissionCtx,
  PermissionService,
} from '../../src/rbac/permission.service';
import type { TraefikAppConfigService } from '../../src/traefik/app-config.service';

/**
 * The insert half of the parent fix, at the seam the DTO cannot reach.
 *
 * `create` wrote `.values({ ...data, host, path })`, which writes **both**
 * foreign keys, while `findParentService` tests `applicationId` first and
 * *returns* on that branch — so a body carrying the caller's own
 * `applicationId` beside another organization's `composeId` was access-checked
 * on the first id and attached a `domain` row to the victim's Compose stack.
 * `createDomainSchema`'s refinement now refuses that body over the wire
 * (`domain.dto.spec.ts`) and the cross-tenant refusal is asserted over HTTP
 * (`domain-tenancy.e2e-spec.ts`); what is pinned **here** is the independent
 * half neither of those can state, because it is about a call that never passes
 * through the global pipe:
 *
 * - `PlanApplier` (a Template's compose Domains) and `AiService.deploy` reach `create`
 *   through the service seam with an object they built, so the refinement does
 *   not run for them — and this is the rule that makes their inserts safe too.
 * - "The parent id is the one this method *resolved*" and "no caller-supplied
 *   key reaches the insert at all" are two different claims, and the second is
 *   what makes the next foreign key this DTO grows inert by construction. A
 *   refinement guards only the fields it was written for.
 *
 * Written against the reads `create` makes rather than through Postgres, on
 * `compose-update-routable.spec.ts`' terms — its own docblock's reasoning for
 * driving a service's write path off a stubbed `db`.
 */

const ctx: PermissionCtx = {
  user: { id: 'user-1' },
  session: { activeOrganizationId: 'org-1' },
};

const LIST_LABELLED = `services:
  web:
    image: nginx:1
    labels:
      - com.example.owner=platform
`;

/** The row the parent lookup answers with, whichever table it reads. */
const APPLICATION_PARENT = {
  serviceId: 'our-application',
  appName: 'blog',
  serverId: null,
};

/**
 * One row for both selects `compose` serves here — `findParentService`'s
 * three aliased columns and `findComposeDefinition`'s three real ones — since
 * the stub is keyed by table and those two are told apart only by a join.
 */
const COMPOSE_PARENT = {
  serviceId: 'our-compose',
  appName: 'stack',
  serverId: null,
  sourceType: 'raw',
  composeType: 'docker-compose',
  composeFile: LIST_LABELLED,
};

interface Written {
  values?: Record<string, unknown>;
}

/**
 * Every read `create` makes, answered by table rather than by shape:
 * `application` and `compose` for the parent lookup, `domain` for the
 * `(host, path)` pair check and the two claim joins, `webServerSettings` for
 * the console-host reservation, `aiModelFacet` for the "an AI model takes
 * no Domain" lock. `domain` answers `[]` throughout — an unclaimed hostname
 * and an untaken pair — and `aiModelFacet` answers `[]` — a plain Application,
 * not an AI model — which is what leaves the insert as the only thing under
 * test.
 */
const makeDb = (written: Written) => {
  const rowsFor = (table: unknown): unknown[] => {
    if (table === application) return [APPLICATION_PARENT];
    if (table === compose) return [COMPOSE_PARENT];
    if (table === domain) return [];
    if (table === webServerSettings) return [];
    if (table === aiModelFacet) return [];
    throw new Error('unexpected table read');
  };

  const select = () => ({
    from: (table: unknown) => {
      const rows = rowsFor(table);
      const chain = {
        innerJoin: () => chain,
        leftJoin: () => chain,
        where: () => chain,
        orderBy: () => chain,
        limit: () => Promise.resolve(rows),
        // Awaited directly by `assertParentRowsRoutable`, which takes no limit.
        then: (
          resolve: (value: unknown[]) => unknown,
          reject: (reason: unknown) => unknown,
        ) => Promise.resolve(rows).then(resolve, reject),
      };
      return chain;
    },
  });

  const insert = () => ({
    values: (values: Record<string, unknown>) => ({
      returning: () => {
        written.values = values;
        return Promise.resolve([{ domainId: 'domain-1', ...values }]);
      },
    }),
  });

  const db = {
    select,
    insert,
    transaction: (run: (tx: unknown) => Promise<unknown>) =>
      run({ select, insert }),
  };
  return db as unknown as DrizzleDB;
};

function makeService(): { domains: DomainsService; written: Written } {
  const written: Written = {};
  const domains = new DomainsService(
    makeDb(written),
    {
      checkPermission: jest.fn().mockResolvedValue(undefined),
      checkServiceAccess: jest.fn().mockResolvedValue(undefined),
    } as unknown as PermissionService,
    {
      regenerate: jest.fn().mockResolvedValue(undefined),
    } as unknown as TraefikAppConfigService,
    // A Self-hosted instance whose own origins are unset: the host
    // reservation (`instance-host-reservation.spec.ts`) asks both, and
    // reserves nothing here.
    {
      get: (token: unknown) =>
        token === InstanceMode ? { isHosted: false } : { get: () => undefined },
    } as unknown as ModuleRef,
  );
  return { domains, written };
}

/** A create body as the service seam hands one over: no pipe, no refinement. */
const body = (data: Record<string, unknown>) =>
  ({ host: 'app.example.com', ...data }) as unknown as CreateDomainDto;

/** The fifteen columns `create` names, and nothing else. */
const NAMED_COLUMNS = [
  'host',
  'path',
  'internalPath',
  'stripPath',
  'port',
  'https',
  'certificateType',
  'customCertResolver',
  'customEntrypoint',
  'middlewares',
  'forwardAuthEnabled',
  'serviceName',
  'domainType',
  'applicationId',
  'composeId',
  // A bucket on a Server, the third parent.
  'bucketId',
];

describe('DomainsService.create, on which parent the row is attached to', () => {
  it('writes the resolved Application and leaves the composeId a body sent beside it unwritten', async () => {
    const { domains, written } = makeService();

    await domains.create(
      ctx,
      body({
        applicationId: 'our-application',
        composeId: 'their-compose',
      }),
    );

    // `findParentService` returned on the `applicationId` branch, so the
    // Application is the only parent that was looked up and access-checked —
    // and it is now the only one written. Before the fix `composeId` here was
    // `'their-compose'`: a row on a stack in another organization, whose
    // Traefik router `findComposeDomains` splices into that stack's next
    // deploy. The refinement refuses this body over the wire; this is the
    // guarantee for the seam callers the pipe never sees.
    expect(written.values).toMatchObject({ applicationId: 'our-application' });
    expect(written.values?.composeId).toBeUndefined();
  });

  it('writes the resolved Compose stack and leaves the applicationId unwritten', async () => {
    const { domains, written } = makeService();

    await domains.create(
      ctx,
      body({
        composeId: 'our-compose',
        serviceName: 'web',
        domainType: 'compose',
      }),
    );

    // The other branch, so the rule is symmetric rather than a special case
    // for the branch the bug happened to be reachable through.
    expect(written.values).toMatchObject({ composeId: 'our-compose' });
    expect(written.values?.applicationId).toBeUndefined();
  });

  it('reaches the insert with the columns it names and no key a caller supplied', async () => {
    const { domains, written } = makeService();

    await domains.create(
      ctx,
      body({
        applicationId: 'our-application',
        // Two keys no DTO declares, standing in for the next column this table
        // grows: a spread would have carried both into the insert, and the
        // first is a foreign key of exactly the class the parent fix is about.
        previewDeploymentId: 'their-preview',
        uniqueConfigKey: 99,
      }),
    );

    expect(Object.keys(written.values ?? {}).sort()).toEqual(
      [...NAMED_COLUMNS].sort(),
    );
  });

  it('leaves every column the body omitted to the table default', async () => {
    const { domains, written } = makeService();

    await domains.create(ctx, body({ applicationId: 'our-application' }));

    // Naming the columns must not start writing explicit nulls over the
    // defaults the spread left alone: a present-but-`undefined` key is
    // `DEFAULT` in drizzle's dialect, so `https`, `stripPath`,
    // `certificateType` and `forwardAuthEnabled` still land theirs. `path` is
    // the one exception and is `create`'s own `?? '/'`.
    expect(written.values).toEqual({
      host: 'app.example.com',
      path: '/',
      internalPath: undefined,
      stripPath: undefined,
      port: undefined,
      https: undefined,
      // With HTTPS left at its default (off), the certificate is written as
      // what HTTPS off serves: `none` and no resolver, which are the
      // table's own defaults for both columns, so nothing changes in storage.
      certificateType: 'none',
      customCertResolver: null,
      customEntrypoint: undefined,
      middlewares: undefined,
      forwardAuthEnabled: undefined,
      serviceName: undefined,
      domainType: undefined,
      applicationId: 'our-application',
      composeId: undefined,
      bucketId: undefined,
    });
  });
});
