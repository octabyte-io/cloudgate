import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { StackBackupsNote } from "./stack-backups-note";

afterEach(cleanup);

const NOT_DEPLOYED =
  "This stack hasn’t deployed successfully yet, and its volumes are read from its first deploy";

/**
 * What the Volume backups tab says about the stack it is on (#163): that a
 * swarm stack's backup copies only its Server's volume, and that a stack not
 * deployed yet has no volumes to pick from until its first deploy.
 */
describe("StackBackupsNote", () => {
  it("says on a swarm stack that only the copy on its Server is backed up", () => {
    render(<StackBackupsNote swarm unavailableReason={null} />);

    expect(
      screen.getByText(
        /only the copy of a volume on this stack’s Server is backed up/,
      ),
    ).toBeDefined();
  });

  it("says nothing of other nodes on a docker-compose stack", () => {
    render(
      <StackBackupsNote swarm={false} unavailableReason={null} />,
    );

    expect(screen.queryByText(/only the copy of a volume/)).toBeNull();
  });

  it("says a stack not deployed yet has its volumes read from its first deploy", () => {
    render(
      <StackBackupsNote
        swarm={false}
        unavailableReason={NOT_DEPLOYED}
      />,
    );

    expect(screen.getByText(NOT_DEPLOYED)).toBeDefined();
  });
});
