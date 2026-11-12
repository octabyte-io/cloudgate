import { isApiError } from "@/lib/api/api-error";
import { cn } from "@/lib/utils";

/**
 * What a connection test answered: whether it worked, and in whose words —
 * plus, when the answer came from a tool, what the tool printed.
 */
export type TestOutcome = { ok: boolean; message: string; details?: string };

/**
 * The tool output a refused test carried, for `TestOutcome.details`:
 * `ApiError.output`, or nothing. The caller redacts it as it redacts the
 * sentence.
 */
export function testDetails(error: unknown): string | undefined {
  return isApiError(error) && error.output ? error.output : undefined;
}

/**
 * The answer to a "Test connection" press — green when it worked, red when it
 * did not, with the sentence after the verdict.
 *
 * One component because two forms render it: `ResourceFormModal`'s `spec.test`
 * and the Docker-image source form, which is not a `ResourceSpec` but asks a
 * registry the same question.
 *
 * **The sentence is plain; the tool's transcript is behind "Details"**.
 * A registry test used to print docker's whole stderr — a logrus line, a Go
 * memory address and the error twice — as the sentence. The backend now says
 * it in one line and sends the transcript as `output`, which is here for
 * whoever needs it and out of the way for everyone else.
 */
export function TestResult({ result }: { result: TestOutcome }) {
  return (
    <div
      role="status"
      className={cn(
        "rounded-md border px-3 py-2.5 text-meta wrap-anywhere",
        result.ok
          ? "border-ok-line bg-ok-tint text-tx"
          : "border-bad-line bg-bad-tint text-tx",
      )}
    >
      <p>
        <span className="font-medium">
          {result.ok ? "Worked." : "Did not work."}
        </span>{" "}
        {result.message}
      </p>
      {result.details ? (
        <details className="mt-1.5">
          <summary className="cursor-pointer text-tx-2">Details</summary>
          <pre className="mt-1.5 font-mono text-meta whitespace-pre-wrap text-tx-2">
            {result.details}
          </pre>
        </details>
      ) : null}
    </div>
  );
}
