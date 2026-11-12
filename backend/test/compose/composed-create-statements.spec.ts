import { composedCreateStatements } from '../../src/compose/composed-create-statements';

/**
 * The statements a composed create claims before its first write;
 * `test/ai/deploy-preflight.spec.ts` is the rule applied on `AiService.deploy`.
 */
describe('composedCreateStatements', () => {
  /**
   * All four input shapes in one object, because the property is the *mapping*
   * — claim what the loops will claim, and nothing when no loop runs. Split
   * into four tests, each would keep passing while the mapping drifted.
   */
  it('names the statements the loops will claim, and nothing when no loop runs', () => {
    const claimed = (domains: number, mounts: number) =>
      composedCreateStatements({ domains, mounts });

    expect({
      neither: claimed(0, 0),
      domainsOnly: claimed(2, 0),
      mountsOnly: claimed(0, 2),
      both: claimed(1, 2),
    }).toEqual({
      // Not an omission: a stack with no mounts and no domains reaches
      // neither gate, so claiming either here would be a widening rather
      // than a hoist.
      neither: [],
      domainsOnly: [{ service: ['read'] }, { domain: ['create'] }],
      mountsOnly: [{ service: ['read'] }, { volume: ['create'] }],
      both: [
        { service: ['read'] },
        { domain: ['create'] },
        { volume: ['create'] },
      ],
    });
  });

  /**
   * `checkPermission`'s owner/admin bypass fires only when *every* requested
   * resource is in `enterpriseOnlyResources`. `domain` and `volume` are;
   * `service` is not. So a merged `{ service, domain, volume }` object would
   * stop owner and admin being bypassed on the two enterprise-only statements.
   * Pinned as "no statement shares an object with another", because that is
   * the property rather than the count.
   */
  it('keeps every statement in an object of its own, so none is evaluated alongside another', () => {
    const perObject = composedCreateStatements({ domains: 1, mounts: 1 }).map(
      (statement) => Object.keys(statement),
    );

    expect(perObject).toEqual([['service'], ['domain'], ['volume']]);
  });
});
