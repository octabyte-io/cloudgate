import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ApplicationDetail } from "@/lib/api/endpoints/applications";

const toast = vi.hoisted(() => ({ done: vi.fn(), error: vi.fn() }));
vi.mock("@/components/console/toast", () => ({ toast }));

const {
  CLOUD_DELETE_LOG_GROUP_LINE,
  CLOUD_RUN_LOGS_STAY_LINE,
  DeleteApplicationModal,
} = await import("./delete-application-modal");

afterEach(() => {
  cleanup();
  toast.done.mockReset();
});

const cloudWeb = {
  applicationId: "app-1",
  environmentId: "env-1",
  name: "web",
  appName: "web-abc",
  cloudPlace: {
    cloudAccountId: "cloud-1",
    cloudAccountName: "Production AWS",
    region: "eu-central-1",
  },
  cloudDelete: null,
} as unknown as ApplicationDetail;

/**
 * A cloud Service's Delete dialog says its log group goes too, queues
 * the destroy-only Cloud run, and stays on the Service, which reads
 * "Deleting" until the run ends.
 */
describe("DeleteApplicationModal on a cloud Service", () => {
  it("says the log group goes too, and offers no volumes", () => {
    render(
      <DeleteApplicationModal
        application={cloudWeb}
        open
        onOpenChange={() => undefined}
        remove={() => Promise.resolve({})}
        onDeleted={() => undefined}
      />,
    );

    expect(
      screen.getByText(new RegExp(CLOUD_DELETE_LOG_GROUP_LINE)),
    ).toBeTruthy();
    expect(screen.queryByText("Delete its volumes too")).toBeNull();
  });

  it("queues the Delete and does not leave the page", async () => {
    const remove = vi.fn(() => Promise.resolve({}));
    const onDeleted = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <DeleteApplicationModal
        application={cloudWeb}
        open
        onOpenChange={onOpenChange}
        remove={remove}
        onDeleted={onDeleted}
      />,
    );

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "web" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Delete Application" }));

    await waitFor(() => expect(remove).toHaveBeenCalledWith(false));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(onDeleted).not.toHaveBeenCalled();
    expect(toast.done).toHaveBeenCalledWith("Deleting web.", expect.anything());
  });
});

const cloudSite = {
  ...cloudWeb,
  name: "docs",
  buildType: "static",
  cloudBucketName: "docs-p4x8m2rt-123456789012-eu-central-1-an",
} as unknown as ApplicationDetail;

/**
 * A static site on AWS's Delete empties its own bucket and destroys
 * it with its CloudFront distribution. Its files are a copy of its build, so
 * there is no box to keep them.
 */
describe("DeleteApplicationModal on a static site on AWS", () => {
  it("says its bucket is emptied and destroyed with its distribution, with no files box", () => {
    render(
      <DeleteApplicationModal
        application={cloudSite}
        open
        onOpenChange={() => undefined}
        remove={() => Promise.resolve({})}
        onDeleted={() => undefined}
      />,
    );

    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain(
      "empties its S3 bucket docs-p4x8m2rt-123456789012-eu-central-1-an",
    );
    expect(dialog.textContent).toContain("CloudFront distribution");
    expect(dialog.textContent).toContain("partly emptied");
    expect(dialog.textContent).not.toContain("ECS service");
    expect(dialog.textContent).not.toContain(CLOUD_DELETE_LOG_GROUP_LINE);
    expect(screen.queryByRole("checkbox")).toBeNull();
  });
});

const cloudRunWeb = {
  ...cloudWeb,
  cloudPlace: {
    cloudAccountId: "cloud-2",
    cloudAccountName: "Production Google",
    cloud: "gcp",
    region: "europe-west1",
  },
} as unknown as ApplicationDetail;

/**
 * A Cloud Run Service's Delete dialog says its Domains come off the
 * Environment network first, and in one line that its logs stay in the
 * project's log store and expire: no log group goes.
 */
describe("DeleteApplicationModal on a Cloud Run Service", () => {
  it("says its logs stay in the project and expire, and its Domains come off the network first", () => {
    render(
      <DeleteApplicationModal
        application={cloudRunWeb}
        open
        onOpenChange={() => undefined}
        remove={() => Promise.resolve({})}
        onDeleted={() => undefined}
      />,
    );

    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain(CLOUD_RUN_LOGS_STAY_LINE);
    expect(dialog.textContent).toContain(
      "first takes its Domains off the Environment network's load balancer",
    );
    expect(dialog.textContent).toContain("Cloud Run service");
    expect(dialog.textContent).not.toContain(CLOUD_DELETE_LOG_GROUP_LINE);
    expect(dialog.textContent).not.toContain("ECS service");
  });
});

const googleSite = {
  ...cloudRunWeb,
  name: "docs",
  buildType: "static",
  cloudBucketName: "cloudgate-abcdefghijkl-p4x8m2rt",
} as unknown as ApplicationDetail;

/**
 * A static site on Google Cloud's Delete takes its Domains off the
 * network first, then empties its Cloud Storage bucket and destroys it
 * with its Cloud CDN backend bucket. Its files are a copy of its build, so
 * there is no box to keep them.
 */
describe("DeleteApplicationModal on a static site on Google Cloud", () => {
  it("says its Domains come off first, then its bucket is emptied and destroyed with its backend bucket, with no files box", () => {
    render(
      <DeleteApplicationModal
        application={googleSite}
        open
        onOpenChange={() => undefined}
        remove={() => Promise.resolve({})}
        onDeleted={() => undefined}
      />,
    );

    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain(
      "first takes its Domains off the Environment network's load balancer",
    );
    expect(dialog.textContent).toContain(
      "empties its Cloud Storage bucket cloudgate-abcdefghijkl-p4x8m2rt",
    );
    expect(dialog.textContent).toContain("Cloud CDN backend bucket");
    expect(dialog.textContent).toContain("partly emptied");
    expect(dialog.textContent).not.toContain("Cloud Run service");
    expect(dialog.textContent).not.toContain("S3");
    expect(screen.queryByRole("checkbox")).toBeNull();
  });
});
