import { ConflictException } from '@nestjs/common';

/**
 * A violation of the unique index or constraint `indexName` becomes a 409
 * Conflict carrying `message`; any other error comes back unchanged, for the
 * caller to rethrow.
 *
 * Drizzle wraps the pg error, so the name is looked for down the `cause`
 * chain. pg names a unique index in its message exactly as it names a unique
 * constraint, so an index on `lower(name)` is found the same way.
 *
 * The index — not a lookup before the write — decides these, so two writes
 * racing each other get one success and one 409 rather than two rows. Shared
 * by `TagsService`, `ProjectsService` and `EnvironmentsService`,
 * which each held a copy.
 */
export function mapUniqueViolation(
  error: unknown,
  indexName: string,
  message: string,
): unknown {
  for (let e = error; e instanceof Error; e = e.cause) {
    if (e.message.includes(indexName)) return new ConflictException(message);
  }
  return error;
}
