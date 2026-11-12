import {
  createDomainSchema,
  updateDomainSchema,
} from '../../src/domains/dto/domain.dto';

/**
 * The DTO half of the parent fix. `DomainsService.create` resolved its parent through
 * `findParentService`, which is organization-scoped in both branches — and
 * *returns* on the `applicationId` one, so a body carrying the caller's own
 * `applicationId` beside another organization's `composeId` was access-checked
 * on the first id only, while `.values({ ...data, host, path })` wrote **both**
 * foreign keys. The row landed on the victim's Compose stack, whose Traefik
 * router is spliced into their next deploy. §2.4 puts a payload shape rule on
 * the DTO, so "exactly one owning service" is now a `superRefine` here — the
 * same rule, message and field path an earlier fix landed on `createPatchSchema` for the
 * identical defect one module over.
 *
 * The cross-tenant behaviour itself is asserted over HTTP in
 * `domain-tenancy.e2e-spec.ts`, which needs two organizations and two accounts.
 * What is unit-testable is the rule the refinement states, that it composes
 * with the three cross-field rules it is chained after rather than replacing
 * them, and — the property §2.2 and ADR-0008 ask for — that its refusal is a
 * function of the *shape* of the body and of nothing about which ids exist, so
 * a caller cannot read one id off another's rejection.
 */
describe('createDomainSchema', () => {
  const body = { host: 'app.example.com' };

  it('accepts a body owned by an application, and one owned by a compose stack', () => {
    expect(
      createDomainSchema.parse({ ...body, applicationId: 'app-1' }),
    ).toEqual({ ...body, applicationId: 'app-1' });
    expect(
      createDomainSchema.parse({
        ...body,
        composeId: 'compose-1',
        serviceName: 'web',
        domainType: 'compose',
      }),
    ).toEqual({
      ...body,
      composeId: 'compose-1',
      serviceName: 'web',
      domainType: 'compose',
    });
  });

  it('refuses a body carrying both an applicationId and a composeId', () => {
    const result = createDomainSchema.safeParse({
      ...body,
      applicationId: 'app-1',
      composeId: 'compose-1',
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues).toEqual([
      expect.objectContaining({
        path: ['applicationId'],
        message:
          'Exactly one of applicationId, composeId or bucketId must be provided',
      }),
    ]);
  });

  it('refuses a body carrying neither an applicationId nor a composeId', () => {
    const result = createDomainSchema.safeParse(body);

    // The other half of "exactly one". This used to reach the service and
    // answer 400 `'applicationId or composeId is required'`, which
    // `findParentService` still raises for an internal caller and for the four
    // read/write paths that hand it a stored row.
    expect(result.success).toBe(false);
    expect(result.error?.issues).toEqual([
      expect.objectContaining({
        path: ['applicationId'],
        message:
          'Exactly one of applicationId, composeId or bucketId must be provided',
      }),
    ]);
  });

  it('refuses both ids identically whichever compose stack the second one names', () => {
    const flatten = (input: unknown) =>
      JSON.stringify(createDomainSchema.safeParse(input).error?.issues);

    // The refinement runs before anything is looked up, so a real neighbouring
    // stack, a stack of the caller's own and an id that names nothing anywhere
    // are one refusal — the pair ADR-0008 requires, at the layer that answers
    // first. Nothing here reaches the database to tell them apart.
    const victims = ['their-compose-id', 'our-compose-id', 'no-such-compose'];
    const refusals = victims.map((composeId) =>
      flatten({ ...body, applicationId: 'app-1', composeId }),
    );
    // Refused, and refused with one body: without the first assertion the
    // second passes vacuously on three successes carrying no issues at all.
    expect(refusals[0]).toBeDefined();
    expect(new Set(refusals).size).toBe(1);
  });

  it('still applies the three cross-field rules it is chained after', () => {
    // Two chained `superRefine`s on one object, so the parent-reference rule
    // must not have displaced `refineDomainRules`: a body that breaks both
    // carries both issues.
    const result = createDomainSchema.safeParse({
      ...body,
      https: true,
      applicationId: 'app-1',
      composeId: 'compose-1',
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues).toEqual([
      expect.objectContaining({
        path: ['certificateType'],
        message: 'Required when https is enabled',
      }),
      expect.objectContaining({
        path: ['applicationId'],
        message:
          'Exactly one of applicationId, composeId or bucketId must be provided',
      }),
    ]);
  });

  it('rejects an id sent as an empty string rather than reading it as absent', () => {
    // `''` is falsy, and `findParentService` branches on truthiness — so an
    // empty `applicationId` would fall through to the `composeId` branch and,
    // with no `composeId`, to `'applicationId or composeId is required'`. It is
    // one *present* id, so the refinement passes it; `min(1)` is deliberately
    // not added, because that would be a new refusal for a payload the API
    // already accepted (the no-new-refusals rule) and the FK lookup is what decides whether
    // an id names a service.
    expect(
      createDomainSchema.safeParse({ ...body, applicationId: '' }).success,
    ).toBe(true);
  });
});

describe('updateDomainSchema', () => {
  it('strips an applicationId or composeId off an update body', () => {
    // A Domain cannot be re-pointed at another service: the ids are not in the
    // schema, and a plain `z.object` strips unknown keys rather than passing
    // them through, so `DomainsService.update` — which access-checked the row's
    // **current** parent and then spreads `data` into its `set` — never sees
    // one. The exposure was create-only, and this is the assertion that says
    // so rather than assuming it.
    expect(
      updateDomainSchema.parse({
        port: 3001,
        applicationId: 'app-1',
        composeId: 'compose-1',
      }),
    ).toEqual({ port: 3001 });
  });
});

/**
 * `stored` — a certificate from Settings → Certificates — is a Certificate
 * choice both writes take, and needs no resolver name: whether a stored
 * certificate actually covers the host is `DomainsService`'s question, not the
 * body's.
 */
describe('createDomainSchema and updateDomainSchema — certificateType', () => {
  it('takes stored on a create and an update, with no resolver', () => {
    expect(
      createDomainSchema.safeParse({
        host: 'shop.example.com',
        https: true,
        certificateType: 'stored',
        customCertResolver: null,
        applicationId: 'app-1',
      }).success,
    ).toBe(true);
    expect(
      updateDomainSchema.safeParse({ https: true, certificateType: 'stored' })
        .success,
    ).toBe(true);
  });
});
