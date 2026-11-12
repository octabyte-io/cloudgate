import { Icon, type IconName } from "@/lib/design/icons";

/**
 * A lifecycle button's glyph, or the spinner while its own request is in
 * flight — `SubmitButton`'s recipe, so Deploy, Restart, Start and Stop say
 * "working" the same way a form's submit does. The label never changes (a
 * button that renames itself mid-press makes the person doubt what they
 * pressed); the glyph is the progress. With no glyph of its own, the spinner
 * appears only while pending.
 *
 * Under reduced motion the spin settles (the blanket rule in `globals.css`),
 * and the button's `aria-busy` and inert styling carry the message alone.
 */
export function ActionIcon({
  name,
  pending,
  size,
}: {
  name?: IconName;
  pending: boolean;
  size: number;
}) {
  if (pending) {
    return <Icon name="refresh" size={size} className="animate-spin" />;
  }
  return name ? <Icon name={name} size={size} /> : null;
}
