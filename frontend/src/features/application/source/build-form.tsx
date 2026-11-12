import { useState } from "react";
import { Controller, FormProvider } from "react-hook-form";
import { z } from "zod";

import { Field, FormError } from "@/components/console/field";
import { PickCard, PickGrid } from "@/components/console/pick-card";
import { Picker } from "@/components/console/picker";
import { SubmitButton } from "@/components/console/submit-button";
import { toast } from "@/components/console/toast";
import { useApiForm } from "@/components/console/use-api-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import type {
  Application,
  BuildType,
  UpdateApplicationInput,
} from "@/lib/api/endpoints/applications";

import { useRegistries } from "../use-application";
import { BUILDERS, BUILDER_ORDER } from "./builders";

/**
 * The builder, its own settings, and where the image goes.
 *
 * The fields on screen come from `BUILDERS[buildType].reads`, so changing the
 * builder changes the form — a Dockerfile path has no meaning under nixpacks, and
 * leaving it visible invites someone to fill it in and wonder why nothing
 * happened.
 *
 * Values for a builder that is no longer chosen are **left on the row**, not
 * cleared. Someone switching from Dockerfile to nixpacks to try something has
 * their Dockerfile path back when they switch return, and the column is only read
 * by the builder it belongs to.
 */
const schema = z.object({
  buildType: z.enum([
    "nixpacks",
    "railpack",
    "dockerfile",
    "static",
    "heroku_buildpacks",
    "paketo_buildpacks",
  ]),
  dockerfile: z.string(),
  dockerContextPath: z.string(),
  dockerBuildStage: z.string(),
  publishDirectory: z.string(),
  isStaticSpa: z.boolean(),
  railpackVersion: z.string(),
  herokuVersion: z.string(),
  registryId: z.string(),
});
type Values = z.infer<typeof schema>;

export function BuildForm({
  application,
  save,
  onDone,
}: {
  application: Application;
  save: (input: UpdateApplicationInput) => Promise<unknown>;
  onDone: () => void;
}) {
  const registries = useRegistries();
  const [buildType, setBuildType] = useState<BuildType>(application.buildType);

  const form = useApiForm<Values>({
    schema,
    defaultValues: {
      buildType: application.buildType,
      dockerfile: application.dockerfile ?? "",
      dockerContextPath: application.dockerContextPath ?? "",
      dockerBuildStage: application.dockerBuildStage ?? "",
      publishDirectory: application.publishDirectory ?? "",
      isStaticSpa: application.isStaticSpa ?? false,
      railpackVersion: application.railpackVersion ?? "",
      herokuVersion: application.herokuVersion ?? "",
      registryId: application.registryId ?? "",
    },
    onSubmit: async (values) => {
      await save({
        buildType: values.buildType,
        // An empty text field means "unset", which is `null` on the row — an
        // empty string would be a value, and a Dockerfile called "" is not one.
        dockerfile: values.dockerfile.trim() || null,
        dockerContextPath: values.dockerContextPath.trim() || null,
        dockerBuildStage: values.dockerBuildStage.trim() || null,
        publishDirectory: values.publishDirectory.trim() || null,
        isStaticSpa: values.isStaticSpa,
        railpackVersion: values.railpackVersion.trim() || null,
        herokuVersion: values.herokuVersion.trim() || null,
        registryId: values.registryId || null,
      });
      toast.done("Build settings saved.", {
        description: `The next Deployment builds with ${BUILDERS[values.buildType].title}.`,
      });
      onDone();
    },
    onError: (error) => toast.error(error),
  });

  const settings = BUILDERS[buildType].reads;

  return (
    <FormProvider {...form}>
      <form method="post" noValidate onSubmit={form.submit} className="grid gap-3.5">
        <PickGrid label="Builder">
          {BUILDER_ORDER.map((type) => (
            <PickCard
              key={type}
              title={BUILDERS[type].title}
              description={BUILDERS[type].summary}
              selected={buildType === type}
              onClick={() => {
                setBuildType(type);
                form.setValue("buildType", type);
              }}
            />
          ))}
        </PickGrid>

        {settings.map((setting) =>
          setting.control === "switch" ? (
            <Field
              key={String(setting.key)}
              name={String(setting.key)}
              label={setting.label}
              hint={setting.hint}
              orientation="horizontal"
              manual
            >
              <Controller
                name={String(setting.key) as "isStaticSpa"}
                control={form.control}
                render={({ field }) => (
                  <Switch
                    checked={Boolean(field.value)}
                    onCheckedChange={(next) => field.onChange(next)}
                  />
                )}
              />
            </Field>
          ) : (
            <Field
              key={String(setting.key)}
              name={String(setting.key)}
              label={setting.label}
              hint={setting.hint}
              optional
            >
              <Input
                placeholder={setting.placeholder}
                autoComplete="off"
                spellCheck={false}
                className={
                  setting.mono ? "font-mono text-meta md:text-meta" : undefined
                }
              />
            </Field>
          ),
        )}

        <Field
          name="registryId"
          label="Push the image to"
          optional
          hint="A connected registry the built image is pushed to. Leave it empty to keep the image on the Server that built it."
          manual
        >
          <Controller
            name="registryId"
            control={form.control}
            render={({ field }) => (
              <Picker
                // The empty choice is an **option**: as the placeholder
                // alone it vanished once a registry was chosen, and every later
                // build pushed there with no way back short of deleting the
                // registry. `""` is the Picker's none; the save sends `null`.
                options={[
                  { value: "", label: "Keep it on the build Server" },
                  ...(registries.data ?? []).map((registry) => ({
                    value: registry.registryId,
                    label: registry.name,
                    detail: registry.url || "docker.io",
                  })),
                ]}
                value={field.value}
                onValueChange={field.onChange}
                pending={registries.isPending}
                placeholder="Keep it on the build Server"
              />
            )}
          />
        </Field>

        <FormError message={form.rootError} />

        <div className="flex flex-wrap items-center gap-2">
          <SubmitButton pending={form.formState.isSubmitting}>
            Save build settings
          </SubmitButton>
          <Button type="button" onClick={onDone}>
            Cancel
          </Button>
        </div>
      </form>
    </FormProvider>
  );
}
