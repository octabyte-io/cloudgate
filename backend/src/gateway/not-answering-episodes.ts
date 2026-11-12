import { Logger } from '@nestjs/common';
import type { AiUsageOutcome } from './ai-usage.schema';

/**
 * "AI model not answering" (spec stories 97-98): an operator
 * hears **once per episode** that an AI model meant to be running cannot be
 * reached through the Gateway, never once per failing call.
 *
 * Judged on the outcome each call settles with, the one its usage row keeps:
 *
 * - `runtime-error` — the hop could not reach the runtime, the machine's
 *   Traefik answered for it (its plain 404 once the runtime's router is gone,
 *   its 502 when the runtime is down), or the runtime broke off — **opens**
 *   an episode, and that is the one moment the Notification fires.
 * - `ok` — a call that got through, whatever status the runtime chose —
 *   **closes** it, so the next failure opens a fresh one.
 * - A `runtime-error` while a Deployment of the AI model is running is not
 *   observed at all (`GatewayService.record`): a redeploy takes the runtime
 *   away on purpose, so it neither opens nor closes an episode.
 * - `refused` and `client-aborted` do neither. A refusal is the caller's own
 *   mistake (no `call`, a wrong `model`, a path outside the allowlist), or an
 *   AI model that is not running because someone stopped it (`stopped`, and
 *   the `idle` a never-deployed or pre-#574-stopped one wears): the Gateway
 *   refuses those before the hop, so a deliberate Stop never pages. A caller
 *   who left says nothing about the runtime. A refused key never reaches here.
 *
 * **The mark lives in memory and keeps no history**, like
 * `TeardownStuckEpisodes`: it is not an Incident, and the usage rows already
 * count every failing call. A restart re-arms, so the first failure after it
 * tells again.
 */

/** The episode that just opened: the one event to send. */
export interface NotAnswering {
  applicationId: string;
  /** When the call that opened it failed. */
  failedAt: Date;
}

/** Tells the operator an AI model's episode opened. Never awaited by a call. */
export interface AiModelNotAnsweringNotifier {
  aiModelNotAnswering(episode: NotAnswering): Promise<void>;
}

/** The injection token for the notifier, which `NotificationsModule` provides. */
export const AI_MODEL_NOT_ANSWERING_NOTIFIER =
  'AI_MODEL_NOT_ANSWERING_NOTIFIER';

export class AiModelNotAnsweringEpisodes {
  private readonly logger = new Logger(AiModelNotAnsweringEpisodes.name);
  /** The AI models whose episode has fired and not closed. */
  private readonly told = new Set<string>();

  constructor(private readonly notifier: AiModelNotAnsweringNotifier) {}

  /** One call to `applicationId`, settled with `outcome` at `at`. */
  observe(applicationId: string, outcome: AiUsageOutcome, at: Date): void {
    if (outcome === 'ok') {
      this.told.delete(applicationId);
      return;
    }
    if (outcome !== 'runtime-error' || this.told.has(applicationId)) return;
    // Marked before the send: a delivery problem is logged, never retried
    // into noise, and two calls failing together tell once.
    this.told.add(applicationId);
    this.notifier
      .aiModelNotAnswering({ applicationId, failedAt: at })
      .catch((error: unknown) =>
        this.logger.error(
          `Could not tell the channels that AI model ${applicationId} is not answering`,
          error instanceof Error ? error.stack : String(error),
        ),
      );
  }
}
