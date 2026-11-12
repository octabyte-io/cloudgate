import type { Application, BuildType } from "@/lib/api/endpoints/applications";

/**
 * **The six builders, as data** — `buildTypeEnum` in
 * `applications/application.schema.ts`, and nothing else.
 *
 * Each one owns a different subset of the row's build columns, and that is the
 * only thing that varies: `dockerfile` reads three, `static` reads two,
 * `railpack` and `heroku_buildpacks` read a version pin each, `nixpacks` and
 * `paketo_buildpacks` read none. Declaring that once means the read-out card and
 * the form show the same fields for a given builder and cannot disagree — which
 * is the mistake a hand-written `if (buildType === …)` in two components makes.
 *
 * `reads` is what the resting card lists; `writes` is what the form offers. They
 * are the same list, because a setting you can see and cannot change is a setting
 * someone will look for a control for.
 */

export type BuilderSetting = {
  key: keyof Application;
  label: string;
  hint: string;
  /** A path or a literal, set in mono. */
  mono?: boolean;
  /** What `Dash` says when it is unset. */
  absent: string;
  /** A boolean column's two readings. */
  trueLabel?: string;
  falseLabel?: string;
  /** The form control this needs. Everything else is a text input. */
  control?: "switch";
  placeholder?: string;
};

export type BuilderSpec = {
  buildType: BuildType;
  title: string;
  /** One line, in the picker and in the read-out. Says what it *does*. */
  summary: string;
  reads: BuilderSetting[];
};

const DOCKERFILE: BuilderSetting[] = [
  {
    key: "dockerfile",
    label: "Dockerfile",
    hint: "Path to the Dockerfile, relative to the build path.",
    mono: true,
    absent: "Dockerfile",
    placeholder: "Dockerfile",
  },
  {
    key: "dockerContextPath",
    label: "Context",
    hint: "The directory sent to the daemon as the build context. Empty means the build path.",
    mono: true,
    absent: "The build path",
    placeholder: ".",
  },
  {
    key: "dockerBuildStage",
    label: "Target stage",
    hint: "Which stage of a multi-stage Dockerfile to stop at. Empty builds the last one.",
    mono: true,
    absent: "The last stage",
    placeholder: "runtime",
  },
];

const STATIC: BuilderSetting[] = [
  {
    key: "publishDirectory",
    label: "Publish directory",
    hint: "The directory that is served — dist, build, public.",
    mono: true,
    absent: "The build path",
    placeholder: "dist",
  },
  {
    key: "isStaticSpa",
    label: "Single-page app",
    hint: "Serve index.html for any path that is not a file, so client-side routes work on reload.",
    absent: "No",
    control: "switch",
    trueLabel: "Yes — unknown paths serve index.html",
    falseLabel: "No — unknown paths are 404",
  },
];

export const BUILDERS: Record<BuildType, BuilderSpec> = {
  nixpacks: {
    buildType: "nixpacks",
    title: "Nixpacks",
    summary:
      "Detects the language and framework and builds an image with no configuration.",
    reads: [],
  },
  railpack: {
    buildType: "railpack",
    title: "Railpack",
    summary:
      "Nixpacks' successor — same idea, newer detection, and a version you can pin.",
    reads: [
      {
        key: "railpackVersion",
        label: "Railpack version",
        hint: "Pin a version so a build is reproducible. Empty uses the default.",
        mono: true,
        absent: "The default",
        placeholder: "0.15.4",
      },
    ],
  },
  dockerfile: {
    buildType: "dockerfile",
    title: "Dockerfile",
    summary: "Builds the Dockerfile in the repository, exactly as written.",
    reads: DOCKERFILE,
  },
  static: {
    buildType: "static",
    title: "Static files",
    summary:
      "Serves a directory of built files behind nginx. No runtime, no process.",
    reads: STATIC,
  },
  heroku_buildpacks: {
    buildType: "heroku_buildpacks",
    title: "Heroku buildpacks",
    summary:
      "Builds with Heroku's buildpacks, for a repository that already targets them.",
    reads: [
      {
        key: "herokuVersion",
        label: "Stack version",
        hint: "Heroku's stack version. Empty uses the default.",
        mono: true,
        absent: "The default",
        placeholder: "24",
      },
    ],
  },
  paketo_buildpacks: {
    buildType: "paketo_buildpacks",
    title: "Paketo buildpacks",
    summary:
      "Builds with Cloud Native Buildpacks, for a repository that already targets them.",
    reads: [],
  },
};

/** The picker's order: what most Applications want first. */
export const BUILDER_ORDER: BuildType[] = [
  "nixpacks",
  "railpack",
  "dockerfile",
  "static",
  "heroku_buildpacks",
  "paketo_buildpacks",
];
