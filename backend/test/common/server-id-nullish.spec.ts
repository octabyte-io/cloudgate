import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deployAiSchema, suggestAiSchema } from '../../src/ai/dto/ai.dto';
import { createApplicationSchema } from '../../src/applications/dto/application.dto';
import { listBackupFilesSchema } from '../../src/backups/dto/backup.dto';
import { createCertificateSchema } from '../../src/certificates/dto/certificate.dto';
import { createComposeSchema } from '../../src/compose/dto/compose.dto';
import { createLibsqlSchema } from '../../src/databases/libsql/dto/libsql.dto';
import { createMariadbSchema } from '../../src/databases/mariadb/dto/mariadb.dto';
import { createMongoSchema } from '../../src/databases/mongo/dto/mongo.dto';
import { createMysqlSchema } from '../../src/databases/mysql/dto/mysql.dto';
import { createPostgresSchema } from '../../src/databases/postgres/dto/postgres.dto';
import { createRedisSchema } from '../../src/databases/redis/dto/redis.dto';
import { listDestinationObjectsSchema } from '../../src/destinations/dto/destination.dto';
import { ServerIdBodyDto } from '../../src/docker-ops/dto/docker-ops.dto';
import { generateDomainSchema } from '../../src/domains/dto/domain.dto';
import { cleanPatchReposSchema } from '../../src/patch/dto/patch.dto';
import { ServerIdQueryDto } from '../../src/settings/dto/settings.dto';

/**
 * The one contract every `serverId` in a DTO owes ADR-0008: **no server row
 * *is* the platform host**, across the whole HTTP surface.
 *
 * 23 fields spelled it `z.string().optional()`, which accepts the key being
 * omitted and answers `400 "expected string, received null"` to an explicit
 * `null` — the exact value the API itself hands out, because a Service on
 * Cloudgate's own host carries `serverId: null` on its row. A client that
 * round-trips what it read got a 400 from 23 endpoints; the console only
 * escaped it by omitting the field rather than sending what it had.
 *
 * `checkServerAccess` (`common/owned-server.ts`) has always collapsed `null`
 * and `undefined` onto the same "platform host" branch, and
 * `test/common/owned-server.spec.ts` pins that. Validation was the only layer
 * that disagreed, so the sweep is `.nullish()` everywhere and no handler
 * change at all.
 *
 * One representative route per module rather than all 23 — the spelling is
 * mechanical, and the last test here is what actually holds the sweep shut.
 */
describe('serverId', () => {
  describe('across the HTTP surface', () => {
    type Payload = Record<string, unknown>;
    type Parsed = { serverId?: string | null } | undefined;

    /**
     * One representative route per module that takes a `serverId`, with the rest
     * of its payload at the minimum the schema requires. `destinations` and
     * `certificates` are here as the two modules that already spelled it
     * `.nullish()` — the precedent the other 13 were swept onto.
     */
    const routes: readonly {
      readonly route: string;
      readonly base: Payload;
      readonly parse: (payload: Payload) => {
        success: boolean;
        data?: unknown;
      };
    }[] = [
      {
        route: 'POST /domains/generate',
        base: { appName: 'blog-app' },
        parse: (payload) => generateDomainSchema.safeParse(payload),
      },
      {
        route: 'GET /settings/traefik (the apiServerSchema family)',
        base: {},
        parse: (payload) => ServerIdQueryDto.schema.safeParse(payload),
      },
      {
        route: 'POST /postgres',
        base: {
          name: 'db',
          databaseName: 'app',
          databaseUser: 'app',
          environmentId: 'env-1',
        },
        parse: (payload) => createPostgresSchema.safeParse(payload),
      },
      {
        route: 'POST /mysql',
        base: {
          name: 'db',
          databaseName: 'app',
          databaseUser: 'app',
          environmentId: 'env-1',
        },
        parse: (payload) => createMysqlSchema.safeParse(payload),
      },
      {
        route: 'POST /mariadb',
        base: {
          name: 'db',
          databaseName: 'app',
          databaseUser: 'app',
          environmentId: 'env-1',
        },
        parse: (payload) => createMariadbSchema.safeParse(payload),
      },
      {
        route: 'POST /mongo',
        base: { name: 'db', databaseUser: 'app', environmentId: 'env-1' },
        parse: (payload) => createMongoSchema.safeParse(payload),
      },
      {
        route: 'POST /redis',
        base: { name: 'db', environmentId: 'env-1' },
        parse: (payload) => createRedisSchema.safeParse(payload),
      },
      {
        route: 'POST /libsql',
        base: { name: 'db', databaseUser: 'app', environmentId: 'env-1' },
        parse: (payload) => createLibsqlSchema.safeParse(payload),
      },
      {
        route: 'POST /applications',
        base: { name: 'Blog', environmentId: 'env-1' },
        parse: (payload) => createApplicationSchema.safeParse(payload),
      },
      {
        route: 'POST /compose',
        base: { name: 'Stack', environmentId: 'env-1' },
        parse: (payload) => createComposeSchema.safeParse(payload),
      },
      {
        route: 'POST /patches/repo/clean',
        base: {},
        parse: (payload) => cleanPatchReposSchema.safeParse(payload),
      },
      {
        route: 'POST /ai/suggest',
        base: { aiId: 'ai-1', input: 'a blog' },
        parse: (payload) => suggestAiSchema.safeParse(payload),
      },
      {
        route: 'POST /ai/deploy',
        base: {
          environmentId: 'env-1',
          id: 'ai-1',
          dockerCompose: 'services: {}',
          envVariables: '',
          name: 'Blog',
          description: '',
        },
        parse: (payload) => deployAiSchema.safeParse(payload),
      },
      {
        route: 'GET /backups/files',
        base: { destinationId: 'dst-1' },
        parse: (payload) => listBackupFilesSchema.safeParse(payload),
      },
      {
        route: 'POST /docker/upload (the shared serverId const)',
        base: {},
        parse: (payload) => ServerIdBodyDto.schema.safeParse(payload),
      },
      {
        route: 'GET /destinations/:id/objects (already .nullish())',
        base: {},
        parse: (payload) => listDestinationObjectsSchema.safeParse(payload),
      },
      {
        route: 'POST /certificates (already .nullish())',
        base: {
          name: 'wildcard',
          certificateData: '-----BEGIN CERTIFICATE-----',
          privateKey: '-----BEGIN PRIVATE KEY-----',
        },
        parse: (payload) => createCertificateSchema.safeParse(payload),
      },
    ];

    it('accepts an explicit null serverId on every route that takes one', () => {
      for (const { route, base, parse } of routes) {
        const result = parse({ ...base, serverId: null });
        // The route name is in the assertion so a failure names the module.
        expect({ route, success: result.success }).toEqual({
          route,
          success: true,
        });
        expect((result.data as Parsed)?.serverId).toBeNull();
      }
    });

    it('reads an omitted serverId and an explicit null as the same platform host', () => {
      for (const { route, base, parse } of routes) {
        const omitted = parse({ ...base });
        const explicit = parse({ ...base, serverId: null });

        expect({ route, success: omitted.success }).toEqual({
          route,
          success: true,
        });
        // Both land on the falsy branch every caller of checkServerAccess takes
        // for the platform host — `undefined` from the omission, `null` from the
        // explicit value, and no server row looked up either way.
        expect((omitted.data as Parsed)?.serverId ?? null).toBeNull();
        expect((explicit.data as Parsed)?.serverId ?? null).toBeNull();
      }
    });

    it('passes a real serverId through untouched', () => {
      for (const { route, base, parse } of routes) {
        const result = parse({ ...base, serverId: 'R1m04UctPKlbUMWfKMCXV' });

        expect({ route, success: result.success }).toEqual({
          route,
          success: true,
        });
        expect((result.data as Parsed)?.serverId).toBe('R1m04UctPKlbUMWfKMCXV');
      }
    });

    it('refuses a serverId that is neither a string nor null', () => {
      // Widening to `.nullish()` widens by exactly one value. Anything else that
      // is not a string is still a 400, so the field cannot carry a number, an
      // object or an array into a shell-interpolated server lookup.
      for (const { route, base, parse } of routes) {
        for (const serverId of [7, {}, [], true]) {
          expect({
            route,
            serverId,
            success: parse({ ...base, serverId }).success,
          }).toEqual({ route, serverId, success: false });
        }
      }
    });

    it('leaves no DTO in src spelling serverId .optional()', () => {
      // The acceptance criterion of the nullish-serverId sweep stated as a test,
      // because the sweep's only real failure mode is a 24th site being written
      // later: a new DTO copied from an old one re-introduces the 400 for one
      // more route, and nothing else in the suite would notice.
      const src = join(__dirname, '..', '..', 'src');
      const offenders: string[] = [];

      const walk = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const path = join(dir, entry.name);
          if (entry.isDirectory()) {
            walk(path);
            continue;
          }
          if (!entry.name.endsWith('.ts')) continue;
          const text = readFileSync(path, 'utf8');
          if (
            /serverId:\s*z\s*\.string\(\)[^,;]*\.optional\(\)/.test(text) ||
            /\bserverId\s*=\s*z\s*\.string\(\)[^,;]*\.optional\(\)/.test(text)
          ) {
            offenders.push(path.slice(src.length + 1));
          }
        }
      };

      walk(src);

      expect(offenders).toEqual([]);
    });
  });
});
