# Integration tests run against ephemeral Postgres via Testcontainers

Tests exercise services through the real database, not mocks of the Drizzle layer. Each test run starts a throwaway Postgres container (`@testcontainers/postgresql`), applies the committed Drizzle migrations, and truncates all public tables between tests so suites are order-independent. We chose this over an in-memory fake (pg-mem) or a shared dev database because migration SQL, constraints, and Postgres-specific behavior are part of what we're verifying — the harness lives in `backend/test/utils/`.

## Consequences

- Docker is required to run the backend test suite.
- Suite startup pays a container-boot cost (tens of seconds); Jest `testTimeout` is raised to 60s.
