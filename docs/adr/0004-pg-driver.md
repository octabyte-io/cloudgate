# node-postgres (`pg` Pool) as the Drizzle driver

Cloudgate uses `pg` (node-postgres) with a `Pool`, via `drizzle-orm/node-postgres`, rather than the `postgres` (postgres-js) driver. The `pg` ecosystem integrates more cleanly with NestJS lifecycle management and Testcontainers, and Drizzle's query API is driver-agnostic. Driver-level code is written in node-postgres idioms — no postgres-js `sql`/`max: 1` idioms, no `drizzle-orm/postgres-js/migrator` — and postgres-js is not to be added as a second driver.
