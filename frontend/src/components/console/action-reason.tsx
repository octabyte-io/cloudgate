/**
 * Why the controls beside it are off, on its own line under them.
 *
 * F03's rule says an off control carries its reason as `title` and through
 * `aria-describedby` at **the sentence on screen**; this is that sentence, for
 * an action row — a `PageHeader`'s or a `Card.Header`'s `actions`, which are
 * a wrapping flex row of buttons. Pass the `id` the buttons describe by.
 *
 * It used to be a bare `<span>` among the buttons, and two things went wrong
 * with that, both on a never-deployed Compose stack's header:
 *
 * - **It took a line of the row's width.** `PageHeader` sizes its actions to
 *   their max-content and does not let them shrink, and a 100-character
 *   sentence's max-content is the sentence on one line — so the row grew past
 *   the header and Remove containers ran off the right edge of the page.
 *   `contain-inline-size` takes the text out of the width the row asks for
 *   (the way `CodeWell` keeps its longest line out of a Modal's); the buttons
 *   alone decide it, and the sentence wraps to whatever they leave.
 * - **It sat between two buttons.** `w-full` gives it a line to itself — a
 *   flex item's `auto` basis is its width, which also survives `PageHeader`'s
 *   narrow `*:flex-[1_1_auto]` — so callers put it **last**, after every
 *   button, and the row stays one run of controls with its explanation under it.
 *
 * Muted meta text, like a field's hint: it is the answer to "why is this
 * grey", read when someone asks, not a warning.
 */
export function ActionReason({
  id,
  children,
}: {
  /** What the off controls' `aria-describedby` points at. */
  id?: string;
  children: React.ReactNode;
}) {
  return (
    <p id={id} className="w-full text-meta text-tx-3 contain-inline-size">
      {children}
    </p>
  );
}
