import { GutterMark } from "@/components/console/gutter-mark";
import { Icon } from "@/lib/design/icons";
import { cn } from "@/lib/utils";

import type { PlanItem } from "./converted-plan";

/**
 * One planned change.
 *
 * The mark is `GutterMark`'s, which is the app's signed change column — a planned
 * rewrite of a file is exactly what that vocabulary is for, and `create`,
 * `change` and `noop` are the three of its six this can honestly claim. A refusal
 * is not a change, so it takes the alert mark instead.
 *
 * **It used to claim two, and the missing third was the defect.** The
 * mark came from `tone` alone, `add` → create and anything else → noop, so a row
 * that could not know — the two platform defaults, on a git source whose file is
 * in its repository — was drawn as `○ no-op`, a statement that nothing happens.
 * `unknown` is that row now, and `converted-plan.ts` is where a tone is decided;
 * nothing here reads the file.
 */
export function PlanRow({ item }: { item: PlanItem }) {
  return (
    <div
      className={cn(
        "flex gap-2.5 rounded-lg border px-3.5 py-3",
        item.tone === "bad"
          ? "border-bad-line bg-bad-tint"
          : item.tone === "warn"
            ? "border-warn-line bg-warn-tint"
            : "border-line bg-panel-2",
      )}
    >
      <span className="mt-0.5 flex-none">
        {item.tone === "add" ? (
          <GutterMark change="create" />
        ) : item.tone === "unknown" ? (
          <GutterMark change="change" />
        ) : item.tone === "bad" ? (
          <>
            <Icon name="alert" size={15} className="text-bad" />
            <span className="sr-only">Stops the deploy</span>
          </>
        ) : item.tone === "warn" ? (
          <>
            <Icon name="alert" size={15} className="text-warn" />
            <span className="sr-only">Warning</span>
          </>
        ) : (
          <GutterMark change="noop" />
        )}
      </span>
      <div className="min-w-0">
        <p className="text-body font-medium text-tx wrap-anywhere">
          {item.title}
        </p>
        <p className="mt-0.5 text-meta text-tx-2 wrap-anywhere">{item.detail}</p>
      </div>
    </div>
  );
}
