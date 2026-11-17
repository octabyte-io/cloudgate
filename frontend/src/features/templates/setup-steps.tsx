import { Card } from "@/components/console/card";
import { cn } from "@/lib/utils";

const STEPS = [
  {
    title: "Set up",
    body: "Choose where it goes and fill in its values. Every value is made once and kept encrypted.",
  },
  {
    title: "Review the Plan",
    body: "The Project's Config tab lists what it creates, each value and its Domain.",
  },
  {
    title: "Apply",
    body: "Creates the Compose stack and starts its first Deployment.",
  },
] as const;

/**
 * The setup screen's aside: the three steps from here to a running app, with
 * this one marked.
 *
 * Numbered because they are a sequence, and the one thing a first-time reader
 * cannot know from the form alone is that Set up runs nothing: it ends on a
 * Plan, and only Apply deploys. The form's own subtitle used to carry that in
 * one dense sentence. A template deploy page elsewhere (Railway, Coolify)
 * shows the same path as a sidebar beside the configuration, which is where
 * it is read: next to the button that starts it.
 */
export function SetupSteps() {
  return (
    <Card>
      <Card.Header title="From here to a running app" />
      <Card.Body>
        <ol className="grid gap-3.5">
          {STEPS.map((step, at) => (
            <li key={step.title} className="grid grid-cols-[auto_1fr] gap-3">
              <span
                aria-hidden="true"
                className={cn(
                  "grid size-6 place-items-center rounded-pill border text-chip num",
                  at === 0
                    ? "border-brand bg-brand text-primary-foreground"
                    : "border-line-2 bg-panel text-tx-2",
                )}
              >
                {at + 1}
              </span>
              <span className="grid gap-0.5">
                <span
                  className={cn(
                    "text-body font-medium",
                    at === 0 ? "text-tx" : "text-tx-2",
                  )}
                >
                  {step.title}
                  {at === 0 ? (
                    <span className="sr-only"> (this step)</span>
                  ) : null}
                </span>
                <span className="text-meta text-tx-3">{step.body}</span>
              </span>
            </li>
          ))}
        </ol>
      </Card.Body>
    </Card>
  );
}
