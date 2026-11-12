export interface PaginationInput {
  page: number;
  limit: number;
}

export interface PaginationMeta {
  page: number;
  limit: number;
  totalItems: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

export const toOffsetLimit = ({ page, limit }: PaginationInput) => ({
  offset: (page - 1) * limit,
  limit,
});

export const buildPaginationMeta = ({
  page,
  limit,
  totalItems,
}: PaginationInput & { totalItems: number }): PaginationMeta => {
  const totalPages = Math.ceil(totalItems / limit);
  return {
    page,
    limit,
    totalItems,
    totalPages,
    hasNextPage: page < totalPages,
    hasPreviousPage: page > 1 && totalItems > 0,
  };
};
