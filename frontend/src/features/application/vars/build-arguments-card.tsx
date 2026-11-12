import { useState } from "react";

import { Card } from "@/components/console/card";
import { Segmented } from "@/components/console/segmented";
import type {
  Application,
  SaveApplicationEnvironmentInput,
} from "@/lib/api/endpoints/applications";
import { usePermission } from "@/lib/auth/use-permission";
import { Icon } from "@/lib/design/icons";

import {
  useConfigLock,
  variableNameLock,
} from "@/components/console/config-lock";
import { VariablesCard } from "@/components/console/variables-card";
import { parseEnvBlob } from "@/lib/format/env-blob";

import { APPLICATION_UPDATE_REFUSAL } from "../use-application";

type Which = "buildArgs" | "buildSecrets";

/**
 * The two blobs the **build** sees, and the difference between them.
 *
 * They share one card with a two-way switch rather than sitting in two cards,
 * because the decision someone is making is *which of these two* a value belongs
 * in — and that is a comparison, not two separate tasks. Putting them side by side
 * as two tables would also double the height of a screen that already stacks four
 * variable blocks.
 *
 * The distinction is the whole point of the card and it is stated on screen:
 *
 * - **Build arguments** become `--build-arg` on the build. Docker records them in
 *   the image's history, so anyone who can pull the image can read them.
 * - **Build secrets** are mounted for the duration of the build and are not in any
 *   layer. This is where a registry token or a private package credential goes.
 *
 * Both go through the same route as `env` (`PATCH /applications/:id/environment`),
 * so saving one sends only that key and leaves the others untouched.
 */
export function BuildArgumentsCard({
  application,
  save,
}: {
  application: Application;
  save: (input: SaveApplicationEnvironmentInput) => Promise<unknown>;
}) {
  const [which, setWhich] = useState<Which>("buildArgs");
  // The same route as the runtime variables, so the same statement.
  const canSave = usePermission({ service: ["update"] });
  const prebuilt = application.sourceType === "docker";
  // A repository-kept config's file sets the names it lists.
  const lock = useConfigLock(
    application.environmentId,
    "application",
    application.applicationId,
  );

  if (prebuilt) {
    return (
      <Card>
        <Card.Header
          title="Build arguments"
          sub="Nothing is built here."
          headingLevel={2}
        />
        <Card.Body>
          <p className="text-body text-tx-2">
            This Application runs a prebuilt image, so there is no build to pass
            arguments to. The variables above are still handed to the container
            when it starts.
          </p>
        </Card.Body>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-3">
        <Segmented<Which>
          label="Which build values to show"
          value={which}
          onChange={setWhich}
          options={[
            { value: "buildArgs", label: "Build arguments" },
            { value: "buildSecrets", label: "Build secrets" },
          ]}
        />
        <p
          key={which}
          className="flex min-w-0 flex-1 animate-fade items-start gap-1 text-meta text-tx-2"
        >
          {which === "buildArgs" ? (
            <>
              <Icon name="alert" size={13} className="mt-0.5 text-warn" />
              <span>
                Recorded in the image&rsquo;s history — readable by anyone who
                can pull it.
              </span>
            </>
          ) : (
            <>
              <Icon name="lock" size={13} className="mt-0.5 text-ok" />
              <span>Mounted during the build only, and in no image layer.</span>
            </>
          )}
        </p>
      </div>

      {/*
        Keyed on the choice, so switching remounts the card and its editor —
        and fades it in, the content replaced in place.
        `VariablesCard`'s form reads `defaultValues` once (F08's note), so a shared
        instance would offer to save the *other* blob's text under this key.
      */}
      <div key={which} className="animate-fade">
        <VariablesCard
          gate={{
            allowed: canSave.allowed,
            refusal: APPLICATION_UPDATE_REFUSAL,
          }}
          env={
            (which === "buildArgs"
              ? application.buildArgs
              : application.buildSecrets) ?? ""
          }
          names={variableNameLock(
            lock,
            which === "buildArgs" ? "build_args" : "build_secrets",
            parseEnvBlob(
              which === "buildArgs"
                ? application.buildArgs
                : application.buildSecrets,
            ).map((variable) => variable.key),
          )}
          noun={which === "buildArgs" ? "Build argument" : "Build secret"}
          title={which === "buildArgs" ? "Build arguments" : "Build secrets"}
          sub={
            which === "buildArgs"
              ? "Passed to the build as --build-arg."
              : "Mounted for the build and left out of the image."
          }
          meta={
            which === "buildArgs" ? (
              <>
                A Dockerfile has to declare <strong>ARG</strong> for each of
                these before it can read one. Nixpacks and railpack pass them to
                the build environment directly.
              </>
            ) : (
              <>
                Put credentials here rather than in build arguments. A value in
                a build argument survives in the image; a value here does not.
              </>
            )
          }
          save={(next) =>
            save(
              which === "buildArgs"
                ? { buildArgs: next }
                : { buildSecrets: next },
            )
          }
        />
      </div>
    </div>
  );
}
