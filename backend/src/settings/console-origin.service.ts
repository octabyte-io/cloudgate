import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isOriginTrustedNow } from '../auth/auth.config';
import type { Auth } from '../auth/auth.config';
import { AUTH } from '../auth/auth.constants';
import type { Env } from '../common/config/env.schema';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';

/**
 * The console domain as a browser signing in on it sees it, and whether the
 * backend will let that browser in.
 */
export interface ConsoleOriginTrust {
  /** What a browser on the console domain sends in `Origin`. */
  origin: string;
  /**
   * Whether better-auth accepts a request from {@link origin} right now —
   * `BETTER_AUTH_URL`'s own origin, `TRUSTED_ORIGINS`, or an owner's runtime
   * allowlist (the Trusted origins card). `false` means every sign-in on the
   * console domain is refused `403 INVALID_ORIGIN`.
   */
  trusted: boolean;
}

/**
 * The origin a browser on the console domain sends.
 *
 * No port, and that is the install's contract rather than a guess: the routers
 * `createWebServerConfig` writes sit on Traefik's `web` and `websecure`
 * entrypoints, which `deploy/install.sh` publishes on 80 and 443 — the default
 * ports, which an origin omits. `new URL` is what lower-cases the host, the way
 * the browser does before better-auth compares it.
 */
export function consoleOriginOf(host: string, https: boolean): string {
  return new URL(`${https ? 'https' : 'http'}://${host}`).origin;
}

/**
 * Answers whether the console domain's origin is trusted, for the settings row
 * the Console domain and Console routing cards render.
 *
 * **Why the save warns rather than trusting the origin itself.** Adding the
 * console domain to the allowlist on save would make sign-in work there — and
 * `deploy/install.sh` leaves `TRUSTED_ORIGINS` empty for exactly that reason:
 * a second trusted origin signs an operator in on an address whose
 * build-time `NEXT_PUBLIC_API_URL` points elsewhere, so every live screen is
 * dead and nothing says why (`docs/deploy.md` §3). Whether the operator has
 * rebuilt the console for the new hostname is not something this process can
 * see, so the decision stays theirs and this is what lets the console say it.
 *
 * Its own injectable rather than a `SettingsService` method because it is the
 * one thing on the settings row that has to reach into auth; everything else
 * there is the row.
 */
@Injectable()
export class ConsoleOriginService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    @Inject(AUTH) private readonly auth: Auth,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /** `null` when no console domain is set — there is nothing to sign in on. */
  async trustOf(row: {
    host: string | null;
    https: boolean;
  }): Promise<ConsoleOriginTrust | null> {
    if (!row.host) return null;
    const origin = consoleOriginOf(row.host, row.https);
    // The same two keys `AuthModule` hands `createAuth`, read from the same
    // validated snapshot, so the list asked here is the list the gate uses.
    const trusted = await isOriginTrustedNow(
      this.auth,
      this.db,
      {
        baseURL: this.config.get('BETTER_AUTH_URL', { infer: true }),
        trustedOrigins: this.config.get('TRUSTED_ORIGINS', { infer: true }),
      },
      origin,
    );
    return { origin, trusted };
  }
}
