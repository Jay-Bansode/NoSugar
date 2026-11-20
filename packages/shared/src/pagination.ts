import { z } from 'zod';

export const DEFAULT_PAGE_LIMIT = 20;
export const MAX_PAGE_LIMIT = 100;

/** Query params for cursor pagination: `?cursor=...&limit=20`. */
export const cursorQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT),
});

export type CursorQuery = z.infer<typeof cursorQuerySchema>;

/** Wraps an item schema in the paginated response shape `{ data: [], nextCursor }`. */
export function paginated<T extends z.ZodType>(item: T) {
  return z.object({
    data: z.array(item),
    nextCursor: z.string().nullable(),
  });
}

export type Paginated<T> = { data: T[]; nextCursor: string | null };
