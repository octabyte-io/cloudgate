/**
 * There is no value here.
 *
 * The dash is a **mark**, so it ships its word. `--tx-4` is decoration-only and
 * an em dash on its own tells a screen reader nothing at all — "None" is what the
 * cell means, and it is what the cell says. Same rule as every status glyph in
 * `status.ts`: meaning never rests on a glyph alone.
 *
 * The word is the caller's, because "no value" is not one sentence: a column of
 * domains says "None", a "last deployed" column says "Never", and a figure whose
 * request was refused says "Unknown".
 */
export function Dash({ word = "None" }: { word?: string }) {
  return (
    <>
      <span aria-hidden="true" className="font-sans text-tx-4">
        —
      </span>
      <span className="sr-only">{word}</span>
    </>
  );
}
