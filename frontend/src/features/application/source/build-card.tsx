import { useState } from "react";

import { Card } from "@/components/console/card";
import { KVList, KVRow } from "@/components/console/kv-list";
import { Skeleton } from "@/components/console/skeleton";
import { Button } from "@/components/ui/button";
import type {
  Application,
  UpdateApplicationInput,
} from "@/lib/api/endpoints/applications";
import { Dash } from "@/components/console/dash";
import {
  ConfigLockNote,
  lockRefusal,
  useConfigLock,
} from "@/components/console/config-lock";
import { usePermission } from "@/lib/auth/use-permission";
import { Icon } from "@/lib/design/icons";

import { APPLICATION_UPDATE_REFUSAL, useRegistries } from "../use-application";
import { BUILDERS } from "./builders";
import { BuildForm } from "./build-form";

/**
 * How the source becomes an image.
 *
 * Same two-state shape as the source card above it, and for the same reason: six
 * builders, each with its own two or three settings, is a form nobody wants
 * permanently open on a screen they came to read a status on.
 *
 * **A Docker-image source has no build at all**, so the card says that instead of
 * offering a `buildType` the deployment would ignore. The column still holds one
 * (`nixpacks` by default, `notNull`), which is exactly why it must not be shown as
 * if it meant something here.
 *
 * **Where the image goes is a row here too**,
 * and it is the one setting on this card that the form offered and the read-out
 * did not: "Push the image to" was visible only by opening Edit again. It is not
 * decoration — a build on one Server can only deploy on another *through* a
 * registry (`BuildServerCard`'s warning is that sentence), and removing a
 * registry clears the column rather than refusing the build, so the row an
 * operator reads after either of those is this one. A prebuilt image has no
 * push and so no row; the column may hold a registry and nothing pushes to it.
 */
export function BuildCard({
  application,
  save,
}: {
  application: Application;
  save: (input: UpdateApplicationInput) => Promise<unknown>;
}) {
  const [editing, setEditing] = useState(false);
  // The build settings save through `PATCH /applications/:id` too.
  const canChange = usePermission({ service: ["update"] });
  // Every build setting is config-owned: a repository-kept config's file
  // sets them, and the backend refuses them here.
  const lock = useConfigLock(
    application.environmentId,
    "application",
    application.applicationId,
  );
  const registries = useRegistries();
  const builder = BUILDERS[application.buildType];
  const prebuilt = application.sourceType === "docker";
  const pushesTo =
    (registries.data ?? []).find(
      (registry) => registry.registryId === application.registryId,
    ) ?? null;

  return (
    <Card>
      <Card.Header
        title="Build"
        sub={
          prebuilt
            ? "Nothing is built — the image is pulled as it is."
            : "How the code becomes an image."
        }
        headingLevel={2}
        actions={
          editing || prebuilt ? null : (
            <Button
              size="xs"
              disabled={!canChange.allowed || lock !== null}
              title={
                !canChange.allowed
                  ? APPLICATION_UPDATE_REFUSAL
                  : lock
                    ? lockRefusal(lock)
                    : undefined
              }
              onClick={() =>
                canChange.allowed && lock === null && setEditing(true)
              }
            >
              <Icon name="pencil" size={14} />
              Edit
            </Button>
          )
        }
      />

      <Card.Body>
        {lock && !prebuilt ? (
          <div className="mb-3">
            <ConfigLockNote lock={lock} what="The build settings are" />
          </div>
        ) : null}
        {prebuilt ? (
          <p className="text-body text-tx-2">
            Change the source to a git provider to build from code.
          </p>
        ) : editing ? (
          <div className="animate-fade">
            <BuildForm
              application={application}
              save={save}
              onDone={() => setEditing(false)}
            />
          </div>
        ) : (
          <KVList>
            <KVRow label="Builder" value={builder.title} />
            <KVRow
              label="What it does"
              value={
                <span className="whitespace-normal text-tx-2">
                  {builder.summary}
                </span>
              }
              className="items-start"
            />
            {builder.reads.map((setting) => {
              const value = application[setting.key];
              return (
                <KVRow
                  key={String(setting.key)}
                  label={setting.label}
                  mono={setting.mono}
                  title={value ? String(value) : undefined}
                  value={
                    value === null || value === undefined || value === "" ? (
                      <Dash word={setting.absent} />
                    ) : typeof value === "boolean" ? (
                      value ? (
                        (setting.trueLabel ?? "Yes")
                      ) : (
                        (setting.falseLabel ?? "No")
                      )
                    ) : (
                      String(value)
                    )
                  }
                />
              );
            })}
            <KVRow
              label="Pushes to"
              value={
                application.registryId === null ? (
                  // Not a `Dash`: staying on the build Server is a real answer
                  // and the default one, not a value someone forgot to set.
                  <span className="text-tx-2">Stays on the build Server</span>
                ) : registries.error ? (
                  // `error` before `isPending` (§3.5): a member whose role
                  // cannot list registries is refused here, and "Unknown" is
                  // the word `Dash` reserves for a figure whose request was
                  // refused — not a claim that the push has no destination.
                  <Dash word="Unknown" />
                ) : registries.isPending ? (
                  <Skeleton className="ml-auto w-24" />
                ) : pushesTo ? (
                  <>
                    {pushesTo.name}{" "}
                    <span className="font-mono text-meta text-tx-2">
                      {/* The registry list draws the empty `url` the same way
                          the picker does — it is Docker Hub, not a blank. */}
                      {pushesTo.url || "docker.io"}
                    </span>
                  </>
                ) : (
                  // The column is `onDelete: 'set null'`, so a linked id the
                  // Organization's list does not carry is a race rather than a
                  // steady state — and a name we cannot read is not one to
                  // invent.
                  <Dash word="Unknown" />
                )
              }
            />
          </KVList>
        )}
      </Card.Body>
    </Card>
  );
}
