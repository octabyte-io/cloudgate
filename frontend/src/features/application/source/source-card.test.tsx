import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Application } from "@/lib/api/endpoints/applications";

const uploadDrop = vi.hoisted(() => vi.fn());

// Two boundaries: the upload's HTTP call, and better-auth's session store that
// `useInvalidate` reads the Organization from. The card and its forms are real.
vi.mock("@/lib/api/endpoints/applications", async (original) => {
  const real = await original<typeof import("@/lib/api/endpoints/applications")>();
  return {
    ...real,
    applicationsApi: { ...real.applicationsApi, uploadDrop },
  };
});
vi.mock("@/lib/auth/client", async (original) => ({
  ...(await original<typeof import("@/lib/auth/client")>()),
  useActiveOrganizationId: () => ({ organizationId: "org-1", pending: false }),
}));
vi.mock("@/components/console/toast", () => ({
  toast: { done: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

// The repository-kept config's lock, when a test sets one.
const lock = vi.hoisted(() => ({
  current: null as null | Record<string, unknown>,
}));
vi.mock("@/components/console/config-lock", async (original) => ({
  ...(await original<typeof import("@/components/console/config-lock")>()),
  useConfigLock: () => lock.current,
}));

const { SourceCard, openingSource } = await import("./source-card");

afterEach(() => {
  cleanup();
  lock.current = null;
  uploadDrop.mockReset();
});

/** The row `POST /applications` answers: `source_type`'s default and nothing else. */
const fresh = {
  applicationId: "app-1",
  name: "ui-whoami-scratch",
  sourceType: "github",
  repository: null,
  owner: null,
  branch: null,
  autoDeploy: true,
  triggerType: "push",
  dockerImage: null,
  customGitUrl: null,
  dropBuildPath: null,
} as unknown as Application;

function renderCard(application: Application) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <SourceCard application={application} save={async () => undefined} />
    </QueryClientProvider>,
  );
  return document.body.textContent ?? "";
}

/**
 * **A new Application with no source says so**.
 *
 * The row's `sourceType` is the column default, not a choice, and the card used
 * to render it as one: Type GitHub, Deploys on a push, automatic — on an
 * instance with no GitHub connection and no repository to push to.
 */
describe("SourceCard — no source yet", () => {
  it("claims no GitHub and no automatic deploy for a fresh-create row", () => {
    const text = renderCard(fresh);

    expect(text).not.toContain("A push to the branch");
    expect(text).not.toContain("GitHub");
    expect(text).not.toContain("automatic");
    expect(text).toContain("No source yet");
    expect(screen.getByRole("button", { name: "Change source" })).toBeTruthy();
  });

  it("still reads a configured repository as the source it is", () => {
    // The control: the same row once a repository is chosen.
    const text = renderCard({
      ...fresh,
      owner: "acme",
      repository: "shop",
      branch: "main",
    } as Application);

    expect(text).toContain("GitHub");
    expect(text).toContain("acme/shop");
    expect(text).toContain("A push to the branch");
  });
});

/**
 * **"Deploys on" says automatic only where something delivers the push**.
 *
 * The one inbound trigger in the backend is the GitHub App's webhook, and
 * `DeploymentsService.deployOnGithubPush` deploys a `github` Application on a
 * branch push and nothing else — no other provider has a push route, a tag push
 * names no branch and builds nothing, and there is no deploy-webhook URL for a
 * custom one to call. The card used to read "A push to the branch · automatic"
 * for all of them.
 */
describe("SourceCard — what deploys it", () => {
  const configured = {
    ...fresh,
    owner: "acme",
    repository: "shop",
    branch: "main",
  } as Application;

  it("says a custom git URL deploys on nothing", () => {
    const text = renderCard({
      ...configured,
      sourceType: "git",
      customGitUrl: "https://github.com/render-examples/express-hello-world",
    } as Application);

    expect(text).toContain("Nothing — deploys are manual");
    expect(text).not.toContain("A push to the branch");
    expect(text).not.toContain("automatic");
  });

  it("says a provider with no push route deploys on nothing", () => {
    const text = renderCard({
      ...configured,
      sourceType: "gitlab",
      gitlabRepository: "shop",
    } as Application);

    expect(text).toContain("Nothing — deploys are manual");
    expect(text).not.toContain("automatic");
  });

  it("says a GitHub source set to deploy on a tag deploys on nothing", () => {
    const text = renderCard({ ...configured, triggerType: "tag" } as Application);

    expect(text).toContain("Nothing — deploys are manual");
    expect(text).not.toContain("A new tag");
    expect(text).not.toContain("automatic");
  });

  it("keeps a push to the branch, automatic, for a GitHub branch source", () => {
    const text = renderCard(configured);

    expect(text).toContain("A push to the branch");
    expect(text).toContain("automatic");
  });
});

/**
 * **Uploaded files are a source like the others**.
 *
 * The card used to leave `drop` out of Change source and show a `drop` row
 * read-only, saying no endpoint could upload — with a link to a closed ticket —
 * so an Application an upload had set could only be moved back through the API.
 */
describe("SourceCard — uploaded files", () => {
  const dropped = {
    ...fresh,
    sourceType: "drop",
    dropBuildPath: "/",
  } as unknown as Application;

  it("keeps Change source on a drop Application, and says nothing about a missing endpoint", () => {
    const text = renderCard(dropped);

    expect(text).toContain("Uploaded files");
    expect(text).not.toContain("no endpoint");
    expect(text).not.toContain("#12");
    expect(document.querySelector("a[href*='github.com']")).toBeNull();
    expect(screen.getByRole("button", { name: "Change source" })).toBeTruthy();
  });

  it("offers Uploaded files, and uploads the chosen zip to the drop route", async () => {
    uploadDrop.mockResolvedValue({ ...dropped });
    renderCard(fresh);

    fireEvent.click(screen.getByRole("button", { name: "Change source" }));
    fireEvent.click(screen.getByRole("button", { name: /Uploaded files/ }));

    const zip = new File(["PK"], "site.zip", { type: "application/zip" });
    fireEvent.change(screen.getByLabelText(/^Archive/), {
      target: { files: [zip] },
    });
    fireEvent.change(screen.getByLabelText(/^Build path/), {
      target: { value: "/frontend" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Upload" }));

    await waitFor(() => expect(uploadDrop).toHaveBeenCalledTimes(1));
    expect(uploadDrop).toHaveBeenCalledWith("app-1", zip, "/frontend");
  });

  it("refuses to upload with no archive chosen", async () => {
    renderCard(fresh);

    fireEvent.click(screen.getByRole("button", { name: "Change source" }));
    fireEvent.click(screen.getByRole("button", { name: /Uploaded files/ }));
    fireEvent.click(screen.getByRole("button", { name: "Upload" }));

    expect(
      await screen.findByText("Choose a .zip of the code to upload."),
    ).toBeTruthy();
    expect(uploadDrop).not.toHaveBeenCalled();
  });
});

/**
 * A repository-kept config's file describes this Application, so its
 * provider, repository, path and image are locked inside the form, which
 * still opens for what stays Cloudgate's.
 */
describe("SourceCard — on a repository-kept config", () => {
  it("offers only the saved source type and locks the image", () => {
    lock.current = {
      repository: "acme/shop",
      path: "cloudgate.yaml",
      branch: "main",
      fileUrl: null,
      appliedCommit: null,
      stated: new Set(),
      listed: { env: [], build_args: [], build_secrets: [] },
    };
    renderCard({
      ...fresh,
      sourceType: "docker",
      dockerImage: "nginx:1.27",
    } as Application);

    fireEvent.click(screen.getByRole("button", { name: /Change source/ }));

    const pick = (name: RegExp) =>
      screen
        .getAllByRole("button")
        .find((button) => name.test(button.textContent ?? "")) as HTMLElement;
    expect(pick(/^GitHub/).getAttribute("aria-disabled")).toBe("true");
    expect(pick(/^Docker image/).getAttribute("aria-disabled")).toBeNull();
    const image = screen.getByLabelText(/^Image/);
    expect(image.hasAttribute("readonly")).toBe(true);
    expect(image.getAttribute("title")).toContain("cloudgate.yaml in acme/shop");
  });
});

/**
 * Change source opened on GitHub, the column's default, with no GitHub
 * connected and so no Save; Any git URL showed `main` as a placeholder and
 * refused the save as empty; and any string was taken as a clone URL.
 */
describe("SourceCard — a first source", () => {
  const none = { github: false, gitlab: false, bitbucket: false, gitea: false };

  it("opens on the first provider with a connection, or on Any git URL", () => {
    expect(openingSource(none)).toBe("git");
    expect(openingSource({ ...none, gitlab: true, gitea: true })).toBe("gitlab");
    expect(openingSource({ ...none, github: true })).toBe("github");
  });

  it("opens a fresh row on Any git URL when nothing is connected, with main as the branch", async () => {
    const save = vi.fn(async () => undefined);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <SourceCard
          // The row's own submodules flag, which the git form sends back.
          application={{ ...fresh, enableSubmodules: false } as Application}
          save={save}
        />
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Change source" }));
    const picked = screen
      .getAllByRole("button")
      .find((button) => button.getAttribute("aria-pressed") === "true");
    expect(picked?.textContent).toContain("Any git URL");

    const branch = screen.getByLabelText(/^Branch/) as HTMLInputElement;
    expect(branch.value).toBe("main");

    fireEvent.change(screen.getByLabelText(/^Clone URL/), {
      target: { value: "not a url" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save source" }));
    expect(await screen.findByText(/^Give a clone URL:/)).toBeTruthy();
    expect(save).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText(/^Clone URL/), {
      target: { value: "git@github.com:acme/api.git" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save source" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceType: "git",
        customGitUrl: "git@github.com:acme/api.git",
        customGitBranch: "main",
      }),
    );
  });
});
