import { LinkButton } from "@/components/console/link-button";
import { Icon } from "@/lib/design/icons";
import { cn } from "@/lib/utils";

import type { StageState } from "./wizard-model";

/**
 * The small pieces every step of the get-started wizard draws the same way:
 * a list of stages with how far along each is, the note a member who
 * cannot take a step reads instead of it, and the "ready" line that leads
 * on. No `"use client"`: each is imported by a step that already is one.
 */

const STATE_WORD: Record<StageState, string> = {
  done: "Done",
  now: "In progress",
  todo: "Not started",
};

/**
 * Stages as a list, each with its mark and, for a screen reader, its word:
 * a tick when done, a turning mark while it runs (still under reduced
 * motion), an empty ring before it starts. The list is a live region, so
 * a stage moving on is announced without moving focus.
 */
export function StageList({
  label,
  stages,
}: {
  label: string;
  stages: { label: string; state: StageState }[];
}) {
  return (
    <ol aria-label={label} aria-live="polite" className="grid gap-2.5">
      {stages.map((stage) => (
        <li key={stage.label} className="flex items-center gap-2.5">
          <span
            aria-hidden="true"
            className={cn(
              // The ring's tint carries a stage moving on; the mark inside
              // it swaps. Colours only, so the row never shifts.
              "grid size-6 flex-none place-items-center rounded-pill border transition-colors duration-200 ease-out-strong",
              stage.state === "done" && "border-ok-line bg-ok-tint text-ok",
              stage.state === "now" &&
                "border-brand-line bg-brand-tint text-brand-tx",
              stage.state === "todo" && "border-line-2 text-tx-4",
            )}
          >
            {stage.state === "done" ? (
              <Icon name="check" size={13} />
            ) : stage.state === "now" ? (
              <Icon
                name="refresh"
                size={13}
                className="animate-spin motion-reduce:animate-none"
              />
            ) : null}
          </span>
          <span
            className={cn(
              "min-w-0 text-body wrap-anywhere",
              stage.state === "todo" ? "text-tx-3" : "text-tx",
              stage.state === "now" && "font-medium",
            )}
          >
            {stage.label}
          </span>
          <span className="sr-only">: {STATE_WORD[stage.state]}</span>
        </li>
      ))}
    </ol>
  );
}

/**
 * What a member reads where a step needs an owner or an admin: the step
 * by name and who can take it. Not a refusal tinted red: nothing failed,
 * and the way on is a person, not a setting.
 */
export function AskAdmin({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid justify-items-start gap-2 rounded-lg border border-info-line bg-info-tint p-4">
      <p className="flex items-center gap-2 text-body font-medium text-tx">
        <Icon name="users" size={15} className="text-info" />
        Ask your organization&rsquo;s owner or admin
      </p>
      <p className="text-body text-tx-2">{children}</p>
    </div>
  );
}

/** A Server that is ready, and the way on to the app's details. */
export function ServerReady({
  name,
  href,
}: {
  name: string;
  href: string;
}) {
  return (
    // Fades in where the progress card stood: the step itself already rose,
    // so this is content replaced in place, not a second entrance.
    <div className="grid animate-fade justify-items-start gap-3 rounded-lg border border-ok-line bg-ok-tint p-4">
      <p className="flex min-w-0 items-center gap-2 text-body font-medium wrap-anywhere text-tx">
        <Icon name="check" size={15} className="flex-none text-ok" />
        {/* One text node: in a flex row, a name and the words after it
            would be two items, and the space between them dropped. */}
        <span>{name} is ready.</span>
      </p>
      <LinkButton href={href} variant="pri">
        Continue
      </LinkButton>
    </div>
  );
}

/** A note beside a step: what happened on the way back from a payment page. */
export function StepNote({
  tone,
  children,
}: {
  tone: "info" | "warn";
  children: React.ReactNode;
}) {
  return (
    <p
      role="status"
      className={cn(
        "flex gap-2 rounded-lg border p-3 text-ui text-tx",
        tone === "info"
          ? "border-info-line bg-info-tint"
          : "border-warn-line bg-warn-tint",
      )}
    >
      <Icon
        name={tone === "info" ? "info" : "alert"}
        size={14}
        className={cn(
          "mt-0.5 flex-none",
          tone === "info" ? "text-info" : "text-warn",
        )}
      />
      <span className="min-w-0">{children}</span>
    </p>
  );
}
