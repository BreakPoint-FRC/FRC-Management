import type { Paginated, PaginationInput } from "@breakpoint/types";

/** Turns validated page/pageSize into the arguments Prisma wants. */
export function toPrismaPage({ page, pageSize }: PaginationInput) {
  return { skip: (page - 1) * pageSize, take: pageSize };
}

/**
 * The envelope every list endpoint returns.
 *
 * `total` is the count before paging, so a client can render "page 2 of 7"
 * without a second request. Endpoints fetch it with the same where clause,
 * inside the same transaction as the page, so the two cannot disagree about a
 * row that was written between them.
 */
export function paginated<T>(
  items: T[],
  total: number,
  { page, pageSize }: PaginationInput
): Paginated<T> {
  return {
    items,
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}
