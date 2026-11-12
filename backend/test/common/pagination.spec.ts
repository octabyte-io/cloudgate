import {
  toOffsetLimit,
  buildPaginationMeta,
} from '../../src/common/pagination/pagination';

describe('pagination helper', () => {
  it('maps page 1 to offset 0', () => {
    expect(toOffsetLimit({ page: 1, limit: 10 })).toEqual({
      offset: 0,
      limit: 10,
    });
  });

  it('maps a later page to the correct offset', () => {
    // page 3 with 20 per page skips the 40 items on pages 1-2
    expect(toOffsetLimit({ page: 3, limit: 20 })).toEqual({
      offset: 40,
      limit: 20,
    });
  });

  it('builds metadata for a partial last page', () => {
    // 45 items at 10 per page: pages 1-4 full, page 5 holds the last 5
    expect(buildPaginationMeta({ page: 2, limit: 10, totalItems: 45 })).toEqual(
      {
        page: 2,
        limit: 10,
        totalItems: 45,
        totalPages: 5,
        hasNextPage: true,
        hasPreviousPage: true,
      },
    );
  });

  it('marks the boundaries of the first and last page', () => {
    const first = buildPaginationMeta({ page: 1, limit: 10, totalItems: 45 });
    expect(first.hasPreviousPage).toBe(false);
    expect(first.hasNextPage).toBe(true);

    const last = buildPaginationMeta({ page: 5, limit: 10, totalItems: 45 });
    expect(last.hasPreviousPage).toBe(true);
    expect(last.hasNextPage).toBe(false);
  });

  it('reports zero items as a single empty page range', () => {
    const meta = buildPaginationMeta({ page: 1, limit: 10, totalItems: 0 });
    expect(meta.totalPages).toBe(0);
    expect(meta.hasNextPage).toBe(false);
    expect(meta.hasPreviousPage).toBe(false);
  });
});
