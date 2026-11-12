import type { SpendFigures } from "@/lib/api/endpoints/token-spend";

/**
 * Token spend read for a person: shared by the AI model's Model
 * tab, the Environment and the Project, so it lives here rather than in any
 * one feature (CODING_STANDARDS §1.4).
 */

const NUMBER = new Intl.NumberFormat("en-US");
export const readCount = (value: number) => NUMBER.format(value);

/** Prompt and completion together, the reported and estimated parts apart. */
export function spendTokens(figures: SpendFigures) {
  return {
    reported: figures.promptTokens.reported + figures.completionTokens.reported,
    estimated:
      figures.promptTokens.estimated + figures.completionTokens.estimated,
  };
}

/**
 * A 30-day total as an Environment's or a Project's fact reads it:
 * every token, the estimated part said in the title, since a rail row has no
 * room for the chart's two paints.
 */
export function spendFact(figures: SpendFigures): {
  value: string;
  title: string;
} {
  const { reported, estimated } = spendTokens(figures);
  return {
    value: `${readCount(reported + estimated)} tokens`,
    title:
      estimated > 0
        ? `${readCount(reported)} reported by the inference runtime, ${readCount(estimated)} estimated by the Gateway`
        : `${readCount(reported)} reported by the inference runtime`,
  };
}
