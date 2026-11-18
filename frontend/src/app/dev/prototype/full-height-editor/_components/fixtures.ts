/**
 * The prototype's data: a raw compose file for a small billing stack, long
 * enough that the card's 340px well scrolls, which is the problem the
 * full-height editor answers. Nothing here is read from a backend.
 */
export const STACK_NAME = "billing-stack";

export const COMPOSE_FILE = `# billing-stack: the invoicing API, its worker and their stores.
# Deployed by Cloudgate to prod-eu-1. Variables live under Variables.

services:
  api:
    image: ghcr.io/acme/billing-api:2.14.3
    restart: unless-stopped
    environment:
      DATABASE_URL: postgres://billing:\${POSTGRES_PASSWORD}@postgres:5432/billing
      REDIS_URL: redis://redis:6379/0
      STRIPE_SECRET_KEY: \${STRIPE_SECRET_KEY}
      LOG_LEVEL: \${LOG_LEVEL:-info}
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_started
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:8080/healthz"]
      interval: 15s
      timeout: 3s
      retries: 5
    deploy:
      resources:
        limits:
          cpus: "1.0"
          memory: 512M

  worker:
    image: ghcr.io/acme/billing-api:2.14.3
    command: ["node", "dist/worker.js", "--queues", "invoices,webhooks"]
    restart: unless-stopped
    environment:
      DATABASE_URL: postgres://billing:\${POSTGRES_PASSWORD}@postgres:5432/billing
      REDIS_URL: redis://redis:6379/0
      CONCURRENCY: 4
    depends_on:
      - postgres
      - redis

  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: billing
      POSTGRES_DB: billing
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD}
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U billing"]
      interval: 10s
      retries: 6

  redis:
    image: redis:7.4-alpine
    command: ["redis-server", "--appendonly", "yes"]
    volumes:
      - redisdata:/data

volumes:
  pgdata:
  redisdata:
`;

export const SERVICES = [
  { name: "api", image: "ghcr.io/acme/billing-api:2.14.3" },
  { name: "worker", image: "ghcr.io/acme/billing-api:2.14.3" },
  { name: "postgres", image: "postgres:16-alpine" },
  { name: "redis", image: "redis:7.4-alpine" },
];
