import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ReviewPlanButton } from "./review-plan-button";

afterEach(cleanup);

const place = { projectId: "proj-1", environmentId: "env-1" };

describe("ReviewPlanButton", () => {
  it("links a stopped cloud deploy to its Environment's plan", () => {
    render(
      <ReviewPlanButton
        deployment={{ reviewPlanId: "plan-1" }}
        place={place}
      />,
    );

    expect(
      screen
        .getByRole("link", { name: "Review the open plan →" })
        .getAttribute("href"),
    ).toBe("/projects/proj-1/config#plan-env-1");
  });

  it("renders nothing for a Deployment that names no plan, or before the place is known", () => {
    const { container } = render(
      <>
        <ReviewPlanButton deployment={{ reviewPlanId: null }} place={place} />
        <ReviewPlanButton deployment={{}} place={place} />
        <ReviewPlanButton
          deployment={{ reviewPlanId: "plan-1" }}
          place={null}
        />
      </>,
    );

    expect(container.textContent).toBe("");
  });
});
