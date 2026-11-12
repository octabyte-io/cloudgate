const MASK = "••••••••••••";

/**
 * A credential, hidden until asked for.
 *
 * F08's rule and for the same reason: the reveal is one control for the whole card
 * rather than one per row — three reveals to read one connection string is not
 * privacy, it is friction — and the mask carries **its own word for a screen
 * reader** rather than twelve bullet characters.
 */
export function SecretValue({
  value,
  revealed,
}: {
  value: string;
  revealed: boolean;
}) {
  // The value replaces the mask in place, so it fades rather than snapping —
  // a cue that the press changed this row, not that the row moved.
  if (revealed) return <span className="animate-fade">{value}</span>;
  return (
    <span className="animate-fade">
      <span aria-hidden="true" className="text-tx-3 tracking-widest">
        {MASK}
      </span>
      <span className="sr-only">Hidden. Choose Show secrets to read it.</span>
    </span>
  );
}
