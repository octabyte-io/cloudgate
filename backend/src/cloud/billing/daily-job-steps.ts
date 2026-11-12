import { Injectable, Logger } from '@nestjs/common';

/** One step a feature outside billing adds to the daily job. */
export interface DailyJobStep {
  /** Named in the log when it fails. */
  name: string;
  run(now: Date): Promise<void>;
}

/**
 * The steps the daily lapse job (`LapseClockService`) takes for features
 * outside billing, after its own: a **Bought Server**'s reprice starts on
 * its date there (ADR-0071, #1400). A registry rather than an import, for
 * `PurchasePayments`' reason: the Bought Servers module already depends on
 * billing, and billing depending back on it would close a cycle. Each step
 * registers itself at start.
 *
 * A step that throws is logged and never stops the next, nor the job's own
 * steps, which have run by then. Each must be safe to run again the next day
 * after failing halfway.
 */
@Injectable()
export class DailyJobSteps {
  private readonly logger = new Logger(DailyJobSteps.name);
  private readonly steps: DailyJobStep[] = [];

  add(step: DailyJobStep): void {
    this.steps.push(step);
  }

  async run(now: Date): Promise<void> {
    for (const step of this.steps) {
      try {
        await step.run(now);
      } catch (error) {
        this.logger.error(
          `The daily step ${step.name} failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }
}
