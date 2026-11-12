import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { CertificatesService } from '../../src/certificates/certificates.service';
import type { DrizzleDB } from '../../src/db/drizzle.module';
import type { PermissionCtx } from '../../src/rbac/permission.service';
import type { PermissionService } from '../../src/rbac/permission.service';
import type { TraefikWriterService } from '../../src/traefik/traefik-writer.service';

/**
 * Who may put PEM material into the **platform host's** Traefik certificate
 * store, and whether a refusal ever reaches the store on the way out (
 * ADR-0013).
 *
 * An earlier fix closed the named Server: a `serverId` in another organization is a 404
 * before anything is written, and `certificates.e2e-spec.ts` asserts that over
 * HTTP. What is decided here is the branch an earlier fix left — a nullish `serverId`,
 * which is the one Traefik every organization's gated Domain is served by, so
 * material naming somebody else's hostname is selected for their traffic. The
 * decision and its cost to a legitimate operator are recorded on
 * `CertificatesService.create`.
 *
 * Asserted at this seam rather than only over HTTP because the interesting
 * facts are negative and ordered: that `TraefikWriterService.writeCertificate`
 * was not reached, that no row was inserted or updated on the way to the
 * refusal, and — for `update` — that a *rename* deliberately does not take the
 * boundary. An HTTP suite sees the status; it cannot see that the certs dir was
 * left alone. The database is faked and `PermissionService` stubbed on
 * `test/environments/environment-tenancy.spec.ts`'s reasoning: they are the
 * collaborators whose answers select the branch.
 */

const ctx: PermissionCtx = {
  user: { id: 'user-1' },
  session: { activeOrganizationId: 'org-a' },
};

/** `PermissionService.checkInstanceAuthority`'s sentence, verbatim. */
const INSTANCE_REFUSAL =
  'Only an owner or admin of the instance organization can configure the platform host';

const MATERIAL = {
  name: 'wildcard-example-com',
  certificateData:
    '-----BEGIN CERTIFICATE-----\nMIIBszCCAVo=\n-----END CERTIFICATE-----',
  privateKey:
    '-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBM=\n-----END PRIVATE KEY-----',
};

/** A stored certificate on the platform host, as `findRow` projects it. */
const HOST_ROW = {
  certificateId: 'cert-1',
  certificatePath: 'certificate-abc123',
  organizationId: 'org-a',
  serverId: null as string | null,
  ...MATERIAL,
};

/** The same certificate on a Server the organization owns. */
const SERVER_ROW = { ...HOST_ROW, serverId: 'server-a' };

/** A Server row in the caller's organization, as `checkServerAccess` finds it. */
const OWNED_SERVER = { serverId: 'server-a', organizationId: 'org-a' };

interface Refusal {
  status: number;
  message: string;
}

/** What a caller reads off a refusal: the two things the filter puts on the wire. */
async function refusalOf(pending: Promise<unknown>): Promise<Refusal> {
  try {
    await pending;
  } catch (error) {
    if (
      error instanceof NotFoundException ||
      error instanceof ForbiddenException
    ) {
      return { status: error.getStatus(), message: error.message };
    }
    throw error;
  }
  throw new Error('the call was expected to be refused and was not');
}

interface Harness {
  service: CertificatesService;
  /** Every caller the instance-authority boundary was consulted about. */
  instanceChecks: string[];
  /** Every permission set `checkPermission` was asked for. */
  statements: unknown[];
  /** Every certificate handed to the host-side writer. */
  written: { serverId?: string | null }[];
  /** Every row inserted. */
  inserted: unknown[];
  /** Every `set(...)` an update reached. */
  updated: unknown[];
}

interface HarnessOptions {
  /** What the organization-scoped select answers (a Server, or a certificate). */
  rows?: unknown[];
  /** The instance-authority half — what `checkInstanceAuthority` answers. */
  instanceAuthority?: () => Promise<void>;
}

function harness(options: HarnessOptions = {}): Harness {
  const { rows = [], instanceAuthority = () => Promise.resolve() } = options;

  const instanceChecks: string[] = [];
  const statements: unknown[] = [];
  const written: { serverId?: string | null }[] = [];
  const inserted: unknown[] = [];
  const updated: unknown[] = [];

  const selectChain = {
    from: () => selectChain,
    where: () => selectChain,
    limit: () => Promise.resolve(rows),
  };
  const db = {
    select: () => selectChain,
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        inserted.push(values);
        return {
          returning: () => Promise.resolve([{ ...values }]),
        };
      },
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => {
        updated.push(values);
        return {
          where: () => ({
            returning: () =>
              Promise.resolve([
                { ...HOST_ROW, ...(rows[0] as object), ...values },
              ]),
          }),
        };
      },
    }),
  } as unknown as DrizzleDB;

  const permissions = {
    checkPermission: (_ctx: PermissionCtx, asked: unknown) => {
      statements.push(asked);
      return Promise.resolve();
    },
    checkInstanceAuthority: (called: PermissionCtx) => {
      instanceChecks.push(called.user.id);
      return instanceAuthority();
    },
  } as unknown as PermissionService;

  const traefikWriter = {
    writeCertificate: (cert: { serverId?: string | null }) => {
      written.push(cert);
      return Promise.resolve();
    },
  } as unknown as TraefikWriterService;

  return {
    service: new CertificatesService(db, permissions, traefikWriter),
    instanceChecks,
    statements,
    written,
    inserted,
    updated,
  };
}

describe('CertificatesService.create', () => {
  it('refuses a platform-host certificate to an owner who does not administer the instance, before any PEM material is written', async () => {
    const state = harness({
      instanceAuthority: () =>
        Promise.reject(new ForbiddenException(INSTANCE_REFUSAL)),
    });

    expect(await refusalOf(state.service.create(ctx, MATERIAL))).toEqual({
      status: 403,
      message: INSTANCE_REFUSAL,
    });

    // Neither half of the traversal rule's order was reached: no key on the shared host's
    // disk, and no row claiming one is there.
    expect(state.written).toEqual([]);
    expect(state.inserted).toEqual([]);
    // The statement was still asked for first, so a caller without
    // `certificate: ['create']` is refused for that and learns nothing about
    // who administers the instance.
    expect(state.statements).toEqual([{ certificate: ['create'] }]);
  });

  it('reads an explicit null serverId as the platform host', async () => {
    const state = harness({
      instanceAuthority: () =>
        Promise.reject(new ForbiddenException(INSTANCE_REFUSAL)),
    });

    // `.nullish()`, so `null` is the value a client reads off the resource and
    // sends back; it cannot be a way past the check.
    expect(
      await refusalOf(
        state.service.create(ctx, { ...MATERIAL, serverId: null }),
      ),
    ).toEqual({ status: 403, message: INSTANCE_REFUSAL });
    expect(state.written).toEqual([]);
  });

  it('writes the material for a caller who does administer the instance', async () => {
    const state = harness();

    const created = await state.service.create(ctx, MATERIAL);

    expect(state.instanceChecks).toEqual(['user-1']);
    expect(state.written).toHaveLength(1);
    expect(state.written[0]).toMatchObject({ serverId: null });
    expect(state.inserted).toHaveLength(1);
    expect(created).not.toHaveProperty('privateKey');
  });

  it('asks the instance nothing for a Server the caller organization owns', async () => {
    const state = harness({ rows: [OWNED_SERVER] });

    await state.service.create(ctx, { ...MATERIAL, serverId: 'server-a' });

    // ADR-0013's second consequence: an organization's owner administers its
    // own fleet, and the organization-scoped 404 already covers a Server that is
    // not theirs.
    expect(state.instanceChecks).toEqual([]);
    expect(state.written[0]).toMatchObject({ serverId: 'server-a' });
  });

  it('refuses a Server outside the caller organization without falling through to the host', async () => {
    const state = harness({ rows: [] });

    expect(
      await refusalOf(
        state.service.create(ctx, { ...MATERIAL, serverId: 'server-b' }),
      ),
    ).toEqual({ status: 404, message: 'Server not found' });

    expect(state.instanceChecks).toEqual([]);
    expect(state.written).toEqual([]);
    expect(state.inserted).toEqual([]);
  });
});

describe('CertificatesService.update', () => {
  it('refuses new material on a platform-host certificate, and the row still advertises the old material', async () => {
    const state = harness({
      rows: [HOST_ROW],
      instanceAuthority: () =>
        Promise.reject(new ForbiddenException(INSTANCE_REFUSAL)),
    });

    expect(
      await refusalOf(
        state.service.update(ctx, 'cert-1', {
          certificateData:
            '-----BEGIN CERTIFICATE-----\nother\n-----END CERTIFICATE-----',
        }),
      ),
    ).toEqual({ status: 403, message: INSTANCE_REFUSAL });

    // The check runs ahead of the row write, not ahead of the file write it
    // guards, so no row is left claiming material the certs dir never took.
    expect(state.updated).toEqual([]);
    expect(state.written).toEqual([]);
  });

  it('refuses a new private key alone on a platform-host certificate', async () => {
    const state = harness({
      rows: [HOST_ROW],
      instanceAuthority: () =>
        Promise.reject(new ForbiddenException(INSTANCE_REFUSAL)),
    });

    // Either field rewrites the pair, so either field is the host-side write.
    await refusalOf(
      state.service.update(ctx, 'cert-1', { privateKey: 'a new key' }),
    );
    expect(state.written).toEqual([]);
  });

  it('renames a platform-host certificate on organization authority alone', async () => {
    const state = harness({
      rows: [HOST_ROW],
      instanceAuthority: () =>
        Promise.reject(new ForbiddenException(INSTANCE_REFUSAL)),
    });

    const renamed = await state.service.update(ctx, 'cert-1', {
      name: 'internal-example-com',
    });

    // The deliberate split: the shared certs dir takes instance
    // authority, the organization's own row does not — which is what keeps an
    // organization able to tidy a host certificate it created before the check
    // existed. Nothing was written to the host.
    expect(state.instanceChecks).toEqual([]);
    expect(state.written).toEqual([]);
    expect(state.updated).toEqual([{ name: 'internal-example-com' }]);
    expect(renamed.name).toBe('internal-example-com');
  });

  it('asks the instance nothing for new material on the organization own Server', async () => {
    const state = harness({ rows: [SERVER_ROW] });

    await state.service.update(ctx, 'cert-1', { privateKey: 'a new key' });

    expect(state.instanceChecks).toEqual([]);
    expect(state.written).toHaveLength(1);
  });
});

/**
 * **This is deliberately an enumeration**, on `gateway-leases.e2e-spec.ts`'s
 * reasoning: nothing in the compiler notices a sixth method here that writes
 * into the platform host's Traefik store on an organization-level statement,
 * which is the defect this file pins. The keys are asserted against
 * `CertificatesService.prototype`, so a new method fails by name until whoever
 * adds it writes down the boundary it takes.
 *
 * Module-scoped, not tree-wide: the original report says why the tree-wide version is
 * not achievable — this write is *per-row* on disk (its own directory under a
 * generated `certificatePath`), and what makes it instance-wide is Traefik
 * merging every certificate's fragment into one `tls.certificates` and choosing by
 * the SANs inside the material. No static rule over this file can see that.
 */
const BOUNDARIES: Readonly<Record<string, string>> = {
  // The host branch writes into the one Traefik every organization is served
  // by, so it takes PermissionService.checkInstanceAuthority on top of
  // the statement; a named Server is an organization-scoped 404.
  create:
    "certificate: ['create'], then checkInstanceAuthority when serverId is nullish",
  update:
    "certificate: ['update'], then checkInstanceAuthority when new material lands on the host",

  // `remove` deletes only the directory this row's own `certificatePath` names,
  // and `findRow` is organization-scoped, so nothing shared is reachable.
  remove: "certificate: ['delete'], plus the organization-scoped findRow",
  list: "certificate: ['read'], organization-scoped query",
  findOne: "certificate: ['read'], plus the organization-scoped findRow",
  findRow: 'private: the organization-scoped row lookup itself',
  constructor: 'not a method',
};

describe('CertificatesService', () => {
  it('gives every method that can reach the platform host a named boundary', () => {
    expect(
      Object.getOwnPropertyNames(CertificatesService.prototype).sort(),
    ).toEqual(Object.keys(BOUNDARIES).sort());
  });
});
