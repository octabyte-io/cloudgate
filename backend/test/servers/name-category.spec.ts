import {
  MAX_NAMED_PER_CATEGORY,
  nameCategory,
} from '../../src/servers/servers.service';

const rows = (n: number, kind: string) =>
  Array.from({ length: n }, (_, i) => `${kind} "row-${i}"`);

describe('nameCategory', () => {
  it('returns null for an empty category, so the clause is dropped rather than empty', () => {
    expect(nameCategory([], 'service', 'services')).toBeNull();
  });

  it('uses the singular for one row and names it', () => {
    expect(nameCategory(['application "Web App"'], 'service', 'services')).toBe(
      '1 service (application "Web App")',
    );
  });

  it('names every row up to the budget without a count of the rest', () => {
    const clause = nameCategory(
      rows(MAX_NAMED_PER_CATEGORY, 'application'),
      'service',
      'services',
    );
    expect(clause).toBe(
      `${MAX_NAMED_PER_CATEGORY} services (${rows(MAX_NAMED_PER_CATEGORY, 'application').join(', ')})`,
    );
    // Nothing was truncated at exactly the budget, so no ", and 0 more".
    expect(clause).not.toContain('more');
  });

  it('truncates past the budget and keeps the exact total', () => {
    const clause = nameCategory(rows(42, 'application'), 'service', 'services');
    expect(clause).toBe(
      `42 services (${rows(MAX_NAMED_PER_CATEGORY, 'application').join(', ')}, and ${42 - MAX_NAMED_PER_CATEGORY} more)`,
    );
    // The count an operator acts on is the total, never the number named.
    expect(clause).toContain('42 services');
  });

  it('spends a separate budget per category, so a full Services clause never starves the configuration one', () => {
    const services = nameCategory(
      rows(42, 'application'),
      'service',
      'services',
    );
    const configuration = nameCategory(
      rows(12, 'certificate'),
      'configuration entry',
      'configuration entries',
    );

    // This is the decision: both clauses name ten, and neither is the empty
    // slice behind a stray comma a shared budget would have produced.
    expect(services).toContain('and 32 more');
    expect(configuration).toContain('and 2 more');
    expect(configuration).not.toContain('(,');
    expect(
      `${services} and ${configuration}`.match(/certificate "row-/g),
    ).toHaveLength(MAX_NAMED_PER_CATEGORY);
  });
});
