import { Icon } from "@/lib/design/icons";
import { cn } from "@/lib/utils";

const TONE = {
  warn: {
    box: "border-warn-line bg-warn-tint",
    mark: "text-warn",
    word: "Warning",
  },
  bad: { box: "border-bad-line bg-bad-tint", mark: "text-bad", word: "Danger" },
} as const;

/**
 * One warning beside the choice it is about, in `ServerAllowanceNotice`'s
 * shape. The tone's word is in an `sr-only` span, so the hue never carries
 * the meaning alone.
 */
export function BuyNote({
  tone,
  className,
  children,
}: {
  tone: keyof typeof TONE;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex gap-2 rounded-lg border p-2.5",
        TONE[tone].box,
        className,
      )}
    >
      <Icon
        name="alert"
        size={14}
        className={cn("mt-0.5 flex-none", TONE[tone].mark)}
      />
      <p className="min-w-0 text-ui text-tx">
        <span className="sr-only">{TONE[tone].word}: </span>
        {children}
      </p>
    </div>
  );
}
