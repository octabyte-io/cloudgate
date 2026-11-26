import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ApiError } from "@/lib/api/api-error";

import { TarballPicker } from "./tarball-picker";

afterEach(cleanup);

/**
 * A capped message with the shape `capFailureMessage` gives one, built here
 * rather than read back out of `errorMessage()` so the expectation comes from
 * somewhere other than the code under test (§1.7). It is already capitalised
 * and its last line already ends in a colon, so `asSentence()` neither
 * capitalises nor appends over it: what the picker renders is exactly `CAPPED`.
 *
 * The two lone surrogates are where a real cap leaves them — one either side of
 * the marker, because the cap steps back off the pair it would otherwise split.
 * They are the reason nothing below re-cuts this string on code units.
 */
const WHALES = "🐳".repeat(1000);
const MARKER = "… 15910 characters elided …";
const HEAD = `Failed to lsjson: error in ListJSON: SignatureDoesNotMatch: ${WHALES}\ud83d`;
const TAIL = `\udc33${WHALES}\n\tstatus code: 403, request id: , host id:`;
const CAPPED = `${HEAD}\n${MARKER}\n${TAIL}`;

/** One sentence, which is what a refusal here almost always is. */
const SHORT = "Bucket 'w05-bucket' does not exist on this endpoint.";

function refuse(message: string) {
  render(
    <TarballPicker
      objects={undefined}
      pending={false}
      error={new ApiError(400, message)}
      waiting={false}
      fetching={false}
      prefix=""
      onPrefixChange={() => {}}
      bucket="w05-bucket"
      value=""
      onChoose={() => {}}
      onRefresh={() => {}}
    />,
  );
}

function halves() {
  return Array.from(
    document.querySelectorAll<HTMLElement>("[data-slot='refusal-half']"),
  );
}

describe("TarballPicker", () => {
  it("renders a one-sentence refusal as one sentence", () => {
    refuse(SHORT);

    expect(screen.getByText(SHORT)).toBeTruthy();
    expect(halves()).toHaveLength(0);
  });

  /**
   * The listing fails while the reader is looking at the destination picker two
   * fields above it, so the slot going quiet is the whole of the defect —
   * `FormError` announces the refusal it holds and this holds the same kind of
   * refusal. Both shapes, because a capped message takes the other branch.
   */
  it("announces a refusal rather than only drawing it", () => {
    refuse(SHORT);

    expect(screen.getByRole("alert").textContent).toBe(SHORT);
  });

  it("announces a capped refusal too, on the element that holds it", () => {
    refuse(CAPPED);

    const alert = screen.getByRole("alert");
    expect(alert.querySelectorAll("[data-slot='refusal-half']")).toHaveLength(2);
  });

  /**
   * X11-2's measurement: 8 192 units in one `<p>`, 2 192 px of content in a
   * 256 px window. Two bounded boxes is what stops the listing being pushed off
   * the screen by somebody else's S3 endpoint.
   */
  it("bounds a capped refusal in two scroll regions instead of one paragraph", () => {
    refuse(CAPPED);

    const parts = halves();
    expect(parts).toHaveLength(2);
    for (const part of parts) {
      expect(part.className).toContain("max-h-20");
      expect(part.className).toContain("overflow-y-auto");
      // A region that scrolls and cannot be focused is a region whose second
      // half nobody reads.
      expect(part.tabIndex).toBe(0);
    }
  });

  /**
   * The marker was ~1 090 px below the fold, which is the whole of the finding:
   * a reader could not tell the message had been cut. It is its own line here,
   * between the two halves, so it cannot be scrolled past.
   */
  it("puts the cap's own elision marker on a line of its own", () => {
    refuse(CAPPED);

    // Exactly the marker and nothing else — before the fix the only element
    // whose text held it also held all 8 192 units around it.
    expect(screen.getByText(MARKER).textContent).toBe(MARKER);
  });

  /** Each half opens on the end that carries its information. */
  it("opens the head half at the top and the tail half at its summary line", () => {
    refuse(CAPPED);

    const [head, tail] = halves();
    expect(head.textContent?.startsWith("Failed to lsjson:")).toBe(true);
    // No full stop after the colon: `asSentence()` only adds one to a message
    // that ends in a letter or a digit.
    expect(
      tail.textContent?.endsWith("status code: 403, request id: , host id:"),
    ).toBe(true);
    // jsdom lays nothing out, so `scrollHeight` is 0 and the tail's write is a
    // no-op here; that it opens at zero and the other is never written is what
    // this can honestly say. The browser measurement is X11-2's own.
    expect(head.scrollTop).toBe(0);
  });

  /**
   * The control X11-2 came with, kept as an assertion: the cap is sound on the
   * wire and this must not be the thing that breaks it. Nothing sanitises the
   * message, so both lone surrogates are still in the DOM and no U+FFFD is.
   */
  it("holds every code unit the backend sent, lone surrogates included", () => {
    refuse(CAPPED);

    const [head, tail] = halves();
    const rebuilt = `${head.textContent}\n${MARKER}\n${tail.textContent}`;
    expect(rebuilt).toBe(CAPPED);
    expect(rebuilt).toContain("\ud83d");
    expect(rebuilt).toContain("\udc33");
    expect(rebuilt).not.toContain("�");
  });

  /**
   * A long message the backend did *not* cap carries no marker to split on, and
   * is bounded rather than dropped: there is no second end to point at, so it
   * gets the one box.
   */
  it("bounds a long refusal that carries no marker in a single region", () => {
    refuse(`Failed to lsjson: ${WHALES}.`);

    expect(halves()).toHaveLength(1);
    expect(screen.queryByText(MARKER)).toBeNull();
  });
});
