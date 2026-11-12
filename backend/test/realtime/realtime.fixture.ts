import { EventEmitter } from 'node:events';
import { Logger } from '@nestjs/common';
import type { StreamChannel } from '../../src/realtime/channels/stream-channel';

/**
 * What the realtime specs share.
 *
 * Three specs in this directory drive the same six gateways, and had each grown
 * their own copy of the socket plumbing — two spellings of the poll helper in
 * one file, `cookieHeader` in all three. §1.4 asks whether it needed to be new;
 * for these it did not, and §1.7 puts the fixture beside the feature.
 *
 * The socket *doubles* stay in the specs that use them: `FakeWs` differs between
 * a gateway that only ever closes and one that bridges input both ways, and
 * collapsing those would hide the difference rather than share it.
 */

/** Collapses supertest's set-cookie array into a request cookie header. */
export function cookieHeader(setCookie: string | string[]): string {
  const entries = Array.isArray(setCookie) ? setCookie : [setCookie];
  return entries.map((entry) => entry.split(';')[0]).join('; ');
}

/** The permission context a caller acts in, as the services take it. */
export const permissionCtx = (userId: string, organizationId: string) => ({
  user: { id: userId },
  session: { activeOrganizationId: organizationId },
});

/**
 * Poll until a condition holds, or fail saying it never did.
 *
 * For anything driven by a gateway's own interval, or by a `handleConnection`
 * that keeps working after the upgrade resolves. A fixed `setTimeout` just over
 * the interval reads as equivalent and is not: it makes the test a race against
 * the machine, which is how a suite that passes alone fails in a full run.
 */
export async function waitFor(
  condition: () => boolean,
  { timeoutMs = 10_000, everyMs = 25 } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`waitFor: condition still false after ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }
}

/** A StreamChannel double the mocked channel services hand back. */
export class FakeChannel implements StreamChannel {
  write = jest.fn();
  resize = jest.fn<void, [number, number]>();
  close = jest.fn();
  private readonly emitter = new EventEmitter();

  onData(listener: (chunk: string) => void) {
    this.emitter.on('data', listener);
  }
  onStderr(listener: (chunk: string) => void) {
    this.emitter.on('stderr', listener);
  }
  onClose(listener: (code?: number) => void) {
    this.emitter.on('close', listener);
  }
  onError(listener: (err: Error) => void) {
    this.emitter.on('error', listener);
  }

  emitData(chunk: string) {
    this.emitter.emit('data', chunk);
  }
  emitStderr(chunk: string) {
    this.emitter.emit('stderr', chunk);
  }
  emitClose(code?: number) {
    this.emitter.emit('close', code);
  }
  emitError(err: Error) {
    this.emitter.emit('error', err);
  }
}

let journalSpy: jest.SpyInstance | null = null;

/**
 * The refusal lines an operator would see, captured from the call on.
 *
 * For the tests that assert a socket recorded what its close frame deliberately
 * does not say: denial and unknown id are byte-identical on the wire by design
 * (ADR-0008), so the journal is the only place the difference survives, and a
 * line that quietly stopped naming the caller or the subject would leave an
 * operator unable to tell a broken client from someone walking another
 * organization's id space.
 *
 * Restoration is this fixture's `afterEach`, not the caller's job: a
 * `mockRestore()` written after the assertions never runs when one of them
 * fails, and a live `Logger.prototype` spy then leaks into every test that
 * follows — so the first real failure would be followed by a cascade of
 * unrelated ones. Installed on call rather than in a `beforeEach` because
 * callers assert exact line counts, and a spy armed before the setup would
 * count refusals the test did not cause.
 *
 * Shared because two specs in this directory needed it and had grown separate
 * idioms for one job (§1.4).
 */
export function captureJournal(): () => string[] {
  journalSpy = jest.spyOn(Logger.prototype, 'warn');
  return () =>
    (journalSpy?.mock.calls ?? [])
      .map(([message]) => String(message))
      .filter((message) => message.startsWith('Refused socket'));
}

afterEach(() => {
  journalSpy?.mockRestore();
  journalSpy = null;
});
