import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { CAPTCHA_RESPONSE_HEADER } from '../../src/auth/turnstile';

/** The widget token {@link FakeTurnstile} accepts; any other is refused. */
export const TURNSTILE_PASSING_TOKEN = 'turnstile-passing-token';

/**
 * The header a Hosted public sign-up carries, as the console's widget sets it
 * `.set(PASSING_TURNSTILE)` on a supertest request.
 */
export const PASSING_TURNSTILE = {
  [CAPTCHA_RESPONSE_HEADER]: TURNSTILE_PASSING_TOKEN,
};

/** One siteverify call, as Cloudflare would have received it. */
export interface TurnstileVerification {
  secret: string;
  response: string;
  remoteip?: string;
}

/**
 * Cloudflare's Turnstile siteverify, answered on localhost: better-
 * auth's captcha plugin runs unchanged and posts here instead of to
 * Cloudflare (`TURNSTILE_SITEVERIFY_URL`, which `createTestApp` points at one
 * of these for every suite). It says `success` for
 * {@link TURNSTILE_PASSING_TOKEN} only, the way Cloudflare refuses a token it
 * did not issue.
 */
export class FakeTurnstile {
  readonly verifications: TurnstileVerification[] = [];
  private readonly server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      const call = JSON.parse(body || '{}') as TurnstileVerification;
      this.verifications.push(call);
      const success = call.response === TURNSTILE_PASSING_TOKEN;
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify(
          success
            ? { success, hostname: 'cloudgate.test' }
            : { success, 'error-codes': ['invalid-input-response'] },
        ),
      );
    });
  });
  private address = '';

  /** A fake listening on a free localhost port. */
  static async start(): Promise<FakeTurnstile> {
    const fake = new FakeTurnstile();
    await new Promise<void>((resolve) =>
      fake.server.listen(0, '127.0.0.1', resolve),
    );
    const { port } = fake.server.address() as AddressInfo;
    fake.address = `http://127.0.0.1:${port}/siteverify`;
    return fake;
  }

  /** What `TURNSTILE_SITEVERIFY_URL` is set to. */
  get url(): string {
    return this.address;
  }

  clear(): void {
    this.verifications.length = 0;
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}
