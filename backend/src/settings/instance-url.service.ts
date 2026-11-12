import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../common/config/env.schema';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import { DEFAULT_CONSOLE_PORT } from '../traefik/config/web-server';

/**
 * The URL an operator reaches this instance's **console** at — https?://host
 * when a console domain is assigned, else http://serverIp:<console port>.
 * Lives outside SettingsService so the notifications module can build console
 * links without importing SettingsModule (which itself depends on
 * NotificationsModule for the docker-cleanup dispatch). Returns null while
 * neither host nor serverIp is configured — callers (e.g. deployment
 * buildLink) omit their links rather than build "http://null:3000".
 *
 * **It is the console's port, not this process's.** This used to end
 * `:${PORT}`, and `PORT` is the API's own listener (4000 by default), so every
 * deploy notification on a default install carried a link to the backend —
 * where the path resolves to nothing and the operator is handed the API's raw
 * 404 JSON. Nothing about that was recoverable by hand, because the *path* was
 * wrong too; `DeploymentNotifierAdapter.buildLink` owns that half. The host was
 * never the problem: `serverIp` is the address operators and browsers reach
 * this instance on, which is exactly what a link mailed to a person needs, and
 * it is the one thing `resolveConsoleUpstream` deliberately does *not* use —
 * that function answers for Traefik, from inside its container, and falls back
 * to `127.0.0.1`. So this resolves the port only, and does not call it.
 */
@Injectable()
export class InstanceUrlService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async getInstanceUrl(): Promise<string | null> {
    const settings = await this.db.query.webServerSettings.findFirst({
      orderBy: (row, { asc }) => [asc(row.createdAt)],
    });

    if (settings?.host) {
      const protocol = settings.https ? 'https' : 'http';
      return `${protocol}://${settings.host}`;
    }
    if (settings?.serverIp) {
      return `http://${settings.serverIp}:${this.consolePort()}`;
    }
    return null;
  }

  /**
   * The port the console listens on, from what the install already puts in
   * this process's environment.
   *
   * **`BETTER_AUTH_URL` is the branch that carries a real install**, not a
   * fallback for an exotic one. `deploy/install.sh` takes `CONSOLE_PORT` as an
   * input and writes `BETTER_AUTH_URL=http://<public host>:<console port>`
   * into the backend's env file — but it never writes `CONSOLE_PORT` there, as
   * `env.schema.ts` says beside the declaration. So an operator who moved the
   * console off 3000 is answered by the origin, and the explicit
   * `CONSOLE_PORT` is honoured first for anyone who does set it.
   *
   * A `BETTER_AUTH_URL` with no explicit port means the console answers on its
   * scheme's default behind a hostname, which is the shape that has a console
   * domain — so `getInstanceUrl` never reaches here for it, and guessing 80 or
   * 443 against a bare `serverIp` would be a worse answer than the documented
   * default.
   */
  private consolePort(): number {
    // Already a positive integer or undefined: `env.schema.ts` coerces and
    // bounds it, so there is nothing left here to re-check (§2.4).
    const configured = this.config.get('CONSOLE_PORT', { infer: true });
    if (configured) return configured;

    const declared = Number(portOf(this.config.get('BETTER_AUTH_URL')));
    if (Number.isInteger(declared) && declared > 0) return declared;

    return DEFAULT_CONSOLE_PORT;
  }
}

/**
 * The explicit port in an origin, or `''` for one that names none.
 *
 * A second copy of `web-server.ts`'s own `parseUrl`, which is a local const
 * there; six lines rather than a cross-module export that would make a pure
 * config generator answer for this file's needs. `new URL` throws on a value
 * `z.url()` would have refused at boot, and a notification is not where that
 * should surface.
 */
function portOf(origin: string | undefined | null): string {
  if (!origin) return '';
  try {
    return new URL(origin).port;
  } catch {
    return '';
  }
}
