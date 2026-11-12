import { Field } from "@/components/console/field";
import { Input } from "@/components/ui/input";

/**
 * A step Apply confirms by typing a name: a destroy, an
 * Environment network's removal, or a major upgrade. The field is the one
 * Delete asks for, so a confirmation reads the same wherever it is asked.
 */
export function ConfirmByName({
  confirmKey,
  word,
  value,
  matches,
  mismatch = "That does not match the Service's name.",
  onChange,
}: {
  /** What the confirmation is keyed and sent by. */
  confirmKey: string;
  /** What the operator types. */
  word: string;
  value: string;
  matches: boolean;
  mismatch?: string;
  onChange: (value: string) => void;
}) {
  return (
    <Field
      name={`confirm-${confirmKey}`}
      label={`Type ${word} to confirm`}
      error={value !== "" && !matches ? mismatch : undefined}
    >
      <Input
        value={value}
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  );
}
