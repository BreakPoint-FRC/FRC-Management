import { z } from "zod";

// Query parameters arrive as strings, so both fields coerce. The cap is the
// point: without it a client can ask for the whole table and the endpoint that
// was fast with a hundred tasks stops being fast in March.
export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export type PaginationInput = z.infer<typeof paginationSchema>;

/** The envelope every list endpoint returns. */
export interface Paginated<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}
