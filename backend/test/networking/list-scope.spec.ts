import { listPortsSchema } from '../../src/networking/ports/dto/port.dto';
import { listRedirectsSchema } from '../../src/networking/redirects/dto/redirect.dto';
import { listSecuritySchema } from '../../src/networking/security/dto/security.dto';

// The three networking list routes are only listable through their parent
// Application, and that parent is what scopes them to an Organization. A
// schema that let applicationId go missing or empty would turn each route
// into an unscoped dump, so the requirement is pinned here rather than left
// to the HTTP layer.
const schemas = [
  ['listPortsSchema', listPortsSchema],
  ['listRedirectsSchema', listRedirectsSchema],
  ['listSecuritySchema', listSecuritySchema],
] as const;

describe.each(schemas)('%s', (_name, schema) => {
  it('accepts an applicationId', () => {
    expect(schema.parse({ applicationId: 'app_1' })).toEqual({
      applicationId: 'app_1',
    });
  });

  it('rejects a query with no applicationId', () => {
    expect(schema.safeParse({}).success).toBe(false);
  });

  it('rejects an empty applicationId', () => {
    expect(schema.safeParse({ applicationId: '' }).success).toBe(false);
  });

  it('ignores anything else in the query', () => {
    expect(
      schema.parse({ applicationId: 'app_1', organizationId: 'org_2' }),
    ).toEqual({ applicationId: 'app_1' });
  });
});
