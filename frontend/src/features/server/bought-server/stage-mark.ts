import type { BoughtServerStage } from "@/lib/api/endpoints/bought-servers";
import type { Mark } from "@/lib/design/status";

/**
 * How each stage a list shows reads. Ready is the one at rest; waiting on the
 * customer stands out; Deleting is only shown going. A stage is a status, so
 * it is a pill with its glyph and word — not a chip, which is a static label
 * (rule 5, and `chip`'s own contract).
 *
 * One map for the Bought Servers page and the Servers page's "Servers being
 * bought", which had each kept their own copy of it.
 */
const STAGE_MARKS: Partial<Record<BoughtServerStage, Mark>> = {
  ready: { glyph: "●", tone: "ok", label: "Ready" },
  changing: { glyph: "◐", tone: "info", label: "Changing" },
  setting_up: { glyph: "◐", tone: "info", label: "Setting up" },
  creating: { glyph: "◐", tone: "info", label: "Creating" },
  waiting_for_payment: {
    glyph: "◐",
    tone: "warn",
    label: "Waiting for payment",
  },
  deleting: { glyph: "○", tone: "mute", label: "Deleting" },
};

/** A stage's mark; one no list expects reads as on its way, by its own name. */
export function stageMark(stage: BoughtServerStage): Mark {
  return STAGE_MARKS[stage] ?? { glyph: "◐", tone: "info", label: stage };
}
