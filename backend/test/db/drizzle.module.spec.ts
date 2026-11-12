import { EventEmitter } from 'node:events';
import { Logger } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { DRIZZLE, DrizzleModule } from '../../src/db/drizzle.module';
import type { DrizzleDB } from '../../src/db/drizzle.module';

/**
 * `new Pool` does not dial, so this needs no database: the module can be
 * compiled against a `DATABASE_URL` that points nowhere and the pool is still
 * the real `BoundPool`, with the real `EventEmitter` semantics that are the
 * whole subject.
 */
describe('DrizzleModule', () => {
  let moduleRef: TestingModule;
  let db: DrizzleDB;
  let logged: jest.SpyInstance;
  /** What the module's `Logger` was handed, so nothing reads `mock.calls`. */
  const logLines: string[] = [];

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [
            () => ({
              DATABASE_URL: 'postgres://nobody@127.0.0.1:1/nowhere',
            }),
          ],
        }),
        DrizzleModule,
      ],
    }).compile();

    db = moduleRef.get<DrizzleDB>(DRIZZLE);
  });

  afterAll(async () => {
    await db.$client.end();
    await moduleRef.close();
  });

  beforeEach(() => {
    logLines.length = 0;
    logged = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation((message: unknown) => {
        logLines.push(String(message));
      });
  });

  afterEach(() => {
    logged.mockRestore();
  });

  it('subscribes to the pool error event', () => {
    expect(db.$client.listenerCount('error')).toBeGreaterThan(0);
  });

  it('an EventEmitter with no error listener throws on emit', () => {
    // The independent source for why the listener above is load-bearing: this
    // is exactly what the pool did before the fix, and an uncaught throw out of
    // the event loop is what terminated the process.
    const unlistened = new EventEmitter();
    expect(() =>
      unlistened.emit(
        'error',
        new Error('terminating connection due to administrator command'),
      ),
    ).toThrow('terminating connection due to administrator command');
  });

  it('survives an idle client error and logs it', () => {
    expect(() =>
      db.$client.emit(
        'error',
        new Error('terminating connection due to administrator command'),
      ),
    ).not.toThrow();

    expect(logged).toHaveBeenCalledTimes(1);
    expect(logLines[0]).toContain(
      'terminating connection due to administrator command',
    );
    // Nothing was thrown, nothing exited: the pool is still the pool.
    expect(db.$client.ended).toBe(false);
  });

  it('logs an error that is not an Error instance', () => {
    // The handler guards by shape, not `instanceof Error`: the real error is
    // constructed in Node's own realm and fails `instanceof` against jest's
    // sandboxed `Error` global, the trap `remote-exec.service.ts` documents.
    const foreign = { message: 'connection terminated unexpectedly' };
    expect(() => db.$client.emit('error', foreign)).not.toThrow();

    expect(logged).toHaveBeenCalledTimes(1);
    expect(logLines[0]).toContain('connection terminated unexpectedly');
  });

  it('fails a checkout rather than hanging when Postgres is away', () => {
    expect(db.$client.options.connectionTimeoutMillis).toBe(10_000);
  });
});
