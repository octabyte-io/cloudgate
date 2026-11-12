import {
  CLOSE_REASON_BYTE_LIMIT,
  closeFrameReason,
  REAPED_LOG_CLOSE_CODE,
  reapedLogCloseReason,
} from '../../src/realtime/socket-access';
import {
  DEPLOYMENT_LOG_RETENTION_DAYS,
  reapedLogNotice,
} from '../../src/deployments/log-retention';

/**
 * ADR-0020 gave `GET /deployments/:id/logs` a sentence naming the
 * retention window when a log is past it; `/listen-deployment` follows the same
 * `logPath` (ADR-0007) and streamed **nothing at all** for the same Deployment,
 * so the two readers of one artifact disagreed about whether its absence was
 * explicable.
 *
 * What this file pins is the *framing*, which is the half that had to be
 * decided rather than written:
 *
 * - **The notice is a close, not a frame.** The console appends every string
 *   frame this socket sends into the log well, so a notice delivered as a frame
 *   would render as though the build had printed it — and it would be
 *   indistinguishable from a line the build really did print, because a build's
 *   stdout may be any bytes at all (the reason `terminal-protocol.ts` refuses an
 *   envelope in the server→browser direction). A 4xxx close reason lands on a
 *   different surface entirely (`LogRefusal`) and stops the console redialling.
 * - **The sentence is `reapedLogNotice`'s, elided to fit a close frame rather
 *   than rewritten.** That elision exists because of a measurement this file
 *   holds: the notice is longer than the 123 bytes a close frame's reason can
 *   carry, so verbatim reuse is not available, and a second hand-written
 *   sentence beside the code is what `UNREACHABLE_CLOSE_CODE`'s docblock
 *   already argues against.
 */

describe('reapedLogCloseReason', () => {
  it('is the retention notice, elided at a word boundary to fit a close frame', () => {
    const reason = reapedLogCloseReason();

    // Derived from the one sentence, not a second copy of it: every byte of the
    // reason is a byte of the notice, in order, from the start.
    expect(reapedLogNotice().startsWith(reason.replace(/…$/, ''))).toBe(true);
    expect(reason.endsWith('…')).toBe(true);
    expect(reason).not.toMatch(/\s…$/);
  });

  it('names the window, which is the half of the sentence an operator cannot look up', () => {
    expect(reapedLogCloseReason()).toContain(
      `${DEPLOYMENT_LOG_RETENTION_DAYS} days`,
    );
  });

  it('fits the reason a close frame carries', () => {
    expect(
      Buffer.byteLength(reapedLogCloseReason(), 'utf8'),
    ).toBeLessThanOrEqual(CLOSE_REASON_BYTE_LIMIT);
  });

  /**
   * The measurement that forecloses the obvious implementation. `ws` throws
   * `RangeError: The message must not be greater than 123 bytes` rather than
   * truncating, so `ws.close(code, reapedLogNotice())` would raise inside
   * `handleConnection` and the caller would get the bare close an
   * unauthenticated caller gets — the gateway saying *less* than it did before.
   */
  it('is needed at all because the notice does not fit one', () => {
    expect(Buffer.byteLength(reapedLogNotice(), 'utf8')).toBeGreaterThan(
      CLOSE_REASON_BYTE_LIMIT,
    );
  });

  it('sits in the band that is not a judgement of the request', () => {
    // 4013, after 4010 (lease), 4011 (`STATS_CLOSE.workloadGone`) and 4012
    // (unreachable host). Not `400x`: the caller asked a well-formed question
    // about a Deployment they are entitled to, and got a true answer.
    expect(REAPED_LOG_CLOSE_CODE).toBe(4013);
  });
});

describe('closeFrameReason', () => {
  it('leaves a sentence that already fits exactly as it was', () => {
    expect(closeFrameReason('Not found or not permitted')).toBe(
      'Not found or not permitted',
    );
  });

  it('drops a trailing newline, because a reason is a sentence and not a line', () => {
    expect(closeFrameReason('No running container to sample\n')).toBe(
      'No running container to sample',
    );
  });

  it('elides on a word boundary rather than mid-word', () => {
    const long = `${'word '.repeat(40)}end`;
    const reason = closeFrameReason(long);

    expect(Buffer.byteLength(reason, 'utf8')).toBeLessThanOrEqual(
      CLOSE_REASON_BYTE_LIMIT,
    );
    expect(reason).toMatch(/word…$/);
  });

  it('counts bytes rather than characters', () => {
    // A close frame's limit is on the payload, so a reason of multi-byte
    // characters fits fewer of them. Counting `length` would overrun it and
    // `ws` would throw — the failure this whole helper exists to avoid.
    const wide = 'é'.repeat(200);
    const reason = closeFrameReason(wide);

    expect(Buffer.byteLength(reason, 'utf8')).toBeLessThanOrEqual(
      CLOSE_REASON_BYTE_LIMIT,
    );
    expect(reason.length).toBeLessThan(CLOSE_REASON_BYTE_LIMIT);
  });

  it('elides a word too long to break at all', () => {
    // No space to break on: the reason still has to fit, so the cut is where
    // the budget runs out.
    const reason = closeFrameReason('x'.repeat(300));

    expect(Buffer.byteLength(reason, 'utf8')).toBeLessThanOrEqual(
      CLOSE_REASON_BYTE_LIMIT,
    );
    expect(reason.endsWith('…')).toBe(true);
  });
});
