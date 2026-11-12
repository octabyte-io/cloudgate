import { LEASE_CLOSE_CODE } from "@/lib/realtime/gateways";

/**
 * Why a log stream stopped: the gateway's own reason, and — only when it can be
 * true — the screen's guess at what to do about it.
 *
 * **The two are different kinds of sentence and used to run together.** Every log
 * view surfaced `closeReason` verbatim, which ADR-0012 §18 promises, and then
 * appended a fixed hint written when the only way a stream could be refused was
 * at connect: "a database that has never been deployed", "a container that has
 * been removed". `4010` broke that
 * — a lease ending
 * is by construction a socket that *was* streaming, so "never been deployed" is
 * the one explanation that cannot apply, and it was the half a reader acted on.
 *
 * So the hint is conditional on the close it claims to explain, and the mid-stream
 * case gets the only sentence that is true of every screen: the access this
 * stream was opened with is gone. It is one component rather than three copies
 * because all three log views need the same distinction, and a fourth would
 * otherwise be written without it.
 *
 * The reason is also its own paragraph, in primary text, with the hint quieter
 * under it — the two sentences were one run of prose, and the guess read as part
 * of the gateway's answer.
 *
 * **`hint` and `note` are two kinds of sentence and the gate is the difference.**
 * A hint is the screen's guess at what *caused* this refusal, so it can only be
 * true of one decided at connect. A note is a fact about the thing being logged
 * that holds under every close, so it is never gated. An earlier fix exempted the
 * deployment log's "the build may still be running" from the gate by name, and
 * this is what happened when the fourth view was converted and that sentence
 * went through `hint` anyway: on a `4010` it was withheld, which is the one
 * close it was written to survive. Do not collapse the two props back together.
 */
export function LogRefusal({
  reason,
  code,
  hint,
  note,
}: {
  /** The gateway's words. `closeReason`, never a sentence written here. */
  reason: string;
  /** `closeCode` — which decides whether `hint` can be true. */
  code: number | null;
  /**
   * What is usually behind a refusal *at connect* on this screen. Left off when
   * the screen has nothing useful to guess.
   */
  hint?: React.ReactNode;
  /**
   * A fact about the thing being logged, true of *every* close — so it is not
   * gated. `hint` is the screen's guess at the cause and can only be true of a
   * refusal decided at connect; this is the sentence a reader needs whichever
   * kind of close they got. The deployment log's "the build may
   * still be running" was exempted from the gate for exactly this reason, and
   * was lost when it went through `hint` instead. Do not collapse the two.
   */
  note?: React.ReactNode;
}) {
  const midStream = code === LEASE_CLOSE_CODE;

  return (
    <div className="grid gap-2 rounded-lg border border-warn-line bg-warn-tint px-3 py-2.5 text-meta">
      <p className="text-tx">{reason}</p>
      {midStream ? (
        <p className="text-tx-2">
          This stream was authorized when it opened and is not any more — either
          that access was withdrawn, or the check that renews it could not run for
          two minutes. A new connection is authorized from scratch.
        </p>
      ) : hint ? (
        <p className="text-tx-2">{hint}</p>
      ) : null}
      {note ? <p className="text-tx-2">{note}</p> : null}
    </div>
  );
}
