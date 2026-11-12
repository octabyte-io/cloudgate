import { CopyButton } from "@/components/console/copy-button";
import type { Plan } from "@/lib/api/endpoints/project-config";
import { Icon } from "@/lib/design/icons";

import { noStateLines } from "./plan-aws";
import { PlanSection } from "./plan-section";

/**
 * A Plan's Notes: what changes nothing — the planner's notes, a line to
 * copy where one has it, and what a tag search found that no state wants
 * which Cloudgate never removes.
 */
export function NotesSection({ plan }: { plan: Plan }) {
  const strays = noStateLines(plan);
  if (plan.notes.length === 0 && strays.length === 0) return null;
  return (
    <PlanSection title="Notes">
      {strays.map((line) => (
        <p
          key={line}
          className="flex items-start gap-2 text-body wrap-anywhere text-tx-2"
        >
          <Icon name="info" className="mt-0.5 flex-none text-tx-3" />
          <span>{line}. Cloudgate never removes it; remove it by hand.</span>
        </p>
      ))}
      {plan.notes.map((note) => (
        <div
          key={`${note.kind}-${note.configName}-${"variable" in note ? note.variable : ""}-${"at" in note ? note.at : ""}`}
          className="grid gap-1.5"
        >
          <p className="flex items-start gap-2 text-body text-tx-2">
            <Icon name="info" className="mt-0.5 flex-none text-tx-3" />
            <span>{note.message}</span>
          </p>
          {"line" in note ? (
            <div className="ml-6 flex items-start gap-2">
              <pre className="min-w-0 flex-1 overflow-x-auto rounded-md border border-line bg-panel-2 px-2.5 py-1.5 font-mono text-meta text-tx-2">
                {note.line}
              </pre>
              <CopyButton value={note.line} label="line" />
            </div>
          ) : null}
        </div>
      ))}
    </PlanSection>
  );
}
